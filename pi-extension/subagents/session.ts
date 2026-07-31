import { readFileSync, appendFileSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

export const SUBAGENT_DONE_RESULT_TYPE = "subagent_done_result";
export const SUBAGENT_METADATA_TYPE = "subagent_metadata";

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

export interface SessionHeader {
  type: "session";
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession: string;
}

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string | null;
  timestamp?: string;
  [key: string]: unknown;
}

export type SubagentSessionMode = "fresh" | "fork";

export interface SubagentMetadata {
  schemaVersion: 1;
  parentSessionId: string;
  parentSessionFile: string;
  parentLeafId?: string;
  childSessionId: string;
  runId: string;
  name: string;
  agent?: string;
  mode: SubagentSessionMode;
  taskDigest: string;
  createdAt: string;
}

export interface CreatedSubagentSession {
  sessionFile: string;
  childSessionId: string;
  metadata: SubagentMetadata;
}

export interface SubagentSessionCorrelation {
  childSessionId: string;
  cwd: string;
  originatingRunId?: string;
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

function readFileEntries(sessionFile: string): Array<SessionHeader | SessionEntry> {
  const raw = readFileSync(sessionFile, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SessionHeader | SessionEntry);
}

function readEntries(sessionFile: string): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SessionEntry);
}

function isUserMessage(entry: SessionEntry): boolean {
  return entry.type === "message" && (entry as Partial<MessageEntry>).message?.role === "user";
}

/**
 * Validate an active Pi branch and remove the final user-message suffix that
 * triggered orchestration. The caller must pass SessionManager.getBranch(),
 * never the append-order contents of the parent JSONL.
 */
export function selectForkHistory(activeBranch: SessionEntry[]): SessionEntry[] {
  const seen = new Set<string>();
  for (let index = 0; index < activeBranch.length; index++) {
    const entry = activeBranch[index];
    if (!entry || entry.type === "session" || typeof entry.type !== "string") {
      throw new Error(`Invalid entry at active branch index ${index}.`);
    }
    if (typeof entry.id !== "string" || entry.id.length === 0 || seen.has(entry.id)) {
      throw new Error(`Invalid or duplicate entry id at active branch index ${index}.`);
    }
    const expectedParentId = index === 0 ? null : activeBranch[index - 1].id;
    if (entry.parentId !== expectedParentId) {
      throw new Error(`Broken parent chain at active branch entry ${entry.id}.`);
    }
    if (typeof entry.timestamp !== "string" || Number.isNaN(Date.parse(entry.timestamp))) {
      throw new Error(`Invalid timestamp at active branch entry ${entry.id}.`);
    }
    seen.add(entry.id);
  }

  let triggerIndex = -1;
  for (let index = activeBranch.length - 1; index >= 0; index--) {
    if (isUserMessage(activeBranch[index])) {
      triggerIndex = index;
      break;
    }
  }
  return activeBranch.slice(0, triggerIndex >= 0 ? triggerIndex : activeBranch.length);
}

function createUniqueEntryId(existingIds: Set<string>): string {
  let id: string;
  do {
    id = randomBytes(4).toString("hex");
  } while (existingIds.has(id));
  return id;
}

export function digestSubagentTask(task: string): string {
  return `sha256:${createHash("sha256").update(task, "utf8").digest("hex")}`;
}

/** Pre-create a valid child Pi v3 session with explicit lineage metadata. */
export function createSubagentSession(options: {
  sessionDir: string;
  cwd: string;
  parentSessionId: string;
  parentSessionFile: string;
  parentLeafId?: string | null;
  runId: string;
  name: string;
  agent?: string;
  mode: SubagentSessionMode;
  task: string;
  historyEntries?: SessionEntry[];
  createdAt?: string;
  childSessionId?: string;
}): CreatedSubagentSession {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const childSessionId = options.childSessionId ?? randomUUID();
  const sessionDir = resolve(options.sessionDir);
  const parentSessionFile = resolve(options.parentSessionFile);
  const cwd = resolve(options.cwd);
  const historyEntries = options.historyEntries ?? [];
  const existingIds = new Set(historyEntries.map((entry) => entry.id));
  const metadata: SubagentMetadata = {
    schemaVersion: 1,
    parentSessionId: options.parentSessionId,
    parentSessionFile,
    parentLeafId: options.parentLeafId ?? undefined,
    childSessionId,
    runId: options.runId,
    name: options.name,
    agent: options.agent,
    mode: options.mode,
    taskDigest: digestSubagentTask(options.task),
    createdAt,
  };
  const header: SessionHeader = {
    type: "session",
    version: 3,
    id: childSessionId,
    timestamp: createdAt,
    cwd,
    parentSession: parentSessionFile,
  };
  const metadataEntry: CustomEntry<SubagentMetadata> = {
    type: "custom",
    id: createUniqueEntryId(existingIds),
    parentId: historyEntries.at(-1)?.id ?? null,
    timestamp: createdAt,
    customType: SUBAGENT_METADATA_TYPE,
    data: metadata,
  };

  mkdirSync(sessionDir, { recursive: true });
  const fileTimestamp = createdAt.replace(/[:.]/g, "-");
  const sessionFile = join(sessionDir, `${fileTimestamp}_${childSessionId}.jsonl`);
  const content = [header, ...historyEntries, metadataEntry]
    .map((entry) => JSON.stringify(entry))
    .join("\n") + "\n";
  writeFileSync(sessionFile, content, { encoding: "utf8", flag: "wx" });
  return { sessionFile, childSessionId, metadata };
}

/** Read stable child/originating-run correlation for a resumed session. */
export function readSubagentSessionCorrelation(sessionFile: string): SubagentSessionCorrelation {
  const entries = readFileEntries(sessionFile);
  const header = entries[0];
  if (
    !header ||
    header.type !== "session" ||
    typeof header.id !== "string" ||
    typeof (header as SessionHeader).cwd !== "string"
  ) {
    throw new Error(`Session file has no valid header: ${sessionFile}`);
  }
  const metadataEntry = entries.find(
    (entry): entry is CustomEntry<SubagentMetadata> =>
      entry.type === "custom" &&
      (entry as CustomEntry<unknown>).customType === SUBAGENT_METADATA_TYPE &&
      !!(entry as CustomEntry<SubagentMetadata>).data,
  );
  const metadata = metadataEntry?.data;
  if (metadata) {
    if (
      metadata.schemaVersion !== 1 ||
      metadata.childSessionId !== header.id ||
      typeof metadata.runId !== "string" ||
      metadata.runId.length === 0 ||
      typeof metadata.parentSessionFile !== "string" ||
      typeof metadata.parentSessionId !== "string"
    ) {
      throw new Error(`Session file has invalid subagent metadata: ${sessionFile}`);
    }
  }
  return {
    childSessionId: header.id,
    cwd: resolve((header as SessionHeader).cwd),
    originatingRunId: metadata?.runId,
  };
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
