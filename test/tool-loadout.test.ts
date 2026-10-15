import { test } from "node:test";
import assert from "node:assert/strict";
import { parentToolCeiling, parentVisibleTools, readChildToolLoadout, resolveChildInitialTools, resolveChildTools, restoreChildTools } from "../pi-extension/subagents/config.ts";
import { childLaunchSpec } from "../pi-extension/subagents/launch.ts";
import { createRunRuntime } from "../pi-extension/subagents/runtime.ts";

const metadata = [
  { name: "read", exposure: "direct" },
  { name: "bash", exposure: "direct" },
  { name: "tool_search", exposure: "model-only" },
  { name: "codemode", exposure: "model-only" },
  { name: "browser_navigate", exposure: "deferred" },
  { name: "web_search", exposure: "codemode" },
  { name: "withdrawn", exposure: "hidden" },
  { name: "subagent", exposure: "direct" },
  { name: "unused_direct", exposure: "direct" },
];
const registered = metadata.map(tool => tool.name);
const active = ["read", "tool_search", "codemode"];

test("general inheritance includes deferred capabilities but not inactive direct or hidden tools", () => {
  const tools = resolveChildTools({}, active, registered, { metadata });
  assert.ok(tools.includes("browser_navigate"));
  assert.ok(tools.includes("web_search"));
  assert.ok(!tools.includes("unused_direct"));
  assert.ok(!tools.includes("withdrawn"));
  const visible = resolveChildInitialTools(undefined, tools, active, metadata);
  assert.deepEqual(visible, ["read", "tool_search", "codemode", "subagent_done", "set_pane_title", "write_artifact", "read_artifact"]);
  // Discovering a tool before spawning does not grant a different capability set.
  assert.deepEqual(new Set(resolveChildTools({}, [...active, "browser_navigate"], registered, { metadata })), new Set(tools));
});

test("explicit role tools remain strict; exposure only changes initial declarations", () => {
  const tools = resolveChildTools({ tools: "read,tool_search,browser_navigate", spawning: false }, active, registered, { metadata });
  assert.ok(!tools.includes("web_search"));
  assert.ok(!tools.includes("codemode"));
  assert.ok(!tools.includes("subagent"));
  assert.ok(!resolveChildInitialTools(undefined, tools, active, metadata, true).includes("browser_navigate"));
  assert.deepEqual(resolveChildInitialTools("read,browser_navigate", tools, active, metadata), ["read", "browser_navigate", "subagent_done"]);
  assert.throws(() => resolveChildInitialTools("bash", tools, active, metadata), /Unknown tool.*initialTools/);
  assert.throws(() => resolveChildTools({ tools: "withdrawn" }, active, registered, { metadata }), /Hidden tools/);
  const denied = resolveChildTools({ denyTools: "browser_navigate,write_artifact" }, active, registered, { metadata });
  assert.ok(!denied.includes("browser_navigate"));
  assert.throws(() => resolveChildInitialTools("browser_navigate", denied, active, metadata), /initialTools/);
});

test("strict roles without a loader retain direct access when their selected extensions become deferred", () => {
  const tools = resolveChildTools({ tools: "read,browser_navigate,web_search", spawning: false }, active, registered, { metadata });
  const initial = resolveChildInitialTools(undefined, tools, active, metadata, true);
  assert.ok(initial.includes("browser_navigate"));
  assert.ok(initial.includes("web_search"));
  assert.ok(!tools.includes("tool_search"), "Compatibility must not grant an unselected loader");
  assert.ok(!tools.includes("codemode"));
  assert.ok(!resolveChildInitialTools("read", tools, active, metadata, true).includes("browser_navigate"), "Explicit visibility is still authoritative");
});

