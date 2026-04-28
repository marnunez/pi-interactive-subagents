/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a mandatory structured `subagent_done` lifecycle tool
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "@mariozechner/pi-ai";

const defineTool = <T>(tool: T): T => tool;
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  SUBAGENT_DONE_RESULT_TYPE,
  type SessionEntry,
  type SubagentArtifactRef,
  type SubagentDoneResult,
} from "./session.ts";

const MAX_SUMMARY_CHARS = 2_000;
const MAX_REPORT_CHARS = 50 * 1024;
const MAX_REPORT_LINES = 2_000;
const MAX_ARTIFACTS = 20;
const MAX_ARTIFACT_NAME_CHARS = 512;
const MAX_ARTIFACT_DESCRIPTION_CHARS = 500;
const MAX_NEXT_STEPS = 20;
const MAX_NEXT_STEP_CHARS = 500;

const DoneParams = Type.Object({
  status: Type.Union(
    [Type.Literal("success"), Type.Literal("failed"), Type.Literal("blocked")],
    {
      description:
        "Required task status: success = completed as requested; failed = completed the attempt but the objective/check failed; blocked = cannot proceed without external input or environment changes.",
    },
  ),
  summary: Type.String({
    minLength: 1,
    maxLength: MAX_SUMMARY_CHARS,
    description:
      "Required concise result for orchestration and collapsed UI. Maximum 2,000 characters.",
  }),
  report: Type.Optional(
    Type.String({
      maxLength: MAX_REPORT_CHARS,
      description:
        "Optional full human-readable result shown when the parent expands the subagent result. Maximum 50 KiB / 2,000 lines.",
    }),
  ),
  artifacts: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String({
          minLength: 1,
          maxLength: MAX_ARTIFACT_NAME_CHARS,
          description:
            "Session artifact name previously written with write_artifact, e.g. context/auth-map.md. Must be relative and exist.",
        }),
        description: Type.Optional(
          Type.String({
            maxLength: MAX_ARTIFACT_DESCRIPTION_CHARS,
            description: "Optional short description of the artifact.",
          }),
        ),
      }),
      { maxItems: MAX_ARTIFACTS },
    ),
  ),
  nextSteps: Type.Optional(
    Type.Array(
      Type.String({
        minLength: 1,
        maxLength: MAX_NEXT_STEP_CHARS,
        description: "Optional recommended follow-up action.",
      }),
      { maxItems: MAX_NEXT_STEPS },
    ),
  ),
});

function hasExistingDoneResult(entries: SessionEntry[]): boolean {
  return entries.some(
    (entry) => entry.type === "custom" && entry.customType === SUBAGENT_DONE_RESULT_TYPE,
  );
}

function lineCount(text: string): number {
  return text.split("\n").length;
}

function assertBoundedString(value: unknown, label: string, maxChars: number, required = false) {
  if (value == null) {
    if (required) throw new Error(`${label} is required.`);
    return;
  }
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  if (required && value.trim() === "") throw new Error(`${label} cannot be empty.`);
  if (value.length > maxChars) {
    throw new Error(`${label} is too long (${value.length}/${maxChars} characters).`);
  }
}

function resolveArtifact(artifactDir: string, name: string): string {
  if (isAbsolute(name)) throw new Error(`Artifact name must be relative: ${name}`);
  const resolved = resolve(artifactDir, name);
  const rel = relative(artifactDir, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Artifact name escapes the artifact directory: ${name}`);
  }
  if (!existsSync(resolved)) {
    throw new Error(`Listed artifact does not exist: ${name}`);
  }
  if (!statSync(resolved).isFile()) {
    throw new Error(`Listed artifact is not a file: ${name}`);
  }
  return resolved;
}

export function validateSubagentDoneParams(
  params: typeof DoneParams.static,
  artifactDir: string,
): Omit<SubagentDoneResult, "completedAt"> {
  if (params.status !== "success" && params.status !== "failed" && params.status !== "blocked") {
    throw new Error('status must be one of "success", "failed", or "blocked".');
  }

  assertBoundedString(params.summary, "summary", MAX_SUMMARY_CHARS, true);
  assertBoundedString(params.report, "report", MAX_REPORT_CHARS);
  if (params.report && lineCount(params.report) > MAX_REPORT_LINES) {
    throw new Error(`report has too many lines (${lineCount(params.report)}/${MAX_REPORT_LINES}).`);
  }

  if (params.artifacts && params.artifacts.length > MAX_ARTIFACTS) {
    throw new Error(`artifacts has too many entries (${params.artifacts.length}/${MAX_ARTIFACTS}).`);
  }

  const artifacts: SubagentArtifactRef[] | undefined = params.artifacts?.map((artifact) => {
    assertBoundedString(artifact.name, "artifact.name", MAX_ARTIFACT_NAME_CHARS, true);
    assertBoundedString(
      artifact.description,
      "artifact.description",
      MAX_ARTIFACT_DESCRIPTION_CHARS,
    );
    return {
      name: artifact.name,
      description: artifact.description,
      path: resolveArtifact(artifactDir, artifact.name),
    };
  });

  if (params.nextSteps && params.nextSteps.length > MAX_NEXT_STEPS) {
    throw new Error(`nextSteps has too many entries (${params.nextSteps.length}/${MAX_NEXT_STEPS}).`);
  }
  params.nextSteps?.forEach((step, index) => {
    assertBoundedString(step, `nextSteps[${index}]`, MAX_NEXT_STEP_CHARS, true);
  });

  return {
    schemaVersion: 1,
    status: params.status,
    summary: params.summary,
    report: params.report,
    artifacts,
    nextSteps: params.nextSteps,
    artifactBaseDir: artifactDir,
  };
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    renderWidget(ctx, null);
  });

  // Toggle expand/collapse with Ctrl+J
  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool(defineTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Mandatory lifecycle tool for sub-agents. Call exactly once when the task is complete, failed, or blocked. " +
      "Persists a structured result for the parent orchestrator and then shuts this sub-agent session down. " +
      "Exiting without calling this tool is a protocol failure.",
    parameters: DoneParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const entries = ctx.sessionManager.getEntries() as unknown as SessionEntry[];
      if (hasExistingDoneResult(entries)) {
        throw new Error("subagent_done has already been called for this session.");
      }

      const project = basename(ctx.cwd);
      const sessionId = ctx.sessionManager.getSessionId();
      const artifactDir = join(homedir(), ".pi", "history", project, "artifacts", sessionId);
      const validated = validateSubagentDoneParams(params, artifactDir);
      const result: SubagentDoneResult = {
        ...validated,
        completedAt: new Date().toISOString(),
      };

      pi.appendEntry(SUBAGENT_DONE_RESULT_TYPE, result);

      setTimeout(() => ctx.shutdown(), 0);

      return {
        content: [
          {
            type: "text",
            text: `Subagent result persisted with status "${result.status}". Shutting down.`,
          },
        ],
        details: { persisted: true, status: result.status },
      };
    },
  }));
}
