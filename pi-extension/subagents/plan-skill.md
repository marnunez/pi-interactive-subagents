---
name: plan
description: Plan a change with optional focused delegation.
---

# Planning workflow

1. Inspect the relevant project context and clarify requirements with the user where needed.
2. Compare sensible approaches, recommend one and agree on the scope before implementation.
3. Write a plan only when its complexity warrants one. Do not create todos or a fixed agent pipeline by default.
4. Delegate an independent, bounded investigation if it would save context or time. Say whether it may edit and what result to return. Use the profile's general-purpose agent if present, or omit `agent` to use inherited capabilities. Do not poll: completion arrives as an event.
5. When the user approves implementation, do the work directly or delegate clearly partitioned work. Verify changes and report remaining uncertainties.

```typescript
subagent({ name: "Investigate auth", task: "Trace authentication and report relevant code paths with file references. Do not edit files." });
```

WezTerm automatically places children in dedicated tabs in the originating Pi window, at most two child panes per tab (new tab, split, new tab). The parent tab stays untouched, and focus returns immediately to its Pi pane after each launch/resume; do not arrange panes manually. Select a child explicitly only when you want to interact with it. Pane display names are automatic at startup/resume/reload; never require a first-action model title call. The parent maintains shared tab labels from the child names (e.g. `Review | Implement`), removing finished/cancelled names. Optional child progress uses `set_pane_title` on its own pane only, not the shared tab, workspace or window. `set_tab_title` is a pane-only compatibility alias for explicit/saved selections, not a default tool for new runs. tmux placement is unchanged.

Agents share the filesystem by default; partition concurrent edits or explicitly request `worktree: true` for a separate managed Git checkout. Review and integrate child changes manually. Child completion requires `subagent_done`. Do not infer success merely because a child stops speaking.
