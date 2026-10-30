import { afterEach, describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createExtension } from "../src/index.ts";
import {
  BUILTIN_ASK,
  FakeApp,
  FakeHost,
  FakeNativeAsk,
  type HookBehavior,
  isAlive,
  NO_SPAWN_GRACE_MS,
  ompCtx,
  piCtx,
  ToolAbortError,
  waitFor,
} from "./harness.ts";

const apps: FakeApp[] = [];
const hosts: FakeHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.emit("session_shutdown", { reason: "quit" }, ompCtx());
  for (const app of apps.splice(0)) app.cleanup();
});

function setup(behavior: HookBehavior = { kind: "silent" }, { platform = "darwin" as NodeJS.Platform, hardKillMs = 10_000 } = {}) {
  const app = new FakeApp(behavior);
  const host = new FakeHost();
  apps.push(app);
  hosts.push(host);
  createExtension({ agentsDir: app.agentsDir, platform, hardKillMs })(host.api);
  return { app, host };
}

describe("registering the `ask` shadow", () => {
  test("on omp session_start, re-registers the built-in `ask` with its description, parameters and native traits", async () => {
    const { host } = setup();

    await host.emit("session_start", { reason: "startup" }, ompCtx());

    expect(host.registeredTools).toHaveLength(1);
    const tool = host.registeredTools[0] as ToolDefinition & Record<string, unknown>;
    expect(tool.name).toBe("ask");
    expect(tool.description).toBe(BUILTIN_ASK.description);
    expect(tool.parameters).toBe(BUILTIN_ASK.parameters);
    expect({
      label: tool.label,
      approval: tool.approval,
      strict: tool.strict,
      loadMode: tool.loadMode,
      concurrency: tool.concurrency,
    }).toEqual({ label: "Ask", approval: "read", strict: true, loadMode: "discoverable", concurrency: "exclusive" });
  });

  test("registers once per extension instance", async () => {
    const { host } = setup();
    await host.emit("session_start", { reason: "startup" }, ompCtx());
    await host.emit("session_start", { reason: "new" }, ompCtx());
    expect(host.registeredTools).toHaveLength(1);
  });

  test("never registers on pi", async () => {
    const { host } = setup();
    await host.emit("session_start", { reason: "startup" }, piCtx([]));
    expect(host.registeredTools).toEqual([]);
  });

  test("does not register when omp has no built-in `ask`", async () => {
    const { host } = setup();
    host.allTools = [];
    await host.emit("session_start", { reason: "startup" }, ompCtx());
    expect(host.registeredTools).toEqual([]);
  });

  test("does not register over an `ask` that is not omp's built-in", async () => {
    const { host } = setup();
    host.allTools = [{ ...BUILTIN_ASK, sourceInfo: { ...BUILTIN_ASK.sourceInfo, path: "<extension:ask>", source: "extension" } }];
    await host.emit("session_start", { reason: "startup" }, ompCtx());
    expect(host.registeredTools).toEqual([]);
  });
});

const database = { id: "db", question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] };
const languages = {
  id: "langs",
  question: "Which languages?",
  options: [{ label: "TypeScript" }, { label: "Rust" }, { label: "Go" }],
  multi: true,
};

/** The `ask` the extension registered on an omp session_start. */
async function registeredAsk(host: FakeHost): Promise<ToolDefinition> {
  await host.emit("session_start", { reason: "startup" }, ompCtx());
  const [tool] = host.registeredTools;
  if (!tool) throw new Error("no `ask` registered");
  return tool;
}

/** Calls the registered `ask` the way omp does, with a ctx whose `invokeTool` runs the fake native ask. */
function callAsk(
  tool: ToolDefinition,
  params: Record<string, unknown>,
  { native = new FakeNativeAsk(), signal, ctx = ompCtx({ invokeTool: native.invokeTool }) }: CallOptions = {},
) {
  return tool.execute("call-1", params as never, signal, undefined, ctx as never);
}

interface CallOptions {
  native?: FakeNativeAsk;
  signal?: AbortSignal;
  ctx?: unknown;
}

