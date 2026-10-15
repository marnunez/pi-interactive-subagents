import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChildRunConfig, legacyChildDefaults } from "../pi-extension/subagents/launch-config.ts";

test("missing legacy snapshot migrates role, tools, skills and environment", () => {
  const defaults = legacyChildDefaults("worker", { tools: "read,bash", skills: "nixos,uv", env: "PI_PERMISSION_LEVEL=low", body: "role" });
  assert.deepEqual(defaults.tools, ["read", "bash"]);
  assert.equal(defaults.skills, "nixos,uv");
  assert.equal(defaults.env, "PI_PERMISSION_LEVEL=low");
  assert.throws(() => legacyChildDefaults("missing", null), /definition not found/);
});

test("resume distinguishes missing snapshots from malformed or unsupported snapshots", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-config-test-"));
  const path = join(dir, "config.json");
  try {
    assert.equal(readChildRunConfig(path), undefined);
    for (const invalid of ["{", "{}", '{"tools":null,"autoExit":false}', '{"tools":[42],"autoExit":false}',
      '{"schemaVersion":2,"tools":[],"autoExit":false}',
      '{"schemaVersion":4,"tools":[]}',
      '{"schemaVersion":2,"tools":["read"],"initialTools":["write"],"autoExit":false}',
      '{"schemaVersion":1,"tools":["read"],"initialTools":[],"autoExit":false}',
      '{"tools":["*"],"autoExit":false}', '{"tools":["+write"],"autoExit":false}']) {
      writeFileSync(path, invalid);
      assert.throws(() => readChildRunConfig(path), /configuration/);
    }
    const config = { schemaVersion: 1, tools: ["read", "subagent_done"], autoExit: false, skills: "uv", systemPrompt: "role" };
    writeFileSync(path, JSON.stringify(config));
    const { autoExit: _autoExit, ...permissions } = config;
    assert.deepEqual(readChildRunConfig(path), permissions);
    const dynamic = { ...config, schemaVersion: 2, tools: [...config.tools, "browser_navigate"], initialTools: ["read", "subagent_done"] };
    writeFileSync(path, JSON.stringify(dynamic));
    assert.deepEqual(readChildRunConfig(path), { ...permissions, schemaVersion: 2, tools: dynamic.tools });
    const current = { ...permissions, schemaVersion: 3 };
    writeFileSync(path, JSON.stringify(current));
    assert.deepEqual(readChildRunConfig(path), current);
    writeFileSync(path, JSON.stringify({ ...current, initialTools: ["read"] }));
    assert.throws(() => readChildRunConfig(path), /configuration/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
