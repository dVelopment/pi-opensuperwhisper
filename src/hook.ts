import { spawn } from "node:child_process";

/** The `agent-hook` subcommands this extension runs. */
export type HookEvent = "stop" | "question";

/** The Claude Code–style Stop payload `agent-hook stop` reads from stdin. */
export interface StopRequest {
  hook_event_name: "Stop";
  session_id: string;
  cwd: string;
  last_assistant_message: string;
  stop_hook_active: false;
}

export interface HookProcess {
  /** Resolves with the hook's stdout when it exits 0, or nothing on any failure. */
  readonly stdout: Promise<string | undefined>;
  /** Stops the hook (SIGTERM). Safe to call after it has exited. */
  kill(): void;
}

/**
 * Spawns `<executable> agent-hook <event>` without blocking, writes the request as JSON to its
 * stdin and collects its stdout. `CLAUDE_PROJECT_DIR` makes the app accept the request as Claude Code.
 */
export function runHook(executable: string, event: HookEvent, request: { cwd: string }): HookProcess {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  const child = spawn(executable, ["agent-hook", event], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: request.cwd },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.on("error", () => resolve(undefined));
  child.on("close", (code) => resolve(code === 0 ? stdout : undefined));
  // The hook may exit before reading stdin; a broken pipe must not crash the host.
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(request));
  return {
    stdout: promise,
    kill: () => {
      child.kill("SIGTERM");
    },
  };
}
