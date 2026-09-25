/** Run outcomes are session-wide facts, not branch-local conversation state. */
export const LAUNCH_ENTRY = "subagent_ipc_launch";
export const FINISH_ENTRY = "subagent_ipc_finish";
export const CLOSED_ENTRY = "subagent_ipc_closed";
export const IDENTITY_ENTRY = "subagent_ipc_identity";

export interface LedgerEntry {
  type: string;
  customType?: string;
  data?: any;
  details?: any;
}

export function restoreRunLedger(entries: readonly LedgerEntry[]) {
  const launches = new Map<string, any>();
  const finishes = new Map<string, any>();
  const delivered = new Set<string>();
  const closed = new Set<string>();
  const identities = new Map<string, any>();
  for (const entry of entries) {
    const id = entry.data?.runId ?? entry.data?.id;
    if (entry.type === "custom" && id) {
      if (entry.customType === LAUNCH_ENTRY) launches.set(id, entry.data);
      if (entry.customType === FINISH_ENTRY) finishes.set(id, entry.data);
      if (entry.customType === CLOSED_ENTRY) closed.add(id);
      if (entry.customType === IDENTITY_ENTRY) identities.set(id, entry.data);
    }
    if (entry.type === "custom_message" && entry.customType === "subagent_result") {
      const id = entry.details?.runId ?? entry.details?.id;
      if (id) delivered.add(id);
    }
  }
  const runs = [...launches.values()].map((launch) => ({ ...launch, ...identities.get(launch.runId ?? launch.id) }));
  return {
    unresolved: runs.filter((launch) => !finishes.has(launch.runId ?? launch.id)),
    openSurfaces: runs.filter((launch) => {
      const id = launch.runId ?? launch.id;
      return !closed.has(id) && (!finishes.has(id) || finishes.get(id).pendingCleanup === true);
    }),
    pendingResults: [...finishes.values()]
      .filter((finish) => finish.notify !== false && finish.result && !delivered.has(finish.runId ?? finish.id))
      .map((finish) => finish.result),
    finishes,
  };
}
