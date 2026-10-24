import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
    pi.on("agent_settled", async (_event, ctx) => {
      const message = lastAssistant(ctx.sessionManager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message] : [])));
      const text = message && extractText(message);
      if (!text) return;
      const executable = locateApp(options.agentsDir);
      if (!executable) return;
      const run = runStopHook(executable, {
        hook_event_name: "Stop",
        session_id: ctx.sessionManager.getHeader()?.id ?? "",
        cwd: ctx.cwd,
        last_assistant_message: text,
        stop_hook_active: false,
      });
      void run.stdout.then((stdout) => {
        const reply = stdout && parseReply(stdout);
        if (reply) pi.sendUserMessage(reply);
      });
    });
  };
}

function lastAssistant(messages: readonly { role: string }[]): AssistantMessageLike | undefined {
  return messages.findLast((message): message is AssistantMessageLike => message.role === "assistant");
}

export default createExtension();
