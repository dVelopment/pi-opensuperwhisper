import { afterEach, describe, expect, test } from "bun:test";
import { runHook } from "../src/hook.ts";
import type { QuestionRequest } from "../src/question.ts";
import { FakeApp, type HookBehavior, questionAnswerStdout } from "./harness.ts";

const apps: FakeApp[] = [];

afterEach(() => {
  for (const app of apps.splice(0)) app.cleanup();
});

function fakeApp(behavior: HookBehavior): FakeApp {
  const app = new FakeApp(behavior);
  apps.push(app);
  return app;
}

const questionRequest: QuestionRequest = {
  hook_event_name: "PreToolUse",
  tool_name: "AskUserQuestion",
  tool_input: {
    questions: [{ question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }], multiSelect: false }],
  },
  session_id: "omp-session-id",
  cwd: "/Users/me/project",
};

describe("runHook", () => {
  test("runs `agent-hook question` with the request on stdin and returns the panel's answer", async () => {
    const app = fakeApp({ kind: "answer", answers: { "Which database?": "SQLite" } });

    const hook = runHook(app.executable, "question", questionRequest);

    expect(await hook.stdout).toBe(questionAnswerStdout({ "Which database?": "SQLite" }));
    const [run] = app.runs();
    expect(run?.argv).toEqual(["agent-hook", "question"]);
    expect(JSON.parse(run?.stdin ?? "")).toEqual(questionRequest);
    expect(run?.env.CLAUDE_PROJECT_DIR).toBe("/Users/me/project");
  });

  test("a question answer can be held back until the test releases it", async () => {
    const app = fakeApp({ kind: "answer-on-release", answers: { "Which database?": "Postgres" } });
    const hook = runHook(app.executable, "question", questionRequest);
    let settled = false;
    void hook.stdout.then(() => {
      settled = true;
    });

    await app.waitForRuns(1);
    expect(settled).toBe(false);
    app.release();

    expect(await hook.stdout).toBe(questionAnswerStdout({ "Which database?": "Postgres" }));
  });

  test("only accepts the request its event reads (checked by tsc)", () => {
    // @ts-expect-error `agent-hook stop` reads a Stop payload, not a question request.
    const mismatched = () => runHook("agent-hook", "stop", questionRequest);
    expect(mismatched).toBeFunction();
  });
});
