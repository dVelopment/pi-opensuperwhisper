import { describe, expect, test } from "bun:test";
import { extractText, parseReply } from "../src/message.ts";

const PREFIX = "The user answered by voice, through OpenSuperWhisper:\n\n";

function reply(reason: unknown, decision: unknown = "block"): string {
  return JSON.stringify({ decision, reason });
}

describe("parseReply", () => {
  test("returns the reply text with the panel prefix stripped", () => {
    expect(parseReply(reply(`${PREFIX}Ship it.`))).toBe("Ship it.");
  });

  test("returns the whole reason when the prefix is missing", () => {
    expect(parseReply(reply("Ship it."))).toBe("Ship it.");
  });

  test("tolerates a trailing newline after the JSON", () => {
    expect(parseReply(`${reply(`${PREFIX}Ship it.`)}\n`)).toBe("Ship it.");
  });

  test("keeps multi-line replies intact", () => {
    expect(parseReply(reply(`${PREFIX}First line.\n\nSecond line.`))).toBe("First line.\n\nSecond line.");
  });

  test("returns nothing for an empty reason", () => {
    expect(parseReply(reply(""))).toBeUndefined();
  });

  test("returns nothing when only the prefix is left", () => {
    expect(parseReply(reply(PREFIX))).toBeUndefined();
  });

  test("returns nothing for a non-string reason", () => {
    expect(parseReply(reply(42))).toBeUndefined();
  });

  test("returns nothing for empty stdout", () => {
    expect(parseReply("")).toBeUndefined();
  });

  test("returns nothing for non-JSON stdout", () => {
    expect(parseReply("panic: something went wrong")).toBeUndefined();
  });

  test("returns nothing for a decision other than block", () => {
    expect(parseReply(reply(`${PREFIX}Ship it.`, "approve"))).toBeUndefined();
  });

  test("returns nothing for JSON that is not an object", () => {
    expect(parseReply("null")).toBeUndefined();
    expect(parseReply('"block"')).toBeUndefined();
  });
});

describe("extractText", () => {
  test("returns the text of an assistant message, trimmed", () => {
    const message = { role: "assistant", content: [{ type: "text", text: "  All done.\n" }] };
    expect(extractText(message)).toBe("All done.");
  });

  test("joins several text blocks with a blank line", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "First." },
        { type: "text", text: "Second." },
      ],
    };
    expect(extractText(message)).toBe("First.\n\nSecond.");
  });

  test("leaves out thinking, tool-call and image blocks", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Let me think." },
        { type: "text", text: "Here is the plan." },
        { type: "toolCall", id: "1", name: "bash", arguments: { command: "ls" } },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "text", text: "Ready when you are." },
      ],
    };
    expect(extractText(message)).toBe("Here is the plan.\n\nReady when you are.");
  });

  test("returns nothing when there are no text blocks", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Hmm." },
        { type: "toolCall", id: "1", name: "bash", arguments: {} },
      ],
    };
    expect(extractText(message)).toBeUndefined();
  });

  test("returns nothing when the text is only whitespace", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "  \n" },
        { type: "text", text: "\t" },
      ],
    };
    expect(extractText(message)).toBeUndefined();
  });

  test("returns nothing for an empty content list", () => {
    expect(extractText({ role: "assistant", content: [] })).toBeUndefined();
  });
});
