/** The parts of a pi/omp assistant message this extension reads. */
export interface AssistantMessageLike {
  role: string;
  content?: unknown;
  stopReason?: string;
}

/**
 * Returns the visible text of an assistant message: its text blocks joined by a blank line,
 * trimmed. Thinking, tool-call and image blocks are left out. Returns nothing when no text is left.
 */
export function extractText(message: AssistantMessageLike): string | undefined {
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter((text) => text !== "")
    .join("\n\n");
  return text === "" ? undefined : text;
}

const REPLY_PREFIX = "The user answered by voice, through OpenSuperWhisper:\n\n";

/**
 * Parses the stdout of `agent-hook stop`. Returns the user's reply, or nothing when the
 * panel was dismissed, timed out, or printed anything other than a block decision.
 */
export function parseReply(stdout: string): string | undefined {
  let output: unknown;
  try {
    output = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof output !== "object" || output === null) return undefined;
  const { decision, reason } = output as { decision?: unknown; reason?: unknown };
  if (decision !== "block" || typeof reason !== "string") return undefined;
  const text = reason.startsWith(REPLY_PREFIX) ? reason.slice(REPLY_PREFIX.length) : reason;
  return text.trim() === "" ? undefined : text;
}
