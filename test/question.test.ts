import { describe, expect, test } from "bun:test";
import { toQuestionRequest } from "../src/question.ts";

describe("toQuestionRequest", () => {
  test("maps one question to the agent-hook question stdin, dropping preview, id and recommended", () => {
    const input = {
      questions: [
        {
          id: "storage",
          question: "Database?",
          options: [{ label: "SQLite", preview: "file based" }, { label: "Postgres" }],
          recommended: 0,
        },
      ],
    };
    expect(toQuestionRequest(input, "session-1", "/work")).toEqual({
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "Database?",
            options: [{ label: "SQLite" }, { label: "Postgres" }],
            multiSelect: false,
          },
        ],
      },
      session_id: "session-1",
      cwd: "/work",
    });
  });

  test("passes header, option descriptions and multi through", () => {
    const input = {
      questions: [
        {
          id: "features",
          question: "Which features?",
          header: "Scope",
          options: [{ label: "Auth", description: "Login and signup" }, { label: "Billing" }],
          multi: true,
        },
        { id: "go", question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }], multi: false },
      ],
    };
    expect(toQuestionRequest(input, "s", "/c")?.tool_input).toEqual({
      questions: [
        {
          question: "Which features?",
          header: "Scope",
          options: [{ label: "Auth", description: "Login and signup" }, { label: "Billing" }],
          multiSelect: true,
        },
        { question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false },
      ],
    });
  });

  test("returns nothing when two questions share the same text", () => {
    const input = {
      questions: [
        { id: "a", question: "Proceed?", options: [{ label: "Yes" }] },
        { id: "b", question: "Proceed?", options: [{ label: "No" }] },
      ],
    };
    expect(toQuestionRequest(input, "s", "/c")).toBeUndefined();
  });
});
