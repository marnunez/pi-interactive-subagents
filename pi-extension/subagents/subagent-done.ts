/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a mandatory structured `subagent_done` lifecycle tool
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const defineTool = <T>(tool: T): T => tool;
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  findLastAssistantMessage,
  SUBAGENT_DONE_RESULT_TYPE,
  type SessionEntry,
  type SubagentArtifactRef,
  type SubagentDoneResult,
} from "./session.ts";
import { ChildIpcClient, type IpcEnvelope } from "./ipc.ts";

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
type DoneParamsValue = Static<typeof DoneParams>;

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
  params: DoneParamsValue,
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
  let completionSent = false;
  let latestCtx: ExtensionContext | null = null;

  // Read subagent identity and IPC configuration from env vars set by the parent.
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const childId = process.env.PI_SUBAGENT_ID ?? "";
  const socketPath = process.env.PI_SUBAGENT_SOCKET ?? "";
  const token = process.env.PI_SUBAGENT_TOKEN ?? "";
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const lockedModel = process.env.PI_SUBAGENT_MODEL;
  const lockedThinking = process.env.PI_SUBAGENT_THINKING;
  const lockedTools = (process.env.PI_SUBAGENT_TOOLS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const ipc = childId && socketPath && token
    ? new ChildIpcClient({
        socketPath,
        childId,
        token,
        helloPayload: () => ({
          pid: process.pid,
          name: subagentName,
          agent: subagentAgent || undefined,
          sessionId: latestCtx?.sessionManager.getSessionId(),
          sessionFile: latestCtx?.sessionManager.getSessionFile(),
          model: latestCtx?.model
            ? `${latestCtx.model.provider}/${latestCtx.model.id}`
            : undefined,
          autoExit,
        }),
        onMessage: (message: IpcEnvelope) => {
          const payload = message.payload as { text?: string } | undefined;
          if (message.type === "prompt" && payload?.text) {
            if (latestCtx?.isIdle()) pi.sendUserMessage(payload.text);
            else pi.sendUserMessage(payload.text, { deliverAs: "followUp" });
          } else if (message.type === "steer" && payload?.text) {
            pi.sendUserMessage(payload.text, { deliverAs: "steer" });
          } else if (message.type === "follow_up" && payload?.text) {
            pi.sendUserMessage(payload.text, { deliverAs: "followUp" });
          } else if (message.type === "abort") {
            void latestCtx?.abort();
          } else if (message.type === "shutdown") {
            void latestCtx?.abort();
            latestCtx?.shutdown();
          } else if (message.type === "ping") {
            ipc?.send("pong", { timestamp: Date.now() });
          }
        },
      })
    : null;

  function persistAndSendCompletion(result: SubagentDoneResult): void {
    if (completionSent) throw new Error("subagent_done has already been called for this run.");
    completionSent = true;
    pi.appendEntry(SUBAGENT_DONE_RESULT_TYPE, result);
    ipc?.send("completion", result);
  }

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

  // Show widget + status bar and establish the parent IPC connection.
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    completionSent = false;
    ipc?.start();
    ipc?.send("ready", {
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
    });

    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    renderWidget(ctx, null);
  });

  // Reassert parent-selected model and tools after all startup extensions (including presets) ran.
  pi.on("before_agent_start", async () => {
    if (lockedModel?.includes("/")) {
      const slash = lockedModel.indexOf("/");
      const provider = lockedModel.slice(0, slash);
      const modelId = lockedModel.slice(slash + 1);
      const model = latestCtx?.modelRegistry.find(provider, modelId);
      if (model && (latestCtx?.model?.provider !== provider || latestCtx.model.id !== modelId)) {
        await pi.setModel(model);
      }
    }
    if (lockedThinking) pi.setThinkingLevel(lockedThinking as any);
    if (lockedTools.length > 0) pi.setActiveTools(lockedTools);
  });

  pi.on("agent_start", () => {
    ipc?.send("running", { timestamp: Date.now() });
  });

  pi.on("message_end", (_event, ctx) => {
    ipc?.send("activity", {
      entries: ctx.sessionManager.getEntries().length,
      timestamp: Date.now(),
    });
  });

  pi.on("agent_settled", (_event, ctx) => {
    ipc?.send("settled", { timestamp: Date.now(), autoExit });
    if (!autoExit || completionSent) return;

    const entries = ctx.sessionManager.getEntries() as unknown as SessionEntry[];
    const report = findLastAssistantMessage(entries) ?? "Subagent settled without a textual final response.";
    const boundedReport = report
      .split("\n")
      .slice(0, MAX_REPORT_LINES)
      .join("\n")
      .slice(0, MAX_REPORT_CHARS)
      .trim();
    const summary = boundedReport.slice(0, MAX_SUMMARY_CHARS).trim() || "Subagent task settled.";
    const result: SubagentDoneResult = {
      schemaVersion: 1,
      status: "success",
      summary,
      report: boundedReport === summary ? undefined : boundedReport,
      completedAt: new Date().toISOString(),
    };
    persistAndSendCompletion(result);
    setTimeout(() => ctx.shutdown(), 0);
  });

  pi.on("session_shutdown", (event, ctx) => {
    ipc?.send("shutdown", {
      reason: event.reason,
      sessionId: ctx.sessionManager.getSessionId(),
      completionSent,
    });
    if (event.reason !== "reload") latestCtx = null;
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
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as DoneParamsValue;
      if (completionSent) {
        throw new Error("subagent_done has already been called for this run.");
      }

      const project = basename(ctx.cwd);
      const sessionId = ctx.sessionManager.getSessionId();
      const artifactDir = join(homedir(), ".pi", "history", project, "artifacts", sessionId);
      const validated = validateSubagentDoneParams(params, artifactDir);
      const result: SubagentDoneResult = {
        ...validated,
        completedAt: new Date().toISOString(),
      };

      persistAndSendCompletion(result);

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
