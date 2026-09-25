import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const defineTool = <T>(tool: T): T => tool;
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  statSync,
  readFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { ChildProcess, spawn as nodeSpawn, execSync as nodeExecSync, execFileSync as nodeExecFileSync } from "node:child_process";
import { loadAgentDefaults, listAgentDefinitions, resolveChildTools } from "./config.ts";
import { restoreRunLedger, CLOSED_ENTRY, IDENTITY_ENTRY } from "./run-ledger.ts";
import { collectOpenDescendants, terminateWorkspaceChild } from "./termination.ts";
import { readChildRunConfig, legacyChildDefaults, type ChildRunConfig } from "./launch-config.ts";
import { homedir } from "node:os";
import {
  isMuxAvailable,
  muxSetupHint,
  createSurface,
  sendCommand,
  closeSurface,
  shellEscape,
  renameCurrentTab,
  renameWorkspace,
} from "./cmux.ts";
import {
  createSubagentSession,
  isSubagentDoneResult,
  readSubagentSessionCorrelation,
  readRunCompletion,
  selectForkHistory,
  type SessionEntry,
  type SubagentDoneResult,
  type SubagentSessionMode,
} from "./session.ts";
import {
  ensureSessionArtifactDir,
  getSessionArtifactDir,
  writeArtifactFile,
} from "../session-artifacts/paths.ts";
import {
  createIpcToken,
  getIpcSocketPath,
  type IpcEnvelope,
  ParentIpcServer,
} from "./ipc.ts";

const SUBAGENT_COMPLETION_INSTRUCTION =
  "Complete your task. When this run is finished, call subagent_done with a structured result. " +
  "This ends the current run, not the session: the session remains resumable as a new run. " +
  "Set status to success, failed, or blocked; put the concise orchestration result in summary; " +
  "put the expanded human-readable result in report when useful; list any write_artifact outputs in artifacts; " +
  "and include recommended follow-up actions in nextSteps. Exiting without subagent_done is a protocol failure. " +
  "The user can interact with you at any time, but the same completion contract still applies.";

const SUBAGENT_ASYNC_GUIDANCE =
  "Results are delivered automatically via a steer message; never poll child status. " +
  "Continue independent work if any remains. Otherwise end the current turn silently: emit no text and call no more tools. " +
  "The first child completion will trigger the next turn.";

const SUBAGENT_KILL_GUIDANCE =
  "Kill one or all running sub-agents. Omit target to inspect running children only when the user explicitly asks. " +
  "Never use this tool to poll while waiting; completion arrives automatically via a steer message.";

const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Agent definition name (e.g. worker, scout, reviewer). Uses trusted project agents, the active profile's agents, then bundled defaults.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Appended to system prompt (role instructions)" }),
  ),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
  skills: Type.Optional(
    Type.String({ description: "Comma-separated skills (overrides agent default)" }),
  ),
  tools: Type.Optional(
    Type.String({ description: "Comma-separated tools (overrides agent default)" }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "Fork the current session — sub-agent gets full conversation context. Use for iterate/bugfix patterns.",
    }),
  ),
  workspace: Type.Optional(
    Type.String({
      description:
        "Launch on a dedicated Sway workspace instead of a mux pane. " +
        "Value is the workspace name (e.g. '🌐 Browse'). The subagent runs in a " +
        "WezTerm window on that workspace. Switches back when done.",
    }),
  ),
});
type SubagentParamsValue = Static<typeof SubagentParams>;

/** Child-only tools that may not exist in the parent process' tool registry. */
const CHILD_ONLY_TOOLS = new Set(["subagent_done", "set_tab_title", "write_artifact"]);

function withChildOnlyTools(allToolNames?: string[]): string[] | undefined {
  if (!allToolNames) return undefined;
  return [...new Set([...allToolNames, ...CHILD_ONLY_TOOLS])];
}

function readJsonFile<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function getPreferredDefaultModel(cwd: string): { defaultProvider?: string; defaultModel?: string } {
  const globalSettings = readJsonFile<{ defaultProvider?: string; defaultModel?: string }>(
    join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json"),
  );
  const projectSettings = readJsonFile<{ defaultProvider?: string; defaultModel?: string }>(
    join(cwd, ".pi", "settings.json"),
  );

  return {
    defaultProvider: projectSettings?.defaultProvider ?? globalSettings?.defaultProvider,
    defaultModel: projectSettings?.defaultModel ?? globalSettings?.defaultModel,
  };
}

function qualifyModelWithProvider(
  model: string,
  ctx: { cwd: string; model?: { id: string; provider: string } | undefined },
): string {
  if (model.includes("/")) return model;

  const { defaultProvider, defaultModel } = getPreferredDefaultModel(ctx.cwd);
  if (defaultProvider && defaultModel === model) {
    return `${defaultProvider}/${model}`;
  }

  if (ctx.model?.id === model && ctx.model.provider) {
    return `${ctx.model.provider}/${model}`;
  }

  return model;
}

function resolveEffectiveChildCwd(rawCwd: string | undefined, parentCwd: string): string {
  if (!rawCwd) return resolve(parentCwd);
  if (rawCwd === "~") return homedir();
  if (rawCwd.startsWith("~/")) return resolve(homedir(), rawCwd.slice(2));
  if (rawCwd.startsWith("~")) {
    throw new Error(`Unsupported home-relative cwd: ${rawCwd}`);
  }
  return resolve(parentCwd, rawCwd);
}

const PROFILE_ENV_NAMES = ["PI_PROFILE", "PI_CODING_AGENT_DIR"] as const;
const NON_INHERITED_RUNTIME_ENV_NAMES = [
  "PI_SESSION_LEASE_OWNER_PID", "PI_SESSION_LEASE_OWNER_NONCE",
  "PI_DENY_TOOLS", "PI_SUBAGENT_NAME", "PI_SUBAGENT_ID", "PI_SUBAGENT_SOCKET",
  "PI_SUBAGENT_TOKEN", "PI_SUBAGENT_AUTO_EXIT", "PI_SUBAGENT_MODEL",
  "PI_SUBAGENT_THINKING", "PI_SUBAGENT_TOOLS", "PI_SUBAGENT_AGENT", "PI_SUBAGENT_DEPTH",
] as const;

function inheritedProfileEnvParts(): string[] {
  return PROFILE_ENV_NAMES.flatMap((name) => {
    const value = process.env[name];
    return value == null ? [] : [`${name}=${shellEscape(value)}`];
  });
}

/**
 * Multiplexer servers retain their own environment. Explicitly remove profile
 * selectors absent from this parent before applying the selectors it does have.
 */
function inheritedProfileEnvUnsets(): string[] {
  return [
    ...PROFILE_ENV_NAMES.flatMap((name) => (process.env[name] == null ? ["-u", name] : [])),
    ...NON_INHERITED_RUNTIME_ENV_NAMES.flatMap((name) => ["-u", name]),
  ];
}

