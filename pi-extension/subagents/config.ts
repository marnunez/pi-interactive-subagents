import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { OPTIONAL_CHILD_INSPECTION_TOOLS } from "./inspection.ts";

export interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  spawning?: boolean;
  maxInstances?: number;
  cwd?: string;
  workspace?: string;
  env?: string;
  body?: string;
}

export interface AgentDefinition {
  name: string;
  description?: string;
  model?: string;
  source: string;
}

type Frontmatter = Record<string, unknown>;
type ParsedFrontmatter = { frontmatter: Frontmatter; body: string };

const SPAWNING_TOOLS = new Set([
  "subagent",
  "subagents_list",
  "subagent_resume",
  "subagent_kill",
  "subagent_message",
]);

const CHILD_TOOLS = [
  "subagent_done",
  "set_pane_title",
  "write_artifact",
  "read_artifact",
] as const;
export const COMMON_CHILD_TOOLS = ["codemode", "subagent_done"] as const;
const LEGACY_CHILD_TOOLS = ["set_tab_title"] as const;

const moduleDir = dirname(fileURLToPath(import.meta.url));
const bundledAgentsDir = join(moduleDir, "../../agents");

function profileAgentsDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "agents");
}

function agentDirectories(
  cwd: string,
  projectTrusted: boolean,
): Array<{ path: string; source: string }> {
  const directories: Array<{ path: string; source: string }> = [];
  if (projectTrusted) directories.push({ path: join(cwd, ".pi", "agents"), source: "project" });
  const profileDir = profileAgentsDir();
  directories.push({ path: profileDir, source: "profile" });
  // An explicit profile catalogue can opt out of the bundled role defaults.
  if (!existsSync(join(profileDir, ".no-bundled"))) {
    directories.push({ path: bundledAgentsDir, source: "bundled" });
  }
  return directories;
}

function isValidAgentName(name: string): boolean {
  return (
    name.length > 0 &&
    name.trim() === name &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    !name.endsWith(".chain")
  );
}

function hasFrontmatter(content: string): boolean {
  return /^\uFEFF?---(?:\r\n|\n|\r)/.test(content);
}

/**
 * Compatibility parser for Pi versions that predate the exported
 * parseFrontmatter helper. It deliberately supports only top-level scalar
 * `key: value` pairs; single- and double-quoted scalar values are unquoted.
 */
function parseScalarFrontmatter(content: string): ParsedFrontmatter {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized };

  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return { frontmatter: {}, body: normalized };

  const frontmatter: Frontmatter = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (!match) continue;

    let value = match[2];
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/g, "'");
    } else if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    }
    frontmatter[match[1]] = value;
  }

  return { frontmatter, body: normalized.slice(end + 4).trim() };
}

function parseAgentFile(content: string): ParsedFrontmatter | null {
  if (!hasFrontmatter(content)) return null;

  try {
    const parser = (
      PiCodingAgent as unknown as {
        parseFrontmatter?: (value: string) => ParsedFrontmatter;
      }
    ).parseFrontmatter;
    return parser ? parser(content) : parseScalarFrontmatter(content);
  } catch {
    return null;
  }
}

function scalarString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function toolString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "";
  if (!Array.isArray(value) && typeof value !== "string") throw new Error("Tool/skill lists must be strings or arrays.");
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tools = values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return tools.join(",");
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  if (value.trim().toLowerCase() === "true") return true;
  if (value.trim().toLowerCase() === "false") return false;
  return undefined;
}

function integerValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) ? parsed : undefined;
}

function defaultsFrom(content: string): AgentDefaults | null {
  const parsed = parseAgentFile(content);
  if (!parsed) return null;

  const { frontmatter, body } = parsed;
  for (const field of ["allow-tools", "deny-tools", "initial-tools", "auto-exit"]) {
    if (field in frontmatter) throw new Error(`Unsupported agent field '${field}'. Use a tools allowlist; completion is explicit and Pi controls discovery.`);
  }
  return {
    model: scalarString(frontmatter.model),
    tools: toolString(frontmatter.tools),
    skills: toolString(frontmatter.skill) ?? toolString(frontmatter.skills),
    thinking: scalarString(frontmatter.thinking),
    spawning: booleanValue(frontmatter.spawning),
    maxInstances: integerValue(frontmatter["max-instances"]),
    cwd: scalarString(frontmatter.cwd),
    workspace: scalarString(frontmatter.workspace),
    env: scalarString(frontmatter.env),
    body: body || undefined,
  };
}

export function loadAgentDefaults(
  agentName: string,
  cwd: string,
  projectTrusted = true,
): AgentDefaults | null {
  if (!isValidAgentName(agentName)) return null;

  for (const directory of agentDirectories(cwd, projectTrusted)) {
    const path = join(directory.path, `${agentName}.md`);
    if (!existsSync(path)) continue;

    // Never fall through to a broader lower-precedence role after a policy error.
    const defaults = defaultsFrom(readFileSync(path, "utf8"));
    if (!defaults) throw new Error(`Invalid agent definition: ${path}`);
    return defaults;
  }

  return null;
}