describe("panel answers first", () => {
  test("resolves `ask` with the native-format result and aborts the native dialog", async () => {
    const { host } = setup({ kind: "answer", answers: { "Which database?": "SQLite" } });
    const ask = await registeredAsk(host);
    const native = new FakeNativeAsk();
    const outer = new AbortController();

    const result = await callAsk(ask, { questions: [database] }, { native, signal: outer.signal });

    expect(result).toEqual({
      content: [{ type: "text", text: "User selected: SQLite" }],
      details: { question: "Which database?", options: ["Postgres", "SQLite"], multi: false, selectedOptions: ["SQLite"] },
    });
    expect(native.calls).toHaveLength(1);
    expect(native.calls[0]?.params).toEqual({ questions: [database] });
    expect(native.calls[0]?.signal?.aborted).toBe(true);
    expect(outer.signal.aborted).toBe(false);
  });

  test("resolves a multi-select question with every picked option", async () => {
    const { host } = setup({ kind: "answer", answers: { "Which languages?": "TypeScript, Go" } });
    const ask = await registeredAsk(host);

    const result = await callAsk(ask, { questions: [languages] });

    expect(result).toEqual({
      content: [{ type: "text", text: "User selected: TypeScript, Go" }],
      details: {
        question: "Which languages?",
        options: ["TypeScript", "Rust", "Go"],
        multi: true,
        selectedOptions: ["TypeScript", "Go"],
      },
    });
  });

  test("runs `agent-hook question` with the questions on stdin and CLAUDE_PROJECT_DIR set", async () => {
    const { app, host } = setup({ kind: "answer", answers: { "Which database?": "SQLite", "Which languages?": "Rust" } });
    const ask = await registeredAsk(host);
    const native = new FakeNativeAsk();

    await callAsk(ask, { questions: [database, languages] }, { native, ctx: ompCtx({ cwd: "/Users/me/project", invokeTool: native.invokeTool }) });

    const [run] = app.runs();
    expect(run?.argv).toEqual(["agent-hook", "question"]);
    expect(JSON.parse(run?.stdin ?? "")).toEqual({
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          { question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }], multiSelect: false },
          {
            question: "Which languages?",
            options: [{ label: "TypeScript" }, { label: "Rust" }, { label: "Go" }],
            multiSelect: true,
          },
        ],
      },
      session_id: "omp-session-id",
      cwd: "/Users/me/project",
    });
    expect(run?.env.CLAUDE_PROJECT_DIR).toBe("/Users/me/project");
  });

  test("sees the labels and question without the `\\r` runs native strips, and answers with them", async () => {
    const { app, host } = setup({ kind: "answer", answers: { "Which database?": "SQL ite" } });
    const ask = await registeredAsk(host);
    const native = new FakeNativeAsk();
    const params = {
      questions: [{ id: "d\rb", question: "Which\r\rdatabase?", options: [{ label: "Postgres" }, { label: "SQL\rite" }] }],
    };

    const result = await callAsk(ask, params, { native });

    expect(JSON.parse(app.runs()[0]?.stdin ?? "").tool_input.questions).toEqual([
      { question: "Which database?", options: [{ label: "Postgres" }, { label: "SQL ite" }], multiSelect: false },
    ]);
    expect(result).toEqual({
      content: [{ type: "text", text: "User selected: SQL ite" }],
      details: { question: "Which database?", options: ["Postgres", "SQL ite"], multi: false, selectedOptions: ["SQL ite"] },
    });
    // Native gets the call as the model made it; it sanitizes on its own.
    expect(native.calls[0]?.params).toEqual(params);
  });
});

/** What the native dialog returns when the user answers in the terminal. */
const nativeResult = {
  content: [{ type: "text" as const, text: "User selected: Postgres" }],
  details: { question: "Which database?", options: ["Postgres", "SQLite"], multi: false, selectedOptions: ["Postgres"] },
};

describe("native dialog answers first", () => {
  test("kills the panel request and returns the native result unchanged", async () => {
    const { app, host } = setup({ kind: "answer-on-release", answers: { "Which database?": "SQLite" } });
    const ask = await registeredAsk(host);
    const native = new FakeNativeAsk();
    const call = callAsk(ask, { questions: [database] }, { native });
    const [run] = await app.waitForRuns(1);

    native.resolve(nativeResult);

    expect(await call).toBe(nativeResult);
    await waitFor(() => !isAlive(run?.pid ?? 0), "the panel request to be killed");
  });

  test("kills the panel request and rethrows the native error unchanged", async () => {
    const { app, host } = setup({ kind: "answer-on-release", answers: { "Which database?": "SQLite" } });
    const ask = await registeredAsk(host);
    const native = new FakeNativeAsk();
    const call = callAsk(ask, { questions: [database] }, { native });
    const [run] = await app.waitForRuns(1);
    const cancelled = new ToolAbortError("Ask tool was cancelled by the user");

    native.reject(cancelled);

    await expect(call).rejects.toBe(cancelled);
    await waitFor(() => !isAlive(run?.pid ?? 0), "the panel request to be killed");
  });
});

