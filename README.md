# pi-interactive-subagents

Interactive, asynchronous subagents for [Pi](https://pi.dev). Each child runs a real Pi TUI, launched directly in a visible terminal pane without typing into an interactive shell. Focus returns immediately to the parent pane after WezTerm launches; no shell-input injection is involved. Authenticated, length-prefixed Unix-socket messages carry lifecycle and results—not terminal scraping.

```sh
pi install git:github.com/marnunez/pi-interactive-subagents
```

Pi 1.1 or newer is required for native codemode. A persistent parent session and **local WezTerm or tmux** are required for new launches. Set `PI_SUBAGENT_MUX=wezterm|tmux` to override detection. Legacy cmux/zellij discovery and cleanup remain, but new launches fail explicitly rather than falling back to unsafe terminal input.

## Visible, direct launching

- **WezTerm:** children automatically occupy dedicated tabs in the originating Pi's **same window**, at most **two child panes per tab**: first child opens a new tab, second splits it vertically, third opens another tab, and so on (five concurrent children: **2/2/1**). The parent tab stays untouched; no manual arrangement is needed. Each launch reads the live parent pane's window ID and explicitly passes `spawn --window-id`, never the active window or `--new-window`. Only a solitary, live, owned child outside the parent tab can be split. Full tabs, tabs containing foreign/completed panes and children moved to another window are skipped. Dead/completed runs are not split targets; freed capacity and moved children are re-evaluated from the live layout and this parent's active run ledger, including after reload or resume. WezTerm's CLI initially selects its new tab/pane; the extension immediately restores the verified originating Pi tab and pane before returning, including when splitting a child tab. You remain in the parent and can select a child explicitly when needed. Focus failures produce a warning without discarding the child's identity or failing a connected launch.
- **tmux:** creates a visible, detached split (`split-window -d`) targeting the originating pane, without selecting it. Automatic and optional progress titles use pane OSC naming, never `rename-window` or `rename-session`; placement is unchanged.
- Both spawn and resume derive placement from their originating pane, never whichever pane/window happens to have focus. New launches do not create hidden workspaces or switch Sway workspaces. The old `workspace` tool argument is removed and legacy agent-definition `workspace` fields no longer control placement. Old run workspace metadata remains readable for recovery.
- If live origin inspection, tab creation or splitting fails (for example, a zoomed tab or insufficient space), launch fails rather than falling back to the parent or injecting terminal input. Selection, direct launch and surface registration are synchronous within one parent process, so parallel tool calls and reload cannot reserve the same slot. No placement counters survive failures. A user moving/adding panes concurrently with the mux command is outside this transaction; the next launch re-inspects rather than rearranging user panes.
- Pi arguments and environment overrides travel through a private, one-shot launch file (0700 directory, 0600 file), not terminal input or mux command-line text. A non-interactive launcher spawns Pi with an argument vector and inherited TTY, without a shell. It forwards termination signals and reports spawn failures; it never reads typed input itself.
- There is no `send-text`, simulated Enter or arbitrary shell-readiness sleep. Focus restoration uses only an explicit `activate-pane` call targeting the verified origin, never terminal input. The two-child WezTerm limit is fixed, not configured by the removed `PI_SUBAGENT_MAX_PANES_PER_TAB`; automatic Sway switching remains removed.
- Spawn/resume first report **connecting**, then return **connected** only after the child authenticates. This confirms startup, not task completion. Cancellation and startup failure do not return a successful launch result.

### Automatic names and optional progress

Every child pane receives its launch/resume **display name automatically**, before any model request. The direct launcher emits a safe OSC title before Pi starts. The child's TUI `session_start` handler sets its own session display name through `pi.setSessionName` (only if different), then sets the initial pane title through `ctx.ui.setTitle`. Pi asynchronously rebuilds its default title after all startup handlers/provider discovery; the persisted name makes that title include the child identity, even with slow extensions. No timing workaround, polling or mandatory first-action title tool call is needed. Parent-selected identity is authoritative on child startup/reload/resume, including forked sessions and explicitly renamed resumes; a manual `/name` in the child is replaced at the next such boundary. The parent's session and tab labels are not changed.

Only the parent manages explicit WezTerm **tab labels**: `Review | Implement` for a pair, `Implement` once Review completes or is cancelled. Labels use stable display names, not child progress text. Launch, resume, parent reload, completion and cancellation re-inspect live ownership and refresh labels. Parent tabs, foreign windows and mixed/foreign tabs are not renamed; at most two wholly owned panes can contribute a label. Cosmetic title/inspection failures cannot fail a successful launch or replace its original lifecycle error.

A child can optionally call `set_pane_title({ title: "Checking logout" })`. It uses only that child's `ctx.ui.setTitle` (OSC), with no mux rename command or session/workspace/window-label operation. Progress does not rename the child session or replace its durable identity; Pi's own title-reset operations, such as reload, can clear transient progress text. An explicit tab label remains stable; a terminal's default window-title rendering may still follow its active pane. `set_tab_title` remains a **pane-only legacy alias**, recognised in explicit role definitions and saved tool snapshots, but is not added or inherited by new runs. Saved capability selections are preserved, with common codemode and handback available; excluding title tools does not prevent automatic naming. Title strings have C0/C1 controls stripped, whitespace normalised and a 160-character Unicode bound; paired names are individually bounded so both remain represented. Arguments and environment values remain literal and unchanged.

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

By default, multiple children share the parent's filesystem. Set `worktree: true` on `subagent` for an **opt-in separate Git checkout** (including a read-only child if explicitly requested). Nested delegation is supported to a maximum depth of four; a nested child needs its own `worktree: true` to get a further checkout. Finish or cancel descendants before completing their parent run.

### Opt-in Git worktrees

```typescript
subagent({ name: "Implement", agent: "worker", task: "Change and test the parser", worktree: true });
```

This requires an existing non-bare Git checkout with a commit (`HEAD`). The checkout is detached at the selected repository's current `HEAD` under its common Git directory, in `.git/pi-subagent-checkouts/<run-id>/` (or the equivalent linked-worktree common directory). Parent staged, unstaged, untracked and ignored files are **not copied**. A `cwd` override must already exist in that repository; a tracked subdirectory is mapped into the new checkout. An untracked-only subdirectory fails rather than silently starting in the parent checkout. A fresh read-only child stays in the requested cwd unless you explicitly set `worktree: true`; this feature does not infer writability from the role or tool list.

The child session header records the actual checkout cwd and its lineage metadata records the worktree root. Spawn, resume, and completion results expose `worktreePath`; the parent should review `git -C <worktreePath> status --short`, `git -C <worktreePath> diff` (and any commits), then integrate via a reviewed commit/cherry-pick or deliberate file transfer. **No automatic merge or deletion occurs after launch**, including on failure, cancellation, or completion. Resume reuses the same registered, canonical checkout and refuses to run if it is missing or replaced by a symlink; it never falls back to the parent checkout. Early setup failures only remove a registered worktree when even ignored/untracked files and tracked changes are absent; otherwise it remains for manual recovery. After integrating, remove it explicitly using `git worktree remove <worktreePath>` only after checking for uncommitted and untracked content.

This is checkout separation, **not a security sandbox**: the child has the same Unix permissions and can access other paths or run Git commands against the parent. Git hooks/config, symlinks, submodules, shared Git metadata, and tools with absolute paths can cross checkout boundaries. Pi's project trust is resolved independently for the new cwd; do not auto-approve unfamiliar project extensions. Dirty parent changes and uncommitted changes in a parent worktree are not inherited, so commit or deliberately copy prerequisites before delegating. A child working in a nested checkout should not assume its parent's uncommitted work is available.

### Mid-task messages

Use the exact `runId` from `subagent` or `subagent_resume` to contact an **active, connected child of this parent**:

```typescript
subagent_message({ runId: "<active-run-id>", message: "Please also check the error path." });
```

The tool returns only when the child acknowledges accepting the message into Pi as a **custom advisory message**. It steers an active turn or triggers a new one when idle, except that an uncorrelated advisory does not wake a child waiting for clarification; it does **not** confirm that the child read, followed, or completed the request. The stored message is marked as agent-originated, and each child receives a system-level instruction that it is not user approval. **Pi's model adapter nevertheless presents custom messages with a user role**: do not rely on the model role or this instruction as an approval boundary; actual tool permissions must require confirmation through Pi's UI. Names, past session IDs, completed runs and another parent's runs are not valid addresses. The parent retries unacknowledged messages for up to 10 seconds, including across brief IPC disconnects; a timeout or shutdown reports uncertain delivery, not success. Accepted messages are journaled by run/message ID, so retries are deduplicated across reload. Journaled messages not yet committed to the model transcript are replayed; this is not an exactly-once execution guarantee. Do not use messaging as a status poll or for non-idempotent instructions.

Agent messages and completion reports share Pi's full-width, padded tool-card layout and configured output padding. Headers show the agent's name and **update**, **question** or **reply**; questions use the pending-tool background, while updates and replies use the successful-tool background. Previews show up to three wrapped lines in the normal tool-output colour, with one consistent `Ctrl+O` expansion hint. Expansion reveals the full message, run/message IDs and the reminder that agent text is not user approval. Messaging tools show a one-line preview and distinguish receipt from an answer or task completion; delivery errors remain visible. This presentation does not alter the stored model-facing message or its routing instructions.

### Child-to-parent messages and clarification

A child can send findings without finishing its delegation:

```typescript
message_parent({ message: "The old endpoint is still in use." });
```

To ask a question and pause, call the tool **on its own**, not alongside other tools:

```typescript
message_parent({ message: "Should I preserve the old endpoint?", waitForReply: true });
```

The child journals the message before sending it. The tool waits up to 10 seconds for **receipt acknowledgement**, not the answer. `waitForReply` defaults to `false`; with `true`, the tool stops automatic follow-up and the parent shows **waiting for parent**. The pane, session and run stay open, and further child tool calls are blocked until the question is answered. This does not emit `subagent_done` or a blocked/failed result. Work already performed by other tools is not undone.

The parent receives an agent-originated steering message containing the exact run and message IDs. It can answer directly or ask the human for clarification, then reply:

```typescript
subagent_message({
  runId: "<child-run-id>",
  replyTo: "<question-message-id>",
  message: "Yes, preserve compatibility.",
});
```

Only a matching `replyTo` clears the pending question and wakes the child. An ordinary advisory is retained as context but does not release the pause. Wrong-run, stale and mismatched answers are rejected. There is one outstanding clarification per child; a human approval dialog remains a separate, higher-priority waiting state.

Messages are limited to 16,000 characters. Receipt acknowledgements, accepted messages and pending questions survive `/reload`; unacknowledged child messages and journaled-but-uncommitted model messages are replayed. Interrupted/timed-out delivery is reported as uncertain, and a pending clarification remains paused rather than silently continuing. Cancelling the delegation remains available to the parent. Full parent-process crash/adoption limitations below still apply. Both directions carry agent text, **never human approval**, even when Pi's model adapter uses a user role.

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
- An idle turn, ordinary final reply, user interruption or pause **never completes the delegation**. You can stop execution, talk to the child and redirect it while its run remains open. `auto-exit` is removed; even a legacy automatic-exit environment flag cannot turn a pause into completion.
- Parent cancellation and non-reload shutdown persist cancelled outcomes. Shutdown is retried after reconnect and waits for a `shutdown_ready` acknowledgement after descendants drain. A depth-ordered deadline provides forced cleanup using the journalled subtree, with workspace PIDs checked against their run identity before signalling. `/reload` preserves live children and re-registers lifecycle listeners.

An unexpected child exit without a result is a protocol failure; deliberate cancellation is a separate terminal outcome. A task result (`success`, `failed`, `blocked`) is distinct from parent protocol status (`completed`, `failed`, `cancelled`). Reopening after a full parent-process crash can recover persisted results, but does not guarantee adoption of still-running children: socket identity is process-scoped. Never concurrently resume the same session in separate parent processes.

Results include run/session IDs, the session path and elapsed time. The model receives the summary, artifact references and next steps; `Ctrl+O` expands the human-readable report.

## Tools and commands

- `subagent`: spawn with `name`, `task`, optional `agent`, `model`, `systemPrompt`, `skills`, `cwd`, `fork`, `worktree` (opt-in). The parent chooses a role, not an arbitrary per-call tool list.
- `subagents_list`: list effective definitions.
- `subagent_resume`: reuse a session with optional `name` and `message`. Without a message it opens interactively. Saved role/model/tools are restored; automatic exit is disabled.
- `subagent_kill`: cancel by ID, name match or `all`. Omit the target only for an explicit user request to inspect running children—not polling.
- `subagent_message`: send an advisory note or a correlated clarification answer (`replyTo`) to one connected, active child; wait for receipt, not completion.
- `message_parent`: child-only finding, warning or question; `waitForReply: true` pauses the run for a correlated answer without completing it.
- `subagent_done`: child-only terminal result.
- `set_pane_title`: optional child-only pane progress title; initial naming is automatic.
- `set_tab_title`: backward-compatible pane-only alias, available only when explicitly selected or restored from a saved selection.
- `subagent_search`: optional child-only literal file discovery/content search within the child's cwd.
- `subagent_git_inspect`: optional child-only fixed-operation Git inspection within the child's cwd.
- `write_artifact`: child-only session artifact storage.
- `read_artifact`: retrieve an artifact by name.

Commands: `/subagent <agent> <task>`, `/iterate <task>` (fork), `/plan <task>` (planning workflow). The child tools widget toggles with `Ctrl+J`.

## Agent definitions

Discovery precedence:

1. Trusted current project's `.pi/agents/<name>.md`.
2. `$PI_CODING_AGENT_DIR/agents/<name>.md` (defaults to `~/.pi/agent/agents`).
3. Bundled `agents/<name>.md`, unless the active profile's `agents/` directory contains a `.no-bundled` marker file. This lets a profile maintain an explicit catalogue without bundled roles reappearing after it removes an override. Trusted project agents still take precedence.

A configured profile never falls back to the legacy shared directory. The filename is the agent identity; `.chain.md` files are not executable agent definitions. Unknown named agents fail explicitly. Project definitions are ignored when project trust is absent.

```yaml
---
name: focused-worker
description: Implements a small verified change
model: openai-codex/gpt-6-sol
thinking: high
tools: read, bash, edit, write, todo
spawning: false
---
Implement only the delegated task. Verify it, then finish the current run with subagent_done.
```

Bundled defaults use `openai-codex/gpt-6-luna` for the scout and `openai-codex/gpt-6-sol` for the other roles. Astra is not a bundled default; selecting it requires an explicit override. Saved model selections in existing sessions are not migrated by changes to these definitions.

Supported frontmatter:

- `model`, `thinking`: model and reasoning defaults; explicit tool-call model overrides the definition.
- `tools`: **positive capability allowlist across built-ins, extension and MCP tools**. A restricted role gains nothing when an extension adds new tools; no denylist maintenance is needed. If absent, the child is a trusted peer inheriting the parent's permitted registry, regardless of which schemas are active. Nested children inherit the parent's saved permission ceiling, and role selection intersects it. Hidden tools are never inherited or granted.
- `spawning: false`: exclude the spawn/list/resume/kill/child-message family even if listed; `message_parent` remains available.
- `skills` (or `skill`): comma-separated skills to load.
- `cwd`: default working directory.
- `max-instances`: per-parent simultaneous instances for this agent.
- `env`: whitespace-separated `KEY=value` assignments; reserved run identity, policy and lease variables cannot be overridden.

`codemode`, native `tool_search`, `message_parent` and `subagent_done` form the common child interface, including for restricted roles and resumed legacy sessions. Codemode uses Pi's QuickJS sandbox and nested calls still pass through the same permission check; it does not grant additional tools. To enable codemode in primary sessions too, configure Pi's native `defaultTools`/preset selection separately.

Restricted roles must explicitly list optional capabilities such as `set_pane_title`, `write_artifact` and `read_artifact`. Trusted peers retain the ordinary artifact/title conveniences. The legacy `set_tab_title` alias is never automatically inherited; select it explicitly only for compatibility. Unknown explicit tool names fail. The bundled scout and visual tester explicitly list their artifact writer; the reviewer does not have one.

Agent bodies and `systemPrompt` supply role instructions for fresh and forked runs. Every child also receives a short common system instruction: complete the delegated task, explicitly hand it back with `subagent_done`, use `message_parent` for findings or clarification, do not treat pauses as completion, and do not treat parent-agent messages as user approval. The task message contains the task, not another copy of the protocol. Terminal layout details stay in runtime code and this README, not model instructions.

Forks copy validated active conversation history, not the parent's orchestration ledger. Resume restores the saved **capability ceiling**, adding only common codemode/discovery/parent-messaging/handback; it does not add optional conveniences, inherit new parent tools or reread changed role defaults. Version 3 snapshots store capabilities and launch settings only. Version 1/2 snapshots are validated; obsolete declaration/automatic-exit fields are discarded without broadening their saved tools. An unavailable saved extension tool, or a selection exceeding the resuming parent's ceiling, fails closed. Sessions without snapshots still resolve role defaults. Ancestor policy and lease variables are cleared before launch.

**Migration:** remove `allow-tools`, `deny-tools`, `initial-tools` and `auto-exit` from agent definitions. They now fail with an explicit configuration error rather than silently weakening a role or falling through to a broader definition. Express the intended permissions in `tools`; `tools: []` grants only codemode, native tool search, parent messaging and handback. Add `write_artifact` explicitly where a role's workflow writes artifacts. Old per-call `tools`/`initialTools` arguments are rejected; select a role instead.

### Native discovery and codemode (Pi v1)

Permissions and schema visibility are different concerns. There is no `initialTools`, declaration snapshot, branch restoration, hiding hook or retry queue. Every child gets both discovery routes: codemode's `searchTools`/`describeTool` for scripts, and native `tool_search` for normal direct calls. The latter loads matching permitted schemas into the active tool set; scripts do not need to activate schemas. `subagent_done` and `message_parent` stay model-only so scripts cannot complete or pause a delegation.

Launches pass one exact capability list to native `--tools` so unselected extension tools are absent from the registry. Pi 1.1 also treats exact names as initial declarations, even for deferred tools. At child startup, a small adapter deactivates tools whose native exposure is `deferred` or `codemode`, then ensures common codemode/handback remain reachable. It does not widen the registry, save another loadout or run before every request.

Discoveries remain active during the run and native tree navigation still works. Reload/resume starts optional schemas unloaded again; the capabilities remain available to codemode and native discovery, so no replay/retry machinery is needed. Ordinary direct-tool presentation can also use Pi's native `codemode.mode: "only"`; that setting alone does not hide explicitly activated deferred schemas.

Unselected MCP tools/resources are explicitly excluded where Pi's implicit MCP retention would otherwise bypass the registry selection. A call-time check enforces the saved capability ceiling equally on direct and nested calls, even if an extension changes active tools. Discovery and role selection cannot expand a nested child's permissions.

**These are capability-selection controls, not a sandbox.** Bash and extensions run with the same Unix-user authority as Pi. Neither profiles nor tool allowlists provide filesystem isolation.

### Read-only reviewer inspection

The bundled reviewer uses `read, subagent_search, subagent_git_inspect`, with `spawning: false`; the artifact writer is absent from its positive allowlist. It has **no Bash, test runner or artifact writer**. Reviews are returned through `subagent_done.report`. Profile/project reviewer definitions override this default and must be updated explicitly if they still grant Bash. Reviewer findings should distinguish inspected test evidence from checks actually executed by a worker.

These inspection names are recognised in explicit `tools` lists even though they are not registered in the parent. They are not automatically added to top-level general children. A nested child may inherit them only within its parent's saved ceiling. Child registration requires a run identity and selected capability; legacy process denials remain honoured during upgrades but new launches do not generate denylists. Common codemode/handback and `spawning: false` remain in force. `worktree: true` still works independently of role selection.

```typescript
subagent_search({ operation: "files", path: "src", query: ".ts" });
subagent_search({ operation: "content", path: "src", query: "resolveChildTools", limit: 100 });
subagent_git_inspect({ operation: "status" });
subagent_git_inspect({ operation: "diff_staged", path: "src" });
subagent_git_inspect({ operation: "diff_unstaged", path: "src" });
subagent_git_inspect({ operation: "log", limit: 10 });
subagent_git_inspect({ operation: "diff_commit", commit: "HEAD" });
subagent_git_inspect({ operation: "diff_between", base: "HEAD~2", commit: "HEAD" });
```

- Search matches literal substrings using filesystem APIs, not regex/glob processing or a shell. `query` is optional for `files`, required/non-empty for `content`; `caseSensitive` defaults to true. In Git checkouts, directory searches use `git ls-files --cached --others --exclude-standard -z`: tracked files and non-ignored untracked files, including hidden files, but not ignored dependency/cache trees or untracked nested checkouts. Explicit regular files can be searched even when ignored. Only a missing Git executable or a positively identified non-repository discovery diagnostic allows a bounded filesystem fallback, which prunes `node_modules`, `.venv`, `venv`, `.cache`, `.pi/git` and nested checkouts; it does not implement arbitrary Git ignore rules. Configuration/include/gitdir failures do not fall back, even when Git exits with code 128. `.git`, discovered symlinks, non-regular, binary (NUL-containing) and >1 MiB files are skipped. Results use JSON-quoted filenames/content with line numbers. Catalogue capture is capped at 1 MiB, enumeration at 20,000 entries, content reads at 16 MiB, and result `limit` at 1–1000 (default 200). Catalogue exhaustion returns incomplete output; fallback entry-cap exhaustion fails rather than claiming completeness.
- Filenames are captured/enumerated as bytes, never lossy-decoded into paths. The complete captured Git catalogue is checked for valid UTF-8 **before any catalogue source path is opened**; invalid filename encodings refuse the directory search rather than aliasing another Unicode filename (including an ignored U+FFFD name). At the capture cap, an incomplete final filename is discarded and the result is marked incomplete. Valid UTF-8 names containing controls or literal backslashes, and other unsupported relative names, are skipped and counted during discovery without hiding unrelated matches; explicit user paths remain strict. The filesystem fallback also preserves entry bytes and skips/counts unsupported or non-UTF-8 entries.
- Git operations are strictly `status`, `log`, `diff_unstaged`, `diff_staged`, `diff_commit`, `diff_between`. Commits must be `HEAD`, `HEAD~N` (0–9999), or full 40/64-character object IDs resolving to commits—not paths, blobs, option strings or arbitrary revision expressions. `base` is required only for `diff_between`; `limit` is log-only. No raw flags, alternate cwd, pathspec magic, write operation or test execution is exposed. Paths are literal and scope diffs/status to child cwd (including a nested cwd); porcelain status filenames remain repository-root-relative. Explicitly selected symlink paths and symlink ancestors are refused, but root operations do not recursively pre-scan dependency trees. Git records discovered symlinks as link text/type changes, not dereferenced target contents; tracked directories replaced by links appear as deletions/type changes. Deleted files can still be inspected.
- Git uses `execFile` argument vectors with a minimal environment, ignoring inherited `GIT_DIR`, `GIT_WORK_TREE`, config injection, diff and pager settings. It disables system/global config, optional locks/index refresh, fsmonitor, hooks, external diff, textconv, signatures, pager, submodule inspection and rename detection. Before each Git invocation it enumerates effective `filter.*.clean`/`filter.*.process` configuration, including local includes and worktree config, then overrides every discovered driver's clean/process/smudge command and disables its `required` flag. Unsupported driver names, >512 drivers or incomplete configuration capture cause refusal, not unsafe execution. Filters are not applied, so raw worktree diffs/status may differ from normal Git results for repositories using content filters. Modern Git's `GIT_NO_LAZY_FETCH=1` disables partial-clone lazy fetching. Each subprocess has a 10-second timeout and a 1 MiB capture cap.
- Both tools cap model output, including notices, at **50 KiB / 1000 lines**, escape terminal controls, and report truncation/skips. They never write spill files. A truncated result is not a complete review; narrow paths/queries or inspect another commit. Git diffs do not include untracked file contents.

**Not a sandbox:** explicit path checks reject absolute/traversal/`.git` paths and symlinks, and search validates each discovered file and opens regular files with `O_NOFOLLOW`. They cannot protect against hostile concurrent ancestor replacement, filter/config changes between enumeration and execution, or hard links. Git intentionally reads repository metadata/local config (including linked-worktree metadata outside child cwd); Git-controlled config includes/object alternates can also read external metadata. Trust the Git executable and repository metadata. Other selected tools—including built-in `read`, artifact storage and project extensions—retain their normal authority. Checkout isolation is unchanged and is not a permission boundary.

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
# Optional native Pi v1 integration; absolute path to the SDK from the installation to test:
PI_OFFLINE=1 PI_V1_SDK_PATH=/path/to/pi/dist/index.js npm run test:pi-v1
```

The Pi v1 integration uses a scripted local faux provider: no remote model calls, user credentials, live services or GUI operations. It verifies native tool selection/search and direct/nested codemode execution, filtering of forbidden extension/MCP tools, late permitted tools, tree navigation, reload and resume, without custom discovery snapshots. It also verifies clarification pauses, advisory non-wakeup and correlated reply wakeup after reload against the native tool loop. Standard regressions cover legacy launch migration, positive role allowlists, new extensions not widening restricted roles, nested ceilings, obsolete argument rejection and pauses/interruption never completing a delegation.

Tests cover session lineage, run-scoped persistence, completion retry/acknowledgement, reload recovery, cancellation, nested orchestration sockets, tool policy, profile discovery, artifacts and UI-state monitoring. Inspection regressions cover explicit child role selection, saved allowlists on resume, literal search, adversarial paths/args, bounded output, symlinks, nested cwd and linked worktrees, huge ignored dependency/nested trees, tracked links and directory-to-link replacements, hostile inherited Git environment, disabled execution hooks/diff/textconv/clean/process filters (including local, conditional and worktree config), unchanged index bytes/mtime, invalid-byte filename/ignored-Unicode alias prevention, discovered control/backslash names, malformed-config refusal without ignored-secret fallback, and catalogue overflow. Launch/resume integration tests execute fake mux/Pi processes with real IPC: they assert journal-before-execution, direct argument handling, five concurrent children packed 2/2/1 in the origin window with parent/foreign panes untouched, direct targeted launch failures, reload, resume, startup acknowledgement and cancellation. Unit tests cover live moves, dead/completed children, foreign windows, full/mixed tabs and unchanged tmux argv. No paid model calls or live desktop operations are used.

An explicit, optional real-GUI test creates a **separate Xvfb display and WezTerm instance**. It verifies five children occupy dedicated tabs **2/2/1 in the same origin window**, names appear without model calls, the GUI renders combined labels and the surviving child's name after completion, and pane progress leaves shared labels unchanged. Parent/foreign titles and geometry, literal arguments/environment, control-sequence sanitisation and absence of launch typing are checked. It verifies real keyboard input still reaches the parent after every launch, then explicitly selects a child and sends deliberate input:

```sh
# Requires wezterm, xvfb-run and xdotool on PATH; never targets the desktop display.
node test/isolated-visible.mjs
# Also exercise the installed Pi CLI with this checkout's extensions, offline,
# in a fresh session, reload and resume. Exercises both progress tool names
# via explicit test commands. No task prompt or model request is sent.
PI_REAL_STARTUP_SMOKE=1 node test/isolated-visible.mjs
```

The actual Pi smoke adds a deliberately slow later startup handler to reproduce the asynchronous default-title reset. A completion marker and exact post-reset title assertion reject transient bootstrap-title success. Fresh launch, reload and an explicitly renamed resume must retain the child identity; progress remains pane-only.

Keep actual Pi smoke sessions outside the extension checkout: Pi auto-discovers this package there, so loading another installed copy can produce duplicate-tool errors.

### Module boundaries

`pi-extension/subagents/index.ts` only wires together a fresh per-parent runtime and registrations:

- `launch.ts`, `worktree.ts`, `launch-process.ts/.mjs`, `terminal-launch.ts`, `terminal-title.mjs`: session preparation, opt-in Git checkout, private direct process launch, safe pane titles and parent-owned dedicated tab labels.
- `controller.ts`, `runtime.ts`, `types.ts`: orchestration, recovery, cancellation, IPC events and instance-owned state.
- `message-tool.ts`, `parent-messages.ts`: addressed messaging, clarification correlation, durable inbox/outbox recovery and receipt acknowledgement.
- `spawn-tool.ts`, `resume-tool.ts`, `management-tools.ts`, `commands.ts`: tool/command registration and input handling.
- `presentation.ts`, `widget.ts`, `renderers.ts`: result text, status widgets and TUI rendering.
- `config.ts`, `policy.ts`, `launch-config.ts`: agent discovery, capabilities, guidance and resume settings.
- `inspection.ts`, `inspection-tools.ts`: bounded read-only filesystem/Git operations and explicitly selected child-only registration.
- `ipc.ts`, `session.ts`, `run-ledger.ts`, `termination.ts`, `subagent-done.ts`: transport, persistence, subtree cleanup and child lifecycle.

MIT. Originally based on HazAT/pi-interactive-subagents.
