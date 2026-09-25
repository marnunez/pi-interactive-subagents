# pi-interactive-subagents

Interactive, asynchronous subagents for [Pi](https://pi.dev). Each child runs a real Pi TUI, launched directly in a visible terminal split without typing into an interactive shell. Terminal focus may change; no shell-input injection is involved. Authenticated, length-prefixed Unix-socket messages carry lifecycle and results—not terminal scraping.

```sh
pi install git:github.com/marnunez/pi-interactive-subagents
```

A persistent parent session and **local WezTerm or tmux** are required for new launches. Set `PI_SUBAGENT_MUX=wezterm|tmux` to override detection. Legacy cmux/zellij discovery and cleanup remain, but new launches fail explicitly rather than falling back to unsafe terminal input.

## Visible, direct launching

- **WezTerm:** the first run opens to the right of the originating Pi pane in the same tab. Further concurrent runs split the tallest still-running, owned sibling in that tab vertically, preserving the parent's half. You can immediately watch and interact with the child. WezTerm normally focuses the new pane; this is intentional, not prevented or reversed.
- **tmux:** creates a visible, detached split (`split-window -d`) targeting the originating pane, without selecting it.
- Both spawn and resume explicitly target their originating pane, never whichever pane happens to have focus. New launches do not create hidden workspaces or switch Sway workspaces. The old `workspace` tool argument is removed and legacy agent-definition `workspace` fields no longer control placement. Old run workspace metadata remains readable for recovery.
- If a split cannot be created (for example, a zoomed tab or insufficient space), launch fails rather than silently hiding the child or injecting terminal input.
- Pi arguments and environment overrides travel through a private, one-shot launch file (0700 directory, 0600 file), not terminal input or mux command-line text. A non-interactive launcher spawns Pi with an argument vector and inherited TTY, without a shell. It forwards termination signals and reports spawn failures; it never reads typed input itself.
- There is no `send-text`, simulated Enter, arbitrary shell-readiness sleep, or switch-focus-and-restore sequence. Legacy tab packing (`PI_SUBAGENT_MAX_PANES_PER_TAB`) and automatic Sway switching are removed.
- Spawn/resume first report **connecting**, then return **connected** only after the child authenticates. This confirms startup, not task completion. Cancellation and startup failure do not return a successful launch result.

## Session versus run

A **session** is the durable conversation. A **run** is one delegated invocation.

| Action | Session | Run |
|---|---|---|
| Spawn | New | New ID |
| Fork | New, with active conversation history | New ID |
| Resume | Existing | New ID |
| Reload | Unchanged | Unchanged ID |

Each run accepts one terminal outcome. A completed session remains resumable; it may contain many results, each associated with a different `runId`. Reload restores the current run's completion guard rather than resetting it. Uncorrelated legacy results are never used to complete a new run.

```typescript
subagent({ name: "Map auth", agent: "scout", task: "Map authentication and write a context artifact." });
// Returns after startup connects, not after the task finishes.
// Do independent work, or end the turn silently.
// Do not poll: completion arrives as a steering message and triggers a turn.

subagent_resume({ sessionPath: "/absolute/session.jsonl", message: "Now check the logout path." });
```

Multiple tool calls launch concurrent children. They share the filesystem, not isolated worktrees: partition edits or use separate worktrees. Nested delegation is supported to a maximum depth of four. Finish or cancel descendants before completing their parent run.

## Completion protocol

When finished, the child calls:

```typescript
subagent_done({
  status: "success", // alternatively failed or blocked
  summary: "Implemented and verified logout.", // max 2,000 characters
  report: "Optional longer human-readable report.",
  artifacts: [{ name: "context/logout.md", description: "Details and test evidence" }],
  nextSteps: ["Run the staging smoke test"],
});
```

This ends the **current run**, not the session permanently. Use `failed` when the attempt/check failed; `blocked` when external input or an environment change is needed. Progress statements and an idle model are not proof of success.

- The child persists `subagent_done_result` with its `runId` before sending it.
- Completion is retried/replayed until a matching acknowledgement, with a bounded 10-second delivery wait. The durable result remains available even if delivery fails.
- The parent persists the terminal outcome before acknowledging it and closing the pane. Duplicate frames do not create duplicate outcomes.
- Reload, disconnect and missing-completion shutdown recovery consult the child transcript for the matching run result.
- A durable parent outbox replays committed results missing from the parent conversation.
- Explicit completion terminates the model's tool loop. The child shuts down after acknowledgement (or the delivery timeout).
- `auto-exit: true` is an opt-in fallback: when a run settles without explicit completion and has no children, it records **blocked**, with the last assistant text as a report. It never infers success. Prefer explicit completion for workers and interactive agents.
- Parent cancellation and non-reload shutdown persist cancelled outcomes. Shutdown is retried after reconnect and waits for a `shutdown_ready` acknowledgement after descendants drain. A depth-ordered deadline provides forced cleanup using the journalled subtree, with workspace PIDs checked against their run identity before signalling. `/reload` preserves live children and re-registers lifecycle listeners.

Closing a child manually without a result is a protocol failure. A task result (`success`, `failed`, `blocked`) is distinct from parent protocol status (`completed`, `failed`, `cancelled`). Reopening after a full parent-process crash can recover persisted results, but does not guarantee adoption of still-running children: socket identity is process-scoped. Never concurrently resume the same session in separate parent processes.

Results include run/session IDs, the session path and elapsed time. The model receives the summary, artifact references and next steps; `Ctrl+O` expands the human-readable report.

## Tools and commands

- `subagent`: spawn with `name`, `task`, optional `agent`, `model`, `systemPrompt`, `tools`, `skills`, `cwd`, `fork`.
- `subagents_list`: list effective definitions.
- `subagent_resume`: reuse a session with optional `name` and `message`. Without a message it opens interactively. Saved role/model/tools are restored; automatic exit is disabled.
- `subagent_kill`: cancel by ID, name match or `all`. Omit the target only for an explicit user request to inspect running children—not polling.
- `subagent_done`: child-only terminal result.
- `set_tab_title`: child-only progress title.
- `write_artifact`: child-only session artifact storage.
- `read_artifact`: retrieve an artifact by name.

Commands: `/subagent <agent> <task>`, `/iterate <task>` (fork), `/plan <task>` (planning workflow). The child tools widget toggles with `Ctrl+J`.

## Agent definitions

Discovery precedence:

1. Trusted current project's `.pi/agents/<name>.md`.
2. `$PI_CODING_AGENT_DIR/agents/<name>.md` (defaults to `~/.pi/agent/agents`).
3. Bundled `agents/<name>.md`.

A configured profile never falls back to the legacy shared directory. The filename is the agent identity; `.chain.md` files are not executable agent definitions. Unknown named agents fail explicitly. Project definitions are ignored when project trust is absent.

```yaml
---
name: focused-worker
description: Implements a small verified change
model: openai-codex/gpt-5.6-sol
thinking: high
tools: read, bash, edit, write, todo
spawning: false
---
Implement only the delegated task. Verify it, then finish the current run with subagent_done.
```

Supported frontmatter:

- `model`, `thinking`: model and reasoning defaults; explicit tool-call model overrides the definition.
- `tools`: **strict allowlist across built-ins and extension tools**. If absent, inherit the parent's active tools, not every registered tool.
- `allow-tools`: narrow that selection further.
- `deny-tools`: remove tools, including built-ins. Denials and `spawning: false` always win over optional allowlists.
- `spawning: false`: disable spawn/list/resume/kill tools.
- `skills` (or `skill`): comma-separated skills to load.
- `cwd`: default working directory.
- `max-instances`: per-parent simultaneous instances for this agent.
- `env`: whitespace-separated `KEY=value` assignments; reserved run identity, policy and lease variables cannot be overridden.
- `auto-exit`: opt-in blocked fallback described above.

`subagent_done` is always available. `set_tab_title`, `write_artifact` and `read_artifact` are added unless narrowed/denied. Unknown explicit tool names fail with an error. Update old definitions that relied on implicit extension access: e.g. a worker using todos needs `todo` in `tools`, and browser agents must list `browser_*` tools explicitly.

Agent bodies and `systemPrompt` are appended as system instructions for both fresh and forked runs. Forks copy validated active conversation history but not the parent's orchestration ledger. Resume restores saved launch settings without inheriting stale multiplexer or ancestor run variables.

**These are capability-selection controls, not a sandbox.** Bash and extensions run with the same Unix-user authority as Pi. Neither profiles nor tool allowlists provide filesystem isolation.

## Profiles, artifacts and recovery

Child commands explicitly reassert `PI_PROFILE` and `PI_CODING_AGENT_DIR`. Parent lease handoff capabilities and ancestor child identity/policy variables are cleared before setting the new run environment.

Task, launch configuration and artifact files live beside the owning session:

```text
<session>.jsonl
<session>/artifacts/context/subagent-task.md
<session>/artifacts/context/subagent-config.json
<session>/artifacts/...
```

Artifacts move with the session corpus. Names must be relative and cannot traverse symlinks. Use distinctive artifact names: lookup searches the current session first, then sibling sessions, and a flat profile session root can contain several projects. Generic names can collide. Large material belongs in artifacts rather than completion summaries.

Startup allows at most two minutes for the authenticated connection; an observed launch failure or vanished pane fails sooner. An IPC timeout does not establish its cause—inspect the child pane or transcript rather than assuming an authentication problem. Reconnect after parent reload allows 15 seconds. These are startup/reconnect guards, not task execution deadlines.

## Development

```sh
npm install
npm test
```

Tests cover session lineage, run-scoped persistence, completion retry/acknowledgement, reload recovery, cancellation, nested orchestration sockets, tool policy, profile discovery, artifacts and UI-state monitoring. Launch/resume integration tests execute fake mux/Pi processes with real IPC: they assert journal-before-execution, direct argument handling, visible targeted splits, startup acknowledgement and cancellation. No paid model calls or live desktop operations are used.

An explicit, optional real-GUI test creates a **separate Xvfb display and WezTerm instance**. It verifies three children share the parent's visible tab, subsequent children preserve parent space, arguments/environment remain literal, and launch performs no terminal typing. It then sends deliberate input to the focused child:

```sh
# Requires wezterm, xvfb-run and xdotool on PATH; never targets the desktop display.
node test/isolated-visible.mjs
# Also exercise the installed Pi CLI with this checkout's extensions, offline,
# in a fresh session and a resume. No task prompt or model request is sent.
PI_REAL_STARTUP_SMOKE=1 node test/isolated-visible.mjs
```

Keep actual Pi smoke sessions outside the extension checkout: Pi auto-discovers this package there, so loading another installed copy can produce duplicate-tool errors.

### Module boundaries

`pi-extension/subagents/index.ts` only wires together a fresh per-parent runtime and registrations:

- `launch.ts`, `launch-process.ts/.mjs`, `terminal-launch.ts`: session preparation, private direct process launch and visible, explicitly targeted mux splits.
- `controller.ts`, `runtime.ts`, `types.ts`: orchestration, recovery, cancellation, IPC events and instance-owned state.
- `spawn-tool.ts`, `resume-tool.ts`, `management-tools.ts`, `commands.ts`: tool/command registration and input handling.
- `presentation.ts`, `widget.ts`, `renderers.ts`: result text, status widgets and TUI rendering.
- `config.ts`, `policy.ts`, `launch-config.ts`: agent discovery, capabilities, guidance and resume settings.
- `ipc.ts`, `session.ts`, `run-ledger.ts`, `termination.ts`, `subagent-done.ts`: transport, persistence, subtree cleanup and child lifecycle.

MIT. Originally based on HazAT/pi-interactive-subagents.
