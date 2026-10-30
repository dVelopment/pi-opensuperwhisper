import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentEndEvent,
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { locateApp } from "./app.ts";
import { type HookProcess, runHook, type StopRequest } from "./hook.ts";
import { type AssistantMessageLike, extractText, parseReply } from "./message.ts";
import { type AskInput, parseQuestionAnswers, sanitizeAskInput, toQuestionRequest } from "./question.ts";

export interface ExtensionOptions {
  /** OpenSuperWhisper's agent registry directory (holds `app.pid` and `app.executable`). */
  agentsDir: string;
  platform: NodeJS.Platform;
  /** Safety net: kill a hook that outlives the app's own wait (30–590 s). */
  hardKillMs: number;
}

const DEFAULT_OPTIONS: ExtensionOptions = {
  agentsDir: join(homedir(), "Library", "Application Support", "fr.my-monkey.opensuperwhisper", "agents"),
  platform: process.platform,
  hardKillMs: 600_000,
};

export function createExtension(overrides: Partial<ExtensionOptions> = {}): (pi: ExtensionAPI) => void {
  const options = { ...DEFAULT_OPTIONS, ...overrides };

  /** The panel is a macOS app, and only an interactive terminal session has a user to ask. */
  function canShowPanel(ctx: ExtensionContext): boolean {
    return options.platform === "darwin" && ctx.mode === "tui";
  }

  /** Calls `kill` once the hook has outlived `hardKillMs`. Returns the function that disarms it. */
  function armHardKill(kill: () => void): () => void {
    const timer = setTimeout(kill, options.hardKillMs);
    timer.unref();
    return () => clearTimeout(timer);
  }

  return (pi) => {
    // At most one pending panel request per session. Bumping the generation orphans any reply
    // still in flight, so typed input racing a panel reply produces exactly one run.
    let pending: HookProcess | undefined;
    let generation = 0;
    /** Panel requests of `ask` calls still in flight. */
    const askHooks = new Set<HookProcess>();

    function cancelPending(): void {
      generation++;
      pending?.kill();
      pending = undefined;
    }

    /** Opens the panel for a settled run, unless a guard says the user shouldn't be asked. */
    function requestReply(ctx: ExtensionContext, message: AssistantMessageLike | undefined, sessionId: string): void {
      cancelPending();
      if (!canShowPanel(ctx)) return;
      if (!message || message.stopReason === "aborted" || message.stopReason === "error") return;
      const text = extractText(message);
      if (!text) return;
      const executable = locateApp(options.agentsDir);
      if (!executable) return;
      const request = generation;
      const stopRequest: StopRequest = {
        hook_event_name: "Stop",
        session_id: sessionId,
        cwd: ctx.cwd,
        last_assistant_message: text,
        stop_hook_active: false,
      };
      pending = runHook(executable, "stop", stopRequest);
      const disarmHardKill = armHardKill(() => {
        if (request === generation) cancelPending();
      });
      void pending.stdout.then((stdout) => {
        disarmHardKill();
        if (request !== generation) return;
        pending = undefined;
        const reply = stdout && parseReply(stdout);
        if (!reply) return;
        try {
          pi.sendUserMessage(reply);
        } catch {
          // Fail open: the session went away mid-wait. An unhandled rejection would crash a Node host.
        }
      });
    }

    // Anything that starts or replaces a run makes the panel's question outdated. Our own
    // injected reply arrives as "extension" input and must not cancel anything.
    pi.on("input", (event) => {
      if (event.source !== "extension") cancelPending();
    });
    pi.on("agent_start", cancelPending);
    pi.on("session_shutdown", () => {
      cancelPending();
      for (const hook of askHooks) hook.kill();
    });
    pi.on("session_before_switch", cancelPending);

    // pi: fires once the run is fully settled (no retry, compaction or queued continuation left).
    pi.on("agent_settled", (event, ctx) => {
      if (isOmp(ctx) || event.aborted) return;
      const messages = ctx.sessionManager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
      requestReply(ctx, lastAssistant(messages), ctx.sessionManager.getHeader()?.id ?? "");
    });

    // omp: has no settled event for extensions, so treat a terminal agent_end as settled once
    // omp has finished handling it and nothing is queued. Subagent sessions never ask the user.
    pi.on("agent_end", async (event, ctx) => {
      if (!isOmp(ctx) || ctx.agent.kind !== "main") return;
      const { messages, willContinue } = event as OmpAgentEndEvent;
      if (willContinue) return;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 0);
      await promise;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
      requestReply(ctx, lastAssistant(messages), ctx.sessionManager.getSessionId());
    });

    // omp: shadow the built-in `ask` and race its native dialog against the panel; the first
    // answer wins. pi has no built-in `ask`.
    let askRegistered = false;

    pi.on("session_start", (_event, ctx) => {
      if (askRegistered || !isOmp(ctx)) return;
      const builtin = pi.getAllTools().find((tool) => tool.name === "ask" && tool.sourceInfo.source === "builtin");
      if (!builtin) return;
      askRegistered = true;
      const ask: OmpToolDefinition = {
        name: "ask",
        description: builtin.description,
        parameters: builtin.parameters,
        // The native tool's traits (`tools/ask.ts`). Exclusive: the dialog is one shared UI
        // surface, so two concurrent asks would clobber each other.
        label: "Ask",
        approval: "read",
        strict: true,
        loadMode: "discoverable",
        concurrency: "exclusive",
        execute: (_toolCallId, params, signal, _onUpdate, toolCtx) =>
          answerAsk(params as Record<string, unknown>, signal, toolCtx as unknown as OmpToolContext),
      };
      pi.registerTool(ask);
    });

    /** Runs the native `ask`, plus the panel when a guard doesn't rule it out. */
    async function answerAsk(params: Record<string, unknown>, signal: AbortSignal | undefined, ctx: OmpToolContext) {
      if (!ctx.invokeTool) throw new Error("omp offers no native `ask` to delegate to");
      // The panel must show and answer the text native shows; native gets the call unchanged.
      const input = sanitizeAskInput(params as unknown as AskInput);
      const request =
        canShowPanel(ctx) && ctx.agent.kind === "main" && !signal?.aborted
          ? toQuestionRequest(input, ctx.sessionManager.getSessionId(), ctx.cwd)
          : undefined;
      const executable = request && locateApp(options.agentsDir);
      if (!request || !executable) return ctx.invokeTool(params);

      const abortNativeDialog = new AbortController();
      const native = ctx.invokeTool(params, {
        signal: signal ? AbortSignal.any([signal, abortNativeDialog.signal]) : abortNativeDialog.signal,
      });
      const hook = runHook(executable, "question", request);
      askHooks.add(hook);
      const kill = () => hook.kill();
      signal?.addEventListener("abort", kill, { once: true });
      const disarmHardKill = armHardKill(kill);
      try {
        // Resolves with the panel's answer, or nothing once native settled or the panel closed
        // without one. Handling native's rejection here also swallows the one the panel's win causes.
        const answer = await Promise.race([
          native.then(() => undefined, () => undefined),
          hook.stdout.then((stdout) => (stdout === undefined ? undefined : parseQuestionAnswers(stdout, input))),
        ]);
        if (answer) {
          abortNativeDialog.abort();
          return answer;
        }
        return await native;
      } finally {
        disarmHardKill();
        signal?.removeEventListener("abort", kill);
        askHooks.delete(hook);
        hook.kill();
      }
    }
  };
}

