import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ParentIpcServer } from "./ipc.ts";
import { type RunningSubagent } from "./types.ts";

export interface RunRuntime {
  epoch: number;
  runningSubagents: Map<string, RunningSubagent>;
  parentIpcServer: ParentIpcServer | null;
  parentIpcSocketPath: string;
  acceptIpcResults: boolean;
  latestCtx: ExtensionContext | null;
  widgetInterval: ReturnType<typeof setInterval> | null;
}
export function createRunRuntime(): RunRuntime {
  return { epoch: 0, runningSubagents: new Map(), parentIpcServer: null, parentIpcSocketPath: '', acceptIpcResults: false, latestCtx: null, widgetInterval: null };
}
export const IPC_LAUNCH_ENTRY = "subagent_ipc_launch";
export const IPC_FINISH_ENTRY = "subagent_ipc_finish";
