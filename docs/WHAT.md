# What pi-opensuperwhisper does

A pi extension (also loadable in oh-my-pi) that hands the agent's last message to the running OpenSuperWhisper macOS app when a run settles. If the user answers in the app's panel, the extension sends that answer back to the agent as the next user message.

> ⚠️ The pi and oh-my-pi API names below come from documentation read on 2026-10-24. Verify every event and method name against the current docs and source before relying on it:
> - pi: `packages/coding-agent/docs/extensions.md` in [badlogic/pi-mono](https://github.com/badlogic/pi-mono)
> - oh-my-pi: [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)

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
- pi: `agent_settled`
- oh-my-pi: `session_settled`

Do **not** use `agent_end`. It fires before retries, compaction retries and queued work.

**Guards.** Run only when all of these hold:
- `process.platform === "darwin"`
- interactive TUI mode (`ctx.mode === "tui"` / `ctx.hasUI`, to be verified)
- the last assistant message has non-empty text
- the run was not aborted by the user (Esc / Ctrl+C)

**Locate the app.** Read `app.pid` and `app.executable` from the directory above.
- Check that the pid is alive with `process.kill(pid, 0)`; treat `EPERM` as alive.
- Check that the executable exists and is executable.
- If any check fails, return silently.

**Spawn.** Run `<app.executable> agent-hook stop` asynchronously. Never block the event loop or the TUI.

stdin:

```json
{
  "hook_event_name": "Stop",
  "session_id": "<pi session id>",
  "cwd": "<session cwd>",
  "last_assistant_message": "<text of the last assistant message>",
  "stop_hook_active": false
}
```

Omit `transcript_path`. The app parses it as a Claude Code transcript to find a session title, and pi's format differs.

env: inherit `process.env` and set `CLAUDE_PROJECT_DIR=<cwd>`. See "Agent detection" below for why.

**Result.**
- If stdout parses to `decision === "block"` with a non-empty `reason`:
  1. Strip the fixed prefix `"The user answered by voice, through OpenSuperWhisper:\n\n"`. If the prefix is missing, use the whole reason.
  2. Send the text with `pi.sendUserMessage(text)`.
- Any other outcome (empty stdout, non-JSON, non-zero exit, spawn error) is a silent no-op. Log it only at debug level.

**Cancellation.**
- If the user submits input in pi while a request is pending, kill the child process (`SIGTERM`). Listen on the `input` event or the closest equivalent.
- Also kill it on session shutdown or switch (`session_shutdown`, `session_before_switch`).
- Allow at most one pending request per session. A new settle replaces the old request: kill it first.

**Timeout.** Rely on the app's own wait. As a safety net, add a hard kill at 600 s.

### Phase 2: questions (oh-my-pi `ask` tool)

- oh-my-pi has an `ask` tool (a structured option picker). pi core has none.
- Intercept it with `tool_call` and map its input to the app's question format:

  ```
  questions: [{ question, header?, options: [{ label, description? }], multiSelect }]
  ```

- Spawn `agent-hook question` with `{"tool_name":"AskUserQuestion","tool_input":{...}}`.
- On `hookSpecificOutput.permissionDecision === "allow"`, map `updatedInput.answers` back into the `ask` tool's expected result. Short-circuit the tool if the API allows that.
- First verify the `ask` tool's exact input and output schema in the oh-my-pi source.

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

By default the app answers only for `claudeCode` (`agentEnabledKinds` defaults to `["claudeCode"]`).

- **MVP:** set `CLAUDE_PROJECT_DIR` so the request is accepted. The panel will label it "Claude Code". Document this in the README.
- **Proper fix:** open an upstream PR that adds a `pi` case to `AgentKind`, detected by an env marker such as `PI_CODING_AGENT=1` (and `OMP=1` for oh-my-pi). The extension then sets that marker instead.

## Host differences (pi vs oh-my-pi)

| | pi | oh-my-pi |
|---|---|---|
| Package | `@earendil-works/pi-coding-agent` (verify current scope) | `@oh-my-pi/pi-coding-agent` |
| Runtime | Node ≥ 22 | Bun |
| Settled event | `agent_settled` | `session_settled` |
| User dir | `~/.pi` | `~/.omp` |
| Manifest key | `pi.extensions` | `omp.extensions` (falls back to `pi.extensions`) |

- Subscribe to both settled event names. Only one will fire on each host.
- Use only `node:child_process`, `node:fs` and `node:os`, which Bun supports, so the code runs on both runtimes.
- Do not import host-specific packages at runtime. Type-only imports are fine.

## Package layout

```
pi-opensuperwhisper/
├── package.json        # "pi": { "extensions": ["./dist/index.js"] }, "omp": { "extensions": ["./dist/index.js"] }
├── src/
│   ├── index.ts        # extension entry: event wiring, guards, cancellation
│   ├── app.ts          # locate app (pid/executable), liveness check
│   ├── hook.ts         # spawn agent-hook, write stdin, parse stdout
│   └── message.ts      # extract last assistant text, strip reply prefix
├── test/               # unit tests for app.ts, hook.ts, message.ts (fake executable script)
├── docs/WHAT.md
├── docs/WHY.md
├── README.md
└── LICENSE             # MIT
```

## Acceptance criteria (MVP)

1. With OpenSuperWhisper running on macOS, finishing a pi turn opens the panel showing the agent's last message.
2. A dictated reply appears in pi as a user message and starts the next run.
3. Clicking "Let it stop" in the panel, or letting it time out, leaves pi idle with no side effects.
4. Typing in pi while the panel waits cancels the request. Exactly one run happens, from the typed input.
5. With the app not running, or on Linux, the extension adds no measurable latency and logs nothing at default level.
6. The same build loads in pi (`pi -e ./dist/index.js`) and in oh-my-pi (`omp -e ./dist/index.js`).
7. Unit tests cover:
   - app discovery: missing files, dead pid, `EPERM`
   - stdout parsing: reply, empty, garbage, missing prefix
   - cancellation, using a fake `agent-hook` script

## Open questions to verify before coding

- The exact pi API to read the last assistant message at settle time. It might be on the event payload, on `ctx.sessionManager`, or elsewhere.
- Whether `pi.sendUserMessage` is allowed from inside a settled handler, or must be deferred with `queueMicrotask` or `setTimeout`.
- How to detect "aborted by user" for the settled run.
- Which event signals user input submission, for cancellation.
- What happens to a request when the hook process is killed: does the app drop it once `hookPID` is dead? Check `AgentInbox.swift`.
