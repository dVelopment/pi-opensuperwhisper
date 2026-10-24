# pi-opensuperwhisper

Answer [pi](https://github.com/badlogic/pi-mono) and [oh-my-pi](https://github.com/can1357/oh-my-pi) agents from the [OpenSuperWhisper](https://github.com/my-monkeys/OpenSuperWhisper) panel on macOS.

When a run is finished and waiting for you, OpenSuperWhisper's Agents panel opens with the agent's last message. Dictate (or type) your reply there. It shows up in the session as a normal user message and starts the next run. You don't have to go back to the terminal.

## Install

pi:

```bash
pi install npm:@chitinai/pi-opensuperwhisper
```

oh-my-pi:

```bash
omp plugin install @chitinai/pi-opensuperwhisper
```

There's nothing to configure. Turn the panel on or off in OpenSuperWhisper's own settings.

## Requirements

- macOS with OpenSuperWhisper running. On any other platform the extension does nothing.
- **The "Claude Code" agent kind must be enabled in OpenSuperWhisper.** OpenSuperWhisper doesn't know pi or oh-my-pi yet, so the extension identifies itself as Claude Code. For the same reason the panel labels these requests "Claude Code". This is temporary until OpenSuperWhisper gets its own pi agent kind.
- The interactive terminal UI. In print, json and rpc modes the extension does nothing.

## How it behaves

- **Panel opens** when the run is fully settled: on pi after `agent_settled`, on oh-my-pi after a terminal `agent_end` once nothing else is queued. It doesn't open while the agent will still continue on its own (retries, compaction, queued follow-ups), after you abort a run with Esc or Ctrl+C, after a run that ended in an error, in oh-my-pi subagent sessions, or when the last message has no visible text. The panel shows only the message's text, without thinking or tool calls.
- **Your reply** is sent as the next user message, without the panel's "The user answered by voice…" prefix.
- **"Let it stop", or the panel timing out,** leaves the agent idle with no side effects.
- **The terminal always wins.** Typing in the terminal, starting a new run, switching or resuming sessions, or quitting cancels the panel request. Exactly one run happens, even if a panel reply arrives at the same moment.
- **Fails open.** If OpenSuperWhisper isn't running, its files are missing or stale, or anything goes wrong, the extension does nothing and logs nothing. It never blocks the agent or the terminal.
- **No network.** The extension only talks to the local OpenSuperWhisper app.

## How it works

The extension uses OpenSuperWhisper's own Claude Code integration path. It finds the running app through `~/Library/Application Support/fr.my-monkey.opensuperwhisper/agents/` (`app.pid`, `app.executable`), then runs `<app> agent-hook stop` with a Claude Code–style Stop request on stdin and `CLAUDE_PROJECT_DIR` set. If you answer, the app prints the reply on stdout. Cancelling a request kills that process, and the app closes the panel within about a second.

## Development

The package ships TypeScript source; there's no build step. pi loads it through jiti, oh-my-pi through Bun.

```bash
bun install
bun test           # behaviour tests against a fake agent-hook script
bun run typecheck  # tsc --noEmit
```

Try it against the real app from a checkout:

```bash
pi -e ./src/index.ts
omp -e ./src/index.ts
```

See [docs/WHAT.md](docs/WHAT.md) for the design and [docs/WHY.md](docs/WHY.md) for the motivation.

## License

MIT
