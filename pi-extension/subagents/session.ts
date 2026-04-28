import { readFileSync, appendFileSync, copyFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export const SUBAGENT_DONE_RESULT_TYPE = "subagent_done_result";

export type SubagentTaskStatus = "success" | "failed" | "blocked";

export interface SubagentArtifactRef {
  name: string;
  description?: string;
  /** Absolute path resolved by subagent_done after validation. Not accepted as model input. */
  path?: string;
}

export interface SubagentDoneResult {
  schemaVersion: 1;
  status: SubagentTaskStatus;
  summary: string;
  report?: string;
  artifacts?: SubagentArtifactRef[];
  nextSteps?: string[];
  completedAt: string;
  artifactBaseDir?: string;
}

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string;
  [key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
}

export interface CustomEntry<T = unknown> extends SessionEntry {
  type: "custom";
  customType: string;
  data?: T;
}

function readEntries(sessionFile: string): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Return the id of the last entry in the session file (current branch point / leaf).
 */
export function getLeafId(sessionFile: string): string | null {
  const entries = readEntries(sessionFile);
  return entries.length > 0 ? entries[entries.length - 1].id : null;
}

/**
 * Return the number of non-empty lines (entries) in the session file.
 */
export function getEntryCount(sessionFile: string): number {
  const raw = readFileSync(sessionFile, "utf8");
  return raw.split("\n").filter((line) => line.trim()).length;
}

/**
 * Return entries added after `afterLine` (1-indexed count of existing entries).
 */
export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  return lines.slice(afterLine).map((line) => JSON.parse(line) as SessionEntry);
}

export function findSubagentDoneResultEntries(entries: SessionEntry[]): CustomEntry<unknown>[] {
  return entries.filter(
    (entry): entry is CustomEntry<unknown> =>
      entry.type === "custom" && entry.customType === SUBAGENT_DONE_RESULT_TYPE,
  );
}

export function isSubagentDoneResult(data: unknown): data is SubagentDoneResult {
  if (!data || typeof data !== "object") return false;
  const candidate = data as Partial<SubagentDoneResult>;
  return (
    candidate.schemaVersion === 1 &&
    (candidate.status === "success" ||
      candidate.status === "failed" ||
      candidate.status === "blocked") &&
    typeof candidate.summary === "string" &&
    typeof candidate.completedAt === "string"
  );
}

/**
 * Find valid structured subagent completion results in session entries.
 */
export function findSubagentDoneResults(entries: SessionEntry[]): SubagentDoneResult[] {
  return findSubagentDoneResultEntries(entries)
    .map((entry) => entry.data)
    .filter(isSubagentDoneResult);
}

/**
 * Find the last assistant message text in a list of entries.
 */
export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;

    const texts = msg.message.content
      .filter(
        (block) =>
          block.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
      )
      .map((block) => block.text as string);

    if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");
  }
  return null;
}

/**
 * Append a branch_summary entry to the session file.
 * Returns the new entry's id.
 */
export function appendBranchSummary(
  sessionFile: string,
  branchPointId: string,
  fromId: string | null,
  summary: string,
): string {
  const id = randomBytes(4).toString("hex");
  const entry = {
    type: "branch_summary",
    id,
    parentId: branchPointId,
    timestamp: new Date().toISOString(),
    fromId: fromId ?? branchPointId,
    summary,
  };
  appendFileSync(sessionFile, JSON.stringify(entry) + "\n", "utf8");
  return id;
}

/**
 * Copy the session file to destDir for parallel worker isolation.
 * Returns the path of the copy.
 */
export function copySessionFile(sessionFile: string, destDir: string): string {
  const id = randomBytes(4).toString("hex");
  const dest = join(destDir, `subagent-${id}.jsonl`);
  copyFileSync(sessionFile, dest);
  return dest;
}

/**
 * Read new entries from sourceFile (after afterLine), append them to targetFile.
 * Returns the appended entries.
 */
export function mergeNewEntries(
  sourceFile: string,
  targetFile: string,
  afterLine: number,
): SessionEntry[] {
  const entries = getNewEntries(sourceFile, afterLine);
  for (const entry of entries) {
    appendFileSync(targetFile, JSON.stringify(entry) + "\n", "utf8");
  }
  return entries;
}