describe("panel closes without an answer", () => {
  const noAnswer: [string, HookBehavior][] = [
    ["is dismissed or times out (prints nothing)", { kind: "silent" }],
    ["prints garbage", { kind: "print", stdout: "not json at all" }],
    ["exits non-zero", { kind: "fail" }],
  ];
  for (const [when, behavior] of noAnswer) {
    test(`the native dialog stays open and its result stands when the panel ${when}`, async () => {
      const { app, host } = setup(behavior);
      const ask = await registeredAsk(host);
      const native = new FakeNativeAsk();
      const call = callAsk(ask, { questions: [database] }, { native });
      const [run] = await app.waitForRuns(1);
      await waitFor(() => !isAlive(run?.pid ?? 0), "the panel request to exit");
      // The exit has been observed; give the extension a turn to (wrongly) settle or abort.
      await Bun.sleep(50);
      expect(native.calls[0]?.signal?.aborted).toBe(false);

      native.resolve(nativeResult);

      expect(await call).toBe(nativeResult);
    });
  }
});

describe("guards fail open to the plain native ask", () => {
  interface GuardCase {
    platform?: NodeJS.Platform;
    ctx?: (native: FakeNativeAsk) => unknown;
    params?: Record<string, unknown>;
    prepare?: (app: FakeApp) => void;
    signal?: AbortSignal;
  }
  const cases: [string, GuardCase][] = [
    ["off macOS", { platform: "linux" }],
    ...["rpc", "json", "print"].map((mode): [string, GuardCase] => [
      `in ${mode} mode`,
      { ctx: (native) => ompCtx({ mode, invokeTool: native.invokeTool }) },
    ]),
    ["in a subagent session", { ctx: (native) => ompCtx({ agentKind: "sub", invokeTool: native.invokeTool }) }],
    ["when the app is not running", { prepare: (app) => app.removeRegistryFile("app.pid") }],
    [
      "when two questions share their text",
      { params: { questions: [database, { ...languages, question: "Which database?" }] } },
    ],
    [
      "when two questions share their text once `\\r` runs are stripped",
      { params: { questions: [database, { ...languages, question: "Which\rdatabase?" }] } },
    ],
    ["when the call is already cancelled", { signal: AbortSignal.abort() }],
  ];
  for (const [when, { platform, ctx, params = { questions: [database] }, prepare, signal = new AbortController().signal }] of cases) {
    test(when, async () => {
      // A panel that would answer at once: any spawn would win the race and change the result.
      const { app, host } = setup({ kind: "answer", answers: { "Which database?": "SQLite" } }, { platform });
      prepare?.(app);
      const ask = await registeredAsk(host);
      const native = new FakeNativeAsk();
      native.resolve(nativeResult);

      const result = await callAsk(ask, params, { native, signal, ctx: ctx?.(native) });

      expect(result).toBe(nativeResult);
      expect(native.calls).toEqual([{ params, signal: undefined }]);
      // A wrongly spawned hook is a real child process; give it time to record its run.
      await Bun.sleep(NO_SPAWN_GRACE_MS);
      expect(app.runs()).toEqual([]);
    });
  }

  test("without a native `ask` to delegate to, the call fails and no panel opens", async () => {
    const { app, host } = setup({ kind: "answer", answers: { "Which database?": "SQLite" } });
    const ask = await registeredAsk(host);

    await expect(callAsk(ask, { questions: [database] }, { ctx: ompCtx() })).rejects.toThrow("no native `ask`");

    await Bun.sleep(NO_SPAWN_GRACE_MS);
    expect(app.runs()).toEqual([]);
  });
});

describe("cancellation", () => {
  async function pendingAsk({ hardKillMs }: { hardKillMs?: number } = {}) {
    const { app, host } = setup({ kind: "sleep" }, { hardKillMs });
    const ask = await registeredAsk(host);
    const native = new FakeNativeAsk();
    const outer = new AbortController();
    const call = callAsk(ask, { questions: [database] }, { native, signal: outer.signal });
    const [run] = await app.waitForRuns(1);
    if (!run) throw new Error("hook did not run");
    return { host, native, outer, call, run };
  }

  test("aborting the call kills the panel request and surfaces the native cancellation", async () => {
    const { outer, call, run } = await pendingAsk();

    outer.abort();

    await expect(call).rejects.toBeInstanceOf(ToolAbortError);
    await waitFor(() => !isAlive(run.pid), "the panel request to be killed");
  });

  test("session shutdown kills the panel request; the native dialog decides the outcome", async () => {
    const { host, native, call, run } = await pendingAsk();

    await host.emit("session_shutdown", { reason: "quit" }, ompCtx());

    await waitFor(() => !isAlive(run.pid), "the panel request to be killed");
    native.resolve(nativeResult);
    expect(await call).toBe(nativeResult);
  });

  test("the hard-kill timer stops a panel request that outlives the app's own wait", async () => {
    const { native, call, run } = await pendingAsk({ hardKillMs: 300 });

    await waitFor(() => !isAlive(run.pid), "the panel request to be killed");
    expect(native.calls[0]?.signal?.aborted).toBe(false);
    native.resolve(nativeResult);
    expect(await call).toBe(nativeResult);
  });
});
