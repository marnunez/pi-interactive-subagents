import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";

export interface AgentDefaults {
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
]);

const CHILD_TOOLS = [
  "subagent_done",
  "set_tab_title",
  "write_artifact",
  "read_artifact",
] as const;
const MANDATORY_CHILD_TOOL = "subagent_done";

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
  directories.push({ path: profileAgentsDir(), source: "profile" });
  directories.push({ path: bundledAgentsDir, source: "bundled" });
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
  return {
    model: scalarString(frontmatter.model),
    tools: toolString(frontmatter.tools),
    skills: toolString(frontmatter.skill) ?? toolString(frontmatter.skills),
    thinking: scalarString(frontmatter.thinking),
    denyTools: toolString(frontmatter["deny-tools"]),
    allowTools: toolString(frontmatter["allow-tools"]),
    spawning: booleanValue(frontmatter.spawning),
    maxInstances: integerValue(frontmatter["max-instances"]),
    cwd: scalarString(frontmatter.cwd),
    workspace: scalarString(frontmatter.workspace),
    env: scalarString(frontmatter.env),
    autoExit: booleanValue(frontmatter["auto-exit"]),
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

    try {
      const defaults = defaultsFrom(readFileSync(path, "utf8"));
      if (defaults) return defaults;
    } catch {
      // An unreadable or malformed definition must not hide lower-precedence defaults.
    }
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

export function resolveChildTools(
  defaults: {
    tools?: string;
    allowTools?: string;
    denyTools?: string;
    spawning?: boolean;
  },
  activeToolNames: string[],
  registeredToolNames: string[],
): string[] {
  const registered = new Set(registeredToolNames);
  const knownTools = new Set([...registered, ...CHILD_TOOLS]);
  const requested = parseToolCsv(defaults.tools);
  const allowed = parseToolCsv(defaults.allowTools);
  const denied = parseToolCsv(defaults.denyTools);

  if (defaults.tools !== undefined) assertKnownExplicitTools("tools", requested, knownTools);
  if (defaults.allowTools !== undefined) assertKnownExplicitTools("allowTools", allowed, knownTools);
  if (defaults.denyTools !== undefined) assertKnownExplicitTools("denyTools", denied, knownTools);

  const selected = defaults.tools !== undefined
    ? unique(requested.filter((name) => registered.has(name) || knownTools.has(name)))
    : unique(activeToolNames.filter((name) => registered.has(name)));

  for (const tool of CHILD_TOOLS) {
    if (!selected.includes(tool)) selected.push(tool);
  }

  const allowSet = defaults.allowTools === undefined ? null : new Set(allowed);
  const denySet = new Set(denied);

  return selected.filter((name) => {
    if (name === MANDATORY_CHILD_TOOL) return true;
    if (allowSet && !allowSet.has(name)) return false;
    if (denySet.has(name)) return false;
    if (defaults.spawning === false && SPAWNING_TOOLS.has(name)) return false;
    return true;
  });
}
