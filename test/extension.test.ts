import { afterEach, describe, expect, test } from "bun:test";
import { createExtension } from "../src/index.ts";
import {
  assistant,
  FakeApp,
  FakeHost,
  type HookBehavior,
  isAlive,
  NO_SPAWN_GRACE_MS,
  ompCtx,
  piCtx,
  user,
  waitFor,
} from "./harness.ts";

const apps: FakeApp[] = [];
const hosts: FakeHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.emit("session_shutdown", { reason: "quit" }, piCtx([]));
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

describe("pi: agent_settled", () => {
  test("a panel reply becomes the next user message, without the panel prefix", async () => {
    const { host } = setup({ kind: "reply", text: "Yes, ship it." });

    await host.emit("agent_settled", { aborted: false }, piCtx([user("Ready?"), assistant("Shall I ship it?")]));

    await host.waitForSent(1);
    expect(host.sent).toEqual([{ content: "Yes, ship it.", options: undefined }]);
  });

  test("the settle handler returns while the panel is still waiting", async () => {
    const { app, host } = setup({ kind: "sleep" });

    await host.emit("agent_settled", { aborted: false }, piCtx([assistant("Shall I ship it?")]));

    const [run] = await app.waitForRuns(1);
    expect(isAlive(run?.pid ?? 0)).toBe(true);
    expect(host.sent).toEqual([]);
  });
});

/** Fires a settle that would open the panel if every other condition holds. */
async function settle(host: FakeHost) {
  await host.emit("agent_settled", { aborted: false }, piCtx([user("Ready?"), assistant("Shall I ship it?")]));
}

async function expectNoSpawn(app: FakeApp, host: FakeHost) {
  // A wrongly spawned hook is a real child process; give it time to record its run.
  await Bun.sleep(NO_SPAWN_GRACE_MS);
  expect(app.runs()).toEqual([]);
  expect(host.sent).toEqual([]);
}

describe("app discovery", () => {
  test("spawns the hook when the app pid is alive and the executable is runnable", async () => {
    const { app, host } = setup();
    await settle(host);
    expect(await app.waitForRuns(1)).toHaveLength(1);
  });

  test("treats a pid it may not signal (EPERM) as alive", async () => {
    const { app, host } = setup();
    app.writePid("1"); // launchd: alive, owned by root
    await settle(host);
    expect(await app.waitForRuns(1)).toHaveLength(1);
  });

  test("tolerates whitespace around the registry values", async () => {
    const { app, host } = setup();
    app.writePid(` ${process.pid}\n`);
    await settle(host);
    expect(await app.waitForRuns(1)).toHaveLength(1);
  });

  for (const name of ["app.pid", "app.executable"] as const) {
    test(`does nothing when ${name} is missing`, async () => {
      const { app, host } = setup();
      app.removeRegistryFile(name);
      await settle(host);
      await expectNoSpawn(app, host);
    });
  }

  for (const pid of ["", "not-a-pid", "0", "-1", "12abc", "1.5"]) {
    test(`does nothing when app.pid is malformed (${JSON.stringify(pid)})`, async () => {
      const { app, host } = setup();
      app.writePid(pid);
      await settle(host);
      await expectNoSpawn(app, host);
    });
  }

  test("does nothing when the app pid is dead", async () => {
    const { app, host } = setup();
    const exited = Bun.spawnSync(["true"]);
    app.writePid(String(exited.pid));
    await settle(host);
    await expectNoSpawn(app, host);
  });

  test("does nothing when the executable does not exist", async () => {
    const { app, host } = setup();
    app.pointExecutableAt(`${app.dir}/missing-agent-hook`);
    await settle(host);
    await expectNoSpawn(app, host);
  });

  test("does nothing when the executable is not executable", async () => {
    const { app, host } = setup();
    app.setBehavior({ kind: "reply", text: "unreachable" }, { executable: false });
    await settle(host);
    await expectNoSpawn(app, host);
  });

  test("does nothing when the executable path is a directory", async () => {
    const { app, host } = setup();
    app.pointExecutableAt(app.agentsDir);
    await settle(host);
    await expectNoSpawn(app, host);
  });
});

