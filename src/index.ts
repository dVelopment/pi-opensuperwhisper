import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { locateApp } from "./app.ts";
import { runStopHook } from "./hook.ts";
import { type AssistantMessageLike, extractText, parseReply } from "./message.ts";

export interface ExtensionOptions {
  /** OpenSuperWhisper's agent registry directory (holds `app.pid` and `app.executable`). */
  agentsDir: string;
  platform: NodeJS.Platform;
  /** Safety net: kill a hook that outlives the app's own maximum wait (590 s). */
  hardKillMs: number;
}

const DEFAULT_OPTIONS: ExtensionOptions = {
  agentsDir: join(homedir(), "Library", "Application Support", "fr.my-monkey.opensuperwhisper", "agents"),
  platform: process.platform,
  hardKillMs: 600_000,
};

export function createExtension(overrides: Partial<ExtensionOptions> = {}): (pi: ExtensionAPI) => void {
  const options = { ...DEFAULT_OPTIONS, ...overrides };
  return (pi) => {
    /** Opens the panel for a settled run, unless a guard says the user shouldn't be asked. */
    function requestReply(ctx: ExtensionContext, message: AssistantMessageLike | undefined, sessionId: string): void {
      if (options.platform !== "darwin" || ctx.mode !== "tui") return;
      if (!message || message.stopReason === "aborted" || message.stopReason === "error") return;
      const text = extractText(message);
      if (!text) return;
      const executable = locateApp(options.agentsDir);
      if (!executable) return;
      const run = runStopHook(executable, {
        hook_event_name: "Stop",
        session_id: sessionId,
        cwd: ctx.cwd,
        last_assistant_message: text,
        stop_hook_active: false,
      });
      void run.stdout.then((stdout) => {
        const reply = stdout && parseReply(stdout);
        if (reply) pi.sendUserMessage(reply);
      });
    }

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
  };
}

/** omp-only members of the extension API (checked against oh-my-pi 18.12.6). pi has none of them. */
interface OmpContext extends ExtensionContext {
  getAsyncJobSnapshot(): unknown;
  agent: { kind: "main" | "sub" };
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
