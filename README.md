# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono) — spawn, orchestrate, and manage sub-agent sessions in multiplexer panes. **Fully non-blocking** — the main agent keeps working while subagents run in the background.

https://github.com/user-attachments/assets/30adb156-cfb4-4c47-84ca-dd4aa80cba9f

## How It Works

Call `subagent()` and it **returns immediately**. The sub-agent runs as a fully interactive Pi TUI in its own terminal pane. A live widget above the input shows all running agents with elapsed time and progress. Parent and child communicate over an authenticated Unix-domain socket; terminal contents are never scraped. When a sub-agent finishes, its result is **steered back** into the main session as an async notification — triggering a new turn so the agent can process it.

```
╭─ Subagents ──────────────────────── 2 running ─╮
│ 00:23  Scout: Auth (scout)    8 msgs (5.1KB)   │
│ 00:45  Scout: DB (scout)     12 msgs (9.3KB)   │
╰─────────────────────────────────────────────────╯
```

For parallel execution, just call `subagent` multiple times — they all run concurrently:

```typescript
subagent({ name: "Scout: Auth", agent: "scout", task: "Analyze auth module" });
subagent({ name: "Scout: DB", agent: "scout", task: "Map database schema" });
// Both return immediately, results steer back independently
```

## Install

```bash
pi install git:github.com/HazAT/pi-interactive-subagents
```

Supported multiplexers:

