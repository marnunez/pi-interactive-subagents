import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const defineTool = <T>(tool: T): T => tool;
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  readdirSync,
  statSync,
  readFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { ChildProcess, spawn as nodeSpawn, execSync as nodeExecSync } from "node:child_process";
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
  "Complete your task. When finished, call the subagent_done tool exactly once with a structured result. " +
  "Set status to success, failed, or blocked; put the concise orchestration result in summary; " +
  "put the expanded human-readable result in report when useful; list any write_artifact outputs in artifacts; " +
  "and include recommended follow-up actions in nextSteps. Exiting without subagent_done is a protocol failure. " +
  "The user can interact with you at any time, but the same completion contract still applies.";

const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name to load defaults from (e.g. 'worker', 'scout', 'reviewer'). Reads ~/.pi/agent/agents/<name>.md for model, tools, skills.",
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

interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  allowTools?: string;
  spawning?: boolean;
  maxInstances?: number;
  cwd?: string;
  workspace?: string;
  env?: string;
  autoExit?: boolean;
  body?: string;
}

const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

/** Tools that are gated by `spawning: false` */
const SPAWNING_TOOLS = new Set(["subagent", "subagents_list", "subagent_resume", "subagent_kill"]);

/** Child-only tools that may not exist in the parent process' tool registry. */
const CHILD_ONLY_TOOLS = new Set(["subagent_done", "set_tab_title"]);

/** Lifecycle tools that must remain available even under allow/deny filtering. */
const MANDATORY_CHILD_TOOLS = new Set(["subagent_done"]);

function parseToolCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function withChildOnlyTools(allToolNames?: string[]): string[] | undefined {
  if (!allToolNames) return undefined;
  return [...new Set([...allToolNames, ...CHILD_ONLY_TOOLS])];
}

function buildSubagentToolAllowList(
  effectiveTools: string | undefined,
  denySet: Set<string>,
  allToolNames?: string[],
): string[] | undefined {
  if (!effectiveTools) return undefined;

  const requestedBuiltins = parseToolCsv(effectiveTools).filter((tool) => BUILTIN_TOOLS.has(tool));
  const extensionTools = (allToolNames ?? [])
    .filter((tool) => !BUILTIN_TOOLS.has(tool))
    .filter((tool) => !denySet.has(tool));

  for (const tool of MANDATORY_CHILD_TOOLS) {
    if (!denySet.has(tool)) extensionTools.push(tool);
  }

  return [...new Set([...requestedBuiltins, ...extensionTools])];
}

/**
 * Resolve the effective set of denied tool names from agent defaults.
 *
 * If `allow-tools` is present, it acts as a whitelist: all tools NOT in the
 * list are denied. This takes priority over `deny-tools`.
 *
 * Otherwise, `deny-tools` is used as a blacklist, and `spawning: false`
 * expands to all SPAWNING_TOOLS.
 *
 * @param allToolNames - all currently registered tool names (from pi.getAllTools())
 */
function resolveDenyTools(agentDefs: AgentDefaults | null, allToolNames?: string[]): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;

  // allow-tools (whitelist) takes priority when present
  if (agentDefs.allowTools && allToolNames) {
    const allowed = new Set(
      agentDefs.allowTools
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    for (const tool of allToolNames) {
      if (!allowed.has(tool)) denied.add(tool);
    }
    return denied;
  }

  // spawning: false → deny all spawning tools
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  // deny-tools: explicit blacklist
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      denied.add(t);
    }
  }

  return denied;
}