test("nested visibility reads this session's selected branch instead of registry-induced activation", () => {
  const entries = [{ type: "custom", customType: "subagent_tool_loadout", data: { sessionId: "child", activeTools: ["read", "tool_search"] } }];
  assert.deepEqual(readChildToolLoadout(entries, "child"), ["read", "tool_search"]);
  assert.equal(readChildToolLoadout(entries, "fork"), undefined);
  const savedId = process.env.PI_SUBAGENT_ID, savedTools = process.env.PI_SUBAGENT_TOOLS;
  try {
    process.env.PI_SUBAGENT_ID = "child";
    process.env.PI_SUBAGENT_TOOLS = "read,tool_search,bash";
    assert.deepEqual(parentVisibleTools(["read", "bash", "tool_search"], { getBranch: () => entries, getSessionId: () => "child" }), ["read", "tool_search"]);
  } finally {
    if (savedId === undefined) delete process.env.PI_SUBAGENT_ID; else process.env.PI_SUBAGENT_ID = savedId;
    if (savedTools === undefined) delete process.env.PI_SUBAGENT_TOOLS; else process.env.PI_SUBAGENT_TOOLS = savedTools;
  }
});

test("nested inheritance uses the permission ceiling, not accidental declarations", () => {
  const ceiling = ["read", "tool_search", "browser_navigate", "unused_direct", "subagent_done"];
  const tools = resolveChildTools({}, ["read"], registered, { metadata, ceiling });
  assert.deepEqual(tools, ceiling);
  assert.deepEqual(resolveChildInitialTools(undefined, tools, ["read", "tool_search"], metadata), ["read", "tool_search", "subagent_done"]);
  assert.throws(() => resolveChildTools({ tools: "read,bash" }, active, registered, { metadata, ceiling }), /exceed the parent/);
  assert.throws(() => restoreChildTools(["read", "web_search"], registered, ceiling), /exceed the parent/);
  assert.deepEqual(restoreChildTools(["read", "browser_navigate"], registered, ceiling), ["read", "browser_navigate", "subagent_done"]);
  assert.deepEqual(parentToolCeiling({ PI_SUBAGENT_ID: "child", PI_SUBAGENT_TOOLS: "read,tool_search" }), ["read", "tool_search", "subagent_done"]);
  assert.equal(parentToolCeiling({ PI_SUBAGENT_TOOLS: "read" }), undefined);
});

test("launch retains allowed deferred tools in --tools, separates visibility and prevents implicit MCP access", () => {
  const tools = ["read", "tool_search", "browser_navigate", "subagent_done"];
  const config = { schemaVersion: 2 as const, tools, initialTools: ["read", "tool_search", "subagent_done"], autoExit: false,
    env: "PI_SUBAGENT_TOOLS=bash PI_SUBAGENT_INITIAL_TOOLS=bash" };
  const spec = childLaunchSpec(createRunRuntime(), config, "run", "name", "/tmp/child.jsonl", "/tmp");
  assert.equal(spec.argv[spec.argv.indexOf("--tools") + 1], tools.join(","));
  assert.equal(spec.env.PI_SUBAGENT_TOOLS, tools.join(","));
  assert.equal(spec.env.PI_SUBAGENT_INITIAL_TOOLS, config.initialTools.join(","));
  assert.ok(spec.unset.includes("PI_SUBAGENT_INITIAL_TOOLS"));
  assert.equal(spec.argv[spec.argv.indexOf("--exclude-tools") + 1], "mcp__*,list_mcp_resources,list_mcp_resource_templates,read_mcp_resource");
  const mcp = childLaunchSpec(createRunRuntime(), { ...config, tools: [...tools, "mcp__docs__search"] }, "run", "name", "/tmp/child.jsonl", "/tmp");
  assert.ok(!mcp.argv.includes("--exclude-tools"), "An explicit MCP name makes Pi's allowlist filter other MCP tools");
  const legacy = childLaunchSpec(createRunRuntime(), { tools, autoExit: false }, "run", "name", "/tmp/child.jsonl", "/tmp");
  assert.equal(legacy.env.PI_SUBAGENT_INITIAL_TOOLS, undefined, "Legacy launch must not inherit an ancestor's visibility override");
});
