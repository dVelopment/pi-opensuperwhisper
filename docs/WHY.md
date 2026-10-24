# Why pi-opensuperwhisper exists

## The problem

[OpenSuperWhisper](https://github.com/my-monkeys/OpenSuperWhisper) is a free, on-device macOS dictation app. It has an "Agents" feature. When a coding agent finishes a turn, a small panel opens in the top-right corner of the screen and shows the agent's last message. You dictate (or type) a reply there, and the agent carries on with it. You never have to go back to the terminal.

The feature only reaches agents that run Claude Code-style command hooks. It ships as a Claude Code plugin, and Codex, Cursor and Gemini CLI can reuse that plugin. [pi](https://github.com/badlogic/pi-mono) and [oh-my-pi](https://github.com/can1357/oh-my-pi) have no hook system of that kind. They have TypeScript extensions instead, so the plugin does nothing there.

This repository closes that gap. It is a pi extension that also loads in oh-my-pi, and it connects both agents to the same panel.

## Why this approach

**Reuse the app's own CLI and do not reimplement its protocol.**
The app's hook mode (`OpenSuperWhisper agent-hook <event>`) does the following:
- writes the request file
- wakes the app through macOS `DistributedNotificationCenter`
- captures the host terminal, so the panel can jump back to it
- waits for the answer

Node and Bun cannot post a distributed notification without native code. Spawning the app's binary gets all of this for free and stays correct when the app changes its internals.

**Do not depend on pi-hooks.**
[pi-hooks](https://github.com/hsingjui/pi-hooks) can run Claude-style hooks in pi, but it has drawbacks here:
- It injects a Stop hook's `reason` as hidden context, not as a visible user message.
- It has no `PermissionRequest` event.
- It is a third-party dependency for something that needs about 100 lines.

A dedicated extension sends the dictated reply as a normal user message, so it shows up in the session like typed input.

**One package for both hosts.**
oh-my-pi loads pi extensions through a compatibility layer. It reads `pkg.omp.extensions` and falls back to `pkg.pi.extensions`. One codebase with a thin host-detection shim is cheaper to maintain than two forks.

## Design principles

- **Fail open.** If the app isn't running, isn't installed, or isn't on macOS, the extension does nothing. If it errors or times out, the agent behaves exactly as if the extension were not installed. It never blocks the agent or the TUI.
- **The terminal always wins.** If the user starts typing in pi while the panel is waiting, the pending panel request is cancelled.
- **Zero config.** Install it and it works. Users turn the panel on or off in OpenSuperWhisper's own settings, not here.
- **Nothing leaves the Mac.** This repo adds no network path.

## Non-goals

- Voice recording or transcription. The app does that.
- Linux or Windows support. The app is macOS-only.
- Text-to-speech of the agent's message.
