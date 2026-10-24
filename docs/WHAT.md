# What pi-opensuperwhisper does

A pi extension (also loadable in oh-my-pi) that hands the agent's last message to the running OpenSuperWhisper macOS app when a run settles. If the user answers in the app's panel, the extension sends that answer back to the agent as the next user message.

> The pi and oh-my-pi API names below were checked against pi `@earendil-works/pi-coding-agent` 1.1.0 and oh-my-pi 18.12.6 source on 2026-10-24. Hosts change quickly; re-check them when upgrading:
> - pi: `packages/coding-agent/docs/extensions.md` in [badlogic/pi-mono](https://github.com/badlogic/pi-mono)
> - oh-my-pi: [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), `packages/coding-agent/src/extensibility/extensions/types.ts`
>
> The full spec is GitHub issue [#1](https://github.com/dVelopment/pi-opensuperwhisper/issues/1).

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

### Phase 2: questions (oh-my-pi `ask` tool, out of scope for the MVP)

- oh-my-pi has an `ask` tool (a structured option picker). pi core has none.
- Its input schema is `questions[{id, question, header?, options[{label, description?, preview?}], multi?, recommended?}]`. Map it to the app's question format:

  ```
  questions: [{ question, header?, options: [{ label, description? }], multiSelect }]
  ```

- Spawn `agent-hook question` with `{"tool_name":"AskUserQuestion","tool_input":{...}}`.
- On `hookSpecificOutput.permissionDecision === "allow"`, map `updatedInput.answers` back into the `ask` tool's expected result.
- Unverified: whether a `tool_call` handler can replace a tool's result rather than only block it. Tracked in a separate issue.

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
| User dir | `~/.pi` | `~/.omp` |
| Manifest key | `pi.extensions` | `omp.extensions` (falls back to `pi.extensions`) |
| Install | `pi install npm:@chitinai/pi-opensuperwhisper` | `omp plugin install @chitinai/pi-opensuperwhisper` |

- Subscribe to both triggers. Each host's handler ignores the other host's `ctx`.
- Use only `node:child_process`, `node:fs`, `node:os` and `node:path`, which work under Node and Bun.
- Do not import host-specific packages at runtime. Type-only imports are fine.

## Package layout

No build step: the package ships TypeScript source, and both manifest keys point at it. Type checking (`tsc --noEmit`) is not a build.

```
pi-opensuperwhisper/
├── package.json        # "pi": { "extensions": ["./src/index.ts"] }, "omp": { "extensions": ["./src/index.ts"] }
├── src/
│   ├── index.ts        # extension factory: event wiring, host detection, guards, pending request, cancellation
│   ├── app.ts          # locate app (pid/executable), liveness check
│   ├── hook.ts         # spawn agent-hook stop, write stdin, collect stdout, kill handle
│   └── message.ts      # extract assistant text, parse the reply and strip its prefix
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