function customAgentEnvParts(value: string | undefined): string[] {
  if (!value) return [];
  const parts: string[] = [];
  for (const pair of value.split(/\s+/).filter(Boolean)) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(pair);
    if (!assignment) continue;
    const [, name, rawValue] = assignment;
    if (NON_INHERITED_RUNTIME_ENV_NAMES.some((reserved) => reserved === name)) continue;
    parts.push(`${name}=${shellEscape(rawValue)}`);
  }
  return parts;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function muxUnavailableResult(kind: "subagents" | "tab-title" = "subagents") {
  if (kind === "tab-title") {
    return {
      content: [
        { type: "text" as const, text: `Terminal multiplexer not available. ${muxSetupHint()}` },
      ],
      details: { error: "mux not available" },
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require a supported terminal multiplexer. ${muxSetupHint()}`,
      },
    ],
    details: { error: "mux not available" },
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)}MB`;
}

function buildSubagentResultContent(details: SubagentResult): string {
  const lines: string[] = [];
  const agentTag = details.agent ? ` (${details.agent})` : "";

  if (details.protocolStatus === "completed" && details.result) {
    lines.push(
      `Sub-agent "${details.name}"${agentTag} completed with task status "${details.result.status}" (${formatElapsed(details.elapsed)}).`,
    );
    lines.push("", `Summary: ${details.result.summary}`);

    if (details.result.artifacts?.length) {
      lines.push("", "Artifacts:");
      for (const artifact of details.result.artifacts) {
        const path = artifact.path ?? artifact.name;
        const description = artifact.description ? ` — ${artifact.description}` : "";
        lines.push(`- ${path}${description}`);
      }
    }

    if (details.result.nextSteps?.length) {
      lines.push("", "Next steps:");
      details.result.nextSteps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
    }
  } else if (details.protocolStatus === "cancelled") {
    lines.push(
      `Sub-agent "${details.name}"${agentTag} was cancelled after ${formatElapsed(details.elapsed)}.`,
    );
    if (details.protocolError) lines.push("", details.protocolError);
  } else {
    lines.push(
      `Sub-agent "${details.name}"${agentTag} failed the completion protocol after ${formatElapsed(details.elapsed)}.`,
    );
    if (details.protocolError) lines.push("", details.protocolError);
    if (details.diagnosticSummary) {
      lines.push("", "Last assistant message (diagnostic only):", details.diagnosticSummary);
    }
  }

  if (details.sessionFile) {
    lines.push("", `Session: ${details.sessionFile}`, `Resume: pi --session ${details.sessionFile}`);
  }

  return lines.join("\n");
}

/**
 * Try to find and measure a specific session file, or discover
 * the right one from new files in the session directory.
 *
 * When `trackedFile` is provided, measures that file directly.
 * Otherwise scans for new files not in `existingFiles` or `excludeFiles`.
 *
 * Returns { file, entries, bytes } — `file` is the path that was measured,
 * so callers can lock onto it for subsequent calls.
 */
type SubagentProtocolStatus = "completed" | "failed" | "cancelled";

/**
 * Result from running a single subagent.
 *
 * `protocolStatus` describes the lifecycle/handshake. `result.status`
 * describes the child agent's task outcome when the protocol completed.
 */
interface SubagentResult {
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

/** Generic child lifecycle and keyboard-focused extension UI state received over IPC. */
type SubagentRunState = "idle" | "running" | "waiting_input";

interface PendingUiRequest {
  id: string;
  method: string;
  title?: string;
  startedAt?: number;
}

const MAX_DISPLAY_UI_REQUESTS = 20;

function parsePendingUiRequest(value: unknown): PendingUiRequest | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Partial<PendingUiRequest>;
  if (typeof request.id !== "string" || typeof request.method !== "string") return null;
  const title = typeof request.title === "string"
    ? request.title
        .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200) || undefined
    : undefined;
  return {
    id: request.id.slice(0, 100),
    method: request.method.slice(0, 50),
    title,
    startedAt: typeof request.startedAt === "number" ? request.startedAt : undefined,
  };
}

function parsePendingUiRequestCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
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
  previousWorkspace?: string;
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

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();

const IPC_LAUNCH_ENTRY = "subagent_ipc_launch";
const IPC_FINISH_ENTRY = "subagent_ipc_finish";
let parentIpcServer: ParentIpcServer | null = null;
let parentIpcSocketPath = "";
let acceptIpcResults = false;

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

function formatSubagentState(agent: RunningSubagent): string {
  if (!agent.connected) return "connecting…";
  if (agent.state === "waiting_input") {
    const request = agent.uiRequests?.[agent.uiRequests.length - 1];
    if (request?.title) return `waiting: ${request.title}`;
    const count = agent.pendingUiRequestCount ?? agent.uiRequests?.length ?? 0;
    return count > 1 ? `waiting for ${count} inputs` : "waiting for input";
  }
  if (agent.state === "idle") return "idle";
  if (agent.state === "running") {
    return agent.entries != null ? `running · ${agent.entries} msgs` : "running";
  }
  if (agent.entries != null && agent.bytes != null) {
    return `${agent.entries} msgs (${formatBytes(agent.bytes)})`;
  }
  return "connected";
}

function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
  const count = agents.length;
  const title = "Subagents";
  const info = `${count} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const left = ` ${elapsed}  ${agent.name}${agentTag} `;
    const right = ` ${formatSubagentState(agent)} `;

    lines.push(borderLine(left, right, width));
  }

  lines.push(borderBottom(width));
  return lines;
}

function updateWidget() {
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(Array.from(runningSubagents.values()), width);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

function forkConversation(branch: SessionEntry[]): SessionEntry[] {
  const history = selectForkHistory(branch).filter((entry) =>
    !(entry.type === "custom" && typeof entry.customType === "string" && entry.customType.startsWith("subagent_")),
  );
  return history.map((entry, index) => ({ ...entry, parentId: history[index - 1]?.id ?? null }));
}

export const __test__ = {
  forkConversation,
  borderLine,
  renderSubagentWidgetLines,
  qualifyModelWithProvider,
  withChildOnlyTools,
  resolveEffectiveChildCwd,
  inheritedProfileEnvParts,
  inheritedProfileEnvUnsets,
  customAgentEnvParts,
  SUBAGENT_ASYNC_GUIDANCE,
  SUBAGENT_KILL_GUIDANCE,
};

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
}

// ── Sway workspace helpers ──────────────────────────────────────────

function getCurrentSwayWorkspace(): string | null {
  try {
    const out = nodeExecSync(`swaymsg -t get_workspaces`, { encoding: "utf8" });
    const workspaces = JSON.parse(out);
    const focused = workspaces.find((w: any) => w.focused);
    return focused?.name ?? null;
  } catch {
    return null;
  }
}

function switchSwayWorkspace(name: string): void {
  try { nodeExecFileSync("swaymsg", ["workspace", JSON.stringify(name)], { stdio: "ignore" }); } catch {}
}

/**
 * Launch a subagent on a dedicated Sway workspace with a WezTerm window.
 * Returns the WezTerm process and the command it should run (pi command).
 */
function launchWorkspaceSurface(
  workspaceName: string,
  name: string,
  command: string,
  cwd: string,
): { process: ChildProcess; previousWorkspace: string | null } {
  const previousWorkspace = getCurrentSwayWorkspace();

  // Switch to the target workspace
  switchSwayWorkspace(workspaceName);

  // Launch WezTerm window on this workspace
  const proc = nodeSpawn("wezterm", [
    "start",
    "--class", `pi-subagent-${name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
    "--cwd", cwd,
    "--",
    "bash", "-c", command,
  ], { detached: true, stdio: "ignore" });
  proc.unref();

  return { process: proc, previousWorkspace };
}

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Lifecycle and completion are reported through the child IPC bridge.
 */
