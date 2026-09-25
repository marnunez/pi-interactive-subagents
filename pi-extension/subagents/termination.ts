import { readFileSync } from "node:fs";
import { restoreRunLedger } from "./run-ledger.ts";

export interface ChildSurface {
  id: string;
  runId: string;
  sessionFile: string;
  surface: string;
  workspace?: string;
  childPid?: number;
}

/** Read-only fallback traversal; never write another live Pi process's transcript. */
export function collectOpenDescendants(sessionFile: string, seen = new Set<string>(), depth = 0): ChildSurface[] {
  if (seen.has(sessionFile) || depth >= 4) return [];
  seen.add(sessionFile);
  const lines = readFileSync(sessionFile, "utf8").split("\n");
  const entries = lines.flatMap((line, index) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; }
    catch (error) { if (index === lines.length - 1) return []; throw error; }
  });
  const runs = restoreRunLedger(entries).openSurfaces as ChildSurface[];
  const descendants: ChildSurface[] = [];
  for (const run of runs) {
    if (typeof run.sessionFile !== "string" || typeof run.surface !== "string") continue;
    descendants.push(...collectOpenDescendants(run.sessionFile, seen, depth + 1), run);
  }
  return descendants;
}

/** A stored PID alone is unsafe after reload: verify its current run identity. */
export function terminateWorkspaceChild(run: ChildSurface): void {
  if (!Number.isSafeInteger(run.childPid) || run.childPid! <= 0) return;
  try {
    const environment = readFileSync(`/proc/${run.childPid}/environ`, "utf8").split("\0");
    if (environment.includes(`PI_SUBAGENT_ID=${run.runId}`)) process.kill(run.childPid!, "SIGTERM");
  } catch { /* Already exited, or no longer an owned process. */ }
}