function loadAgentDefaults(agentName: string): AgentDefaults | null {
  const paths = [
    join(process.cwd(), ".pi", "agents", `${agentName}.md`),
    join(homedir(), ".pi", "agent", "agents", `${agentName}.md`),
    join(dirname(new URL(import.meta.url).pathname), "../../agents", `${agentName}.md`),
  ];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const content = readFileSync(p, "utf8");
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) continue;
    const frontmatter = match[1];
    const get = (key: string) => {
      const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
      return m ? m[1].trim() : undefined;
    };
    // Extract body (everything after frontmatter)
    const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
    const spawningRaw = get("spawning");
    const autoExitRaw = get("auto-exit");
    return {
      model: get("model"),
      tools: get("tools"),
      skills: get("skill") ?? get("skills"),
      thinking: get("thinking"),
      denyTools: get("deny-tools"),
      allowTools: get("allow-tools"),
      maxInstances: get("max-instances") ? parseInt(get("max-instances")!, 10) : undefined,
      spawning: spawningRaw != null ? spawningRaw === "true" : undefined,
      cwd: get("cwd"),
      workspace: get("workspace"),
      env: get("env"),
      autoExit: autoExitRaw != null ? autoExitRaw === "true" : undefined,
      body: body || undefined,
    };
  }
  return null;
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
    join(homedir(), ".pi", "agent", "settings.json"),
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
  return PROFILE_ENV_NAMES.flatMap((name) => (process.env[name] == null ? ["-u", name] : []));
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
  ipcToken: string;
  autoExit: boolean;
  connected?: boolean;
  state?: SubagentRunState;
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
    return request?.title ? `waiting: ${request.title}` : "waiting for input";
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

