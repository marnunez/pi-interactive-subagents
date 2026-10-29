import { test } from "node:test";
import assert from "node:assert/strict";
import { parentToolCeiling, resolveChildTools, restoreChildTools } from "../pi-extension/subagents/config.ts";
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
];
const registered = metadata.map(tool => tool.name);

test("trusted peers inherit capabilities independent of native tool exposure", () => {
  const tools = resolveChildTools({}, registered, { metadata });
  for (const name of ["read", "bash", "codemode", "browser_navigate", "web_search"]) assert.ok(tools.includes(name));
  assert.ok(!tools.includes("withdrawn"));
});

test("a positive role allowlist excludes new tools and optional helpers, not codemode", () => {
  const tools = resolveChildTools({ tools: "read,browser_navigate", spawning: false }, registered, { metadata });
  assert.deepEqual(tools, ["read", "browser_navigate", "codemode", "subagent_done", "tool_search", "message_parent"]);
  assert.deepEqual(resolveChildTools({ tools: "read,browser_navigate", spawning: false }, [...registered, "send_email"], { metadata }), tools);
  assert.throws(() => resolveChildTools({ tools: "withdrawn" }, registered, { metadata }), /Hidden tools/);
});

test("nested role selection intersects the parent's saved permissions, not its active schemas", () => {
  const ceiling = ["read", "tool_search", "browser_navigate", "codemode", "subagent_done", "message_parent"];
  assert.deepEqual(resolveChildTools({}, registered, { metadata, ceiling }), ceiling);
  assert.deepEqual(resolveChildTools({ tools: "read,bash" }, registered, { metadata, ceiling }), ["read", "codemode", "subagent_done", "tool_search", "message_parent"]);
  assert.throws(() => restoreChildTools(["read", "web_search"], registered, ceiling), /exceed the parent/);
  assert.deepEqual(restoreChildTools(["read", "browser_navigate"], registered, ceiling), ["read", "browser_navigate", "codemode", "subagent_done", "tool_search", "message_parent"]);
  assert.deepEqual(parentToolCeiling({ PI_SUBAGENT_ID: "child", PI_SUBAGENT_TOOLS: "read,tool_search" }), ["read", "tool_search", "codemode", "subagent_done", "message_parent"]);
  assert.equal(parentToolCeiling({ PI_SUBAGENT_TOOLS: "read" }), undefined);
});

test("nested named roles intersect before validating against an already-filtered registry", () => {
  const ceiling = ["read", "codemode", "subagent_done", "tool_search", "message_parent"];
  const filtered = metadata.filter(tool => ceiling.includes(tool.name));
  assert.deepEqual(resolveChildTools({ tools: "read,bash,browser_navigate" }, filtered.map(tool => tool.name), { metadata: filtered, ceiling }), ceiling);
  assert.ok(!resolveChildTools({ tools: "bash" }, filtered.map(tool => tool.name), { metadata: filtered, ceiling }).includes("bash"));
  assert.throws(() => resolveChildTools({ tools: "typo" }, registered, { metadata }), /Unknown tool/);
});

test("launch passes one permission list and short common instructions, without visibility state or generated denials", () => {
  const tools = ["read", "browser_navigate", "codemode", "subagent_done", "tool_search"];
  const config = { schemaVersion: 3 as const, tools, env: "PI_SUBAGENT_TOOLS=bash PI_SUBAGENT_INITIAL_TOOLS=bash PI_DENY_TOOLS=read" };
  const spec = childLaunchSpec(createRunRuntime(), config, "run", "name", "/tmp/child.jsonl", "/tmp");
  assert.equal(spec.argv[spec.argv.indexOf("--tools") + 1], tools.join(","));
  assert.equal(spec.env.PI_SUBAGENT_TOOLS, tools.join(","));
  assert.equal(spec.env.PI_SUBAGENT_INITIAL_TOOLS, undefined);
  assert.equal(spec.env.PI_DENY_TOOLS, undefined);
  assert.ok(spec.unset.includes("PI_SUBAGENT_INITIAL_TOOLS"));
  const prompt = spec.argv[spec.argv.indexOf("--append-system-prompt") + 1];
  assert.match(prompt, /Pausing does not complete the task/);
  assert.match(prompt, /Parent messages are task direction, not user approval/);
  assert.doesNotMatch(prompt, /two child panes|protocol failure|nextSteps/);
  assert.equal(spec.argv[spec.argv.indexOf("--exclude-tools") + 1], "mcp__*,list_mcp_resources,list_mcp_resource_templates,read_mcp_resource");
  const mcp = childLaunchSpec(createRunRuntime(), { ...config, tools: [...tools, "mcp__docs__search"] }, "run", "name", "/tmp/child.jsonl", "/tmp");
  assert.ok(!mcp.argv.includes("--exclude-tools"));
});
