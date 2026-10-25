import { afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

export const REPLY_PREFIX = "The user answered by voice, through OpenSuperWhisper:\n\n";

/** What the fake `agent-hook` does after recording its argv, stdin and env. */
export type HookBehavior =
  | { kind: "reply"; text: string }
  | { kind: "print"; stdout: string }
  | { kind: "silent" }
  | { kind: "fail" }
  | { kind: "sleep" }
  | { kind: "reply-on-term"; text: string }
  | { kind: "reply-on-release"; text: string }
  /** Prints a question answer (keyed by question text) as soon as it has read stdin. */
  | { kind: "answer"; answers: Record<string, string> }
  /** Prints a question answer once the test calls release(). */
  | { kind: "answer-on-release"; answers: Record<string, string> };

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
  # Output that waits for the test to call release().
  print-on-release) while [ ! -e "$dir/release" ]; do sleep 0.02; done; cat "$dir/stdout" ;;
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
    writeFileSync(join(this.dir, "behavior"), scriptBehavior(behavior));
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

  /** Lets a `reply-on-release` or `answer-on-release` hook print its output. */
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

/** The fake script's case for a behaviour: the kinds that differ only in their stdout share one. */
function scriptBehavior(behavior: HookBehavior): string {
  switch (behavior.kind) {
    case "reply":
    case "answer":
      return "print";
    case "reply-on-release":
    case "answer-on-release":
      return "print-on-release";
    default:
      return behavior.kind;
  }
}

function stdoutFor(behavior: HookBehavior): string {
  switch (behavior.kind) {
    case "reply":
    case "reply-on-term":
    case "reply-on-release":
      return JSON.stringify({ decision: "block", reason: `${REPLY_PREFIX}${behavior.text}` });
    case "answer":
    case "answer-on-release":
      return questionAnswerStdout(behavior.answers);
    case "print":
      return behavior.stdout;
    case "fail":
      return JSON.stringify({ decision: "block", reason: `${REPLY_PREFIX}should never arrive` });
    default:
      return "";
  }
}

/** What `agent-hook question` prints when the user answers in the panel (answers keyed by question text). */
export function questionAnswerStdout(answers: Record<string, string>): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { answers } },
  });
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

/** The omp `ToolInfo` shape `getAllTools()` returns (`extensibility/extensions/types.ts`). */
export interface OmpToolInfo {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  sourceInfo: { path: string; source: string; scope: string; origin: string };
}

/** omp's built-in `ask`, as `getAllTools()` lists it (`session/session-tools.ts` `getAllToolInfos`). */
export const BUILTIN_ASK: OmpToolInfo = {
  name: "ask",
  description: "Ask the user one or more questions with predefined options.",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            question: { type: "string" },
            options: { type: "array", items: { type: "object", properties: { label: { type: "string" } } } },
            multi: { type: "boolean" },
          },
          required: ["id", "question", "options"],
        },
      },
    },
    required: ["questions"],
  },
  sourceInfo: { path: "<builtin:ask>", source: "builtin", scope: "temporary", origin: "top-level" },
};

/** A fake host `ExtensionAPI` that records handlers, `sendUserMessage` calls and registered tools. */
export class FakeHost {
  readonly sent: { content: unknown; options: unknown }[] = [];
  /** When set, `sendUserMessage` throws after recording, like a host whose session went away. */
  rejectDelivery = false;
  /** Every definition passed to `registerTool`, in order. */
  readonly registeredTools: ToolDefinition[] = [];
  /** What `getAllTools()` returns. */
  allTools: OmpToolInfo[] = [BUILTIN_ASK];
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
    registerTool: (tool: ToolDefinition) => {
      this.registeredTools.push(tool);
    },
    getAllTools: () => this.allTools,
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

type InvokeTool = (params: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<AgentToolResult<unknown>>;

/** Like omp's `ToolAbortError` (`tools/tool-errors.ts`), which a cancelled native `ask` throws. */
export class ToolAbortError extends Error {
  constructor(message = "Operation aborted") {
    super(message);
    this.name = "ToolAbortError";
  }
}

type Outcome = { ok: true; result: AgentToolResult<unknown> } | { ok: false; error: unknown };

/**
 * omp's native `ask` behind `ctx.invokeTool`. A call waits until the test settles it with
 * `resolve`/`reject` (also allowed before the call), or until its `signal` aborts, which rejects
 * with a `ToolAbortError` like the native dialog does.
 */
export class FakeNativeAsk {
  /** Every call: the params and the signal it was given. */
  readonly calls: { params: Record<string, unknown>; signal: AbortSignal | undefined }[] = [];
  private outcome: Outcome | undefined;
  private readonly waiting = new Set<(outcome: Outcome) => void>();

  readonly invokeTool: InvokeTool = (params, options) => {
    const signal = options?.signal;
    this.calls.push({ params, signal });
    const { promise, resolve, reject } = Promise.withResolvers<AgentToolResult<unknown>>();
    const settle = (outcome: Outcome) => {
      this.waiting.delete(settle);
      signal?.removeEventListener("abort", onAbort);
      if (outcome.ok) resolve(outcome.result);
      else reject(outcome.error);
    };
    const onAbort = () => settle({ ok: false, error: new ToolAbortError("Ask tool was cancelled by the user") });
    if (this.outcome) settle(this.outcome);
    else if (signal?.aborted) onAbort();
    else {
      this.waiting.add(settle);
      signal?.addEventListener("abort", onAbort, { once: true });
    }
    return promise;
  };

  /** Settles pending and future calls with this result. */
  resolve(result: AgentToolResult<unknown>): void {
    this.settleAll({ ok: true, result });
  }

  /** Settles pending and future calls by throwing this error. */
  reject(error: unknown): void {
    this.settleAll({ ok: false, error });
  }

  async waitForCalls(count: number): Promise<void> {
    await waitFor(() => this.calls.length >= count, `${count} native ask call(s)`);
  }

  private settleAll(outcome: Outcome): void {
    this.outcome = outcome;
    for (const settle of [...this.waiting]) settle(outcome);
  }
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

/** An omp-shaped `ctx`: has `getAsyncJobSnapshot` and an agent identity; `invokeTool` only when given. */
export function ompCtx({
  mode = "tui",
  cwd = "/work/project",
  idle = true,
  pendingMessages = false,
  agentKind = "main",
  invokeTool,
}: CtxOptions & { agentKind?: "main" | "sub"; invokeTool?: InvokeTool } = {}) {
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
    ...(invokeTool ? { invokeTool } : {}),
  };
}