- [cmux](https://github.com/manaflow-ai/cmux)
- [tmux](https://github.com/tmux/tmux)
- [zellij](https://zellij.dev)
- [WezTerm](https://wezfurlong.org/wezterm/) (terminal emulator with built-in multiplexing)

Start pi inside one of them:

```bash
cmux pi
# or
tmux new -A -s pi 'pi'
# or
zellij --session pi   # then run: pi
# or
# just run pi inside WezTerm — no wrapper needed
```

Optional: set `PI_SUBAGENT_MUX=cmux|tmux|zellij|wezterm` to force a specific backend.

## What's Included

### Extensions

**Subagents** — 5 parent tools, 1 child lifecycle tool + 3 commands:

| Tool              | Description                                                                     |
| ----------------- | ------------------------------------------------------------------------------- |
| `subagent`        | Spawn a sub-agent in a dedicated multiplexer pane (async — returns immediately) |
| `subagents_list`  | List available agent definitions                                                |
| `set_tab_title`   | Update tab/window title to show progress                                        |
| `subagent_resume` | Resume a previous sub-agent session (async)                                     |
| `subagent_kill`   | Cancel running sub-agents                                                       |
| `subagent_done`   | Child-only structured completion/shutdown tool                                  |

| Command                    | Description                          |
| -------------------------- | ------------------------------------ |
| `/plan`                    | Start a full planning workflow       |
| `/iterate`                 | Fork into a subagent for quick fixes |
| `/subagent <agent> <task>` | Spawn a named agent directly         |

**Session Artifacts** — 2 tools for session-scoped file storage:

| Tool             | Description                                               |
| ---------------- | --------------------------------------------------------- |
| `write_artifact` | Write plans, context, notes to a session-scoped directory |
| `read_artifact`  | Read artifacts from current or previous sessions          |

Durable task, report, and artifact files live beside their owning session at
`<session-file-without-.jsonl>/artifacts/`. They therefore move with the session
corpus instead of depending on a separate history tree.

### Bundled Agents

| Agent             | Model                  | Role                                                                                     |
| ----------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| **planner**       | Terra (medium thinking) | Brainstorming — clarifies requirements, explores approaches, writes plans, creates todos |
| **scout**         | Luna                   | Fast codebase reconnaissance — maps files, patterns, conventions                         |
| **worker**        | Sol                    | Implements tasks from todos — writes code, runs tests, makes polished commits            |
| **reviewer**      | Terra (medium thinking) | Reviews code for bugs, security issues, correctness                                      |
| **visual-tester** | Sol                    | Visual QA via Chrome CDP — screenshots, responsive testing, interaction testing          |

Agent discovery follows priority: **project-local** (`.pi/agents/`) > **global** (`~/.pi/agent/agents/`) > **package-bundled**. Override any bundled agent by placing your own version in the higher-priority location.

---

## Async Subagent Flow

```
1. Agent calls subagent()          → returns immediately ("started")
2. Child opens a real Pi TUI       → user can watch, type, and steer directly
3. Child bridge authenticates      → parent/child lifecycle moves over Unix IPC
4. User keeps chatting             → main session remains fully interactive
5. Sub-agent finishes              → structured result steered back as interrupt
6. Main agent processes result     → continues with new context
```

The multiplexer is used only to create, focus, rename, and close panes. Lifecycle, progress, completion, cancellation, and parent-issued prompts use framed IPC messages under `$XDG_RUNTIME_DIR/pi-subagents/`; no pane screen contents or shell sentinels are involved. Child connections automatically retry across parent `/reload`, and unresolved launches are reconstructed from non-context session entries.

Every new child session is pre-created with its own Pi v3 session ID, the effective
child working directory, the official `parentSession` header field, and a
non-context `subagent_metadata` entry. Forks copy only the validated active parent
branch (not the parent header or orchestration trigger). Launches, completions,
and resumed runs retain the child session ID, run correlation, and `sessionFile`.

Multiple subagents run concurrently — each steers its result back independently as it finishes. The live widget above the input tracks all running agents:

```
╭─ Subagents ──────────────────────── 3 running ─╮
│ 01:23  Scout: Auth (scout)      15 msgs (12KB) │
│ 00:45  Researcher (researcher)   8 msgs (6KB)  │
│ 00:12  Scout: DB (scout)             starting…  │
╰─────────────────────────────────────────────────╯
```

Completion messages render with a colored background and are expandable with `Ctrl+O` to show the full report, artifact paths, next steps, and session file path.

### Structured Completion Contract

By default, every sub-agent must finish by calling `subagent_done` exactly once. Exiting without a persisted `subagent_done_result` is a protocol failure, even if the process exits cleanly. Agents configured with `auto-exit: true` instead persist a bounded fallback result from their final assistant message and shut down on the first fully settled run when they did not explicitly call `subagent_done`.

```typescript
subagent_done({
  status: "success", // or "failed" | "blocked"
  summary: "Concise orchestration summary, max 2,000 chars.",
  report: "Optional expanded human-readable report shown with Ctrl+O.",
  artifacts: [
    { name: "context/auth-map.md", description: "Detailed auth flow notes" }
  ],
  nextSteps: ["Run the integration suite"]
});
```

- `status` is the task outcome: `success`, `failed`, or `blocked`.
- `summary` is required and bounded for orchestration/collapsed UI.
- `report` is optional and shown in the expanded result card; large material belongs in artifacts.
- `artifacts` reference files previously written with `write_artifact`; names are validated and rendered as paths only.
- `nextSteps` are optional structured follow-up actions.

The parent sends a structured `subagent_result` steer message after the child process exits. Its `details` distinguish lifecycle status from task status:

```typescript
{
  protocolStatus: "completed" | "failed" | "cancelled",
  result?: { status, summary, report, artifacts, nextSteps },
  protocolError?: string,
  sessionFile?: string,
  elapsed: number
}
```

---

## Spawning Subagents

```typescript
// Named agent with defaults from agent definition
subagent({ name: "Scout", agent: "scout", task: "Analyze the codebase..." });

// Fork — sub-agent gets full conversation context
subagent({ name: "Iterate", fork: true, task: "Fix the bug where..." });

// Override agent defaults
subagent({
  name: "Worker",
  agent: "worker",
  model: "anthropic/claude-haiku-4-5",
  task: "Quick fix...",
});

// Custom working directory
subagent({ name: "Designer", agent: "game-designer", cwd: "agents/game-designer", task: "..." });
```

### Parameters

| Parameter      | Type    | Default  | Description                                                             |
| -------------- | ------- | -------- | ----------------------------------------------------------------------- |
| `name`         | string  | required | Display name (shown in widget and pane title)                           |
| `task`         | string  | required | Task prompt for the sub-agent                                           |
| `agent`        | string  | —        | Load defaults from agent definition                                     |
| `fork`         | boolean | `false`  | Copy current session for full context                                   |
| `model`        | string  | —        | Override agent's default model                                          |
| `systemPrompt` | string  | —        | Append to system prompt                                                 |
| `skills`       | string  | —        | Comma-separated skill names                                             |
| `tools`        | string  | —        | Comma-separated tool names                                              |
| `cwd`          | string  | —        | Working directory for the sub-agent (see [Role Folders](#role-folders)) |

---

## The `/plan` Workflow

The `/plan` command orchestrates a full planning-to-implementation pipeline.

```
/plan Add a dark mode toggle to the settings page
```

```
Phase 1: Investigation    → Quick codebase scan
Phase 2: Planning         → Interactive planner subagent (user collaborates)
Phase 3: Review Plan      → Confirm todos, adjust if needed
Phase 4: Execute          → Scout + sequential workers implement todos
Phase 5: Review           → Reviewer subagent checks all changes
```

Tab/window titles update to show current phase:

```
🔍 Investigating: dark mode → 💬 Planning: dark mode
→ 🔨 Executing: 1/3 → 🔎 Reviewing → ✅ Done
```

---

## The `/iterate` Workflow

For quick, focused work without polluting the main session's context.

```
/iterate Fix the off-by-one error in the pagination logic
```

This forks the current session into a subagent with full conversation context. Make the fix, verify it, and exit to return. The main session gets a summary of what was done.

---

## Custom Agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global):

```markdown
---
name: my-agent
description: Does something specific
model: anthropic/claude-sonnet-4-6
thinking: minimal
tools: read, bash, edit, write
spawning: false
---

# My Agent

You are a specialized agent that does X...
```

### Frontmatter Reference

| Field         | Type    | Description                                                                                                                                                                                                                                                                 |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string  | Agent name (used in `agent: "my-agent"`)                                                                                                                                                                                                                                    |
| `description` | string  | Shown in `subagents_list` output                                                                                                                                                                                                                                            |
| `model`       | string  | Default model (e.g. `anthropic/claude-sonnet-4-6`)                                                                                                                                                                                                                          |
| `thinking`    | string  | Thinking level: `minimal`, `medium`, `high`                                                                                                                                                                                                                                 |
| `tools`       | string  | Comma-separated **native pi tools only**: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`                                                                                                                                                                             |
| `skills`      | string  | Comma-separated skill names to auto-load                                                                                                                                                                                                                                    |
| `spawning`    | boolean | Set `false` to deny all subagent-spawning tools                                                                                                                                                                                                                             |
| `deny-tools`  | string  | Comma-separated extension tool names to deny                                                                                                                                                                                                                                |
| `cwd`         | string  | Default working directory (absolute or relative to project root)                                                                                                                                                                                                            |
| `auto-exit`   | boolean | When `true`, persist the final assistant response and shut down after the initial task fully settles if `subagent_done` was not called explicitly                                                                                                                            |

---

## Tool Access Control

By default, every sub-agent can spawn further sub-agents. Control this with frontmatter:

### `spawning: false`

Denies all spawning tools (`subagent`, `subagents_list`, `subagent_resume`, `subagent_kill`):

```yaml
---
name: worker
spawning: false
---
```

### `deny-tools`

Fine-grained control over individual extension tools:

```yaml
---
name: focused-agent
deny-tools: subagent, set_tab_title
---
```

### Recommended Configuration

| Agent      | `spawning`  | Rationale                                    |
| ---------- | ----------- | -------------------------------------------- |
| planner    | _(default)_ | Legitimately spawns scouts for investigation |
| worker     | `false`     | Should implement tasks, not delegate         |
| researcher | `false`     | Should research, not spawn                   |
| reviewer   | `false`     | Should review, not spawn                     |
| scout      | `false`     | Should gather context, not spawn             |

---

## Role Folders

The `cwd` parameter lets sub-agents start in a specific directory with its own configuration:

```
project/
├── agents/
│   ├── game-designer/
│   │   └── CLAUDE.md          ← "You are a game designer..."
│   ├── sre/
│   │   ├── CLAUDE.md          ← "You are an SRE specialist..."
│   │   └── .pi/skills/        ← SRE-specific skills
│   └── narrative/
│       └── CLAUDE.md          ← "You are a narrative designer..."
```

```typescript
subagent({ name: "Game Designer", cwd: "agents/game-designer", task: "Design the combat system" });
subagent({ name: "SRE", cwd: "agents/sre", task: "Review deployment pipeline" });
```

Set a default `cwd` in agent frontmatter:

```yaml
---
name: game-designer
cwd: ./agents/game-designer
spawning: false
---
```

---

## Tools Widget

Every sub-agent session displays a compact tools widget showing available and denied tools. Toggle with `Ctrl+J`:

```
[scout] — 12 tools · 4 denied  (Ctrl+J)              ← collapsed
[scout] — 12 available  (Ctrl+J to collapse)          ← expanded
  read, bash, edit, write, todo, ...
  denied: subagent, subagents_list, ...
```

---

## Requirements

- [pi](https://github.com/badlogic/pi-mono) — the coding agent
- One supported multiplexer:
  - [cmux](https://github.com/manaflow-ai/cmux)
  - [tmux](https://github.com/tmux/tmux)
  - [zellij](https://zellij.dev)
  - [WezTerm](https://wezfurlong.org/wezterm/)

```bash
cmux pi
# or
tmux new -A -s pi 'pi'
# or
zellij --session pi   # then run: pi
# or
# just run pi inside WezTerm
```

Optional backend override:

```bash
export PI_SUBAGENT_MUX=cmux   # or tmux, zellij, wezterm
```

## License

MIT
