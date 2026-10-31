/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a mandatory structured `subagent_done` lifecycle tool
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { COMMON_CHILD_TOOLS, type ToolMetadata } from "./config.ts";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { registerInspectionTools } from "./inspection-tools.ts";
import { terminalTitle } from "./terminal-title.mjs";

const defineTool = <T>(tool: T): T => tool;
import {
  getSessionArtifactDir,
  resolveExistingArtifactPath,
} from "../session-artifacts/paths.ts";
import {
  readRunCompletion,
  SUBAGENT_DONE_RESULT_TYPE,
  type SubagentArtifactRef,
  type SubagentDoneResult,
} from "./session.ts";
import { ChildIpcClient, type IpcEnvelope } from "./ipc.ts";
import { ChildParentMessages } from "./parent-messages.ts";
import { registerParentMessageRenderer } from "./message-renderers.ts";
import {
  monitorExtensionUi,
  PendingExtensionUiRequests,
} from "./ui-monitor.ts";

const MAX_SUMMARY_CHARS = 2_000;
const MAX_REPORT_CHARS = 50 * 1024;
const MAX_REPORT_LINES = 2_000;
const MAX_ARTIFACTS = 20;
const MAX_ARTIFACT_NAME_CHARS = 512;
const MAX_ARTIFACT_DESCRIPTION_CHARS = 500;
const MAX_NEXT_STEPS = 20;
const MAX_NEXT_STEP_CHARS = 500;
const COMPLETION_RETRY_MS = 250;
const COMPLETION_ACK_TIMEOUT_MS = 10_000;

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
      path: resolveExistingArtifactPath(artifactDir, artifact.name),
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
  registerInspectionTools(pi);
  registerParentMessageRenderer(pi);
  let denied: string[] = [];
  let expanded = false;
  let completionSent = false;
  let pendingChildren = 0;
  let unsubscribeChildren: (() => void) | undefined;
  const registerChildListener = () => {
    unsubscribeChildren?.();
    unsubscribeChildren = pi.events?.on("subagent:children", (count: unknown) => {
      if (typeof count === "number") pendingChildren = count;
    });
  };
  const refreshChildren = () => pi.events?.emit("subagent:children-query", undefined);
  let pendingCompletion: SubagentDoneResult | null = null;
  let completionRetryTimer: ReturnType<typeof setInterval> | null = null;
  let completionTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let completionShutdownRequested = false;
  let latestCtx: ExtensionContext | null = null;
  let runState: "idle" | "running" = "idle";
  let stopUiMonitor: (() => void) | null = null;
  const pendingUiRequests = new PendingExtensionUiRequests();
  let parentMessages: ChildParentMessages | undefined;

  // Read subagent identity and IPC configuration from env vars set by the parent.
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const runId = process.env.PI_SUBAGENT_ID ?? "";
  const socketPath = process.env.PI_SUBAGENT_SOCKET ?? "";
  const token = process.env.PI_SUBAGENT_TOKEN ?? "";
  const autoExit = false; // Legacy metadata only; idle never completes a delegation.
  const lockedModel = process.env.PI_SUBAGENT_MODEL;
  const lockedThinking = process.env.PI_SUBAGENT_THINKING;
  // Permissions are independent of Pi's active declarations and native discovery.
  // Do not broaden a saved ceiling (including old policies without codemode).
  const toolsCsv = process.env.PI_SUBAGENT_TOOLS;
  const allowedTools = toolsCsv === undefined ? null : new Set([
    ...toolsCsv.split(",").map((value) => value.trim()).filter(Boolean),
    "subagent_done", "message_parent",
  ]);

  const ensureCommonTools = () => {
    const active = pi.getActiveTools();
    const missing = pi.getAllTools().map((tool) => tool.name).filter((name) =>
      COMMON_CHILD_TOOLS.some((tool) => tool === name)
      && (!allowedTools || allowedTools.has(name)) && !active.includes(name));
    if (missing.length) pi.setActiveTools([...active, ...missing]);
  };

  const ipc = runId && socketPath && token
    ? new ChildIpcClient({
        socketPath,
        childId: runId,
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
          state: pendingUiRequests.snapshot().pendingUiRequestCount > 0 ? "waiting_input" : parentMessages?.waitingForReply ? "waiting_parent" : runState,
          pendingParentRequestId: parentMessages?.waitingForReply,
          ...pendingUiRequests.snapshot(),
        }),
        onConnect: () => {
          if (pendingCompletion) ipc?.send("completion", pendingCompletion);
          parentMessages?.reconnect();
        },
        onMessage: (message: IpcEnvelope) => {
          // Only the authenticated parent's socket may steer this run. A parent
          // message is an advisory custom message, never a user instruction or approval.
          if (message.childId !== runId) return;
          const payload = message.payload as { text?: string; runId?: string; messageId?: string } | undefined;
          if (
            message.type === "completion_ack" &&
            payload?.runId === runId &&
            pendingCompletion?.runId === runId
          ) {
            pendingCompletion = null;
            clearCompletionDeliveryTimers();
            requestCompletionShutdown();
          } else if (message.type === "child_message_ack") {
            parentMessages?.acknowledge(payload);
          } else if (message.type === "parent_message") {
            parentMessages?.receive(message.payload);
          } else if (message.type === "abort") {
            void latestCtx?.abort();
          } else if (message.type === "shutdown") {
            void (async () => {
              await latestCtx?.abort();
              requestCompletionShutdown();
            })();
          } else if (message.type === "ping") {
            ipc?.send("pong", { timestamp: Date.now() });
          }
        },
      })
    : null;

  if (ipc) {
    parentMessages = new ChildParentMessages(pi, runId,
      (type, payload) => ipc.send(type, payload), () => !!latestCtx && !completionSent);
    parentMessages.register();
  }

  function clearCompletionDeliveryTimers(): void {
    if (completionRetryTimer) clearInterval(completionRetryTimer);
    if (completionTimeoutTimer) clearTimeout(completionTimeoutTimer);
    completionRetryTimer = null;
    completionTimeoutTimer = null;
  }

  async function drainDescendants(): Promise<void> {
    const request = { pending: [] as Promise<void>[] };
    pi.events?.emit("subagent:drain", request);
    await Promise.all(request.pending);
  }

  function requestCompletionShutdown(): void {
    if (completionShutdownRequested) return;
    completionShutdownRequested = true;
    void drainDescendants().then(() => {
      ipc?.send("shutdown_ready", { runId });
      latestCtx?.shutdown();
    });
  }

  function beginCompletionDelivery(result: SubagentDoneResult): void {
    clearCompletionDeliveryTimers();
    pendingCompletion = result;
    ipc?.send("completion", result);
    completionRetryTimer = setInterval(() => {
      if (pendingCompletion) ipc?.send("completion", pendingCompletion);
    }, COMPLETION_RETRY_MS);
    completionTimeoutTimer = setTimeout(() => {
      pendingCompletion = null;
      clearCompletionDeliveryTimers();
      requestCompletionShutdown();
    }, COMPLETION_ACK_TIMEOUT_MS);
  }

  function persistAndDeliverCompletion(result: SubagentDoneResult): void {
    if (completionSent) throw new Error("subagent_done has already been called for this run.");
    if (!runId) throw new Error("subagent_done requires PI_SUBAGENT_ID for run correlation.");
    pi.appendEntry(SUBAGENT_DONE_RESULT_TYPE, result);
    completionSent = true;
    beginCompletionDelivery(result);
  }

  function cleanupSessionResources(): void {
    clearCompletionDeliveryTimers();
    parentMessages?.stop();
    pendingCompletion = null;
    stopUiMonitor?.();
    stopUiMonitor = null;
    pendingUiRequests.reset();
    ipc?.stop();
    latestCtx = null;
  }

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const toolNames = pi.getActiveTools().slice().sort();
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

  // Show widget + status bar, observe generic Pi UI requests, and establish parent IPC.
  pi.on("session_start", (_event, ctx) => {
    cleanupSessionResources();
    registerChildListener();
    latestCtx = ctx;
    if (runId && ctx.mode === "tui") {
      const title = terminalTitle(subagentName);
      // Pi rebuilds its default title after awaiting all startup handlers and
      // provider discovery. Persist the child identity rather than racing that
      // reset with setImmediate. Only this child session is named; reloads do
      // not append duplicates, and a renamed resume adopts the new run name.
      try {
        if (pi.getSessionName() !== title) pi.setSessionName(title);
      } catch { /* Cosmetic only; never interrupt IPC or task lifecycle. */ }
      try { ctx.ui.setTitle(title); } catch { /* Cosmetic only. */ }
    }
    completionShutdownRequested = false;
    runState = ctx.isIdle() ? "idle" : "running";

    const sessionFile = ctx.sessionManager.getSessionFile();
    const persistedCompletion = sessionFile && runId
      ? readRunCompletion(sessionFile, runId)
      : undefined;
    completionSent = !!persistedCompletion;
    if (!completionSent) parentMessages?.start(ctx.sessionManager.getEntries());

    stopUiMonitor = monitorExtensionUi(ctx.ui, (event) => {
      if (event.phase === "started") {
        pendingUiRequests.start(event.request);
        ipc?.send("ui_request", {
          ...event.request,
          pendingUiRequestCount: pendingUiRequests.snapshot().pendingUiRequestCount,
        });
        return;
      }
      pendingUiRequests.resolve(event.request.id);
      ipc?.send("ui_request_resolved", {
        id: event.request.id,
        state: latestCtx?.isIdle() ? "idle" : runState,
        pendingUiRequestCount: pendingUiRequests.snapshot().pendingUiRequestCount,
        resolvedAt: Date.now(),
      });
    });

    // Native --tools also declares exact names, although this launch list is a
    // capability ceiling. Honour extension exposure once at startup; after that
    // native discovery owns declarations. No saved loadout or per-turn reset.
    const deferred = new Set((pi.getAllTools() as ToolMetadata[]).filter((tool) =>
      tool.exposure === "deferred" || tool.exposure === "codemode").map((tool) => tool.name));
    const active = pi.getActiveTools();
    if (active.some((name) => deferred.has(name))) pi.setActiveTools(active.filter((name) => !deferred.has(name)));
    ensureCommonTools();

    ipc?.start();
    ipc?.send("ready", {
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile,
      state: parentMessages?.waitingForReply ? "waiting_parent" : runState,
      pendingParentRequestId: parentMessages?.waitingForReply,
      ...pendingUiRequests.snapshot(),
    });
    if (persistedCompletion) beginCompletionDelivery(persistedCompletion);

    denied = (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    renderWidget(ctx, null);
  });

  // Reassert parent-selected model settings after startup presets ran.
  // Pi alone owns tool discovery and visibility throughout the session.
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
    ensureCommonTools();
  });

  pi.on("agent_start", () => {
    runState = "running";
    ipc?.send("running", { timestamp: Date.now(), pendingParentRequestId: parentMessages?.waitingForReply });
  });

  pi.on("message_end", (_event, ctx) => {
    ipc?.send("activity", {
      entries: ctx.sessionManager.getEntries().length,
      timestamp: Date.now(),
    });
  });

  pi.on("agent_settled", () => {
    runState = "idle";
    // A pause, interrupt, or ordinary final reply is not a delegation result.
    // Only subagent_done can persist and deliver a terminal completion.
    ipc?.send("settled", { timestamp: Date.now(), autoExit, pendingParentRequestId: parentMessages?.waitingForReply });
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason !== "reload") {
      await drainDescendants();
      ipc?.send("shutdown_ready", { runId });
    }
    ipc?.send("shutdown", {
      reason: event.reason,
      sessionId: ctx.sessionManager.getSessionId(),
      completionSent,
    });
    cleanupSessionResources();
    unsubscribeChildren?.();
  });

  // Applies equally to direct calls and nested codemode calls, even if another
  // extension activates a forbidden tool or discovery finds its declaration.
  pi.on("tool_call", (event) => {
    if (completionSent) return { block: true, reason: "This run is already complete; resume the session as a new run.", terminate: true };
    if (parentMessages?.waitingForReply) return { block: true, reason: `Waiting for parent reply to ${parentMessages.waitingForReply}; the run is still open.`, terminate: true };
    if (allowedTools && !allowedTools.has(event.toolName)) {
      return { block: true, reason: `Tool ${event.toolName} is not allowed for this subagent run.` };
    }
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
    exposure: "model-only",
    description:
      "Send your final result back to the parent agent and finish the delegated task. " +
      "Include a summary and any detailed findings, indicating success, failure, or a blocker. " +
      "You must call this even if you cannot complete the task; an ordinary reply or pause does not finish it.",
    parameters: DoneParams,
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as DoneParamsValue;
      refreshChildren();
      if (parentMessages?.waitingForReply) throw new Error("Waiting for a parent reply; this run is not complete.");
      if (pendingChildren > 0) throw new Error("Finish or cancel this run's children before calling subagent_done.");
      if (completionSent) {
        throw new Error("subagent_done has already been called for this run.");
      }

      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        throw new Error("subagent_done requires a persisted session file for artifact validation.");
      }
      const artifactDir = getSessionArtifactDir(sessionFile);
      const validated = validateSubagentDoneParams(params, artifactDir);
      const result: SubagentDoneResult = {
        ...validated,
        runId,
        completedAt: new Date().toISOString(),
      };

      persistAndDeliverCompletion(result);

      return {
        content: [
          {
            type: "text",
            text: `Subagent result persisted with status "${result.status}". Current run complete; session remains resumable.`,
          },
        ],
        details: { persisted: true, runId, status: result.status },
        terminate: true,
      };
    },
  }));
}
