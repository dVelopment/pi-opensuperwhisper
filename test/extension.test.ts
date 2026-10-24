import { afterEach, describe, expect, test } from "bun:test";
import { createExtension } from "../src/index.ts";
import { assistant, FakeApp, FakeHost, type HookBehavior, NO_SPAWN_GRACE_MS, piCtx, user } from "./harness.ts";

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
