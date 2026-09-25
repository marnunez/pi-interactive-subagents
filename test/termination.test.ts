import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectOpenDescendants } from "../pi-extension/subagents/termination.ts";
import { LAUNCH_ENTRY, FINISH_ENTRY, CLOSED_ENTRY, IDENTITY_ENTRY } from "../pi-extension/subagents/run-ledger.ts";

test("forced cleanup walks open descendants deepest first, including terminal-but-not-closed runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-subtree-test-"));
  try {
    const leaf = { id: "leaf", runId: "leaf", sessionFile: join(dir, "leaf.jsonl"), surface: "pane:leaf" };
    const middle = { id: "middle", runId: "middle", sessionFile: join(dir, "middle.jsonl"), surface: "pane:middle" };
    const root = join(dir, "root.jsonl");
    const entry = (customType: string, data: unknown) => JSON.stringify({ type: "custom", customType, data }) + "\n";
    writeFileSync(leaf.sessionFile, "");
    writeFileSync(middle.sessionFile, entry(LAUNCH_ENTRY, leaf));
    writeFileSync(root, entry(LAUNCH_ENTRY, middle) + entry(IDENTITY_ENTRY, { runId: "middle", childPid: 123 }) + entry(FINISH_ENTRY, { runId: "middle", pendingCleanup: true }));
    const open = collectOpenDescendants(root);
    assert.deepEqual(open.map((run) => run.id), ["leaf", "middle"]);
    assert.equal(open[1].childPid, 123);
    writeFileSync(root, entry(LAUNCH_ENTRY, middle) + entry(CLOSED_ENTRY, { runId: "middle" }));
    assert.deepEqual(collectOpenDescendants(root), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