describe("Stop request contract", () => {
  test("runs `agent-hook stop` with the Stop JSON on stdin and CLAUDE_PROJECT_DIR set", async () => {
    process.env.PI_OSW_TEST_INHERITED = "yes";
    const { app, host } = setup();

    await host.emit(
      "agent_settled",
      { aborted: false },
      piCtx([user("Ready?"), assistant("Shall I ship it?")], { cwd: "/Users/me/project" }),
    );

    const [run] = await app.waitForRuns(1);
    expect(run?.argv).toEqual(["agent-hook", "stop"]);
    expect(JSON.parse(run?.stdin ?? "")).toEqual({
      hook_event_name: "Stop",
      session_id: "pi-session-id",
      cwd: "/Users/me/project",
      last_assistant_message: "Shall I ship it?",
      stop_hook_active: false,
    });
    expect(run?.env.CLAUDE_PROJECT_DIR).toBe("/Users/me/project");
    expect(run?.env.PI_OSW_TEST_INHERITED).toBe("yes");
  });

  test("sends only the visible text of the last assistant message", async () => {
    const { app, host } = setup();
    const last = {
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "Done." },
        { type: "toolCall", id: "1", name: "bash", arguments: {} },
        { type: "text", text: "Anything else?" },
      ],
    };

    await host.emit("agent_settled", { aborted: false }, piCtx([assistant("Earlier answer."), user("More"), last]));

    const [run] = await app.waitForRuns(1);
    expect(JSON.parse(run?.stdin ?? "").last_assistant_message).toBe("Done.\n\nAnything else?");
  });
});

describe("hook outcomes", () => {
  test("a reply without the panel prefix is delivered whole", async () => {
    const { host } = setup({ kind: "print", stdout: JSON.stringify({ decision: "block", reason: "Plain reply" }) });
    await settle(host);
    await host.waitForSent(1);
    expect(host.sent.map((call) => call.content)).toEqual(["Plain reply"]);
  });

  const nothingDelivered: [string, HookBehavior][] = [
    ["prints nothing (dismissed or timed out)", { kind: "silent" }],
    ["prints garbage", { kind: "print", stdout: "not json at all" }],
    ["prints a non-block decision", { kind: "print", stdout: JSON.stringify({ decision: "approve", reason: "x" }) }],
    ["exits non-zero, even with a reply on stdout", { kind: "fail" }],
  ];
  for (const [when, behavior] of nothingDelivered) {
    test(`nothing is delivered when the hook ${when}`, async () => {
      const { app, host } = setup(behavior);
      await settle(host);
      const [run] = await app.waitForRuns(1);
      await waitFor(() => !isAlive(run?.pid ?? 0), "the hook to exit");
      // The exit has been observed; give the extension's close handler a turn to (wrongly) deliver.
      await Bun.sleep(50);
      expect(host.sent).toEqual([]);
    });
  }
});

describe("guards", () => {
  test("does nothing off macOS", async () => {
    const { app, host } = setup({ kind: "reply", text: "unreachable" }, { platform: "linux" });
    await settle(host);
    await expectNoSpawn(app, host);
  });

  for (const mode of ["rpc", "json", "print"]) {
    test(`does nothing in ${mode} mode`, async () => {
      const { app, host } = setup({ kind: "reply", text: "unreachable" });
      await host.emit("agent_settled", { aborted: false }, piCtx([assistant("Done.")], { mode }));
      await expectNoSpawn(app, host);
    });
  }

  test("does nothing after a pi run was aborted", async () => {
    const { app, host } = setup({ kind: "reply", text: "unreachable" });
    await host.emit("agent_settled", { aborted: true }, piCtx([assistant("Partial answer", "aborted")]));
    await expectNoSpawn(app, host);
  });

  test("does nothing after a pi run ended in an error", async () => {
    const { app, host } = setup({ kind: "reply", text: "unreachable" });
    await host.emit("agent_settled", { aborted: false }, piCtx([assistant("Provider error: overloaded", "error")]));
    await expectNoSpawn(app, host);
  });

  test("does nothing when the last assistant message has no text", async () => {
    const { app, host } = setup({ kind: "reply", text: "unreachable" });
    const toolOnly = {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "thinking", thinking: "Let me check." },
        { type: "toolCall", id: "1", name: "bash", arguments: {} },
      ],
    };
    await host.emit("agent_settled", { aborted: false }, piCtx([assistant("Earlier text."), toolOnly]));
    await expectNoSpawn(app, host);
  });

  test("does nothing when the last assistant text is only whitespace", async () => {
    const { app, host } = setup({ kind: "reply", text: "unreachable" });
    await host.emit("agent_settled", { aborted: false }, piCtx([assistant(" \n\t")]));
    await expectNoSpawn(app, host);
  });

  test("does nothing when the branch has no assistant message", async () => {
    const { app, host } = setup({ kind: "reply", text: "unreachable" });
    await host.emit("agent_settled", { aborted: false }, piCtx([user("Hello?")]));
    await expectNoSpawn(app, host);
  });
});

