import { Type, type Static } from "typebox";
import { join, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { muxSetupHint, shellEscape } from "./cmux.ts";

export const defineTool = <T>(tool: T): T => tool;

export const SUBAGENT_COMPLETION_INSTRUCTION =
  "Complete your task. When this run is finished, call subagent_done with a structured result. " +
  "This ends the current run, not the session: the session remains resumable as a new run. " +
  "Set status to success, failed, or blocked; put the concise orchestration result in summary; " +
  "put the expanded human-readable result in report when useful; list any write_artifact outputs in artifacts; " +
  "and include recommended follow-up actions in nextSteps. Exiting without subagent_done is a protocol failure. " +
  "The user can interact with you at any time, but the same completion contract still applies.";

export const SUBAGENT_ASYNC_GUIDANCE =
  "Results are delivered automatically via a steer message; never poll child status. " +
  "Continue independent work if any remains. Otherwise end the current turn silently: emit no text and call no more tools. " +
  "The first child completion will trigger the next turn.";

export const SUBAGENT_KILL_GUIDANCE =
  "Kill one or all running sub-agents. Omit target to inspect running children only when the user explicitly asks. " +
  "Never use this tool to poll while waiting; completion arrives automatically via a steer message.";

export const SubagentParams = Type.Object({
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
});

export type SubagentParamsValue = Static<typeof SubagentParams>;

export const CHILD_ONLY_TOOLS = new Set(["subagent_done", "set_tab_title", "write_artifact"]);

export function withChildOnlyTools(allToolNames?: string[]): string[] | undefined {
  if (!allToolNames) return undefined;
  return [...new Set([...allToolNames, ...CHILD_ONLY_TOOLS])];
}

export function readJsonFile<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function getPreferredDefaultModel(cwd: string): { defaultProvider?: string; defaultModel?: string } {
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

export function qualifyModelWithProvider(
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

export function resolveEffectiveChildCwd(rawCwd: string | undefined, parentCwd: string): string {
  if (!rawCwd) return resolve(parentCwd);
  if (rawCwd === "~") return homedir();
  if (rawCwd.startsWith("~/")) return resolve(homedir(), rawCwd.slice(2));
  if (rawCwd.startsWith("~")) {
    throw new Error(`Unsupported home-relative cwd: ${rawCwd}`);
  }
  return resolve(parentCwd, rawCwd);
}

export const PROFILE_ENV_NAMES = ["PI_PROFILE", "PI_CODING_AGENT_DIR"] as const;

export const NON_INHERITED_RUNTIME_ENV_NAMES = [
  "PI_SESSION_LEASE_OWNER_PID", "PI_SESSION_LEASE_OWNER_NONCE",
  "PI_DENY_TOOLS", "PI_SUBAGENT_NAME", "PI_SUBAGENT_ID", "PI_SUBAGENT_SOCKET",
  "PI_SUBAGENT_TOKEN", "PI_SUBAGENT_AUTO_EXIT", "PI_SUBAGENT_MODEL",
  "PI_SUBAGENT_THINKING", "PI_SUBAGENT_TOOLS", "PI_SUBAGENT_AGENT", "PI_SUBAGENT_DEPTH",
] as const;

export function inheritedProfileEnvParts(): string[] {
  return PROFILE_ENV_NAMES.flatMap((name) => {
    const value = process.env[name];
    return value == null ? [] : [`${name}=${shellEscape(value)}`];
  });
}

export function inheritedProfileEnvUnsets(): string[] {
  return [
    ...PROFILE_ENV_NAMES.flatMap((name) => (process.env[name] == null ? ["-u", name] : [])),
    ...NON_INHERITED_RUNTIME_ENV_NAMES.flatMap((name) => ["-u", name]),
  ];
}

export function customAgentEnvironment(value: string | undefined): Record<string, string> {
  const env: Record<string, string> = Object.create(null);
  for (const pair of value?.split(/\s+/).filter(Boolean) ?? []) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(pair);
    if (!assignment) continue;
    const [, name, rawValue] = assignment;
    if (NON_INHERITED_RUNTIME_ENV_NAMES.some((reserved) => reserved === name)) continue;
    env[name] = rawValue;
  }
  return env;
}

// Compatibility adapter for the existing policy regression tests. Launches use
// the same parsed environment object, not these shell-formatted strings.
export function customAgentEnvParts(value: string | undefined): string[] {
  return Object.entries(customAgentEnvironment(value)).map(([name, value]) => `${name}=${shellEscape(value)}`);
}

export function muxUnavailableResult(kind: "subagents" | "tab-title" = "subagents") {
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
