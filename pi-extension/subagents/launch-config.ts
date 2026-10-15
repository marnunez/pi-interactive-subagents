import { existsSync, readFileSync } from "node:fs";
import type { AgentDefaults } from "./config.ts";

export interface ChildRunConfig {
  schemaVersion?: 1 | 2;
  systemPrompt?: string;
  agent?: string;
  model?: string;
  thinking?: string;
  skills?: string;
  env?: string;
  /** Permission ceiling, including tools whose schemas are not initially declared. */
  tools: string[];
  /** Version 2 separates initial declarations from the permission ceiling. */
  initialTools?: string[];
  autoExit: boolean;
}

/** Missing legacy snapshots may migrate; malformed snapshots must fail closed. */
export function readChildRunConfig(path: string): ChildRunConfig | undefined {
  if (!existsSync(path)) return undefined;
  let value: any;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`Invalid subagent launch configuration: ${path}`); }
  const toolList = (list: unknown): list is string[] => Array.isArray(list)
    && list.every((tool: unknown) => typeof tool === "string" && /^[a-zA-Z0-9_-]+$/.test(tool));
  if (!value || typeof value !== "object" || (value.schemaVersion !== undefined && ![1, 2].includes(value.schemaVersion))
    || !toolList(value.tools)
    || (value.schemaVersion === 2 ? !toolList(value.initialTools) : value.initialTools !== undefined)
    || (value.initialTools && !value.initialTools.every((tool: string) => value.tools.includes(tool) || tool === "subagent_done"))
    || typeof value.autoExit !== "boolean"
    || ["systemPrompt", "agent", "model", "thinking", "skills", "env"].some((key) => value[key] !== undefined && typeof value[key] !== "string")) {
    throw new Error(`Malformed subagent launch configuration: ${path}; refusing to broaden tool access.`);
  }
  return value as ChildRunConfig;
}

export function legacyChildDefaults(agent: string | undefined, defaults: AgentDefaults | null): Partial<ChildRunConfig> {
  if (agent && !defaults) throw new Error(`Cannot restore legacy agent ${agent}: definition not found in this profile.`);
  return {
    agent, model: defaults?.model, thinking: defaults?.thinking,
    skills: defaults?.skills, env: defaults?.env, systemPrompt: defaults?.body,
    ...(defaults?.tools !== undefined ? { tools: defaults.tools.split(",").map((tool) => tool.trim()).filter(Boolean) } : {}),
    ...(defaults?.initialTools !== undefined ? { initialTools: defaults.initialTools.split(",").map((tool) => tool.trim()).filter(Boolean) } : {}),
  };
}