describe("omp: agent_end", () => {
  const runMessages = [user("Ready?"), assistant("Shall I ship it?")];

  test("an omp-shaped ctx on a terminal agent_end opens the panel and delivers the reply", async () => {
    const { app, host } = setup({ kind: "reply", text: "Ship it." });

    await host.emit("agent_end", { messages: runMessages }, ompCtx({ cwd: "/Users/me/omp-project" }));

    const [run] = await app.waitForRuns(1);
    expect(JSON.parse(run?.stdin ?? "")).toEqual({
      hook_event_name: "Stop",
      session_id: "omp-session-id",
      cwd: "/Users/me/omp-project",
      last_assistant_message: "Shall I ship it?",
      stop_hook_active: false,
    });
    await host.waitForSent(1);
    expect(host.sent.map((call) => call.content)).toEqual(["Ship it."]);
  });

  test("does nothing when omp will continue on its own", async () => {
    const { app, host } = setup();
    await host.emit("agent_end", { messages: runMessages, willContinue: true }, ompCtx());
    await expectNoSpawn(app, host);
  });

  test("does nothing when omp is not idle", async () => {
    const { app, host } = setup();
    await host.emit("agent_end", { messages: runMessages }, ompCtx({ idle: false }));
    await expectNoSpawn(app, host);
  });

  test("does nothing when omp has pending messages", async () => {
    const { app, host } = setup();
    await host.emit("agent_end", { messages: runMessages }, ompCtx({ pendingMessages: true }));
    await expectNoSpawn(app, host);
  });

  test("checks idleness after omp has finished handling agent_end", async () => {
    const { app, host } = setup();
    const ctx = ompCtx();
    const ended = host.emit("agent_end", { messages: runMessages }, ctx);
    // omp queues a follow-up right after emitting the extension agent_end.
    ctx.hasPendingMessages = () => true;
    await ended;
    await expectNoSpawn(app, host);
  });

  for (const stopReason of ["aborted", "error"]) {
    test(`does nothing when the run's last assistant message stopped with "${stopReason}"`, async () => {
      const { app, host } = setup();
      await host.emit("agent_end", { messages: [user("Go"), assistant("Partial", stopReason)] }, ompCtx());
      await expectNoSpawn(app, host);
    });
  }

  test("does nothing in an omp subagent session", async () => {
    const { app, host } = setup();
    await host.emit("agent_end", { messages: runMessages }, ompCtx({ agentKind: "sub" }));
    await expectNoSpawn(app, host);
  });

  test("does nothing in omp rpc mode", async () => {
    const { app, host } = setup();
    await host.emit("agent_end", { messages: runMessages }, ompCtx({ mode: "rpc" }));
    await expectNoSpawn(app, host);
  });
});

describe("host detection", () => {
  test("a pi-shaped ctx on agent_end is ignored", async () => {
    const { app, host } = setup();
    await host.emit("agent_end", { messages: [user("Ready?"), assistant("Shall I ship it?")] }, piCtx([]));
    await expectNoSpawn(app, host);
  });

  test("an omp-shaped ctx on agent_settled is ignored", async () => {
    const { app, host } = setup();
    const pi = piCtx([assistant("Shall I ship it?")]);
    const omp = ompCtx();
    const ctx = { ...omp, sessionManager: { ...pi.sessionManager, ...omp.sessionManager } };
    await host.emit("agent_settled", { aborted: false }, ctx);
    await expectNoSpawn(app, host);
  });
});

