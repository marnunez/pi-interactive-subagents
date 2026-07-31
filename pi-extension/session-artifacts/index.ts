import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { highlightCode, getLanguageFromPath, keyHint, defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  ensureSessionArtifactDir,
  getSessionArtifactDir,
  writeArtifactFile,
  resolveArtifactPath,
  resolveExistingArtifactPath,
} from "./paths.ts";

const PREVIEW_LINES = 10;

export default function (pi: ExtensionAPI) {
  const isSubagent = !!process.env.PI_SUBAGENT_NAME;

  // write_artifact is only useful for sub-agents passing results back to the orchestrator.
  // The main session should communicate directly with the user.
  if (isSubagent)
  pi.registerTool(defineTool({
    name: "write_artifact",
    label: "Write Artifact",
    description:
      "Write a session-scoped artifact file (plan, context, research, notes, etc.). " +
      "Files are stored under the owning session's sibling <session-stem>/artifacts/ sidecar. " +
      "Use this instead of writing pi working files directly.",
    promptSnippet:
      "Write a session-scoped artifact file (plan, context, research, notes, etc.). " +
      "Files are stored under the owning session's sibling <session-stem>/artifacts/ sidecar. " +
      "Use this instead of writing pi working files directly.",
    promptGuidelines: [
      "Use write_artifact for any pi working file: plans, scout context, research notes, reviews, or other session artifacts.",
      "The name param can include subdirectories (e.g. 'context/auth-flow.md').",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Filename, e.g. 'plan.md' or 'context/auth-flow.md'" }),
      content: Type.String({ description: "File content" }),
    }),

    renderCall(args, theme) {
      const name = args.name ?? "...";
      const content = args.content ?? "";

      let text =
        theme.fg("toolTitle", theme.bold("write_artifact")) + " " + theme.fg("accent", name);

      if (content) {
        const lang = getLanguageFromPath(name);
        const lines = lang ? highlightCode(content, lang) : content.split("\n");
        const totalLines = lines.length;
        // During streaming, show preview
        const displayLines = lines.slice(0, PREVIEW_LINES);
        const remaining = totalLines - PREVIEW_LINES;

        text +=
          "\n\n" +
          displayLines
            .map((line: string) => (lang ? line : theme.fg("toolOutput", line)))
            .join("\n");

        if (remaining > 0) {
          text += theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total)`);
        }
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as { path?: string; name?: string; content?: string } | undefined;
      const name = details?.name ?? "artifact";
      const content = details?.content ?? "";

      let text = theme.fg("success", "✓") + " " + theme.fg("accent", details?.path ?? name);

      if (content) {
        const lang = getLanguageFromPath(name);
        const lines = lang ? highlightCode(content, lang) : content.split("\n");
        const totalLines = lines.length;
        const maxLines = expanded ? lines.length : PREVIEW_LINES;
        const displayLines = lines.slice(0, maxLines);
        const remaining = totalLines - maxLines;

        text +=
          "\n\n" +
          displayLines
            .map((line: string) => (lang ? line : theme.fg("toolOutput", line)))
            .join("\n");

        if (remaining > 0) {
          text +=
            theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`) +
            ` ${keyHint("app.tools.expand", "to expand")})`;        }
      }

      return new Text(text, 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        throw new Error("write_artifact requires a persisted session file.");
      }
      const artifactDir = ensureSessionArtifactDir(sessionFile);
      const filePath = writeArtifactFile(artifactDir, params.name, params.content);

      return {
        content: [{ type: "text", text: `Artifact written to: ${filePath}` }],
        details: {
          path: filePath,
          name: params.name,
          sessionId: ctx.sessionManager.getSessionId(),
          sessionFile,
          content: params.content,
        },
      };
    },
  }));

  /**
   * List sibling session artifact directories for this encoded-CWD directory.
   * The current session is always searched first; older sessions follow by mtime.
   */
  function listArtifactDirs(currentSessionFile: string): string[] {
    const absoluteSessionFile = resolve(currentSessionFile);
    const sessionDir = dirname(absoluteSessionFile);
    const currentArtifactDir = getSessionArtifactDir(absoluteSessionFile);
    const others = readdirSync(sessionDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".jsonl") &&
          join(sessionDir, entry.name) !== absoluteSessionFile,
      )
      .map((entry) => {
        const artifactDir = getSessionArtifactDir(join(sessionDir, entry.name));
        try {
          return existsSync(artifactDir)
            ? { artifactDir, mtime: statSync(artifactDir).mtimeMs }
            : null;
        } catch {
          return null;
        }
      })
      .filter((value): value is { artifactDir: string; mtime: number } => value !== null)
      .sort((a, b) => b.mtime - a.mtime)
      .map(({ artifactDir }) => artifactDir);
    return [currentArtifactDir, ...others];
  }

  function findArtifact(currentSessionFile: string, name: string): string | null {
    const artifactDirs = listArtifactDirs(currentSessionFile);
    // Validate the relative name even when no artifact directory exists yet.
    resolveArtifactPath(artifactDirs[0], name);
    for (let index = 0; index < artifactDirs.length; index++) {
      const artifactDir = artifactDirs[index];
      const candidate = resolveArtifactPath(artifactDir, name);
      if (!existsSync(candidate)) continue;
      try {
        return resolveExistingArtifactPath(artifactDir, name);
      } catch (error) {
        // The active session's sidecar must be trustworthy. A corrupt or
        // symlinked older sidecar must not prevent a safe later session from
        // satisfying the cross-session lookup.
        if (index === 0) throw error;
      }
    }
    return null;
  }

  function collectAvailableArtifacts(artifactDirs: string[]): string[] {
    const available: string[] = [];
    const collect = (baseDir: string, dir: string, prefix: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) collect(baseDir, path, relativeName);
        else if (entry.isFile()) {
          // Revalidate every discovered result before advertising it.
          resolveExistingArtifactPath(baseDir, relativeName);
          available.push(relativeName);
        }
      }
    };

    for (const artifactDir of artifactDirs) {
      if (!existsSync(artifactDir)) continue;
      try {
        collect(artifactDir, artifactDir, "");
      } catch {
        // Ignore an invalid/symlinked sidecar rather than exposing paths from it.
      }
    }
    return [...new Set(available)].sort();
  }

  pi.registerTool(defineTool({
    name: "read_artifact",
    label: "Read Artifact",
    description:
      "Read a session-scoped artifact file by name (e.g. 'plans/my-plan.md', 'context/auth.md'). " +
      "Searches the current session first, then other sessions for the same project. " +
      "Use this to read artifacts written by sub-agents or previous sessions.",
    promptSnippet:
      "Read a session-scoped artifact file by name (e.g. 'plans/my-plan.md', 'context/auth.md'). " +
      "Searches the current session first, then other sessions for the same project. " +
      "Use this to read artifacts written by sub-agents or previous sessions.",
    promptGuidelines: [
      "Use read_artifact to read files written by write_artifact — especially artifacts from sub-agents.",
      "The name param should match what was passed to write_artifact (e.g. 'plans/2026-03-16-fullstack-counter.md').",
      "When a sub-agent reports it wrote an artifact, use read_artifact to access it — don't use the read tool or bash.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description: "Artifact name, e.g. 'plan.md' or 'plans/2026-03-16-fullstack-counter.md'",
      }),
    }),

    renderCall(args, theme) {
      const name = args.name ?? "...";
      return new Text(
        theme.fg("toolTitle", theme.bold("read_artifact")) + " " + theme.fg("accent", name),
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as
        | { path?: string; name?: string; content?: string; sessionId?: string }
        | undefined;
      const name = details?.name ?? "artifact";
      const content = details?.content ?? "";

      let text = theme.fg("success", "✓") + " " + theme.fg("accent", details?.path ?? name);

      if (content) {
        const lang = getLanguageFromPath(name);
        const lines = lang ? highlightCode(content, lang) : content.split("\n");
        const totalLines = lines.length;
        const maxLines = expanded ? lines.length : PREVIEW_LINES;
        const displayLines = lines.slice(0, maxLines);
        const remaining = totalLines - maxLines;

        text +=
          "\n\n" +
          displayLines
            .map((line: string) => (lang ? line : theme.fg("toolOutput", line)))
            .join("\n");

        if (remaining > 0) {
          text +=
            theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`) +
            ` ${keyHint("app.tools.expand", "to expand")})`;
        }
      }

      return new Text(text, 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        throw new Error("read_artifact requires a persisted session file.");
      }
      const artifactDirs = listArtifactDirs(sessionFile);
      const found = findArtifact(sessionFile, params.name);

      if (!found) {
        const available = collectAvailableArtifacts(artifactDirs);
        let msg = `Artifact not found: ${params.name}`;
        if (available.length > 0) {
          msg += `\n\nAvailable artifacts:\n${available.map((name) => `  - ${name}`).join("\n")}`;
        }

        return {
          content: [{ type: "text", text: msg }],
          details: {},
        };
      }

      const content = readFileSync(found, "utf-8");

      return {
        content: [{ type: "text", text: content }],
        details: {
          path: found,
          name: params.name,
          sessionId: ctx.sessionManager.getSessionId(),
          sessionFile,
          content,
        },
      };
    },
  }));
}
