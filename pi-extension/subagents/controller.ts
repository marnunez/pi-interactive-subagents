import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { statSync, existsSync, unlinkSync } from "node:fs";
import { waitForConnection } from "./launch-process.ts";
import { surfaceAlive } from "./terminal-launch.ts";
import { restoreRunLedger, CLOSED_ENTRY, IDENTITY_ENTRY } from "./run-ledger.ts";
import { collectOpenDescendants, terminateWorkspaceChild } from "./termination.ts";
import { closeSurface } from "./cmux.ts";
import { isSubagentDoneResult, readSubagentSessionCorrelation, readRunCompletion } from "./session.ts";
import { getIpcSocketPath, type IpcEnvelope, ParentIpcServer } from "./ipc.ts";
import { type SubagentResult, type PendingUiRequest, type RunningSubagent } from "./types.ts";
import { buildSubagentResultContent, MAX_DISPLAY_UI_REQUESTS, parsePendingUiRequest, parsePendingUiRequestCount } from "./presentation.ts";
import { type RunRuntime, IPC_FINISH_ENTRY } from "./runtime.ts";
import { createWidget } from "./widget.ts";

export function createController(pi: ExtensionAPI, runtime: RunRuntime) {
  const { updateWidget, startWidgetRefresh } = createWidget(runtime);

  const reportChildren = () => pi.events?.emit("subagent:children", runtime.runningSubagents.size);
  let unsubscribeChildren: (() => void) | undefined;
  const connectionFailureTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const serializeRunning = (running: RunningSubagent) => ({
    id: running.id,
    runId: running.runId,
    childSessionId: running.childSessionId,
    resumeOfRunId: running.resumeOfRunId,
    mode: running.mode,
    name: running.name,
    task: running.task,
    agent: running.agent,
    surface: running.surface,
    startTime: running.startTime,
    sessionFile: running.sessionFile,
    forkCleanupFile: running.forkCleanupFile,
    workspace: running.workspace,
    previousWorkspace: running.previousWorkspace,
    backgroundWorkspace: running.backgroundWorkspace,
    ipcToken: running.ipcToken,
    autoExit: running.autoExit,
    config: running.config,
    childPid: running.childPid,
  });

  const completedRuns = new Map<string, SubagentResult>();
  const cleanupTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; cleanup: (force?: boolean) => void; done: Promise<void> }>();
  let drainPromise: Promise<void> | undefined;
  const deliverResult = (result: SubagentResult) => pi.sendMessage({
    customType: "subagent_result", content: buildSubagentResultContent(result),
    display: true, details: result,
  }, { triggerTurn: true, deliverAs: "steer" });

  const finishSubagent = (result: SubagentResult, notify = true) => {
    if (!runtime.acceptIpcResults) return;
    const running = runtime.runningSubagents.get(result.id ?? "");
    const childId = result.id;
    if (!childId || !running) return;
    const correlatedResult: SubagentResult = {
      ...result,
      id: running.id,
      runId: running.runId,
      childSessionId: running.childSessionId,
      resumeOfRunId: running.resumeOfRunId,
      mode: running.mode,
      sessionFile: running.sessionFile,
    };

    // Commit the outcome BEFORE acknowledgement or process cleanup. If message
    // delivery is interrupted, startup replays this durable outbox entry.
    pi.appendEntry(IPC_FINISH_ENTRY, {
      id: childId, runId: running.runId, childSessionId: running.childSessionId,
      sessionFile: running.sessionFile, finishedAt: Date.now(), notify, pendingCleanup: true,
      result: correlatedResult,
    });
    completedRuns.set(childId, correlatedResult);
    runtime.runningSubagents.delete(childId);
    reportChildren();
    const failureTimer = connectionFailureTimers.get(childId);
    if (failureTimer) clearTimeout(failureTimer);
    connectionFailureTimers.delete(childId);
    const server = runtime.parentIpcServer;
    if (result.protocolStatus === "completed") server?.send(childId, "completion_ack", { runId: childId });
    else server?.send(childId, "shutdown", { reason: result.protocolStatus });
    // Wait for an explicit subtree-drained acknowledgement. Deeper levels have
    // shorter force-close deadlines, so an ancestor cannot pre-empt their cleanup.
    let resolveCleanup!: () => void;
    const done = new Promise<void>((resolve) => { resolveCleanup = resolve; });
    const cleanup = (force = false) => {
      if (force) {
        try {
          for (const descendant of collectOpenDescendants(running.sessionFile)) {
            if (descendant.workspace) terminateWorkspaceChild(descendant);
            else if (descendant.surface) { try { closeSurface(descendant.surface); } catch { } }
          }
        } catch (error) {
          runtime.latestCtx?.ui.notify(`Forced cleanup could not inspect descendants of ${running.name}: ${String(error)}`, "warning");
        }
      }
      running.launch?.dispose();
      server?.unregisterChild(childId);
      if (running.workspace) {
        terminateWorkspaceChild(running);
        if (running.workspaceProcess?.pid) {
          try { process.kill(running.workspaceProcess.pid, "SIGTERM"); } catch { }
        }
      } else if (running.surface) {
        try { closeSurface(running.surface); } catch { }
      }
      if (running.forkCleanupFile) {
        try { unlinkSync(running.forkCleanupFile); } catch { }
      }
      const pending = cleanupTimers.get(childId);
      if (pending) clearTimeout(pending.timer);
      cleanupTimers.delete(childId);
      pi.appendEntry(CLOSED_ENTRY, { id: childId, runId: childId, closedAt: Date.now() });
      resolveCleanup();
    };
    const graceMs = Math.max(2_000, (5 - Number(process.env.PI_SUBAGENT_DEPTH ?? "0")) * 2_000);
    cleanupTimers.set(childId, { cleanup, done, timer: setTimeout(() => cleanup(true), graceMs) });
    updateWidget();
    if (notify) deliverResult(correlatedResult);
    return done;
  };

  const awaitStartup = async (running: RunningSubagent, signal?: AbortSignal, onUpdate?: (value: any) => void) => {
    const epoch = runtime.epoch;
    const location = running.backgroundWorkspace ? ` Background WezTerm workspace: ${running.backgroundWorkspace}.` : "";
    let lastInspection = 0;
    try {
      onUpdate?.({ content: [{ type: "text", text: `Launch requested for "${running.name}"; waiting for its authenticated connection.${location}` }], details: { name: running.name, status: "connecting" } });
      await waitForConnection({
        signal,
        connected: () => runtime.epoch === epoch && running.connected === true,
        failure: () => {
          if (runtime.epoch !== epoch) return "Startup observation stopped: parent session lifecycle changed. Run recovery remains with the lifecycle controller.";
          const result = completedRuns.get(running.id);
          if (result && result.protocolStatus !== "completed") return result.protocolError ?? `Startup ${result.protocolStatus}`;
          const failure = running.launch?.failure();
          if (failure) return failure;
          if (!running.connected && Date.now() - lastInspection > 1000) {
            lastInspection = Date.now();
            if (surfaceAlive(running.surface) === false) return "Child pane exited before establishing its IPC connection. No task execution is confirmed.";
          }
          return undefined;
        },
      });
      running.launch?.dispose();
    } catch (error) {
      if (runtime.epoch !== epoch) {
        running.launch?.disposeIfConsumed();
        throw error;
      }
      finishSubagent({
        id: running.id, name: running.name, task: running.task, agent: running.agent,
        protocolStatus: signal?.aborted ? "cancelled" : "failed", protocolError: String(error),
        elapsed: Math.floor((Date.now() - running.startTime) / 1000)
      });
      throw error;
    }
  };

  const recordSurface = (running: RunningSubagent) => pi.appendEntry(IDENTITY_ENTRY, {
    id: running.id, runId: running.runId, surface: running.surface, backgroundWorkspace: running.backgroundWorkspace,
  });

  const drainChildren = (): Promise<void> => {
    if (drainPromise) return drainPromise;
    for (const running of [...runtime.runningSubagents.values()]) {
      finishSubagent({
        id: running.id, name: running.name, task: running.task, agent: running.agent,
        protocolStatus: "cancelled", protocolError: "Parent run ended.",
        elapsed: Math.floor((Date.now() - running.startTime) / 1000),
      }, false);
    }
    drainPromise = Promise.all([...cleanupTimers.values()].map(({ done }) => done)).then(() => { });
    return drainPromise;
  };
  let unsubscribeDrain: (() => void) | undefined;
  const registerLifecycleListeners = () => {
    unsubscribeChildren?.();
    unsubscribeDrain?.();
    unsubscribeChildren = pi.events?.on("subagent:children-query", reportChildren);
    unsubscribeDrain = pi.events?.on("subagent:drain", (request: unknown) => {
      (request as { pending: Promise<void>[] }).pending.push(drainChildren());
    });
  };

  const recoverCompletion = (running: RunningSubagent): boolean => {
    try {
      const result = readRunCompletion(running.sessionFile, running.runId);
      if (!result) return false;
      finishSubagent({
        id: running.id, name: running.name, task: running.task, agent: running.agent,
        protocolStatus: "completed", result,
        elapsed: Math.floor((Date.now() - running.startTime) / 1000),
      });
      return true;
    } catch (error) {
      runtime.latestCtx?.ui.notify(`Cannot recover ${running.name}: ${String(error)}`, "warning");
      return false;
    }
  };

  const scheduleConnectionFailure = (childId: string, delayMs: number, reason: string) => {
    const previous = connectionFailureTimers.get(childId);
    if (previous) clearTimeout(previous);
    connectionFailureTimers.set(childId, setTimeout(() => {
      connectionFailureTimers.delete(childId);
      const running = runtime.runningSubagents.get(childId);
      if (!running || running.connected || !runtime.acceptIpcResults) return;
      if (recoverCompletion(running)) return;
      finishSubagent({
        id: running.id,
        runId: running.runId,
        childSessionId: running.childSessionId,
        resumeOfRunId: running.resumeOfRunId,
        mode: running.mode,
        name: running.name,
        task: running.task,
        agent: running.agent,
        protocolStatus: "failed",
        protocolError: reason,
        sessionFile: running.sessionFile,
        elapsed: Math.floor((Date.now() - running.startTime) / 1000),
      });
    }, delayMs));
  };

  const handleIpcMessage = (message: IpcEnvelope) => {
    if (!runtime.acceptIpcResults) return;
    if (message.type === "shutdown_ready") {
      cleanupTimers.get(message.childId)?.cleanup();
      return;
    }
    const running = runtime.runningSubagents.get(message.childId);
    if (!running) {
      const completed = completedRuns.get(message.childId);
      if (completed && ["hello", "ready", "completion"].includes(message.type)) {
        if (completed.protocolStatus === "completed") runtime.parentIpcServer?.send(message.childId, "completion_ack", { runId: message.childId });
        else runtime.parentIpcServer?.send(message.childId, "shutdown", { reason: completed.protocolStatus });
      }
      return;
    }
    const payload = message.payload as any;

    if (message.type === "hello" || message.type === "ready") {
      running.connected = true;
      if (Number.isSafeInteger(payload?.pid) && payload.pid > 0 && running.childPid !== payload.pid) {
        running.childPid = payload.pid;
        pi.appendEntry(IDENTITY_ENTRY, { id: running.id, runId: running.runId, childPid: payload.pid });
      }
      if (
        typeof payload?.sessionFile === "string" &&
        resolve(payload.sessionFile) === resolve(running.sessionFile)
      ) {
        running.sessionFile = resolve(payload.sessionFile);
      }
      const pendingCount = parsePendingUiRequestCount(payload?.pendingUiRequestCount);
      if (pendingCount !== undefined) running.pendingUiRequestCount = pendingCount;
      if (Array.isArray(payload?.uiRequests)) {
        running.uiRequests = payload.uiRequests
          .map(parsePendingUiRequest)
          .filter((request: PendingUiRequest | null): request is PendingUiRequest => !!request)
          .slice(-MAX_DISPLAY_UI_REQUESTS);
        if (pendingCount === undefined) running.pendingUiRequestCount = (running.uiRequests ?? []).length;
      }
      if ((running.pendingUiRequestCount ?? 0) > 0) {
        running.state = "waiting_input";
      } else if (payload?.state === "idle" || payload?.state === "running") {
        running.state = payload.state;
      }
      updateWidget();
      return;
    }
    if (message.type === "running") {
      running.state = (running.pendingUiRequestCount ?? 0) > 0 ? "waiting_input" : "running";
      updateWidget();
      return;
    }
    if (message.type === "settled") {
      running.state = (running.pendingUiRequestCount ?? 0) > 0 ? "waiting_input" : "idle";
      updateWidget();
      return;
    }
    if (message.type === "ui_request") {
      const request = parsePendingUiRequest(payload);
      if (!request) return;
      const requests = running.uiRequests ?? [];
      const wasDisplayed = requests.some((pending) => pending.id === request.id);
      running.uiRequests = [
        ...requests.filter((pending) => pending.id !== request.id),
        request,
      ].slice(-MAX_DISPLAY_UI_REQUESTS);
      running.pendingUiRequestCount = parsePendingUiRequestCount(payload?.pendingUiRequestCount)
        ?? (running.pendingUiRequestCount ?? requests.length) + (wasDisplayed ? 0 : 1);
      running.state = "waiting_input";
      updateWidget();
      return;
    }
    if (message.type === "ui_request_resolved") {
      if (typeof payload?.id !== "string") return;
      const requestId = payload.id.slice(0, 100);
      running.uiRequests = (running.uiRequests ?? []).filter(
        (request) => request.id !== requestId,
      );
      running.pendingUiRequestCount = parsePendingUiRequestCount(payload?.pendingUiRequestCount)
        ?? Math.max(0, (running.pendingUiRequestCount ?? 1) - 1);
      if (running.pendingUiRequestCount > 0) {
        running.state = "waiting_input";
      } else if (payload?.state === "idle" || payload?.state === "running") {
        running.state = payload.state;
      } else {
        running.state = "running";
      }
      updateWidget();
      return;
    }
    if (message.type === "activity") {
      if (typeof payload?.entries === "number") running.entries = payload.entries;
      try {
        if (existsSync(running.sessionFile)) running.bytes = statSync(running.sessionFile).size;
      } catch { }
      updateWidget();
      return;
    }
    if (message.type === "completion") {
      if (!isSubagentDoneResult(payload) || payload.runId !== running.runId) {
        finishSubagent({
          ...running,
          id: running.id,
          protocolStatus: "failed",
          protocolError: "Subagent sent a malformed completion result over IPC.",
          elapsed: Math.floor((Date.now() - running.startTime) / 1000),
        } as SubagentResult & { id: string });
        return;
      }
      finishSubagent({
        id: running.id,
        name: running.name,
        task: running.task,
        agent: running.agent,
        protocolStatus: "completed",
        result: payload,
        sessionFile: running.sessionFile,
        elapsed: Math.floor((Date.now() - running.startTime) / 1000),
      } as SubagentResult & { id: string });
      return;
    }
    if (message.type === "shutdown" && payload?.reason !== "reload") {
      // Explicit completion is sent before shutdown. Give that frame a moment to arrive first.
      setTimeout(() => {
        if (!runtime.acceptIpcResults || !runtime.runningSubagents.has(running.id)) return;
        if (recoverCompletion(running)) return;
        finishSubagent({
          id: running.id,
          name: running.name,
          task: running.task,
          agent: running.agent,
          protocolStatus: "failed",
          protocolError: "Subagent exited without sending a structured completion result.",
          sessionFile: running.sessionFile,
          elapsed: Math.floor((Date.now() - running.startTime) / 1000),
        } as SubagentResult & { id: string });
      }, 100);
    }
  };

  // Capture UI context, restore unresolved launches, and start the IPC server.
  pi.on("session_start", async (_event, ctx) => {
    runtime.epoch++;
    runtime.latestCtx = ctx;
    drainPromise = undefined;
    registerLifecycleListeners();

    runtime.acceptIpcResults = false;
    await runtime.parentIpcServer?.close().catch(() => { });
    runtime.parentIpcSocketPath = getIpcSocketPath(ctx.sessionManager.getSessionId());

    const ledger = restoreRunLedger(ctx.sessionManager.getEntries());
    completedRuns.clear();
    for (const [id, finish] of ledger.finishes) {
      if (finish.result) completedRuns.set(id, finish.result);
    }
    runtime.runningSubagents.clear();
    for (const data of ledger.unresolved as Partial<RunningSubagent>[]) {
      if (!data?.id || !data.ipcToken || !data.sessionFile) continue;
      let sessionCorrelation: ReturnType<typeof readSubagentSessionCorrelation> | undefined;
      try {
        sessionCorrelation = readSubagentSessionCorrelation(data.sessionFile);
      } catch { }
      const restored = {
        ...data,
        runId: data.runId ?? data.id,
        childSessionId: data.childSessionId ?? sessionCorrelation?.childSessionId ?? data.id,
        mode: data.mode ?? "fresh",
      } as RunningSubagent;
      runtime.runningSubagents.set(restored.id, restored);
    }

    runtime.parentIpcServer = new ParentIpcServer({
      socketPath: runtime.parentIpcSocketPath,
      onMessage: handleIpcMessage,
      onConnect: (childId) => {
        const timer = connectionFailureTimers.get(childId);
        if (timer) clearTimeout(timer);
        connectionFailureTimers.delete(childId);
        const running = runtime.runningSubagents.get(childId);
        if (running) running.connected = true;
        updateWidget();
      },
      onDisconnect: (childId) => {
        const running = runtime.runningSubagents.get(childId);
        if (running) {
          running.connected = false;
          scheduleConnectionFailure(
            childId,
            2_000,
            "Subagent IPC connection closed without a completion result.",
          );
        }
        updateWidget();
      },
    });
    for (const running of runtime.runningSubagents.values()) {
      runtime.parentIpcServer.registerChild(running.id, running.ipcToken);
    }
    await runtime.parentIpcServer.start();
    runtime.acceptIpcResults = true;
    for (const result of ledger.pendingResults) deliverResult(result);
    // A crash can occur after committing a terminal outcome but before closing
    // its pane. Reap only journalled, still-open surfaces, deepest descendants first.
    for (const run of ledger.openSurfaces as RunningSubagent[]) {
      if (!ledger.finishes.has(run.runId ?? run.id)) continue;
      try {
        for (const surface of [...collectOpenDescendants(run.sessionFile), run]) {
          if (surface.workspace) terminateWorkspaceChild(surface);
          else if (surface.surface) { try { closeSurface(surface.surface); } catch { } }
        }
        pi.appendEntry(CLOSED_ENTRY, { id: run.id, runId: run.runId, closedAt: Date.now() });
      } catch (error) {
        ctx.ui.notify(`Could not reap completed subagent ${run.name}: ${String(error)}`, "warning");
      }
    }
    for (const running of runtime.runningSubagents.values()) {
      if (recoverCompletion(running)) continue;
      scheduleConnectionFailure(
        running.id,
        15_000,
        "Subagent did not reconnect to IPC after the parent session reloaded.",
      );
    }
    reportChildren();
    if (runtime.runningSubagents.size > 0) startWidgetRefresh();
  });

  // Preserve child processes across /reload; terminate them for real parent-session shutdowns.
  pi.on("session_shutdown", async (event, _ctx) => {
    runtime.epoch++;
    if (event.reason !== "reload") await drainChildren();
    runtime.acceptIpcResults = false;
    if (runtime.widgetInterval) clearInterval(runtime.widgetInterval);
    runtime.widgetInterval = null;
    for (const { timer, cleanup } of cleanupTimers.values()) {
      clearTimeout(timer);
      cleanup(true);
    }
    cleanupTimers.clear();
    for (const timer of connectionFailureTimers.values()) clearTimeout(timer);
    connectionFailureTimers.clear();
    await runtime.parentIpcServer?.close().catch(() => { });
    runtime.parentIpcServer = null;
    runtime.latestCtx = null;
    unsubscribeChildren?.();
    unsubscribeDrain?.();
  });


  return { serializeRunning, finishSubagent, reportChildren, scheduleConnectionFailure, recordSurface, awaitStartup, updateWidget, startWidgetRefresh };
}
export type RunController = ReturnType<typeof createController>;
