# What pi-opensuperwhisper does

A pi extension (also loadable in oh-my-pi) that hands the agent's last message to the running OpenSuperWhisper macOS app when a run settles. If the user answers in the app's panel, the extension sends that answer back to the agent as the next user message. On oh-my-pi it also opens the questions of the `ask` tool in the panel.

> The pi and oh-my-pi API names below were checked against pi `@earendil-works/pi-coding-agent` 1.1.0 and oh-my-pi 18.12.6 source on 2026-10-24. Hosts change quickly; re-check them when upgrading:
> - pi: `packages/coding-agent/docs/extensions.md` in [badlogic/pi-mono](https://github.com/badlogic/pi-mono)
> - oh-my-pi: [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), `packages/coding-agent/src/extensibility/extensions/types.ts`
>
> The full spec is GitHub issue [#1](https://github.com/stibbons-ai/pi-opensuperwhisper/issues/1); Phase 2 (questions) is issue [#3](https://github.com/stibbons-ai/pi-opensuperwhisper/issues/3).

## Reference: how the Claude Code plugin works upstream

Source: [my-monkeys/OpenSuperWhisper](https://github.com/my-monkeys/OpenSuperWhisper)
- Plugin: `integrations/claude-code/plugin/`
- Hook logic: `OpenSuperWhisper/Agents/AgentHookCommand.swift`
- File bridge: `OpenSuperWhisper/Agents/AgentBridge.swift`

1. Claude Code runs `bin/osw-agent-hook stop` on its `Stop` hook and passes the hook JSON on stdin.
2. `osw-agent-hook` locates the running app through these files:

   ```
   ~/Library/Application Support/fr.my-monkey.opensuperwhisper/agents/app.pid
   ~/Library/Application Support/fr.my-monkey.opensuperwhisper/agents/app.executable
   ```

   If the pid is not alive, it exits 0 silently. Otherwise it runs `<app.executable> agent-hook stop`.
3. The app binary in hook mode then:
   - reads stdin
   - writes `requests/<uuid>.json`
   - posts a distributed notification
   - polls `responses/<uuid>.json` every 200 ms for up to the configured wait (30–590 s)
4. On a reply, it prints the following to stdout and exits 0:

   ```json
   {"decision":"block","reason":"The user answered by voice, through OpenSuperWhisper:\n\n<reply text>"}
   ```

   On dismissal or timeout, it prints nothing and exits 0.

## Scope

### MVP: stop → reply (must have)

**Trigger.** The run is fully settled (idle and waiting for user input):
- pi: `agent_settled`. It fires only after retries, compaction and queued continuations are finished. Skip it when `event.aborted` is true. Read the last assistant message from the active branch (`ctx.sessionManager.getBranch()`, the last `message` entry with role `assistant`).
- oh-my-pi: there is no settled event for extensions (`session_settled` exists only in RPC mode). Use `agent_end` instead:
  1. Ignore it when `willContinue === true` (retries, compaction recovery, todo/plan reminders, async wakes).
  2. Wait one macrotask, then require `ctx.isIdle() && !ctx.hasPendingMessages()`. omp marks queued follow-ups as non-terminal only on its internal session event, not on the extension `agent_end`.
  3. Read the last assistant message from `event.messages`.
  4. Act only when `ctx.agent.kind === "main"`. omp rebinds extension factories to every subagent session (task tool, eval `agent()`, `/tan` clones), so `agent_end` also fires there.
- omp's `session_stop` is not used: its block result becomes a hidden continuation (`display: false`), so the reply wouldn't be visible in the transcript, and it holds the settle open for up to 590 s.

**Host detection.** Decided per handler from `ctx`, not from the JS runtime (pi can run under Bun): `typeof ctx.getAsyncJobSnapshot === "function"` means oh-my-pi, otherwise pi. On pi the `agent_end` path is ignored; on oh-my-pi the `agent_settled` path is ignored.

**Guards.** Run only when all of these hold:
- `process.platform === "darwin"`
- interactive TUI mode: `ctx.mode === "tui"` (`ctx.hasUI` is not enough, because rpc mode also has UI)
- the run was not aborted by the user (Esc / Ctrl+C) and didn't end in an error: pi's `event.aborted`, and the last assistant message's `stopReason` is not `"aborted"` or `"error"`
- the last assistant message has non-empty text (its text blocks only, without thinking, tool calls and images)

**Locate the app.** Read `app.pid` and `app.executable` from the directory above.
- Check that the pid is a positive integer and alive with `process.kill(pid, 0)`; treat `EPERM` as alive.
- Check that the executable is a file and is executable.
- If any check fails, return silently.

**Spawn.** Run `<app.executable> agent-hook stop` asynchronously. Never block the event loop or the TUI.

stdin:

```json
{
  "hook_event_name": "Stop",
  "session_id": "<session id>",
  "cwd": "<ctx.cwd>",
  "last_assistant_message": "<text of the last assistant message>",
  "stop_hook_active": false
}
```

Omit `transcript_path`. The app parses it as a Claude Code transcript to find a session title, and pi's format differs. As a result the panel shows no session title.

Session id: pi uses `ctx.sessionManager.getHeader()?.id`, oh-my-pi uses `ctx.sessionManager.getSessionId()`. An empty string is fine; the app defaults it.

env: inherit `process.env` and set `CLAUDE_PROJECT_DIR=<cwd>`. See "Agent detection" below for why.

**Result.**
- If stdout parses to `decision === "block"` with a non-empty `reason`:
  1. Strip the fixed prefix `"The user answered by voice, through OpenSuperWhisper:\n\n"`. If the prefix is missing, use the whole reason.
  2. Send the text with `pi.sendUserMessage(text)` using default delivery (the host is idle). On pi, a run requested from inside an `agent_settled` handler is deferred by the host until all settled handlers finish, so no manual deferral is needed.
- Any other outcome (empty stdout, non-JSON, non-zero exit, spawn error) is a silent no-op. Neither host gives extensions a debug logger, so the extension logs nothing.

**Cancellation.**
- Allow at most one pending request per session, tracked with a generation counter. A new settle kills the pending request (`SIGTERM`) before spawning a new one.
- These kill the pending request and bump the generation:
  - `input` with `source` other than `"extension"`, so our own injected reply never cancels anything
  - `agent_start`, so any new run (typed input, queued follow-up, background wake) supersedes the panel
  - `session_shutdown` (quit, reload, new, resume, fork) and `session_before_switch`
- A reply is delivered only if its generation is still current, so typed input and a panel reply at the same instant produce exactly one run.
- A killed hook leaves no residue: the app's inbox reloads every second, drops requests whose hook process is dead, deletes their files and hides the panel (`AgentInbox.swift`).

**Timeout.** Rely on the app's own wait (clamped to 30–590 s). As a safety net, hard-kill the hook after 600 s.

### Phase 2: questions (oh-my-pi `ask` tool)

oh-my-pi has a built-in `ask` tool (a structured option picker); pi core has none, so this is oh-my-pi only. On pi, the README recommends a question plugin such as `@mazli/pi-ask-user-question`, answered in the terminal: pi has no `ctx.invokeTool`, so an extension can't race another extension's tool against the panel. Paths below are in oh-my-pi 18.12.6 `packages/coding-agent/src/`.

**Shadow the built-in.** A `tool_call` handler can only block a call or revise its input (`extensibility/extensions/wrapper.ts`), and `tool_result` runs after the native tool has finished, so neither can answer `ask` from the panel or close the terminal dialog. Instead the extension re-registers `ask` and delegates to the native built-in with `ctx.invokeTool(params, { signal })` (`extensibility/extensions/types.ts`). Its own `AbortController` on that signal lets a panel answer close the terminal dialog.

**Registration.** On `session_start`, on oh-my-pi only, when `pi.getAllTools()` lists `ask` with `sourceInfo.source === "builtin"`; once per extension instance. The definition reuses the built-in's `description` and `parameters`, so the model sees the same tool, and copies its traits (`tools/ask.ts`): `label: "Ask"`, `approval: "read"`, `strict: true`, `loadMode: "discoverable"` and `concurrency: "exclusive"` (the dialog is one shared UI surface).

**Guards.** The panel joins only on macOS, in TUI mode, in the main agent (`ctx.agent.kind === "main"`), with the app alive, when the call isn't already cancelled (its signal aborted), and when the call's question texts are distinct: the app keys answers by question text. Otherwise `ask` is a plain `ctx.invokeTool(params)`, exactly the native behavior. Without `ctx.invokeTool` (no native `ask` to delegate to) the call fails with an error.

**Request.** `questions[{id, question, header?, options[{label, description?, preview?}], multi?, recommended?}]` maps to the stdin of `agent-hook question`, with `CLAUDE_PROJECT_DIR` set as for the Stop hook. Like native `ask` (`sanitizeAskParams` in `tools/ask.ts`), the extension first replaces the `\r` runs models sometimes inject, so the panel shows, and its answer matches, the text native would; native itself gets the call unchanged:

```json
{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"…","header":"…","options":[{"label":"…","description":"…"}],"multiSelect":false}]},"session_id":"…","cwd":"…"}
```

**Answer.** Exit 0 with `hookSpecificOutput.permissionDecision === "allow"` and `updatedInput.answers` keyed by question text (`AgentHookCommand.swift`). A value is one label, the picked labels joined with `", "` (multi-select), or free text (`AgentInbox.swift`). The extension maps it back to the exact result native `ask` returns for the same selections: one question → `User selected: A, B` or `User provided custom input: …` with that question's `details`; several → `User answers:` plus one line per question with `details.results`. Anything else (dismissed, timed out, app gone, malformed output) is no answer.

**Race: the first answer wins.** Per call:

1. Start the native `ask` with a signal combining the outer one and the extension's own, and spawn `agent-hook question`.
2. Native settles first (answer, error or cancel) → kill the hook; the native result or error stands unchanged.
3. The panel answers first → abort the native dialog, swallow its `ToolAbortError`, return the mapped result.
4. The panel closes without an answer → keep waiting for the native dialog.
5. The outer signal aborts, or `session_shutdown` → kill the hook; the native dialog decides the outcome. The 600 s hard-kill safety net applies as for the Stop hook.

**Known cost.** A shadowed built-in loses oh-my-pi's built-in transcript renderer for `ask` (`useBuiltInRenderer: hasBuiltInTool(name)` in `modes/controllers/event-controller.ts`), so `ask` calls render like other extension tools. The interactive dialog is unaffected.

### Phase 3 (optional): permission gate

- pi has no built-in permission prompts, so this would be a new feature, not a port. Skip it unless the user asks for it.
- If built, it would run on `tool_call` for configurable tools (e.g. `bash`) and spawn `agent-hook permission` with `{"tool_name", "tool_input"}`.
- Map `hookSpecificOutput.decision.behavior`:
  - `allow` → proceed
  - `deny` → block, with `message` as the reason
  - nothing → fall through to the normal behavior

## Agent detection (important)

The app decides which agent called it from stdin and env (`AgentKind.detect` in `AgentBridge.swift`):

| Signal | Detected agent |
|---|---|
| `turn_id` in stdin, or `PLUGIN_ROOT` without `CLAUDE_PROJECT_DIR` | codex |
| `cursor_version` in stdin, or `CURSOR_VERSION` env | cursor |
| `GEMINI_SESSION_ID` env | gemini |
| `prompt_id` / `scratchpad_dir` / `effort` in stdin, or `CLAUDE_PROJECT_DIR` env | claudeCode |
| none of the above | unknown |

The exact `agentEnabledKinds` default wasn't found in upstream source. The smoke test against the real app confirms that requests are accepted, which needs the Claude Code agent kind enabled.

- **MVP:** set `CLAUDE_PROJECT_DIR` so the request is accepted. The panel will label it "Claude Code". The README documents this.
- **Proper fix (separate issue):** open an upstream PR that adds a `pi` case to `AgentKind`, detected by an env marker the extension sets (one value for pi, one for oh-my-pi). The extension then sets that marker instead of `CLAUDE_PROJECT_DIR`.

**Return to the right terminal.** The app works out which terminal to return to by walking up from the hook process's parent and reading inherited markers such as `TERM_PROGRAM`. Spawning the hook from the host process with the inherited environment keeps that chain intact.

## Host differences (pi vs oh-my-pi)

| | pi | oh-my-pi |
|---|---|---|
| Package | `@earendil-works/pi-coding-agent` | `@oh-my-pi/pi-coding-agent` |
| Runtime | Node ≥ 22 (loads `.ts` through jiti) | Bun (loads `.ts` natively) |
| Settle trigger | `agent_settled` | terminal `agent_end` + idle check |
| Session id | `ctx.sessionManager.getHeader()?.id` | `ctx.sessionManager.getSessionId()` |
| Subagents | none in core | `ctx.agent.kind === "sub"`, skipped |
| `ask` questions in the panel | no built-in `ask` | shadows the built-in `ask` |
| User dir | `~/.pi` | `~/.omp` |
| Manifest key | `pi.extensions` | `omp.extensions` (falls back to `pi.extensions`) |
| Install | `pi install npm:@stibbons/pi-opensuperwhisper` | `omp plugin install @stibbons/pi-opensuperwhisper` |

- Subscribe to both triggers. Each host's handler ignores the other host's `ctx`.
- Use only `node:child_process`, `node:fs`, `node:os` and `node:path`, which work under Node and Bun.
- Do not import host-specific packages at runtime. Type-only imports are fine.

## Package layout

No build step: the package ships TypeScript source, and both manifest keys point at it. Type checking (`tsc --noEmit`) is not a build.

```
pi-opensuperwhisper/
├── package.json        # "pi": { "extensions": ["./src/index.ts"] }, "omp": { "extensions": ["./src/index.ts"] }
├── src/
│   ├── index.ts        # extension factory: event wiring, host detection, guards, pending request, cancellation, `ask` shadow
│   ├── app.ts          # locate app (pid/executable), liveness check
│   ├── hook.ts         # spawn agent-hook stop/question, write stdin, collect stdout, kill handle
│   ├── message.ts      # extract assistant text, parse the reply and strip its prefix
│   └── question.ts     # map ask calls to agent-hook question requests and panel answers to ask results
├── test/               # bun test: extension factory against a fake agent-hook script; pure parsers
├── docs/WHAT.md
├── docs/WHY.md
├── README.md
└── LICENSE             # MIT
```

## Acceptance criteria (MVP)

1. With OpenSuperWhisper running on macOS, finishing a pi or oh-my-pi turn opens the panel showing the agent's last message.
2. A dictated reply appears in the session as a user message and starts the next run.
3. Clicking "Let it stop" in the panel, or letting it time out, leaves the session idle with no side effects.
4. Typing in the terminal while the panel waits cancels the request. Exactly one run happens, from the typed input.
5. With the app not running, or on Linux, the extension adds no measurable latency and logs nothing.
6. The same package loads in pi (`pi -e ./src/index.ts`) and in oh-my-pi (`omp -e ./src/index.ts`).
7. `bun test` covers, against a fake `agent-hook` script and the pure parsers:
   - app discovery: missing files, malformed or dead pid, `EPERM`, missing or non-executable binary
   - guards: platform, mode, aborted, errored, text-less messages
   - the Stop request contract (argv, stdin JSON, `CLAUDE_PROJECT_DIR`)
   - stdout parsing: reply, empty, garbage, missing prefix, non-zero exit
   - cancellation and the hard-kill timer
   - host detection, including omp's `willContinue`, idle/pending checks and subagent sessions
8. "Jump back to terminal" lands in the right terminal (manual smoke test).
