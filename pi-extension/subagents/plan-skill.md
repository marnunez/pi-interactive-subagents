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

Agents share the filesystem, not isolated worktrees; partition concurrent edits or use separate worktrees. Child completion requires `subagent_done`. Do not infer success merely because a child stops speaking.
