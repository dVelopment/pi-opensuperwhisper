import { describe, expect, test } from "bun:test";
import { parseQuestionAnswers, toQuestionRequest } from "../src/question.ts";

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

const storage = {
  id: "storage",
  question: "Database?",
  options: [{ label: "SQLite" }, { label: "Postgres", description: "Server" }],
};
const features = {
  id: "features",
  question: "Which features?",
  options: [{ label: "Auth" }, { label: "Red, white" }, { label: "Billing" }],
  multi: true,
};
const notes = { id: "notes", question: "Anything else?", options: [{ label: "No" }] };

/** The stdout `agent-hook question` prints for an answered panel. */
function allow(answers: Record<string, unknown>, questions: unknown[] = []): string {
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { questions, answers },
    },
  })}\n`;
}

describe("parseQuestionAnswers", () => {
  test("single select matches native ask", () => {
    expect(parseQuestionAnswers(allow({ "Database?": "Postgres" }), { questions: [storage] })).toEqual({
      content: [{ type: "text", text: "User selected: Postgres" }],
      details: { question: "Database?", options: ["SQLite", "Postgres"], multi: false, selectedOptions: ["Postgres"] },
    });
  });

  test("multi select splits the joined labels", () => {
    expect(parseQuestionAnswers(allow({ "Which features?": "Auth, Billing" }), { questions: [features] })).toEqual({
      content: [{ type: "text", text: "User selected: Auth, Billing" }],
      details: {
        question: "Which features?",
        options: ["Auth", "Red, white", "Billing"],
        multi: true,
        selectedOptions: ["Auth", "Billing"],
      },
    });
  });

  test("multi select keeps a label that contains a comma whole", () => {
    const result = parseQuestionAnswers(allow({ "Which features?": "Red, white" }), { questions: [features] });
    expect(result?.content).toEqual([{ type: "text", text: "User selected: Red, white" }]);
    expect(result?.details.selectedOptions).toEqual(["Red, white"]);
  });

  test("multi select finds a comma label among other picks", () => {
    const result = parseQuestionAnswers(allow({ "Which features?": "Auth, Red, white, Billing" }), {
      questions: [features],
    });
    expect(result?.content).toEqual([{ type: "text", text: "User selected: Auth, Red, white, Billing" }]);
    expect(result?.details.selectedOptions).toEqual(["Auth", "Red, white", "Billing"]);
  });

  test("multi select value that is not all labels becomes custom input", () => {
    expect(parseQuestionAnswers(allow({ "Which features?": "Auth, Search" }), { questions: [features] })).toEqual({
      content: [{ type: "text", text: "User provided custom input: Auth, Search" }],
      details: {
        question: "Which features?",
        options: ["Auth", "Red, white", "Billing"],
        multi: true,
        selectedOptions: [],
        customInput: "Auth, Search",
      },
    });
  });

  test("free text becomes custom input", () => {
    expect(parseQuestionAnswers(allow({ "Database?": "MySQL please" }), { questions: [storage] })).toEqual({
      content: [{ type: "text", text: "User provided custom input: MySQL please" }],
      details: {
        question: "Database?",
        options: ["SQLite", "Postgres"],
        multi: false,
        selectedOptions: [],
        customInput: "MySQL please",
      },
    });
  });

  test("multi-line free text is indented like native ask", () => {
    const result = parseQuestionAnswers(allow({ "Database?": "MySQL\nor MariaDB" }), { questions: [storage] });
    expect(result?.content).toEqual([{ type: "text", text: "User provided custom input:\n  MySQL\n  or MariaDB" }]);
  });

  test("several questions produce the native answers list", () => {
    const stdout = allow({
      "Database?": "SQLite",
      "Which features?": "Auth, Billing",
      "Anything else?": "Use tabs",
    });
    expect(parseQuestionAnswers(stdout, { questions: [storage, features, notes] })).toEqual({
      content: [
        {
          type: "text",
          text: 'User answers:\nstorage: SQLite\nfeatures: [Auth, Billing]\nnotes: "Use tabs"',
        },
      ],
      details: {
        results: [
          {
            id: "storage",
            question: "Database?",
            options: ["SQLite", "Postgres"],
            multi: false,
            selectedOptions: ["SQLite"],
          },
          {
            id: "features",
            question: "Which features?",
            options: ["Auth", "Red, white", "Billing"],
            multi: true,
            selectedOptions: ["Auth", "Billing"],
          },
          {
            id: "notes",
            question: "Anything else?",
            options: ["No"],
            multi: false,
            selectedOptions: [],
            customInput: "Use tabs",
          },
        ],
      },
    });
  });

  test("returns nothing for empty, non-JSON or non-object stdout", () => {
    const input = { questions: [storage] };
    expect(parseQuestionAnswers("", input)).toBeUndefined();
    expect(parseQuestionAnswers("panic: boom", input)).toBeUndefined();
    expect(parseQuestionAnswers("null", input)).toBeUndefined();
    expect(parseQuestionAnswers("[]", input)).toBeUndefined();
  });

  test("returns nothing unless the decision is allow", () => {
    const denied = JSON.stringify({
      hookSpecificOutput: { permissionDecision: "deny", updatedInput: { answers: { "Database?": "SQLite" } } },
    });
    expect(parseQuestionAnswers(denied, { questions: [storage] })).toBeUndefined();
    expect(parseQuestionAnswers(JSON.stringify({ decision: "block" }), { questions: [storage] })).toBeUndefined();
  });

  test("returns nothing when answers are missing, partial or not strings", () => {
    const input = { questions: [storage, notes] };
    const noAnswers = JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow", updatedInput: {} } });
    expect(parseQuestionAnswers(noAnswers, input)).toBeUndefined();
    expect(parseQuestionAnswers(allow({ "Database?": "SQLite" }), input)).toBeUndefined();
    expect(parseQuestionAnswers(allow({ "Database?": "SQLite", "Anything else?": 3 }), input)).toBeUndefined();
    expect(parseQuestionAnswers(allow({ "Database?": "SQLite", "Anything else?": "" }), input)).toBeUndefined();
  });
});
