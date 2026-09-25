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
    for (const invalid of ["{", "{}", '{"tools":null,"autoExit":false}', '{"tools":[42],"autoExit":false}', '{"schemaVersion":2,"tools":[],"autoExit":false}']) {
      writeFileSync(path, invalid);
      assert.throws(() => readChildRunConfig(path), /configuration/);
    }
    const config = { schemaVersion: 1, tools: ["read", "subagent_done"], autoExit: false, skills: "uv", systemPrompt: "role" };
    writeFileSync(path, JSON.stringify(config));
    assert.deepEqual(readChildRunConfig(path), config);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
