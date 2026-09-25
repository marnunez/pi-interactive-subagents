---
name: plan
description: Interactive planning and implementation through asynchronous Pi subagents.
---

# Planning workflow

1. Briefly inspect the project with read/bash. Delegate deeper reconnaissance to a scout if useful.
2. Spawn a planner with the user's task, constraints and your findings. The user can work directly in its terminal.
3. Do independent work or end the current turn silently. Never poll children. A planner asking the user a question remains open; its answer is not completion.
4. After the planner calls `subagent_done`, read its plan using `read_artifact` and inspect the todos. Confirm implementation scope with the user.
5. Delegate implementation to workers. Use sequential workers in a shared worktree, or clearly partition files/use separate worktrees for concurrent tasks. Require checks and explicit completion results.
6. Delegate review. State whether the reviewer may edit or must report findings only. Address substantive findings and verify again.

```typescript
subagent({ name: "Planner", agent: "planner", task: "Plan the requested change. Context: ..." });
// Later, after the completion event and user approval:
subagent({ name: "Worker", agent: "worker", task: "Implement TODO-xxxx. Plan artifact: plans/feature.md. Run the relevant tests." });
```

All subagents are interactive; there is no `interactive` parameter. Use descriptive names and child `set_tab_title` for progress. Do not instruct users to close the planner with Ctrl+D as a substitute for completion: the planner should finish its current run with `subagent_done` and reference the plan and todo IDs. The same session can be resumed later for revisions.

Before declaring the overall work complete, verify requested changes, checks, todo status, review findings and publication requirements. Never infer success merely because a child stopped speaking.