describe("cancellation", () => {
  async function pendingHook(behavior: HookBehavior = { kind: "sleep" }, options?: Parameters<typeof setup>[1]) {
    const { app, host } = setup(behavior, options);
    await settle(host);
    const [run] = await app.waitForRuns(1);
    if (!run) throw new Error("hook did not run");
    return { app, host, run };
  }

  async function expectKilledWithoutReply(host: FakeHost, pid: number) {
    await waitFor(() => !isAlive(pid), "the hook to be killed");
    // The exit has been observed; give the extension's close handler a turn to (wrongly) deliver.
    await Bun.sleep(50);
    expect(host.sent).toEqual([]);
  }

  for (const source of ["interactive", "rpc"]) {
    test(`${source} input kills the pending hook and lets the input through`, async () => {
      const { host, run } = await pendingHook();
      const results = await host.emit("input", { text: "typed instead", source }, piCtx([]));
      expect(results.every((result) => result === undefined)).toBe(true);
      await expectKilledWithoutReply(host, run.pid);
    });
  }

  test("a reply that lands as the user types is dropped, so exactly one run happens", async () => {
    const { host, run } = await pendingHook({ kind: "reply-on-term", text: "too late" });
    await host.emit("input", { text: "typed instead", source: "interactive" }, piCtx([]));
    await expectKilledWithoutReply(host, run.pid);
  });

  test("our own injected reply (extension input) does not cancel the pending hook", async () => {
    const { app, host } = await pendingHook({ kind: "reply-on-release", text: "Still wanted." });
    await host.emit("input", { text: "from another extension", source: "extension" }, piCtx([]));
    app.release();
    await host.waitForSent(1);
    expect(host.sent.map((call) => call.content)).toEqual(["Still wanted."]);
  });

  test("a new run (agent_start) kills the pending hook", async () => {
    const { host, run } = await pendingHook({ kind: "reply-on-term", text: "outdated" });
    await host.emit("agent_start", {}, piCtx([]));
    await expectKilledWithoutReply(host, run.pid);
  });

  test("session shutdown kills the pending hook", async () => {
    const { host, run } = await pendingHook({ kind: "reply-on-term", text: "orphan" });
    await host.emit("session_shutdown", { reason: "quit" }, piCtx([]));
    await expectKilledWithoutReply(host, run.pid);
  });

  test("switching sessions kills the pending hook without blocking the switch", async () => {
    const { host, run } = await pendingHook({ kind: "reply-on-term", text: "wrong session" });
    const results = await host.emit("session_before_switch", { reason: "new" }, piCtx([]));
    expect(results.every((result) => result === undefined)).toBe(true);
    await expectKilledWithoutReply(host, run.pid);
  });

  test("a second settle replaces the pending hook", async () => {
    const { app, host, run: first } = await pendingHook({ kind: "reply-on-term", text: "from the first panel" });

    await host.emit("agent_settled", { aborted: false }, piCtx([user("And now?"), assistant("Second question?")]));

    const runs = await app.waitForRuns(2);
    const second = runs.find((run) => run.pid !== first.pid);
    expect(JSON.parse(second?.stdin ?? "").last_assistant_message).toBe("Second question?");
    await expectKilledWithoutReply(host, first.pid);
    expect(isAlive(second?.pid ?? 0)).toBe(true);
  });

  test("the hard-kill timer stops a hook that outlives the app's own wait", async () => {
    // Long enough for the fake hook to record its run before the timer fires.
    const { host, run } = await pendingHook({ kind: "reply-on-term", text: "hung" }, { hardKillMs: 500 });
    await expectKilledWithoutReply(host, run.pid);
  });

  test("a delivered reply leaves nothing to cancel", async () => {
    const { app, host } = setup({ kind: "reply", text: "Go on." });
    await settle(host);
    await host.waitForSent(1);
    await host.emit("input", { text: "Go on.", source: "extension" }, piCtx([]));
    await host.emit("agent_start", {}, piCtx([]));
    expect(host.sent.map((call) => call.content)).toEqual(["Go on."]);
    expect(app.runs()).toHaveLength(1);
  });
});