export function listAgentDefinitions(
  cwd: string,
  projectTrusted = true,
): AgentDefinition[] {
  const definitions = new Map<string, AgentDefinition>();

  // Read low-to-high precedence so later definitions replace earlier ones.
  for (const directory of agentDirectories(cwd, projectTrusted).reverse()) {
    let entries;
    try {
      entries = readdirSync(directory.path, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.name.endsWith(".md") || entry.name.endsWith(".chain.md")) continue;
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;

      const name = entry.name.slice(0, -3);
      if (!isValidAgentName(name)) continue;

      try {
        const parsed = parseAgentFile(readFileSync(join(directory.path, entry.name), "utf8"));
        if (!parsed) continue;
        definitions.set(name, {
          name,
          description: scalarString(parsed.frontmatter.description),
          model: scalarString(parsed.frontmatter.model),
          source: directory.source,
        });
      } catch {
        // Ignore one bad definition without preventing discovery of the rest.
      }
    }
  }

  return [...definitions.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function parseToolCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function unique(names: readonly string[]): string[] {
  return [...new Set(names)];
}

function assertKnownExplicitTools(
  field: string,
  names: readonly string[],
  knownTools: ReadonlySet<string>,
): void {
  const unknown = unique(names.filter((name) => !knownTools.has(name)));
  if (unknown.length === 0) return;
  throw new Error(
    `Unknown tool${unknown.length === 1 ? "" : "s"} in ${field}: ${unknown.join(", ")}. ` +
      "Use a registered tool name.",
  );
}

// Saved tools are effective permissions, not defaults to re-resolve on resume.
// Only the common execution/handback interface is added; never optional capabilities.
export function restoreChildTools(saved: readonly string[], registeredToolNames: readonly string[], ceiling?: readonly string[]): string[] {
  const known = new Set([...registeredToolNames, ...COMMON_CHILD_TOOLS, ...CHILD_TOOLS, ...LEGACY_CHILD_TOOLS, ...OPTIONAL_CHILD_INSPECTION_TOOLS]);
  assertKnownExplicitTools("saved tools", saved, known);
  assertWithinCeiling("saved tools", saved, ceiling);
  return unique([...saved, ...COMMON_CHILD_TOOLS]);
}

export interface ToolMetadata {
  name: string;
  exposure?: string;
}

/** A nested run cannot grant tools outside its own saved capability selection. */
export function parentToolCeiling(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  if (!env.PI_SUBAGENT_ID || env.PI_SUBAGENT_TOOLS === undefined) return undefined;
  return unique([...parseToolCsv(env.PI_SUBAGENT_TOOLS), ...COMMON_CHILD_TOOLS]);
}

function assertWithinCeiling(field: string, names: readonly string[], ceiling?: readonly string[]): void {
  if (!ceiling) return;
  const forbidden = names.filter((name) => !COMMON_CHILD_TOOLS.some((tool) => tool === name) && !ceiling.includes(name));
  if (forbidden.length) throw new Error(`Tools in ${field} exceed the parent subagent's permissions: ${unique(forbidden).join(", ")}`);
}

/** A role narrows capabilities; native Pi exposure controls schema visibility. */
export function resolveChildTools(
  defaults: Pick<AgentDefaults, "tools" | "spawning">,
  registeredToolNames: readonly string[],
  policy: { metadata?: readonly ToolMetadata[]; ceiling?: readonly string[] } = {},
): string[] {
  const known = new Set([...registeredToolNames, ...COMMON_CHILD_TOOLS, ...CHILD_TOOLS, ...LEGACY_CHILD_TOOLS, ...OPTIONAL_CHILD_INSPECTION_TOOLS]);
  // A broader named role is valid inside a restricted parent: intersect first,
  // since tools outside the ceiling may already be absent from Pi's registry.
  const requested = parseToolCsv(defaults.tools).filter((name) => !policy.ceiling
    || policy.ceiling.includes(name) || COMMON_CHILD_TOOLS.some((tool) => tool === name));
  if (defaults.tools !== undefined) assertKnownExplicitTools("tools", requested, known);
  const hidden = new Set(policy.metadata?.filter((tool) => tool.exposure === "hidden").map((tool) => tool.name));
  if (requested.some((name) => hidden.has(name))) throw new Error("Hidden tools cannot be granted to a subagent.");

  // A top-level trusted peer inherits the callable registry, not active schemas.
  // Nested workers inherit their parent's saved ceiling, independent of discovery.
  const inherited = policy.ceiling ?? [...registeredToolNames, ...CHILD_TOOLS];
  const selected = defaults.tools !== undefined ? requested : inherited.filter((name) =>
    !LEGACY_CHILD_TOOLS.some((tool) => tool === name)
    && (policy.ceiling !== undefined || !OPTIONAL_CHILD_INSPECTION_TOOLS.some((tool) => tool === name)));
  const result = selected.filter((name) => !hidden.has(name)
    && (defaults.spawning !== false || !SPAWNING_TOOLS.has(name)));
  return unique([...result, ...COMMON_CHILD_TOOLS]);
}