export const __test__ = {
  borderLine,
  renderSubagentWidgetLines,
  qualifyModelWithProvider,
  buildSubagentToolAllowList,
  resolveDenyTools,
  withChildOnlyTools,
  resolveEffectiveChildCwd,
  inheritedProfileEnvParts,
  inheritedProfileEnvUnsets,
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
  try { nodeExecSync(`swaymsg workspace "${name}"`, { stdio: "ignore" }); } catch {}
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
  options?: { surface?: string; allToolNames?: string[] },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const runId = randomUUID();
  const ipcToken = createIpcToken();

  if (!parentIpcServer || !parentIpcSocketPath) {
    throw new Error("Subagent IPC server is not ready");
  }

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
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
    ? selectForkHistory(ctx.sessionManager.getBranch() as SessionEntry[])
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
  const denySet = resolveDenyTools(agentDefs, withChildOnlyTools(options?.allToolNames));
  for (const tool of MANDATORY_CHILD_TOOLS) denySet.delete(tool);
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
  const roleBlock = identity ? `\n\n${identity}` : "";
  const fullTask = params.fork
    ? `${params.task}\n\n${modeHint}`
    : `${roleBlock}\n\n${modeHint}\n\n${tabTitleInstruction}\n\n${params.task}`;

  // Build pi command
  const parts: string[] = ["pi"];
  parts.push("--session", shellEscape(subagentSessionFile));

  const subagentDonePath = join(dirname(new URL(import.meta.url).pathname), "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));

  let qualifiedModelForLock: string | undefined;
  if (effectiveModel) {
    qualifiedModelForLock = qualifyModelWithProvider(effectiveModel, ctx);
    const model = effectiveThinking ? `${qualifiedModelForLock}:${effectiveThinking}` : qualifiedModelForLock;
    parts.push("--model", shellEscape(model));
  }

  const allowedTools = buildSubagentToolAllowList(effectiveTools, denySet, withChildOnlyTools(options?.allToolNames));
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
  // Custom env vars from agent frontmatter (e.g. "PI_PERMISSION_LEVEL=low PI_FOO=bar")
  if (agentDefs?.env) {
    for (const pair of agentDefs.env.split(/\s+/).filter(Boolean)) {
      if (pair.includes("=")) envParts.push(pair);
    }
  }
  // Multiplexer server environments can lag behind the invoking Pi process.
  // Reassert profile selectors last so agent frontmatter cannot cross profiles.
  envParts.push(...inheritedProfileEnvParts());
  const envPrefix = ["env", ...inheritedProfileEnvUnsets(), ...envParts].join(" ") + " ";

  // Keep the launch task with the child session so it moves atomically with the transcript.
  const artifactDir = ensureSessionArtifactDir(subagentSessionFile);
  const taskPath = writeArtifactFile(artifactDir, "context/subagent-task.md", fullTask);
  parts.push(`@${shellEscape(taskPath)}`);

  const cdPrefix = `cd ${shellEscape(effectiveCwd)} && `;
  const piCommand = cdPrefix + envPrefix + parts.join(" ");
  parentIpcServer.registerChild(runId, ipcToken);
  registeredWithIpc = true;

  if (effectiveWorkspace && !options?.surface) {
    // ── Workspace mode: launch in a WezTerm window on a dedicated Sway workspace ──
    const command = piCommand;
    const { process: wezProc, previousWorkspace: prevWs } = launchWorkspaceSurface(
      effectiveWorkspace,
      params.name,
      command,
      effectiveCwd,
    );
    workspaceProcess = wezProc;

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
      workspaceProcess: wezProc,
      ipcToken,
      autoExit: effectiveAutoExit,
    };

    runningSubagents.set(runId, running);
    return running;
  }

  // ── Normal mode: multiplexer pane ──
  sendCommand(surface, piCommand);

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
  };

  runningSubagents.set(runId, running);
  return running;
  } catch (error) {
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
  const isChildProcess = !!process.env.PI_SUBAGENT_ID;
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
  });

  const finishSubagent = (result: SubagentResult) => {
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

    const failureTimer = connectionFailureTimers.get(childId);
    if (failureTimer) clearTimeout(failureTimer);
    connectionFailureTimers.delete(childId);
    parentIpcServer?.unregisterChild(childId);
    runningSubagents.delete(childId);
    if (running.workspace) {
      if (running.previousWorkspace) switchSwayWorkspace(running.previousWorkspace);
    } else {
      try { closeSurface(running.surface); } catch {}
    }
    if (running.forkCleanupFile) {
      try { unlinkSync(running.forkCleanupFile); } catch {}
    }
    pi.appendEntry(IPC_FINISH_ENTRY, {
      id: childId,
      runId: running.runId,
      childSessionId: running.childSessionId,
      sessionFile: running.sessionFile,
      finishedAt: Date.now(),
    });
    updateWidget();
    pi.sendMessage(
      {
        customType: "subagent_result",
        content: buildSubagentResultContent(correlatedResult),
        display: true,
        details: correlatedResult,
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  };

  const scheduleConnectionFailure = (childId: string, delayMs: number, reason: string) => {
    const previous = connectionFailureTimers.get(childId);
    if (previous) clearTimeout(previous);
    connectionFailureTimers.set(childId, setTimeout(() => {
      connectionFailureTimers.delete(childId);
      const running = runningSubagents.get(childId);
      if (!running || running.connected || !acceptIpcResults) return;
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
    const running = runningSubagents.get(message.childId);
    if (!running) return;
    const payload = message.payload as any;

    if (message.type === "hello" || message.type === "ready") {
      running.connected = true;
      if (
        typeof payload?.sessionFile === "string" &&
        resolve(payload.sessionFile) === resolve(running.sessionFile)
      ) {
        running.sessionFile = resolve(payload.sessionFile);
      }
      if (
        payload?.state === "idle" ||
        payload?.state === "running" ||
        payload?.state === "waiting_input"
      ) {
        running.state = payload.state;
      }
      if (Array.isArray(payload?.uiRequests)) {
        running.uiRequests = payload.uiRequests
          .map(parsePendingUiRequest)
          .filter((request: PendingUiRequest | null): request is PendingUiRequest => !!request)
          .slice(-20);
      }
      updateWidget();
      return;
    }
    if (message.type === "running") {
      running.state = running.uiRequests?.length ? "waiting_input" : "running";
      updateWidget();
      return;
    }
    if (message.type === "settled") {
      running.state = running.uiRequests?.length ? "waiting_input" : "idle";
      updateWidget();
      return;
    }
    if (message.type === "ui_request") {
      const request = parsePendingUiRequest(payload);
      if (!request) return;
      const requests = running.uiRequests ?? [];
      running.uiRequests = [
        ...requests.filter((pending) => pending.id !== request.id),
        request,
      ].slice(-20);
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
      if (running.uiRequests.length > 0) {
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
      if (!isSubagentDoneResult(payload)) {
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
        if (!runningSubagents.has(running.id)) return;
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
    if (isChildProcess) return;

    acceptIpcResults = false;
    await parentIpcServer?.close().catch(() => {});
    parentIpcSocketPath = getIpcSocketPath(ctx.sessionManager.getSessionId());

    const entries = ctx.sessionManager.getBranch() as Array<{
      type: string;
      customType?: string;
      data?: any;
    }>;
    const finished = new Set(
      entries
        .filter((entry) => entry.type === "custom" && entry.customType === IPC_FINISH_ENTRY)
        .map((entry) => entry.data?.id)
        .filter(Boolean),
    );
    runningSubagents.clear();
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== IPC_LAUNCH_ENTRY) continue;
      const data = entry.data as Partial<RunningSubagent> | undefined;
      if (!data?.id || !data.ipcToken || !data.sessionFile || finished.has(data.id)) continue;
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
    for (const running of runningSubagents.values()) {
      scheduleConnectionFailure(
        running.id,
        15_000,
        "Subagent did not reconnect to IPC after the parent session reloaded.",
      );
    }
    if (runningSubagents.size > 0) startWidgetRefresh();
  });

  // Preserve child processes across /reload; terminate them for real parent-session shutdowns.
  pi.on("session_shutdown", async (event, _ctx) => {
    acceptIpcResults = false;
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
    }
    if (!isChildProcess && event.reason !== "reload") {
      for (const running of runningSubagents.values()) {
        parentIpcServer?.send(running.id, "shutdown", { reason: event.reason });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      for (const running of runningSubagents.values()) {
        if (!running.workspace) {
          try { closeSurface(running.surface); } catch {}
        }
      }
      runningSubagents.clear();
    }
    for (const timer of connectionFailureTimers.values()) clearTimeout(timer);
    connectionFailureTimers.clear();
    if (!isChildProcess) await parentIpcServer?.close().catch(() => {});
    parentIpcServer = null;
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
        "IMPORTANT: This tool returns IMMEDIATELY — the sub-agent runs asynchronously in the background. " +
        "You will NOT have results when this tool returns. Results are delivered later via a steer message. " +
        "Do NOT fabricate, assume, or summarize results after calling this tool. " +
        "Either wait for the steer message or move on to other work.",
      promptSnippet:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "IMPORTANT: This tool returns IMMEDIATELY — the sub-agent runs asynchronously in the background. " +
        "You will NOT have results when this tool returns. Results are delivered later via a steer message. " +
        "Do NOT fabricate, assume, or summarize results after calling this tool. " +
        "Either wait for the steer message or move on to other work.",
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
          const agentDefs = loadAgentDefaults(params.agent);
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
        const running = await launchSubagent(params, ctx, { allToolNames });

        pi.appendEntry(IPC_LAUNCH_ENTRY, serializeRunning(running));
        scheduleConnectionFailure(
          running.id,
          30_000,
          "Subagent did not establish its IPC connection during startup.",
        );

        // Start widget refresh when first agent launches. Lifecycle now arrives over IPC.
        startWidgetRefresh();

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
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
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      promptSnippet:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      parameters: Type.Object({}),

      async execute() {
        const agents = new Map<
          string,
          { name: string; description?: string; model?: string; source: string }
        >();

        const dirs = [
          {
            path: join(dirname(new URL(import.meta.url).pathname), "../../agents"),
            source: "package",
          },
          { path: join(homedir(), ".pi", "agent", "agents"), source: "global" },
          { path: join(process.cwd(), ".pi", "agents"), source: "project" },
        ];

        for (const { path: dir, source } of dirs) {
          if (!existsSync(dir)) continue;
          for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
            const content = readFileSync(join(dir, file), "utf8");
            const match = content.match(/^---\n([\s\S]*?)\n---/);
            if (!match) continue;
            const frontmatter = match[1];
            const get = (key: string) => {
              const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
              return m ? m[1].trim() : undefined;
            };
            const name = get("name") ?? file.replace(/\.md$/, "");
            agents.set(name, {
              name,
              description: get("description"),
              model: get("model"),
              source,
            });
          }
        }

        if (agents.size === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const list = [...agents.values()];
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

      async execute(_toolCallId, rawParams, _signal, _onUpdate) {
        const params = rawParams as { sessionPath: string; name?: string; message?: string };
        const name = params.name ?? "Resume";
        const startTime = Date.now();

        if (!isMuxAvailable()) {
          return muxUnavailableResult("subagents");
        }

        if (!existsSync(params.sessionPath)) {
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

        const sessionFile = resolve(params.sessionPath);
        const correlation = readSubagentSessionCorrelation(sessionFile);
        const runId = randomUUID();
        const ipcToken = createIpcToken();
        let surface: string | undefined;
        let resumeMessagePath: string | undefined;

        const parts = ["pi", "--session", shellEscape(sessionFile)];
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
          ...inheritedProfileEnvParts(),
        ];
        const envPrefix = ["env", ...inheritedProfileEnvUnsets(), ...envParts].join(" ") + " ";
        const command = `cd ${shellEscape(correlation.cwd)} && ${envPrefix}${parts.join(" ")}`;
        try {
          surface = createSurface(name);
          await new Promise<void>((resolve) => setTimeout(resolve, 500));
          parentIpcServer.registerChild(runId, ipcToken);
          sendCommand(surface, command);
        } catch (error) {
          parentIpcServer.unregisterChild(runId);
          if (surface) {
            try { closeSurface(surface); } catch {}
          }
          if (resumeMessagePath) {
            try { unlinkSync(resumeMessagePath); } catch {}
          }
          throw error;
        }

        const running: RunningSubagent = {
          id: runId,
          runId,
          childSessionId: correlation.childSessionId,
          resumeOfRunId: correlation.originatingRunId,
          mode: "resume",
          name,
          task: params.message ?? "resumed session",
          surface,
          startTime,
          sessionFile,
          ipcToken,
          autoExit: false,
        };
        runningSubagents.set(runId, running);
        pi.appendEntry(IPC_LAUNCH_ENTRY, serializeRunning(running));
        scheduleConnectionFailure(
          running.id,
          30_000,
          "Resumed subagent did not establish its IPC connection during startup.",
        );
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
      description:
        "Kill one or all running sub-agents. Use without parameters to list running sub-agents. " +
        "Pass an id or name to kill a specific one, or 'all' to kill them all.",
      promptSnippet:
        "Kill one or all running sub-agents. Use without parameters to list running sub-agents. " +
        "Pass an id or name to kill a specific one, or 'all' to kill them all.",
      parameters: Type.Object({
        target: Type.Optional(
          Type.String({
            description:
              "Subagent to kill: an id, a name (case-insensitive partial match), or 'all'. Omit to list running subagents.",
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
                text: `Running sub-agents (${agents.length}):\n${lines.join("\n")}\n\nPass a name, id, or 'all' to kill.`,
              },
            ],
            details: {
              running: agents.map((a) => ({
                id: a.id,
                name: a.name,
                agent: a.agent,
                status: formatSubagentState(a),
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
          // Ask the child bridge to abort and shut down gracefully before closing its pane.
          parentIpcServer?.send(agent.id, "shutdown", { reason: "cancelled" });
          parentIpcServer?.unregisterChild(agent.id);
          // Workspace mode: kill WezTerm process, switch back
          if (agent.workspace) {
            if (agent.workspaceProcess) {
              try { process.kill(agent.workspaceProcess.pid!, "SIGTERM"); } catch {}
            }
            if (agent.previousWorkspace) switchSwayWorkspace(agent.previousWorkspace);
          } else {
            // Close the mux pane
            try { closeSurface(agent.surface); } catch {}
          }
          // Clean up fork temp file
          if (agent.forkCleanupFile) {
            try {
              unlinkSync(agent.forkCleanupFile);
            } catch {}
          }
          runningSubagents.delete(agent.id);
          pi.appendEntry(IPC_FINISH_ENTRY, {
            id: agent.id,
            runId: agent.runId,
            childSessionId: agent.childSessionId,
            sessionFile: agent.sessionFile,
            finishedAt: Date.now(),
            cancelled: true,
          });
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

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
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
