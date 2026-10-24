import { afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const REPLY_PREFIX = "The user answered by voice, through OpenSuperWhisper:\n\n";

/** What the fake `agent-hook` does after recording its argv, stdin and env. */
export type HookBehavior =
  | { kind: "reply"; text: string }
  | { kind: "print"; stdout: string }
  | { kind: "silent" }
  | { kind: "fail" }
  | { kind: "sleep" }
  | { kind: "reply-on-term"; text: string }
  | { kind: "reply-on-release"; text: string };

export interface HookRun {
  pid: number;
  argv: string[];
  stdin: string;
  env: Record<string, string>;
}

/**
 * The fake `agent-hook`. Every FakeApp links to this one file and the script reads its behaviour
 * from the link's directory: macOS scans each new executable on first run (~0.5 s), so a fresh
 * script per test would make spawn timing slow and erratic.
 */
const FAKE_HOOK_SCRIPT = `#!/bin/sh
dir=$(dirname "$0")
echo $$ >> "$dir/started"
run="$dir/runs/$$"
mkdir -p "$run.tmp"
printf '%s\\n' "$@" > "$run.tmp/argv"
cat > "$run.tmp/stdin"
env -0 > "$run.tmp/env"
mv "$run.tmp" "$run"
case "$(cat "$dir/behavior")" in
  print) cat "$dir/stdout" ;;
  fail) cat "$dir/stdout"; exit 1 ;;
  sleep) exec sleep 30 ;;
  # A reply that lands at the same instant the hook is cancelled.
  reply-on-term) trap 'cat "$dir/stdout"; exit 0' TERM; while :; do sleep 0.05; done ;;
  # A reply that waits for the test to call release().
  reply-on-release) while [ ! -e "$dir/release" ]; do sleep 0.02; done; cat "$dir/stdout" ;;
esac
exit 0
`;

let sharedScriptDir: string | undefined;

function fakeHookScript(): string {
  if (!sharedScriptDir) {
    sharedScriptDir = mkdtempSync(join(tmpdir(), "pi-osw-hook-"));
    const script = join(sharedScriptDir, "agent-hook");
    writeFileSync(script, FAKE_HOOK_SCRIPT, { mode: 0o755 });
    // Pay the first-run scan now, so no test (or no-spawn grace period) has to absorb it.
    Bun.spawnSync([script], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  }
  return join(sharedScriptDir, "agent-hook");
}

afterAll(() => {
  if (sharedScriptDir) rmSync(sharedScriptDir, { recursive: true, force: true });
  sharedScriptDir = undefined;
});

/**
 * A temporary OpenSuperWhisper agents directory whose `app.pid` is this test process and whose
 * `app.executable` is the fake `agent-hook` script. It never touches the real app.
 */
export class FakeApp {
  readonly dir = mkdtempSync(join(tmpdir(), "pi-osw-test-"));
  readonly agentsDir = join(this.dir, "agents");
  readonly executable = join(this.dir, "agent-hook");
  private readonly runsDir = join(this.dir, "runs");
  private readonly startedFile = join(this.dir, "started");

  constructor(behavior: HookBehavior = { kind: "silent" }) {
    mkdirSync(this.agentsDir);
    mkdirSync(this.runsDir);
    this.writePid(String(process.pid));
    this.pointExecutableAt(this.executable);
    symlinkSync(fakeHookScript(), this.executable);
    writeFileSync(join(this.dir, "behavior"), behavior.kind === "reply" ? "print" : behavior.kind);
    writeFileSync(join(this.dir, "stdout"), stdoutFor(behavior));
  }

  writePid(contents: string): void {
    writeFileSync(join(this.agentsDir, "app.pid"), contents);
  }

  removeRegistryFile(name: "app.pid" | "app.executable"): void {
    rmSync(join(this.agentsDir, name));
  }

  pointExecutableAt(path: string): void {
    writeFileSync(join(this.agentsDir, "app.executable"), `${path}\n`);
  }

  /** Replaces the hook with a copy that lacks the executable bit. */
  makeExecutableNotExecutable(): void {
    rmSync(this.executable);
    writeFileSync(this.executable, FAKE_HOOK_SCRIPT, { mode: 0o644 });
  }

  /** Lets a `reply-on-release` hook print its reply. */
  release(): void {
    writeFileSync(join(this.dir, "release"), "");
  }

  /** Pids of every hook that started, recorded first thing so even a quickly killed hook shows up. */
  startedPids(): number[] {
    if (!existsSync(this.startedFile)) return [];
    return readFileSync(this.startedFile, "utf8").split("\n").filter(Boolean).map(Number);
  }

  runs(): HookRun[] {
    return readdirSync(this.runsDir)
      .filter((name) => /^\d+$/.test(name))
      .map((name) => {
        const run = join(this.runsDir, name);
        const env = Object.fromEntries(
          readFileSync(join(run, "env"), "utf8")
            .split("\0")
            .filter(Boolean)
            .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
        );
        return {
          pid: Number(name),
          argv: readFileSync(join(run, "argv"), "utf8").trimEnd().split("\n"),
          stdin: readFileSync(join(run, "stdin"), "utf8"),
          env,
        };
      });
  }

  /** Waits until the fake hook has been spawned `count` times and returns the runs. */
  async waitForRuns(count: number): Promise<HookRun[]> {
    await waitFor(() => this.runs().length >= count, `${count} hook run(s)`);
    return this.runs();
  }

  /** Leaves running hooks to the extension (tests end with session_shutdown); fake hooks also exit after 30 s. */
  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

function stdoutFor(behavior: HookBehavior): string {
  switch (behavior.kind) {
    case "reply":
    case "reply-on-term":
    case "reply-on-release":
      return JSON.stringify({ decision: "block", reason: `${REPLY_PREFIX}${behavior.text}` });
    case "print":
      return behavior.stdout;
    case "fail":
      return JSON.stringify({ decision: "block", reason: `${REPLY_PREFIX}should never arrive` });
    default:
      return "";
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** Long enough for a hook that was (wrongly) spawned to have recorded its run. */
export const NO_SPAWN_GRACE_MS = 250;

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A fake host `ExtensionAPI` that records handlers and `sendUserMessage` calls. */
export class FakeHost {
  readonly sent: { content: unknown; options: unknown }[] = [];
  /** When set, `sendUserMessage` throws after recording, like a host whose session went away. */
  rejectDelivery = false;
  private readonly handlers = new Map<string, Handler[]>();

  readonly api = {
    on: (event: string, handler: Handler) => {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
      return () => {};
    },
    sendUserMessage: (content: unknown, options?: unknown) => {
      this.sent.push({ content, options });
      if (this.rejectDelivery) throw new Error("session disposed");
    },
  } as unknown as ExtensionAPI;

  /** Fires a host event and waits for every handler to return, like the host does. */
  async emit(type: string, event: Record<string, unknown>, ctx: unknown): Promise<unknown[]> {
    const results = [];
    for (const handler of this.handlers.get(type) ?? []) {
      results.push(await handler({ type, ...event }, ctx));
    }
    return results;
  }

  /** The host events the extension subscribed to. */
  events(): string[] {
    return [...this.handlers.keys()];
  }

  async waitForSent(count: number): Promise<void> {
    await waitFor(() => this.sent.length >= count, `${count} sendUserMessage call(s)`);
  }
}

export function assistant(text: string, stopReason = "stop") {
  return { role: "assistant", content: [{ type: "text", text }], stopReason };
}

export function user(text: string) {
  return { role: "user", content: [{ type: "text", text }] };
}

interface CtxOptions {
  mode?: string;
  cwd?: string;
  idle?: boolean;
  pendingMessages?: boolean;
}

/** A pi-shaped `ctx`: no `getAsyncJobSnapshot`, no `agent`; the session id is on the header. */
export function piCtx(messages: unknown[], { mode = "tui", cwd = "/work/project", idle = true, pendingMessages = false }: CtxOptions = {}) {
  return {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd,
    isIdle: () => idle,
    hasPendingMessages: () => pendingMessages,
    sessionManager: {
      getHeader: () => ({ type: "session", id: "pi-session-id", cwd }),
      getBranch: () => [
        { type: "session_info", id: "e0", parentId: null },
        ...messages.map((message, i) => ({ type: "message", id: `e${i + 1}`, parentId: `e${i}`, message })),
      ],
    },
  };
}

/** An omp-shaped `ctx`: has `getAsyncJobSnapshot` and an agent identity. */
export function ompCtx({
  mode = "tui",
  cwd = "/work/project",
  idle = true,
  pendingMessages = false,
  agentKind = "main",
}: CtxOptions & { agentKind?: "main" | "sub" } = {}) {
  return {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd,
    isIdle: () => idle,
    hasPendingMessages: () => pendingMessages,
    getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
    agent: { kind: agentKind, id: agentKind === "main" ? "Main" : "0-Task", name: agentKind === "main" ? "main" : "task", depth: 0 },
    sessionManager: {
      getSessionId: () => "omp-session-id",
    },
  };
}
