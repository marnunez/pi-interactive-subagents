import { type ChildProcess } from "node:child_process";
import { prepareLaunch } from "./launch-process.ts";
import { type ChildRunConfig } from "./launch-config.ts";
import { type SubagentDoneResult, type SubagentSessionMode } from "./session.ts";

export type SubagentProtocolStatus = "completed" | "failed" | "cancelled";

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
  exitCode?: number;
  elapsed: number;
  error?: string;
}

export type SubagentRunState = "idle" | "running" | "waiting_input";

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
  startTime: number;
  sessionFile: string;
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
  pendingUiRequestCount?: number;
  uiRequests?: PendingUiRequest[];
}
