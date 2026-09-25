import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync } from "node:fs";
import { prepareLaunch, type LaunchSpec } from "./launch-process.ts";
import { assertDirectLaunchAvailable, launchVisibleSurface } from "./terminal-launch.ts";
import { loadAgentDefaults, resolveChildTools } from "./config.ts";
import { type ChildRunConfig } from "./launch-config.ts";
import { closeSurface } from "./cmux.ts";
import { createSubagentSession, selectForkHistory, type SessionEntry, type SubagentSessionMode } from "./session.ts";
import { ensureSessionArtifactDir, getSessionArtifactDir, writeArtifactFile } from "../session-artifacts/paths.ts";
import { createIpcToken } from "./ipc.ts";
import { SUBAGENT_COMPLETION_INSTRUCTION, type SubagentParamsValue, withChildOnlyTools, qualifyModelWithProvider, resolveEffectiveChildCwd, PROFILE_ENV_NAMES, NON_INHERITED_RUNTIME_ENV_NAMES, customAgentEnvironment } from "./policy.ts";
import { type RunningSubagent } from "./types.ts";
import { type RunRuntime } from "./runtime.ts";

export function forkConversation(branch: SessionEntry[]): SessionEntry[] {
  const history = selectForkHistory(branch).filter((entry) =>
    !(entry.type === "custom" && typeof entry.customType === "string" && entry.customType.startsWith("subagent_")),
  );
  return history.map((entry, index) => ({ ...entry, parentId: history[index - 1]?.id ?? null }));
}

export function childLaunchSpec(runtime: RunRuntime, config: ChildRunConfig, runId: string, name: string, sessionFile: string, cwd: string, promptPath?: string): LaunchSpec {
  const argv = ["pi", "--session", sessionFile, "--tools", config.tools.join(",")];
  if (config.model) argv.push("--model", config.thinking ? `${config.model}:${config.thinking}` : config.model);
  if (config.systemPrompt) argv.push("--append-system-prompt", config.systemPrompt);
  for (const skill of config.skills?.split(",").map((skill) => skill.trim()).filter(Boolean) ?? []) argv.push(`/skill:${skill}`);
  argv.push("-e", join(dirname(fileURLToPath(import.meta.url)), "subagent-done.ts"));
  if (promptPath) argv.push(`@${promptPath}`);
  const env = customAgentEnvironment(config.env);
  Object.assign(env, {
    PATH: process.env.PATH ?? "",
    PI_SUBAGENT_NAME: name, PI_SUBAGENT_ID: runId,
    PI_SUBAGENT_SOCKET: runtime.parentIpcSocketPath!, PI_SUBAGENT_TOKEN: "", // filled by the caller
    PI_SUBAGENT_AUTO_EXIT: config.autoExit ? "1" : "0",
    PI_SUBAGENT_DEPTH: String(Number(process.env.PI_SUBAGENT_DEPTH ?? "0") + 1),
    PI_SUBAGENT_TOOLS: config.tools.join(","),
  });
  if (config.agent) env.PI_SUBAGENT_AGENT = config.agent;
  if (config.model) env.PI_SUBAGENT_MODEL = config.model;
  if (config.thinking) env.PI_SUBAGENT_THINKING = config.thinking;
  for (const key of PROFILE_ENV_NAMES) {
    delete env[key];
    if (process.env[key] !== undefined) env[key] = process.env[key]!;
  }
  return { argv, cwd, env, unset: [...PROFILE_ENV_NAMES, ...NON_INHERITED_RUNTIME_ENV_NAMES] };
}

export async function launchSubagent(runtime: RunRuntime,
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
    allToolNames: string[];
    activeToolNames: string[];
    projectTrusted: boolean;
    onPrepared: (running: RunningSubagent) => void;
    onLaunched: (running: RunningSubagent) => void;
    onFailed: (running: RunningSubagent, error: unknown) => void;
  },
): Promise<RunningSubagent> {
  assertDirectLaunchAvailable();
  const startTime = Date.now();
  const runId = randomUUID();
  const ipcToken = createIpcToken();

  if (!runtime.parentIpcServer || !runtime.parentIpcSocketPath) {
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
  let launch: ReturnType<typeof prepareLaunch> | undefined;
  let registeredWithIpc = false;
  let prepared: RunningSubagent | undefined;

  try {

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

    const qualifiedModelForLock = effectiveModel ? qualifyModelWithProvider(effectiveModel, ctx) : undefined;

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
    const spec = childLaunchSpec(runtime, config, runId, params.name, subagentSessionFile, effectiveCwd, taskPath);
    spec.env.PI_SUBAGENT_TOKEN = ipcToken;
    spec.env.PI_DENY_TOOLS = [...denySet].join(",");
    launch = prepareLaunch(spec);
    runtime.parentIpcServer.registerChild(runId, ipcToken);
    registeredWithIpc = true;

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
      launch,
    };

    options.onPrepared(running);
    prepared = running;
    Object.assign(running, launchVisibleSurface({
      runId, name: params.name, cwd: effectiveCwd, argv: launch.argv,
      siblingSurfaces: [...runtime.runningSubagents.values()].map(run => run.surface).filter(Boolean),
    }));
    surface = running.surface;
    options.onLaunched(running);
    return running;
  } catch (error) {
    if (prepared) {
      options.onFailed(prepared, error);
      throw error;
    }
    if (registeredWithIpc) runtime.parentIpcServer?.unregisterChild(runId);
    launch?.dispose();
    if (surface) { try { closeSurface(surface); } catch { } }
    // No launch entry was persisted yet, so remove the transcript bundle rather
    // than leaving an unresumable orphan after pane/artifact setup failed.
    try { rmSync(subagentSessionFile, { force: true }); } catch { }
    try { rmSync(dirname(getSessionArtifactDir(subagentSessionFile)), { recursive: true, force: true }); } catch { }
    throw error;
  }
}
