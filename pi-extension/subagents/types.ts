import { type ChildProcess } from "node:child_process";
import { prepareLaunch } from "./launch-process.ts";
import { type ChildRunConfig } from "./launch-config.ts";
import { type SubagentDoneResult, type SubagentSessionMode } from "./session.ts";

export type SubagentProtocolStatus = "completed" | "failed" | "cancelled";

/** Persisted display context for a parent message, correlated by exact IDs. */
export interface SubagentMessageContext {
  runId: string;
  replyTo?: string;
  recipientName?: string;
  question?: string;
}

export interface SubagentResult {
  /** Parent-side orchestration id; omitted from older persisted results. */
  id?: string;
  runId?: string;
  childSessionId?: string;
  resumeOfRunId?: string;
  mode?: SubagentSessionMode | "resume";
  name: string;
  task: string;
  agent?: string;
  protocolStatus: SubagentProtocolStatus;
  protocolError?: string;
  diagnosticSummary?: string;
  result?: SubagentDoneResult;
  sessionFile?: string;
  worktreePath?: string;
  exitCode?: number;
  elapsed: number;
  error?: string;
}

export type SubagentRunState = "idle" | "running" | "waiting_input" | "waiting_parent";

export interface PendingUiRequest {
  id: string;
  method: string;
  title?: string;
  startedAt?: number;
}

export interface RunningSubagent {
  /** Backward-compatible alias of runId used by IPC and parent entries. */
  id: string;
  runId: string;
  childSessionId: string;
  resumeOfRunId?: string;
  mode: SubagentSessionMode | "resume";
  name: string;
  task: string;
  agent?: string;
  surface: string;
  focusWarning?: string;
  startTime: number;
  sessionFile: string;
  worktreePath?: string;
  entries?: number;
  bytes?: number;
  forkCleanupFile?: string;
  workspace?: string;
  previousWorkspace?: string; // Legacy metadata only; never restore focus automatically.
  backgroundWorkspace?: string;
  launch?: ReturnType<typeof prepareLaunch>;
  workspaceProcess?: ChildProcess;
  childPid?: number;
  ipcToken: string;
  autoExit: boolean;
  config?: ChildRunConfig;
  connected?: boolean;
  state?: SubagentRunState;
  pendingParentRequestId?: string;
  pendingUiRequestCount?: number;
  uiRequests?: PendingUiRequest[];
}
