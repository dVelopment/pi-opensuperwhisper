/** The parts of an omp `ask` call this extension reads (`tools/ask.ts` input schema). */
export interface AskInput {
  questions: AskQuestion[];
}

export interface AskQuestion {
  id: string;
  question: string;
  header?: string;
  options: { label: string; description?: string; preview?: string }[];
  multi?: boolean;
  recommended?: number;
}

/** What `agent-hook question` reads on stdin: a Claude Code `AskUserQuestion` PreToolUse call. */
export interface QuestionRequest {
  hook_event_name: "PreToolUse";
  tool_name: "AskUserQuestion";
  tool_input: { questions: PanelQuestion[] };
  session_id: string;
  cwd: string;
}

interface PanelQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
}

/**
 * Maps an `ask` call to the stdin of `agent-hook question`. Returns nothing when the panel
 * can't represent the call: it keys answers by question text, so two questions with the same
 * text can't be told apart.
 */
export function toQuestionRequest(input: AskInput, sessionId: string, cwd: string): QuestionRequest | undefined {
  const texts = new Set(input.questions.map((q) => q.question));
  if (texts.size !== input.questions.length) return undefined;
  return {
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_input: {
      questions: input.questions.map((q) => ({
        question: q.question,
        ...(q.header === undefined ? {} : { header: q.header }),
        options: q.options.map((o) => ({
          label: o.label,
          ...(o.description === undefined ? {} : { description: o.description }),
        })),
        multiSelect: q.multi ?? false,
      })),
    },
    session_id: sessionId,
    cwd,
  };
}
