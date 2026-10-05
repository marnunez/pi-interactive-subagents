import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { boundedOutput, inspectChildGit, searchChild, type InspectionResult } from "./inspection.ts";

const path = Type.Optional(Type.String({ description: "Literal path relative to child cwd; default '.'. No absolute paths, '..', .git or symlink traversal.", maxLength: 4096 }));
const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Maximum results (default 200); Git: log only." }));
function result(value: InspectionResult) {
  const bounded = boundedOutput(`${value.limitations.join("\n")}\n\n${value.text}`);
  return {
    content: [{ type: "text" as const, text: bounded.text }],
    details: { truncated: value.truncated || bounded.truncated, limitations: value.limitations },
  };
}

// Loaded only through subagent-done.ts. Even explicitly loading that extension
// in a parent cannot grant these tools without a run identity AND explicit lock.
export function registerInspectionTools(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
  if (!env.PI_SUBAGENT_ID) return;
  const selected = new Set((env.PI_SUBAGENT_TOOLS ?? "").split(",").map((name) => name.trim()));
  const denied = new Set((env.PI_DENY_TOOLS ?? "").split(",").map((name) => name.trim()));
  if (selected.has("subagent_search") && !denied.has("subagent_search")) {
    pi.registerTool({
      name: "subagent_search", label: "Subagent Search",
      description: "Read-only child-cwd file discovery or literal content search. No regex/globs/flags or preprocessors. Directory search uses Git's tracked/non-ignored catalogue, or a dependency-pruned filesystem fallback. Skips symlinks, .git and binary/oversized files; bounded to 50 KiB/1000 lines with no output files. Narrow path/query when incomplete.",
      parameters: Type.Object({
        operation: Type.Union([Type.Literal("files"), Type.Literal("content")]),
        path,
        query: Type.Optional(Type.String({ maxLength: 1024, description: "Literal substring of relative filename (files) or lines (content). Required and non-empty for content. No regex processing." })),
        caseSensitive: Type.Optional(Type.Boolean({ description: "Default true." })),
        limit,
      }, { additionalProperties: false }),
      async execute(_id, params, signal, _update, ctx) { return result(await searchChild(ctx.cwd, params, signal)); },
    });
  }
  if (selected.has("subagent_git_inspect") && !denied.has("subagent_git_inspect")) {
    pi.registerTool({
      name: "subagent_git_inspect", label: "Subagent Git Inspect",
      description: "Read-only Git status/log/unstaged/staged/commit/range diffs within child cwd. Fixed operations only; no shell, extra flags, external diff/textconv/clean/process filters/pager/hooks/fsmonitor/index refresh. Explicitly selected symlink paths/ancestors refused; discovered links inspected as links. Output <=50 KiB/1000 lines; no spill files or test execution.",
      parameters: Type.Object({
        operation: Type.Union([Type.Literal("status"), Type.Literal("log"), Type.Literal("diff_unstaged"), Type.Literal("diff_staged"), Type.Literal("diff_commit"), Type.Literal("diff_between")]),
        path, limit,
        commit: Type.Optional(Type.String({ maxLength: 64, description: "Commit diffs only: HEAD (default), HEAD~N (0–9999), or full object ID resolving to a commit." })),
        base: Type.Optional(Type.String({ maxLength: 64, description: "Required for diff_between, using the same restricted commit syntax." })),
      }, { additionalProperties: false }),
      async execute(_id, params, signal, _update, ctx) { return result(await inspectChildGit(ctx.cwd, params, signal)); },
    });
  }
}
