# pi-interactive-subagents

Interactive, asynchronous subagents for [Pi](https://pi.dev). Each child runs a real Pi TUI in a cmux, tmux, zellij or WezTerm pane; the user can watch and steer it directly. The terminal multiplexer manages presentation only. Authenticated, length-prefixed Unix-socket messages carry lifecycle and results—not terminal scraping.

```sh
pi install git:github.com/marnunez/pi-interactive-subagents
```

Set `PI_SUBAGENT_MUX=cmux|tmux|zellij|wezterm` to override backend detection. A persistent parent session is required. `workspace` optionally launches a WezTerm window on a named Sway workspace.

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
// Returns immediately. Do independent work, or end the turn silently.
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

- `subagent`: spawn with `name`, `task`, optional `agent`, `model`, `systemPrompt`, `tools`, `skills`, `cwd`, `fork`, `workspace`.
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
- `cwd`, `workspace`: default working directory and Sway workspace.
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

Startup allows two minutes for project trust/authentication before reporting a connection failure; reconnect after parent reload allows 15 seconds. These are startup/reconnect guards, not task execution deadlines.

## Development

```sh
npm install
npm test
```

Tests cover session lineage, run-scoped persistence, completion retry/acknowledgement, reload recovery, cancellation, nested orchestration sockets, tool policy, profile discovery, artifacts and UI-state monitoring. They use local fixtures and sockets, not paid model calls.

MIT. Originally based on HazAT/pi-interactive-subagents.
