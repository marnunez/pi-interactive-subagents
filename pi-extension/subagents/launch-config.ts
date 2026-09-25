import { existsSync, readFileSync } from "node:fs";
import type { AgentDefaults } from "./config.ts";

export interface ChildRunConfig {
  schemaVersion?: 1;
  systemPrompt?: string;
  agent?: string;
  model?: string;
  thinking?: string;
  skills?: string;
  env?: string;
  tools: string[];
  autoExit: boolean;
}

/** Missing legacy snapshots may migrate; malformed snapshots must fail closed. */
export function readChildRunConfig(path: string): ChildRunConfig | undefined {
  if (!existsSync(path)) return undefined;
  let value: any;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`Invalid subagent launch configuration: ${path}`); }
  if (!value || typeof value !== "object" || (value.schemaVersion !== undefined && value.schemaVersion !== 1)
    || !Array.isArray(value.tools) || !value.tools.every((tool: unknown) => typeof tool === "string" && tool.trim().length > 0)
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
  };
}
