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

/** One answered question, as native `ask` reports it in `details.results` (`AskToolDetails`). */
export interface QuestionResult {
  id: string;
  question: string;
  options: string[];
  multi: boolean;
  selectedOptions: string[];
  customInput?: string;
}

/** The `ask` tool result: one question puts its answer in `details`, several in `details.results`. */
export interface AskResult {
  content: [{ type: "text"; text: string }];
  details: Partial<Omit<QuestionResult, "id">> & { results?: QuestionResult[] };
}

/**
 * Maps the stdout of `agent-hook question` to the result omp's native `ask` returns for the same
 * selections (`tools/ask.ts` at v18.12.6). Returns nothing unless the panel allowed the call with
 * an answer for every question: dismissed, timed out, empty or malformed output.
 */
export function parseQuestionAnswers(stdout: string, input: AskInput): AskResult | undefined {
  const answers = readAnswers(stdout);
  if (answers === undefined) return undefined;
  const results: QuestionResult[] = [];
  for (const q of input.questions) {
    const answer = answers[q.question];
    if (typeof answer !== "string" || answer === "") return undefined;
    results.push(toResult(q, answer));
  }
  const [only] = results;
  if (only !== undefined && results.length === 1) {
    const { id: _, ...details } = only;
    return { content: [{ type: "text", text: formatSingleQuestionResponse(only) }], details };
  }
  return {
    content: [{ type: "text", text: `User answers:\n${results.map(formatQuestionResult).join("\n")}` }],
    details: { results },
  };
}

/** The parts of `agent-hook question` stdout this extension reads; any of them may be missing or wrong. */
interface HookOutput {
  hookSpecificOutput?: { permissionDecision?: unknown; updatedInput?: { answers?: unknown } };
}

/** The `updatedInput.answers` of an allowed `agent-hook question` call, keyed by question text. */
function readAnswers(stdout: string): Record<string, unknown> | undefined {
  let output: HookOutput | null;
  try {
    output = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const hook = output?.hookSpecificOutput;
  if (hook?.permissionDecision !== "allow") return undefined;
  const answers = hook.updatedInput?.answers;
  return typeof answers === "object" && answers !== null ? (answers as Record<string, unknown>) : undefined;
}

/**
 * The panel answers with one label, the picked labels joined with ", " in option order
 * (multi-select), or free text. Anything that isn't a label (or labels) is custom input.
 */
function toResult(q: AskQuestion, answer: string): QuestionResult {
  const labels = q.options.map((o) => o.label);
  const multi = q.multi ?? false;
  const selected = labels.includes(answer) ? [answer] : multi ? splitLabels(answer, labels, 0) : undefined;
  const base = { id: q.id, question: q.question, options: labels, multi };
  return selected === undefined
    ? { ...base, selectedOptions: [], customInput: answer }
    : { ...base, selectedOptions: selected };
}

/** Labels from `labels[from..]`, in order, whose ", "-join is `value`; labels may contain ", " themselves. */
function splitLabels(value: string, labels: string[], from: number): string[] | undefined {
  for (let i = from; i < labels.length; i++) {
    const label = labels[i] as string;
    if (value === label) return [label];
    if (!value.startsWith(`${label}, `)) continue;
    const rest = splitLabels(value.slice(label.length + 2), labels, i + 1);
    if (rest !== undefined) return [label, ...rest];
  }
  return undefined;
}

// The two formatters mirror omp's `tools/ask.ts` (v18.12.6) for the answers the panel can give:
// picked labels or custom input, never both, and no note or timeout.

function formatQuestionResult(result: QuestionResult): string {
  if (result.customInput !== undefined) return `${result.id}: "${result.customInput}"`;
  const picked = result.multi ? `[${result.selectedOptions.join(", ")}]` : result.selectedOptions[0];
  return `${result.id}: ${picked}`;
}

function formatSingleQuestionResponse(result: QuestionResult): string {
  if (result.customInput === undefined) {
    return result.multi
      ? `User selected: ${result.selectedOptions.join(", ")}`
      : `User selected: ${result.selectedOptions[0]}`;
  }
  return result.customInput.includes("\n")
    ? `User provided custom input:\n${result.customInput
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n")}`
    : `User provided custom input: ${result.customInput}`;
}
