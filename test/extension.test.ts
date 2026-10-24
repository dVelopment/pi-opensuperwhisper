import { afterEach, describe, expect, test } from "bun:test";
import { createExtension } from "../src/index.ts";
import { assistant, FakeApp, FakeHost, type HookBehavior, isAlive, NO_SPAWN_GRACE_MS, piCtx, user, waitFor } from "./harness.ts";

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