/** omp-only members of the extension API (checked against oh-my-pi 18.12.6). pi has none of them. */
interface OmpContext extends ExtensionContext {
  getAsyncJobSnapshot(): unknown;
  agent: { kind: "main" | "sub" };
}

/** The `ctx` omp passes to a tool that re-registers a built-in: `invokeTool` runs the native one. */
interface OmpToolContext extends OmpContext {
  invokeTool?(params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<AgentToolResult<unknown>>;
}

/** omp-only tool traits (`extensibility/extensions/types.ts`, proxied by `RegisteredToolAdapter`). */
interface OmpToolDefinition extends ToolDefinition {
  approval: "read";
  strict: boolean;
  loadMode: "discoverable";
  concurrency: "exclusive";
}

interface OmpAgentEndEvent extends AgentEndEvent {
  /** True when omp will continue on its own (retry, compaction recovery, reminders, async wakes). */
  willContinue?: boolean;
}

/** Detects the host from its API, not the JS runtime: pi can run under Bun too. */
function isOmp(ctx: ExtensionContext): ctx is OmpContext {
  return typeof (ctx as Partial<OmpContext>).getAsyncJobSnapshot === "function";
}

function lastAssistant(messages: readonly { role: string }[]): AssistantMessageLike | undefined {
  return messages.findLast((message): message is AssistantMessageLike => message.role === "assistant");
}

export default createExtension();