async function launchSubagent(
  params: SubagentParamsValue,
  ctx: {
    sessionManager: {
      getSessionFile(): string | undefined;
      getSessionId(): string;
      getLeafId(): string | null;
      getBranch(): unknown[];
    };
    cwd: string;
  },
  options: {
    surface?: string;
    allToolNames: string[];
    activeToolNames: string[];
    projectTrusted: boolean;
    onPrepared: (running: RunningSubagent) => void;
    onFailed: (running: RunningSubagent, error: unknown) => void;
  },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const runId = randomUUID();
  const ipcToken = createIpcToken();

  if (!parentIpcServer || !parentIpcSocketPath) {
    throw new Error("Subagent IPC server is not ready");
  }

  const agentDefs = params.agent ? loadAgentDefaults(params.agent, ctx.cwd, options.projectTrusted) : null;
  if (params.agent && !agentDefs) throw new Error(`Unknown agent: ${params.agent}`);
  const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
  if (!Number.isSafeInteger(depth) || depth >= 4) throw new Error("Subagent nesting limit (4) reached.");
  const effectiveModel = params.model ?? agentDefs?.model;
  const effectiveTools = params.tools ?? agentDefs?.tools;
  const effectiveSkills = params.skills ?? agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;
  const effectiveAutoExit = agentDefs?.autoExit ?? false;

  const parentSessionFile = ctx.sessionManager.getSessionFile();
  if (!parentSessionFile) throw new Error("No session file");

  // Resolve and create the actual child cwd before the child session header is written.
  const rawCwd = params.cwd ?? agentDefs?.cwd;
  const effectiveCwd = resolveEffectiveChildCwd(rawCwd, ctx.cwd);
  mkdirSync(effectiveCwd, { recursive: true });

  const mode: SubagentSessionMode = params.fork ? "fork" : "fresh";
  const historyEntries = params.fork
    ? forkConversation(ctx.sessionManager.getBranch() as SessionEntry[])
    : [];
  const createdSession = createSubagentSession({
    sessionDir: dirname(parentSessionFile),
    cwd: effectiveCwd,
    parentSessionId: ctx.sessionManager.getSessionId(),
    parentSessionFile,
    parentLeafId: ctx.sessionManager.getLeafId(),
    runId,
    name: params.name,
    agent: params.agent,
    mode,
    task: params.task,
    historyEntries,
  });
  const { sessionFile: subagentSessionFile, childSessionId } = createdSession;
  let surface = "";
  let workspaceProcess: ChildProcess | undefined;
  let registeredWithIpc = false;
  let prepared: RunningSubagent | undefined;

  try {
  // Determine workspace mode early — if set, skip mux surface creation entirely.
  const effectiveWorkspace = params.workspace ?? agentDefs?.workspace ?? null;

  // Use pre-created surface (parallel mode), create a new one, or skip for workspace mode.
  if (effectiveWorkspace && !options?.surface) {
    surface = `workspace:${effectiveWorkspace}`; // placeholder, not a real mux surface
  } else {
    const surfacePreCreated = !!options?.surface;
    surface = options?.surface ?? createSurface(params.name);
    if (!surfacePreCreated) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
  }

  // Build the task message
  // When forking, the sub-agent already has the full conversation context.
  // Only send the user's task as a clean message — no wrapper instructions
  // that would confuse the agent into thinking it needs to restart.
  const modeHint = SUBAGENT_COMPLETION_INSTRUCTION;
  const allowedTools = resolveChildTools(
    { ...agentDefs, tools: effectiveTools }, options.activeToolNames, options.allToolNames,
  );
  const denySet = new Set(withChildOnlyTools(options.allToolNames)!.filter((name) => !allowedTools.includes(name)));
  const agentType = params.agent ?? params.name;
  const tabTitleInstruction = denySet.has("set_tab_title")
    ? ""
    : `As your FIRST action, set the tab title using set_tab_title. ` +
      `The title MUST start with [${agentType}] followed by a short description of your current task. ` +
      `Example: "[${agentType}] Analyzing auth module". Keep it concise.`;
  // Combine agent body and user-provided systemPrompt (both are optional).
  // The agent body provides the base role/identity; systemPrompt layers on
  // additional instructions from the caller.
  const identityParts = [agentDefs?.body, params.systemPrompt].filter(Boolean);
  const identity = identityParts.length > 0 ? identityParts.join("\n\n") : null;
  const fullTask = `${modeHint}\n\n${tabTitleInstruction}\n\n${params.task}`;

  // Build pi command
  const parts: string[] = ["pi"];
  parts.push("--session", shellEscape(subagentSessionFile));
  if (identity) parts.push("--append-system-prompt", shellEscape(identity));

  const subagentDonePath = join(dirname(new URL(import.meta.url).pathname), "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));

  let qualifiedModelForLock: string | undefined;
  if (effectiveModel) {
    qualifiedModelForLock = qualifyModelWithProvider(effectiveModel, ctx);
    const model = effectiveThinking ? `${qualifiedModelForLock}:${effectiveThinking}` : qualifiedModelForLock;
    parts.push("--model", shellEscape(model));
  }

  if (allowedTools && allowedTools.length > 0) {
    parts.push("--tools", shellEscape(allowedTools.join(",")));
  }

  if (effectiveSkills) {
    for (const skill of effectiveSkills
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      parts.push(shellEscape(`/skill:${skill}`));
    }
  }

  // Build env prefix: denied tools + subagent identity
  const envParts: string[] = [];
  if (denySet.size > 0) {
    envParts.push(`PI_DENY_TOOLS=${shellEscape([...denySet].join(","))}`);
  }
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  envParts.push(`PI_SUBAGENT_ID=${shellEscape(runId)}`);
  envParts.push(`PI_SUBAGENT_SOCKET=${shellEscape(parentIpcSocketPath)}`);
  envParts.push(`PI_SUBAGENT_TOKEN=${shellEscape(ipcToken)}`);
  envParts.push(`PI_SUBAGENT_AUTO_EXIT=${effectiveAutoExit ? "1" : "0"}`);
  envParts.push(`PI_SUBAGENT_DEPTH=${depth + 1}`);
  if (qualifiedModelForLock) {
    envParts.push(`PI_SUBAGENT_MODEL=${shellEscape(qualifiedModelForLock)}`);
  }
  if (effectiveThinking) {
    envParts.push(`PI_SUBAGENT_THINKING=${shellEscape(effectiveThinking)}`);
  }
  if (allowedTools?.length) {
    envParts.push(`PI_SUBAGENT_TOOLS=${shellEscape(allowedTools.join(","))}`);
  }
  if (params.agent) {
    envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  }
  // Custom env vars from agent frontmatter (e.g. "PI_PERMISSION_LEVEL=low PI_FOO=bar").
  // Lease hand-off values are parent-only capabilities and cannot be restored here.
  envParts.push(...customAgentEnvParts(agentDefs?.env));
  // Multiplexer server environments can lag behind the invoking Pi process.
  // Reassert profile selectors last so agent frontmatter cannot cross profiles.
  envParts.push(...inheritedProfileEnvParts());
  const envPrefix = ["env", ...inheritedProfileEnvUnsets(), ...envParts].join(" ") + " ";

  // Keep the launch task with the child session so it moves atomically with the transcript.
  const artifactDir = ensureSessionArtifactDir(subagentSessionFile);
  const config: ChildRunConfig = {
    schemaVersion: 1, skills: effectiveSkills, env: agentDefs?.env,
    systemPrompt: identity ?? undefined,
    agent: params.agent, model: qualifiedModelForLock, thinking: effectiveThinking,
    tools: allowedTools, autoExit: effectiveAutoExit,
  };
  writeArtifactFile(artifactDir, "context/subagent-config.json", JSON.stringify(config));
  const taskPath = writeArtifactFile(artifactDir, "context/subagent-task.md", fullTask);
  parts.push(`@${shellEscape(taskPath)}`);

  const cdPrefix = `cd ${shellEscape(effectiveCwd)} && `;
  const piCommand = cdPrefix + envPrefix + parts.join(" ");
  parentIpcServer.registerChild(runId, ipcToken);
  registeredWithIpc = true;

  if (effectiveWorkspace && !options?.surface) {
    // ── Workspace mode: launch in a WezTerm window on a dedicated Sway workspace ──
    const prevWs = getCurrentSwayWorkspace();
    const running: RunningSubagent = {
      id: runId,
      runId,
      childSessionId,
      mode,
      name: params.name,
      task: params.task,
      agent: params.agent,
      surface: `workspace:${effectiveWorkspace}`,
      startTime,
      sessionFile: subagentSessionFile,
      workspace: effectiveWorkspace,
      previousWorkspace: prevWs ?? undefined,
      ipcToken,
      autoExit: effectiveAutoExit,
      config,
    };

    options.onPrepared(running);
    prepared = running;
    const launched = launchWorkspaceSurface(effectiveWorkspace, params.name, piCommand, effectiveCwd);
    workspaceProcess = launched.process;
    running.workspaceProcess = workspaceProcess;
    return running;
  }

  // Journal the launch before the pane can execute any child code.
  const running: RunningSubagent = {
    id: runId,
    runId,
    childSessionId,
    mode,
    name: params.name,
    task: params.task,
    agent: params.agent,
    surface,
    startTime,
    sessionFile: subagentSessionFile,
    ipcToken,
    autoExit: effectiveAutoExit,
    config,
  };

  options.onPrepared(running);
  prepared = running;
  sendCommand(surface, piCommand);
  return running;
  } catch (error) {
    if (prepared) {
      options.onFailed(prepared, error);
      throw error;
    }
    if (registeredWithIpc) parentIpcServer?.unregisterChild(runId);
    if (workspaceProcess) {
      try { process.kill(workspaceProcess.pid!, "SIGTERM"); } catch {}
    } else if (surface && !surface.startsWith("workspace:")) {
      try { closeSurface(surface); } catch {}
    }
    // No launch entry was persisted yet, so remove the transcript bundle rather
    // than leaving an unresumable orphan after pane/artifact setup failed.
    try { rmSync(subagentSessionFile, { force: true }); } catch {}
    try { rmSync(dirname(getSessionArtifactDir(subagentSessionFile)), { recursive: true, force: true }); } catch {}
    throw error;
  }
}

export default function subagentsExtension(pi: ExtensionAPI) {
  const reportChildren = () => pi.events?.emit("subagent:children", runningSubagents.size);
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
    if (!acceptIpcResults) return;
    const running = runningSubagents.get(result.id ?? "");
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
    runningSubagents.delete(childId);
    reportChildren();
    const failureTimer = connectionFailureTimers.get(childId);
    if (failureTimer) clearTimeout(failureTimer);
    connectionFailureTimers.delete(childId);
    const server = parentIpcServer;
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
            else if (descendant.surface) { try { closeSurface(descendant.surface); } catch {} }
          }
        } catch (error) {
          latestCtx?.ui.notify(`Forced cleanup could not inspect descendants of ${running.name}: ${String(error)}`, "warning");
        }
      }
      server?.unregisterChild(childId);
      if (running.workspace) {
        terminateWorkspaceChild(running);
        if (running.workspaceProcess?.pid) {
          try { process.kill(running.workspaceProcess.pid, "SIGTERM"); } catch {}
        }
        if (running.previousWorkspace) switchSwayWorkspace(running.previousWorkspace);
      } else if (running.surface) {
        try { closeSurface(running.surface); } catch {}
      }
      if (running.forkCleanupFile) {
        try { unlinkSync(running.forkCleanupFile); } catch {}
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

  const drainChildren = (): Promise<void> => {
    if (drainPromise) return drainPromise;
    for (const running of [...runningSubagents.values()]) {
      finishSubagent({
        id: running.id, name: running.name, task: running.task, agent: running.agent,
        protocolStatus: "cancelled", protocolError: "Parent run ended.",
        elapsed: Math.floor((Date.now() - running.startTime) / 1000),
      }, false);
    }
    drainPromise = Promise.all([...cleanupTimers.values()].map(({ done }) => done)).then(() => {});
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
      latestCtx?.ui.notify(`Cannot recover ${running.name}: ${String(error)}`, "warning");
      return false;
    }
  };

  const scheduleConnectionFailure = (childId: string, delayMs: number, reason: string) => {
    const previous = connectionFailureTimers.get(childId);
    if (previous) clearTimeout(previous);
    connectionFailureTimers.set(childId, setTimeout(() => {
      connectionFailureTimers.delete(childId);
      const running = runningSubagents.get(childId);
      if (!running || running.connected || !acceptIpcResults) return;
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
    if (!acceptIpcResults) return;
    if (message.type === "shutdown_ready") {
      cleanupTimers.get(message.childId)?.cleanup();
      return;
    }
    const running = runningSubagents.get(message.childId);
    if (!running) {
      const completed = completedRuns.get(message.childId);
      if (completed && ["hello", "ready", "completion"].includes(message.type)) {
        if (completed.protocolStatus === "completed") parentIpcServer?.send(message.childId, "completion_ack", { runId: message.childId });
        else parentIpcServer?.send(message.childId, "shutdown", { reason: completed.protocolStatus });
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
      } catch {}
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
        if (!acceptIpcResults || !runningSubagents.has(running.id)) return;
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
    latestCtx = ctx;
    drainPromise = undefined;
    registerLifecycleListeners();

    acceptIpcResults = false;
    await parentIpcServer?.close().catch(() => {});
    parentIpcSocketPath = getIpcSocketPath(ctx.sessionManager.getSessionId());

    const ledger = restoreRunLedger(ctx.sessionManager.getEntries());
    completedRuns.clear();
    for (const [id, finish] of ledger.finishes) {
      if (finish.result) completedRuns.set(id, finish.result);
    }
    runningSubagents.clear();
    for (const data of ledger.unresolved as Partial<RunningSubagent>[]) {
      if (!data?.id || !data.ipcToken || !data.sessionFile) continue;
      let sessionCorrelation: ReturnType<typeof readSubagentSessionCorrelation> | undefined;
      try {
        sessionCorrelation = readSubagentSessionCorrelation(data.sessionFile);
      } catch {}
      const restored = {
        ...data,
        runId: data.runId ?? data.id,
        childSessionId: data.childSessionId ?? sessionCorrelation?.childSessionId ?? data.id,
        mode: data.mode ?? "fresh",
      } as RunningSubagent;
      runningSubagents.set(restored.id, restored);
    }

    parentIpcServer = new ParentIpcServer({
      socketPath: parentIpcSocketPath,
      onMessage: handleIpcMessage,
      onConnect: (childId) => {
        const timer = connectionFailureTimers.get(childId);
        if (timer) clearTimeout(timer);
        connectionFailureTimers.delete(childId);
        const running = runningSubagents.get(childId);
        if (running) running.connected = true;
        updateWidget();
      },
      onDisconnect: (childId) => {
        const running = runningSubagents.get(childId);
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
    for (const running of runningSubagents.values()) {
      parentIpcServer.registerChild(running.id, running.ipcToken);
    }
    await parentIpcServer.start();
    acceptIpcResults = true;
    for (const result of ledger.pendingResults) deliverResult(result);
    // A crash can occur after committing a terminal outcome but before closing
    // its pane. Reap only journalled, still-open surfaces, deepest descendants first.
    for (const run of ledger.openSurfaces as RunningSubagent[]) {
      if (!ledger.finishes.has(run.runId ?? run.id)) continue;
      try {
        for (const surface of [...collectOpenDescendants(run.sessionFile), run]) {
          if (surface.workspace) terminateWorkspaceChild(surface);
          else if (surface.surface) { try { closeSurface(surface.surface); } catch {} }
        }
        pi.appendEntry(CLOSED_ENTRY, { id: run.id, runId: run.runId, closedAt: Date.now() });
      } catch (error) {
        ctx.ui.notify(`Could not reap completed subagent ${run.name}: ${String(error)}`, "warning");
      }
    }
    for (const running of runningSubagents.values()) {
      if (recoverCompletion(running)) continue;
      scheduleConnectionFailure(
        running.id,
        15_000,
        "Subagent did not reconnect to IPC after the parent session reloaded.",
      );
    }
    reportChildren();
    if (runningSubagents.size > 0) startWidgetRefresh();
  });

  // Preserve child processes across /reload; terminate them for real parent-session shutdowns.
  pi.on("session_shutdown", async (event, _ctx) => {
    if (event.reason !== "reload") await drainChildren();
    acceptIpcResults = false;
    if (widgetInterval) clearInterval(widgetInterval);
    widgetInterval = null;
    for (const { timer, cleanup } of cleanupTimers.values()) {
      clearTimeout(timer);
      cleanup(true);
    }
    cleanupTimers.clear();
    for (const timer of connectionFailureTimers.values()) clearTimeout(timer);
    connectionFailureTimers.clear();
    await parentIpcServer?.close().catch(() => {});
    parentIpcServer = null;
    latestCtx = null;
    unsubscribeChildren?.();
    unsubscribeDrain?.();
  });

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(
    (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const shouldRegister = (name: string) => !deniedTools.has(name);

  // ── subagent tool ──
  if (shouldRegister("subagent"))
    pi.registerTool(defineTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "IMPORTANT: This tool returns immediately and the child runs asynchronously. " +
        "Do not fabricate or assume its result. " + SUBAGENT_ASYNC_GUIDANCE,
      promptSnippet:
        "Spawn a sub-agent asynchronously. Do not fabricate its result. " + SUBAGENT_ASYNC_GUIDANCE,
      promptGuidelines: [
        "After using subagent, never poll child status. If no independent work remains, end the turn silently with no text and no further tool calls; child completion arrives as a steer message and triggers the next turn.",
      ],
      parameters: SubagentParams,

      async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
        const params = rawParams as SubagentParamsValue;
        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        // Enforce max-instances limit
        if (params.agent) {
          const agentDefs = loadAgentDefaults(params.agent, ctx.cwd, ctx.isProjectTrusted());
          if (agentDefs?.maxInstances != null) {
            const running = Array.from(runningSubagents.values()).filter(
              (a) => a.agent === params.agent,
            );
            if (running.length >= agentDefs.maxInstances) {
              const names = running.map((a) => a.name).join(", ");
              return {
                content: [
                  {
                    type: "text",
                    text: `Cannot spawn another ${params.agent} agent — max ${agentDefs.maxInstances} instance${agentDefs.maxInstances !== 1 ? "s" : ""} allowed (running: ${names}). Wait for it to finish or kill it first.`,
                  },
                ],
                details: { error: "max-instances reached", running: running.map((a) => a.id) },
              };
            }
          }
        }

        // Validate prerequisites
        if (!isMuxAvailable()) {
          return muxUnavailableResult("subagents");
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // Launch the subagent (creates pane, sends command)
        const allToolNames = pi.getAllTools().map((t: any) => t.name);
        const running = await launchSubagent(params, ctx, {
          allToolNames, activeToolNames: pi.getActiveTools(), projectTrusted: ctx.isProjectTrusted(),
          onPrepared: (running) => {
            pi.appendEntry(IPC_LAUNCH_ENTRY, serializeRunning(running));
            runningSubagents.set(running.id, running);
            reportChildren();
            scheduleConnectionFailure(running.id, 120_000, "Subagent did not establish its IPC connection during startup (check project trust or authentication).");
          },
          onFailed: (running, error) => finishSubagent({
            id: running.id, name: running.name, task: running.task, agent: running.agent,
            protocolStatus: "failed", protocolError: `Launch failed: ${String(error)}`, elapsed: 0,
          }),
        });

        // Start widget refresh when first agent launches. Lifecycle now arrives over IPC.
        startWidgetRefresh();

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do not generate or assume any result. ${SUBAGENT_ASYNC_GUIDANCE}`,
            },
          ],
          details: {
            id: running.id,
            runId: running.runId,
            childSessionId: running.childSessionId,
            mode: running.mode,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            status: "started",
          },
        };
      },

      renderCall(rawArgs, theme) {
        const args = rawArgs as Partial<SubagentParamsValue>;
        const agent = args.agent ? theme.fg("dim", ` (${args.agent})`) : "";
        const cwdHint = args.cwd ? theme.fg("dim", ` in ${args.cwd}`) : "";
        let text =
          "▸ " + theme.fg("toolTitle", theme.bold(args.name ?? "(unnamed)")) + agent + cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        const task = args.task ?? "";
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const first = result.content?.[0];
        const text = first && "text" in first ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    }));

  // ── subagents_list tool ──
  if (shouldRegister("subagents_list"))
    pi.registerTool(defineTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List effective subagent definitions: trusted project .pi/agents, active profile agents, then bundled defaults. Chain files are not supported.",
      promptSnippet:
        "List effective subagent definitions from the trusted project, active profile and bundled defaults.",
      parameters: Type.Object({}),

      async execute(_id, _params, _signal, _update, ctx) {
        const list = listAgentDefinitions(ctx.cwd, ctx.isProjectTrusted());
        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    }));

  // ── set_tab_title tool ──
  // Only useful for sub-agents reporting progress to the orchestrator.
  if (shouldRegister("set_tab_title") && !!process.env.PI_SUBAGENT_NAME)
    pi.registerTool(defineTool({
      name: "set_tab_title",
      label: "Set Tab Title",
      description:
        "Update the current tab/window and workspace/session title. Use to show progress during multi-phase workflows " +
        "(e.g. planning, executing todos, reviewing). Keep titles short and informative.",
      promptSnippet:
        "Update the current tab/window and workspace/session title. Use to show progress during multi-phase workflows " +
        "(e.g. planning, executing todos, reviewing). Keep titles short and informative.",
      parameters: Type.Object({
        title: Type.String({
          description: "New tab title (also applied to workspace/session when supported)",
        }),
      }),

      async execute(_toolCallId, rawParams): Promise<any> {
        const params = rawParams as { title: string };
        if (!isMuxAvailable()) {
          return muxUnavailableResult("tab-title");
        }
        try {
          renameCurrentTab(params.title);
          renameWorkspace(params.title);
          return {
            content: [{ type: "text" as const, text: `Title set to: ${params.title}` }],
            details: { title: params.title },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `Failed to set title: ${err?.message}` }],
            details: { error: err?.message },
          };
        }
      },
    }));

  // ── subagent_resume tool ──
  if (shouldRegister("subagent_resume"))
    pi.registerTool(defineTool({
      name: "subagent_resume",
      label: "Resume Subagent",
      description:
        "Resume a previous sub-agent session in a new multiplexer pane. " +
        "IMPORTANT: Returns IMMEDIATELY — the resumed session runs asynchronously in the background. " +
        "Results are delivered later via a steer message. Do NOT fabricate or assume results. " +
        "Use when a sub-agent was cancelled or needs follow-up work.",
      promptSnippet:
        "Resume a previous sub-agent session in a new multiplexer pane. " +
        "IMPORTANT: Returns IMMEDIATELY — the resumed session runs asynchronously in the background. " +
        "Results are delivered later via a steer message. Do NOT fabricate or assume results. " +
        "Use when a sub-agent was cancelled or needs follow-up work.",
      parameters: Type.Object({
        sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
        name: Type.Optional(
          Type.String({ description: "Display name for the terminal tab. Default: 'Resume'" }),
        ),
        message: Type.Optional(
          Type.String({
            description: "Optional message to send after resuming (e.g. follow-up instructions)",
          }),
        ),
      }),

      renderCall(rawArgs, theme) {
        const args = rawArgs as { name?: string };
        const name = args.name ?? "Resume";
        const text =
          "▸ " + theme.fg("toolTitle", theme.bold(name)) + theme.fg("dim", " — resuming session");
        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "Resume";

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback
        const first = result.content?.[0];
        const text = first && "text" in first ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
        const params = rawParams as { sessionPath: string; name?: string; message?: string };
        const name = params.name ?? "Resume";
        const startTime = Date.now();

        if (!isMuxAvailable()) {
          return muxUnavailableResult("subagents");
        }

        if (!existsSync(resolve(ctx.cwd, params.sessionPath))) {
          return {
            content: [
              { type: "text", text: `Error: session file not found: ${params.sessionPath}` },
            ],
            details: { error: "session not found" },
          };
        }

        if (!parentIpcServer || !parentIpcSocketPath) {
          return {
            content: [{ type: "text", text: "Error: subagent IPC server is not ready." }],
            details: { error: "ipc unavailable" },
          };
        }

        const sessionFile = resolve(ctx.cwd, params.sessionPath);
        if ([...runningSubagents.values()].some((run) => run.sessionFile === sessionFile)) {
          throw new Error("This session already has an active subagent run. Finish or cancel it before resuming.");
        }
        const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
        if (!Number.isSafeInteger(depth) || depth >= 4) throw new Error("Subagent nesting limit (4) reached.");
        const correlation = readSubagentSessionCorrelation(sessionFile);
        const savedConfig = readChildRunConfig(join(getSessionArtifactDir(sessionFile), "context/subagent-config.json"));
        const legacyDefs = !savedConfig && correlation.agent
          ? loadAgentDefaults(correlation.agent, correlation.cwd, correlation.cwd === ctx.cwd && ctx.isProjectTrusted()) : null;
        const restoredConfig = savedConfig ?? legacyChildDefaults(correlation.agent, legacyDefs);
        const config: ChildRunConfig = {
          ...restoredConfig, schemaVersion: 1,
          tools: resolveChildTools({ ...legacyDefs, tools: restoredConfig.tools?.join(",") }, pi.getActiveTools(), pi.getAllTools().map((tool) => tool.name)),
          autoExit: false,
        };
        const runId = randomUUID();
        const ipcToken = createIpcToken();
        let surface: string | undefined;
        let resumeMessagePath: string | undefined;

        const parts = ["pi", "--session", shellEscape(sessionFile), "--tools", shellEscape(config.tools.join(","))];
        if (config.model) parts.push("--model", shellEscape(config.thinking ? `${config.model}:${config.thinking}` : config.model));
        if (config.systemPrompt) parts.push("--append-system-prompt", shellEscape(config.systemPrompt));
        for (const skill of config.skills?.split(",").map((skill) => skill.trim()).filter(Boolean) ?? []) {
          parts.push(shellEscape(`/skill:${skill}`));
        }
        const subagentDonePath = join(
          dirname(new URL(import.meta.url).pathname),
          "subagent-done.ts",
        );
        parts.push("-e", shellEscape(subagentDonePath));

        if (params.message) {
          const artifactDir = ensureSessionArtifactDir(sessionFile);
          resumeMessagePath = writeArtifactFile(
            artifactDir,
            `context/resume-${runId}.md`,
            `${params.message}\n\n${SUBAGENT_COMPLETION_INSTRUCTION}`,
          );
          parts.push(`@${shellEscape(resumeMessagePath)}`);
        }

        const envParts = [
          `PI_SUBAGENT_NAME=${shellEscape(name)}`,
          `PI_SUBAGENT_ID=${shellEscape(runId)}`,
          `PI_SUBAGENT_SOCKET=${shellEscape(parentIpcSocketPath)}`,
          `PI_SUBAGENT_TOKEN=${shellEscape(ipcToken)}`,
          "PI_SUBAGENT_AUTO_EXIT=0",
          `PI_SUBAGENT_DEPTH=${depth + 1}`,
          `PI_SUBAGENT_TOOLS=${shellEscape(config.tools.join(","))}`,
          `PI_DENY_TOOLS=${shellEscape(withChildOnlyTools(pi.getAllTools().map((tool) => tool.name))!.filter((tool) => !config.tools.includes(tool)).join(","))}`,
          ...(config.agent ? [`PI_SUBAGENT_AGENT=${shellEscape(config.agent)}`] : []),
          ...(config.model ? [`PI_SUBAGENT_MODEL=${shellEscape(config.model)}`] : []),
          ...(config.thinking ? [`PI_SUBAGENT_THINKING=${shellEscape(config.thinking)}`] : []),
          ...customAgentEnvParts(config.env),
          ...inheritedProfileEnvParts(),
        ];
        const envPrefix = ["env", ...inheritedProfileEnvUnsets(), ...envParts].join(" ") + " ";
        const command = `cd ${shellEscape(correlation.cwd)} && ${envPrefix}${parts.join(" ")}`;
        let running: RunningSubagent | undefined;
        try {
          surface = createSurface(name);
          await new Promise<void>((resolve) => setTimeout(resolve, 500));
          running = {
            id: runId, runId, childSessionId: correlation.childSessionId,
            resumeOfRunId: correlation.originatingRunId, mode: "resume", name,
            agent: config.agent, task: params.message ?? "resumed session", surface,
            startTime, sessionFile, ipcToken, autoExit: false, config,
          };
          parentIpcServer.registerChild(runId, ipcToken);
          pi.appendEntry(IPC_LAUNCH_ENTRY, serializeRunning(running));
          runningSubagents.set(runId, running);
          reportChildren();
          scheduleConnectionFailure(runId, 120_000, "Resumed subagent did not connect during startup (check project trust or authentication).");
          sendCommand(surface, command);
        } catch (error) {
          if (runningSubagents.has(runId) && running) {
            finishSubagent({ id: runId, name, task: running.task, protocolStatus: "failed", protocolError: String(error), elapsed: 0 });
          } else {
            parentIpcServer.unregisterChild(runId);
            if (surface) { try { closeSurface(surface); } catch {} }
            if (resumeMessagePath) { try { unlinkSync(resumeMessagePath); } catch {} }
          }
          throw error;
        }
        startWidgetRefresh();

        return {
          content: [{ type: "text", text: `Session "${name}" resumed.` }],
          details: {
            id: runId,
            runId,
            childSessionId: correlation.childSessionId,
            resumeOfRunId: correlation.originatingRunId,
            mode: "resume",
            name,
            sessionPath: sessionFile,
            sessionFile,
            status: "started",
          },
        };
      },
    }));

  // ── subagent_kill tool ──
  if (shouldRegister("subagent_kill"))
    pi.registerTool(defineTool({
      name: "subagent_kill",
      label: "Kill Subagent",
      description: SUBAGENT_KILL_GUIDANCE,
      promptSnippet: SUBAGENT_KILL_GUIDANCE,
      promptGuidelines: [
        "Never call subagent_kill to poll child status. Omit its target only when the user explicitly asks to inspect running sub-agents.",
      ],
      parameters: Type.Object({
        target: Type.Optional(
          Type.String({
            description:
              "Subagent to kill: an id, a name (case-insensitive partial match), or 'all'. Omit only when the user explicitly asks to inspect running subagents.",
          }),
        ),
      }),

      renderCall(rawArgs, theme) {
        const args = rawArgs as { target?: string };
        const target = args.target ?? "(list)";
        return new Text(
          "▸ " + theme.fg("toolTitle", theme.bold("Kill Subagent")) + theme.fg("dim", ` — ${target}`),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const first = result.content?.[0];
        const text = first && "text" in first ? first.text : "";
        const details = result.details as any;
        if (details?.killed) {
          const names = details.killed.map((k: any) => k.name).join(", ");
          return new Text(
            theme.fg("error", "✗") + " Killed: " + theme.fg("toolTitle", names),
            0,
            0,
          );
        }
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, rawParams) {
        const params = rawParams as { target?: string };
        const agents = Array.from(runningSubagents.values());

        // No target: list running subagents
        if (!params.target) {
          if (agents.length === 0) {
            return {
              content: [{ type: "text", text: "No sub-agents currently running." }],
              details: { running: [] },
            };
          }
          const lines = agents.map((a) => {
            const elapsed = formatElapsedMMSS(a.startTime);
            const agentTag = a.agent ? ` (${a.agent})` : "";
            return `• ${a.name}${agentTag} [id: ${a.id}] — ${formatSubagentState(a)} · elapsed ${elapsed}`;
          });
          return {
            content: [
              {
                type: "text",
                text: `Running sub-agents (${agents.length}):\n${lines.join("\n")}\n\nPass a name, id, or 'all' to kill. Do not poll again; completion will arrive automatically via a steer message.`,
              },
            ],
            details: {
              running: agents.map((a) => ({
                id: a.id,
                name: a.name,
                agent: a.agent,
                status: formatSubagentState(a),
                pendingUiRequestCount: a.pendingUiRequestCount,
                uiRequests: a.uiRequests,
              })),
            },
          };
        }

        // Resolve targets
        let targets: RunningSubagent[];
        if (params.target.toLowerCase() === "all") {
          targets = agents;
        } else {
          const query = params.target.toLowerCase();
          targets = agents.filter(
            (a) =>
              a.id === params.target ||
              a.name.toLowerCase().includes(query) ||
              (a.agent && a.agent.toLowerCase().includes(query)),
          );
        }

        if (targets.length === 0) {
          const available =
            agents.length > 0
              ? `\nRunning: ${agents.map((a) => `${a.name} [${a.id}]`).join(", ")}`
              : "\nNo sub-agents currently running.";
          return {
            content: [
              {
                type: "text",
                text: `No sub-agent matching "${params.target}".${available}`,
              },
            ],
            details: { error: "not found" },
          };
        }

        // Kill each target
        const killed: { id: string; name: string; agent?: string; elapsed: number }[] = [];
        for (const agent of targets) {
          const elapsed = Math.floor((Date.now() - agent.startTime) / 1000);
          finishSubagent({
            id: agent.id, name: agent.name, task: agent.task, agent: agent.agent,
            protocolStatus: "cancelled", protocolError: "Cancelled by the parent.", elapsed,
          }, false);
          killed.push({ id: agent.id, name: agent.name, agent: agent.agent, elapsed });
        }

        updateWidget();

        const summary = killed
          .map((k) => {
            const agentTag = k.agent ? ` (${k.agent})` : "";
            return `• ${k.name}${agentTag} — killed after ${formatElapsed(k.elapsed)}`;
          })
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Killed ${killed.length} sub-agent${killed.length !== 1 ? "s" : ""}:\n${summary}`,
            },
          ],
          details: { killed },
        };
      },
    }));

  // /iterate command — fork the session into a subagent
  pi.registerCommand("iterate", {
    description: "Fork session into a subagent for focused work (bugfixes, iteration)",
    handler: async (args, _ctx) => {
      const task = args?.trim() || "";
      const toolCall = task
        ? `Use subagent to fork a session. fork: true, name: "Iterate", task: ${JSON.stringify(task)}`
        : `Use subagent to fork a session. fork: true, name: "Iterate", task: "The user wants to do some hands-on work. Help them with whatever they need."`;
      pi.sendUserMessage(toolCall);
    },
  });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName, ctx.cwd, ctx.isProjectTrusted());
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in the trusted project, active profile or bundled definitions`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as SubagentResult | undefined;
    if (!details) return undefined;

    const fit = (line: string, width: number) => truncateToWidth(line, Math.max(0, width - 6), "…");
    const pushWrapped = (lines: string[], text: string, width: number, color?: (s: string) => string) => {
      for (const line of text.split("\n")) {
        const fitted = fit(line, width);
        lines.push(color ? color(fitted) : fitted);
      }
    };

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const taskStatus = details.result?.status;

        let icon = theme.fg("success", "✓");
        let statusText = "completed";
        let bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        if (details.protocolStatus === "failed") {
          icon = theme.fg("error", "✗");
          statusText = "protocol failed";
          bgFn = (text: string) => theme.bg("toolErrorBg", text);
        } else if (details.protocolStatus === "cancelled") {
          icon = theme.fg("warning", "■");
          statusText = "cancelled";
          bgFn = (text: string) => theme.bg("toolPendingBg", text);
        } else if (taskStatus === "failed") {
          icon = theme.fg("error", "✗");
          statusText = "task failed";
          bgFn = (text: string) => theme.bg("toolErrorBg", text);
        } else if (taskStatus === "blocked") {
          icon = theme.fg("warning", "!");
          statusText = "blocked";
          bgFn = (text: string) => theme.bg("toolPendingBg", text);
        } else if (taskStatus === "success") {
          statusText = "success";
        }

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${statusText} ${theme.fg("dim", `(${elapsed})`)}`;
        const contentLines = [header];

        if (details.protocolStatus === "completed" && details.result) {
          const result = details.result;
          const expandedText = result.report ?? result.summary;

          if (options.expanded) {
            contentLines.push("");
            pushWrapped(contentLines, expandedText, width);

            if (result.artifacts?.length) {
              contentLines.push("", theme.fg("toolTitle", theme.bold("Artifacts:")));
              for (const artifact of result.artifacts) {
                const path = artifact.path ?? artifact.name;
                const description = artifact.description ? ` — ${artifact.description}` : "";
                contentLines.push(theme.fg("dim", fit(`- ${path}${description}`, width)));
              }
            }

            if (result.nextSteps?.length) {
              contentLines.push("", theme.fg("toolTitle", theme.bold("Next steps:")));
              result.nextSteps.forEach((step, i) => {
                contentLines.push(theme.fg("dim", fit(`${i + 1}. ${step}`, width)));
              });
            }

            if (details.sessionFile) {
              contentLines.push("", theme.fg("dim", fit(`Session: ${details.sessionFile}`, width)));
              contentLines.push(theme.fg("dim", fit(`Resume:  pi --session ${details.sessionFile}`, width)));
            }
          } else {
            pushWrapped(contentLines, result.summary, width, (line) => theme.fg("dim", line));
            const extras: string[] = [];
            if (result.report) extras.push("full report");
            if (result.artifacts?.length) extras.push(`${result.artifacts.length} artifact${result.artifacts.length === 1 ? "" : "s"}`);
            if (result.nextSteps?.length) extras.push(`${result.nextSteps.length} next step${result.nextSteps.length === 1 ? "" : "s"}`);
            if (extras.length) {
              contentLines.push(theme.fg("muted", fit(`… ${extras.join(", ")}`, width)));
            }
            contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
          }
        } else {
          const messageText = details.protocolError ?? details.diagnosticSummary ?? "No details available.";
          if (options.expanded) {
            pushWrapped(contentLines, messageText, width, (line) => theme.fg("dim", line));
            if (details.diagnosticSummary && details.protocolError) {
              contentLines.push("", theme.fg("toolTitle", theme.bold("Diagnostic last assistant message:")));
              pushWrapped(contentLines, details.diagnosticSummary, width, (line) => theme.fg("dim", line));
            }
            if (details.sessionFile) {
              contentLines.push("", theme.fg("dim", fit(`Session: ${details.sessionFile}`, width)));
              contentLines.push(theme.fg("dim", fit(`Resume:  pi --session ${details.sessionFile}`, width)));
            }
          } else {
            pushWrapped(contentLines, messageText.split("\n").slice(0, 3).join("\n"), width, (line) => theme.fg("dim", line));
            contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
          }
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // /plan command — start the full planning workflow
  pi.registerCommand("plan", {
    description: "Start a planning session: /plan <what to build>",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim();
      if (!task) {
        ctx.ui.notify("Usage: /plan <what to build>", "warning");
        return;
      }

      // Rename workspace and tab to show this is a planning session
      if (isMuxAvailable()) {
        try {
          const label = task.length > 40 ? task.slice(0, 40) + "..." : task;
          renameWorkspace(`🎯 ${label}`);
          renameCurrentTab(`🎯 Plan: ${label}`);
        } catch {
          // non-critical -- do not block the plan
        }
      }

      // Load the plan skill from the subagents extension directory
      const planSkillPath = join(dirname(new URL(import.meta.url).pathname), "plan-skill.md");
      let content = readFileSync(planSkillPath, "utf8");
      content = content.replace(/^---\n[\s\S]*?\n---\n*/, "");
      pi.sendUserMessage(
        `<skill name="plan" location="${planSkillPath}">\n${content.trim()}\n</skill>\n\n${task}`,
      );
    },
  });
}
