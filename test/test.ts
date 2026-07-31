import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

import {
  getLeafId,
  getEntryCount,
  getNewEntries,
  findLastAssistantMessage,
  findSubagentDoneResults,
  SUBAGENT_DONE_RESULT_TYPE,
  appendBranchSummary,
  copySessionFile,
  mergeNewEntries,
  createSubagentSession,
  digestSubagentTask,
  readSubagentSessionCorrelation,
  selectForkHistory,
  SUBAGENT_METADATA_TYPE,
} from "../pi-extension/subagents/session.ts";

import { shellEscape, isCmuxAvailable, isWezTermAvailable } from "../pi-extension/subagents/cmux.ts";
import { validateSubagentDoneParams } from "../pi-extension/subagents/subagent-done.ts";
import {
  ensureSessionArtifactDir,
  getSessionArtifactDir,
  prepareArtifactWritePath,
  writeArtifactFile,
  resolveArtifactPath,
  resolveExistingArtifactPath,
} from "../pi-extension/session-artifacts/paths.ts";
import {
  ChildIpcClient,
  encodeIpcFrame,
  IpcFrameDecoder,
  ParentIpcServer,
} from "../pi-extension/subagents/ipc.ts";

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getLeafId", () => {
    it("returns last entry id", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(getLeafId(file), "asst-001");
    });

    it("returns null for empty file", () => {
      const file = join(dir, "empty.jsonl");
      writeFileSync(file, "");
      assert.equal(getLeafId(file), null);
    });
  });

  describe("getEntryCount", () => {
    it("counts non-empty lines", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG]);
      assert.equal(getEntryCount(file), 3);
    });

    it("returns 0 for empty file", () => {
      const file = join(dir, "empty2.jsonl");
      writeFileSync(file, "\n\n");
      assert.equal(getEntryCount(file), 0);
    });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });
  });

  describe("findSubagentDoneResults", () => {
    it("finds persisted structured subagent results", () => {
      const entries = [
        ASSISTANT_MSG,
        {
          type: "custom",
          id: "done-001",
          customType: SUBAGENT_DONE_RESULT_TYPE,
          data: {
            schemaVersion: 1,
            status: "success",
            summary: "Done.",
            completedAt: "2026-04-28T00:00:00.000Z",
          },
        },
      ] as any[];

      const results = findSubagentDoneResults(entries);
      assert.equal(results.length, 1);
      assert.equal(results[0].summary, "Done.");
    });
  });

  describe("appendBranchSummary", () => {
    it("appends valid branch_summary entry", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const id = appendBranchSummary(file, "user-001", "asst-001", "The plan was created.");

      assert.ok(id, "should return an id");
      assert.equal(typeof id, "string");

      // Read back and verify
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 4); // 3 original + 1 summary

      const summary = JSON.parse(lines[3]);
      assert.equal(summary.type, "branch_summary");
      assert.equal(summary.id, id);
      assert.equal(summary.parentId, "user-001");
      assert.equal(summary.fromId, "asst-001");
      assert.equal(summary.summary, "The plan was created.");
      assert.ok(summary.timestamp);
    });

    it("uses branchPointId as fromId fallback", () => {
      const file = createSessionFile(dir, [SESSION_HEADER]);
      appendBranchSummary(file, "branch-pt", null, "summary");

      const lines = readFileSync(file, "utf8").trim().split("\n");
      const summary = JSON.parse(lines[1]);
      assert.equal(summary.fromId, "branch-pt");
    });
  });

  describe("copySessionFile", () => {
    it("creates a copy with different path", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const copyDir = join(dir, "copies");
      mkdirSync(copyDir, { recursive: true });
      const copy = copySessionFile(file, copyDir);

      assert.notEqual(copy, file);
      assert.ok(copy.endsWith(".jsonl"));
      assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
    });
  });

  describe("mergeNewEntries", () => {
    it("appends new entries from source to target", () => {
      // Source starts with same base (2 entries), then has 1 new entry
      const sourceFile = join(dir, "merge-source.jsonl");
      const targetFile = join(dir, "merge-target.jsonl");
      writeFileSync(
        sourceFile,
        [SESSION_HEADER, USER_MSG, ASSISTANT_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      writeFileSync(
        targetFile,
        [SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      // Merge entries after line 2 (the shared base)
      const merged = mergeNewEntries(sourceFile, targetFile, 2);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, "asst-001");

      // Target should now have 3 entries
      const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
      assert.equal(targetLines.length, 3);
    });
  });
});

describe("subagent session lineage", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const timestamp = "2026-07-31T22:30:00.000Z";
  const rootEntry = {
    type: "model_change",
    id: "root-001",
    parentId: null,
    timestamp,
    provider: "openai-codex",
    modelId: "gpt-5.6-sol",
  };
  const priorUser = {
    type: "message",
    id: "user-prior",
    parentId: "root-001",
    timestamp,
    message: { role: "user", content: [{ type: "text", text: "Prior context" }] },
  };
  const priorAssistant = {
    type: "message",
    id: "assistant-prior",
    parentId: "user-prior",
    timestamp,
    message: { role: "assistant", content: [{ type: "text", text: "Prior answer" }] },
  };
  const orchestrationTrigger = {
    type: "message",
    id: "user-trigger",
    parentId: "assistant-prior",
    timestamp,
    message: { role: "user", content: [{ type: "text", text: "Launch a worker" }] },
  };
  const triggerSuffix = {
    type: "thinking_level_change",
    id: "trigger-suffix",
    parentId: "user-trigger",
    timestamp,
    thinkingLevel: "high",
  };

  it("pre-creates a fresh valid Pi v3 child with unique lineage metadata", () => {
    const sessionDir = join(dir, "fresh-sessions");
    const childCwd = join(dir, "child-cwd");
    mkdirSync(childCwd, { recursive: true });
    const parentFile = join(dir, "parent.jsonl");
    writeFileSync(parentFile, "{}\n");

    const created = createSubagentSession({
      sessionDir,
      cwd: childCwd,
      parentSessionId: "parent-session-id",
      parentSessionFile: parentFile,
      parentLeafId: "parent-leaf",
      runId: "run-001",
      name: "Worker",
      agent: "worker",
      mode: "fresh",
      task: "Implement the task",
      createdAt: timestamp,
    });

    const manager = SessionManager.open(created.sessionFile);
    const header = manager.getHeader();
    assert.equal(header?.version, 3);
    assert.equal(header?.id, created.childSessionId);
    assert.match(created.childSessionId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    assert.equal(header?.cwd, resolve(childCwd));
    assert.equal(header?.parentSession, resolve(parentFile));

    const metadataEntry = manager
      .getEntries()
      .find((entry) => entry.type === "custom" && entry.customType === SUBAGENT_METADATA_TYPE) as any;
    assert.equal(metadataEntry.parentId, null);
    assert.match(metadataEntry.id, /^[0-9a-f]{8}$/);
    assert.deepEqual(metadataEntry.data, created.metadata);
    assert.equal(created.metadata.parentSessionId, "parent-session-id");
    assert.equal(created.metadata.parentLeafId, "parent-leaf");
    assert.equal(created.metadata.childSessionId, created.childSessionId);
    assert.equal(created.metadata.runId, "run-001");
    assert.equal(created.metadata.mode, "fresh");
    assert.equal(created.metadata.taskDigest, digestSubagentTask("Implement the task"));
    assert.equal("ipcToken" in created.metadata, false);
    assert.doesNotMatch(readFileSync(created.sessionFile, "utf8"), /PI_SUBAGENT_TOKEN|ipcToken/);
  });

  it("creates collision-resistant child IDs and paths for parallel launches", () => {
    const sessionDir = join(dir, "parallel-sessions");
    const options = {
      sessionDir,
      cwd: dir,
      parentSessionId: "parent-session-id",
      parentSessionFile: join(dir, "parallel-parent.jsonl"),
      runId: "placeholder",
      name: "Parallel",
      mode: "fresh" as const,
      task: "Parallel task",
      createdAt: timestamp,
    };
    const first = createSubagentSession({ ...options, runId: "run-a" });
    const second = createSubagentSession({ ...options, runId: "run-b" });

    assert.notEqual(first.childSessionId, second.childSessionId);
    assert.notEqual(first.sessionFile, second.sessionFile);
    assert.ok(existsSync(first.sessionFile));
    assert.ok(existsSync(second.sessionFile));
  });

  it("forks only the validated active history and excludes the orchestration trigger", () => {
    const activeBranch = [
      rootEntry,
      priorUser,
      priorAssistant,
      orchestrationTrigger,
      triggerSuffix,
    ] as any[];
    const history = selectForkHistory(activeBranch);
    assert.deepEqual(history.map((entry) => entry.id), ["root-001", "user-prior", "assistant-prior"]);

    const parentFile = join(dir, "fork-parent.jsonl");
    writeFileSync(
      parentFile,
      [
        { type: "session", version: 3, id: "parent-header-id", timestamp, cwd: dir },
        ...activeBranch,
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    const created = createSubagentSession({
      sessionDir: join(dir, "fork-sessions"),
      cwd: dir,
      parentSessionId: "parent-header-id",
      parentSessionFile: parentFile,
      parentLeafId: "user-trigger",
      runId: "fork-run",
      name: "Iterate",
      mode: "fork",
      task: "Fix the issue",
      historyEntries: history,
      createdAt: timestamp,
    });

    const lines = readFileSync(created.sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(lines[0].type, "session");
    assert.notEqual(lines[0].id, "parent-header-id");
    assert.equal(lines.filter((entry) => entry.type === "session").length, 1);
    assert.deepEqual(lines.slice(1, 4).map((entry) => entry.id), history.map((entry) => entry.id));
    assert.equal(lines.some((entry) => entry.id === "user-trigger"), false);
    assert.equal(lines.at(-1).customType, SUBAGENT_METADATA_TYPE);
    assert.equal(lines.at(-1).parentId, "assistant-prior");
  });

  it("rejects broken or non-branch fork history", () => {
    assert.throws(
      () => selectForkHistory([rootEntry, { ...priorUser, parentId: "wrong-parent" }] as any[]),
      /Broken parent chain/,
    );
    assert.throws(
      () => selectForkHistory([{ type: "session", id: "copied-header", timestamp }] as any[]),
      /Invalid entry/,
    );
  });

  it("round-trips stable child and originating-run correlation for resume", () => {
    const created = createSubagentSession({
      sessionDir: join(dir, "resume-sessions"),
      cwd: dir,
      parentSessionId: "parent-session-id",
      parentSessionFile: join(dir, "resume-parent.jsonl"),
      runId: "origin-run-id",
      name: "Worker",
      mode: "fresh",
      task: "Initial work",
    });

    assert.deepEqual(readSubagentSessionCorrelation(created.sessionFile), {
      childSessionId: created.childSessionId,
      cwd: resolve(dir),
      originatingRunId: "origin-run-id",
    });
  });

  it("rejects forged metadata rather than losing child/run correlation", () => {
    const file = join(dir, "forged-metadata.jsonl");
    writeFileSync(file, [
      JSON.stringify({ type: "session", version: 3, id: "child-id", timestamp, cwd: dir }),
      JSON.stringify({
        type: "custom",
        id: "metadata-id",
        parentId: null,
        timestamp,
        customType: SUBAGENT_METADATA_TYPE,
        data: {
          schemaVersion: 1,
          childSessionId: "different-child-id",
          runId: "run-id",
          parentSessionId: "parent-id",
          parentSessionFile: join(dir, "parent.jsonl"),
        },
      }),
    ].join("\n") + "\n");

    assert.throws(() => readSubagentSessionCorrelation(file), /invalid subagent metadata/);
  });
});

describe("session artifact sidecars", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("places artifacts under the owning session sibling sidecar", () => {
    const sessionFile = join(dir, "2026-07-31_session-id.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const artifactDir = ensureSessionArtifactDir(sessionFile);
    assert.equal(
      artifactDir,
      join(dir, "2026-07-31_session-id", "artifacts"),
    );
    assert.equal(getSessionArtifactDir(sessionFile), artifactDir);

    const artifact = prepareArtifactWritePath(artifactDir, "context/notes.md");
    writeFileSync(artifact, "notes");
    assert.equal(resolveExistingArtifactPath(artifactDir, "context/notes.md"), artifact);
  });

  it("rejects absolute paths, traversal, and sibling-prefix escapes", () => {
    const artifactDir = ensureSessionArtifactDir(join(dir, "containment.jsonl"));
    assert.throws(() => resolveArtifactPath(artifactDir, "/tmp/escape.md"), /relative path/);
    assert.throws(() => resolveArtifactPath(artifactDir, "../escape.md"), /escapes/);
    assert.throws(
      () => resolveArtifactPath(artifactDir, `../${basename(artifactDir)}-other/escape.md`),
      /escapes/,
    );
  });

  it("rejects symlink traversal for writes and reads", () => {
    const artifactDir = ensureSessionArtifactDir(join(dir, "symlink.jsonl"));
    const outside = join(dir, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.md"), "secret");
    symlinkSync(outside, join(artifactDir, "linked"), "dir");

    assert.throws(
      () => prepareArtifactWritePath(artifactDir, "linked/new.md"),
      /symbolic link/,
    );
    assert.throws(
      () => resolveExistingArtifactPath(artifactDir, "linked/secret.md"),
      /symbolic link/,
    );
  });

  it("atomically replaces ordinary artifacts without following a leaf symlink", () => {
    const artifactDir = ensureSessionArtifactDir(join(dir, "atomic.jsonl"));
    const artifact = writeArtifactFile(artifactDir, "context/task.md", "first");
    assert.equal(readFileSync(artifact, "utf8"), "first");
    assert.equal(writeArtifactFile(artifactDir, "context/task.md", "second"), artifact);
    assert.equal(readFileSync(artifact, "utf8"), "second");

    const outside = join(dir, "atomic-outside.md");
    writeFileSync(outside, "secret");
    rmSync(artifact);
    symlinkSync(outside, artifact);
    assert.throws(() => writeArtifactFile(artifactDir, "context/task.md", "blocked"), /symbolic link/);
    assert.equal(readFileSync(outside, "utf8"), "secret");
  });
});

describe("subagent-done.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("validates structured completion and resolves artifact paths", () => {
    mkdirSync(join(dir, "context"), { recursive: true });
    writeFileSync(join(dir, "context", "notes.md"), "details");

    const result = validateSubagentDoneParams(
      {
        status: "success",
        summary: "Done.",
        report: "Full report.",
        artifacts: [{ name: "context/notes.md", description: "Implementation notes" }],
        nextSteps: ["Run CI"],
      },
      dir,
    );

    assert.equal(result.schemaVersion, 1);
    assert.equal(result.status, "success");
    assert.equal(result.artifacts?.[0].path, join(dir, "context", "notes.md"));
  });

  it("rejects missing artifacts", () => {
    assert.throws(
      () =>
        validateSubagentDoneParams(
          {
            status: "success",
            summary: "Done.",
            artifacts: [{ name: "missing.md" }],
          },
          dir,
        ),
      /does not exist/,
    );
  });

  it("rejects artifact references that traverse symlinks", () => {
    const artifactDir = join(dir, "symlink-artifacts");
    const outside = join(dir, "symlink-outside");
    mkdirSync(artifactDir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "report.md"), "report");
    symlinkSync(outside, join(artifactDir, "linked"), "dir");

    assert.throws(
      () =>
        validateSubagentDoneParams(
          {
            status: "success",
            summary: "Done.",
            artifacts: [{ name: "linked/report.md" }],
          },
          artifactDir,
        ),
      /symbolic link/,
    );
  });

  it("rejects reports above the line limit", () => {
    assert.throws(
      () =>
        validateSubagentDoneParams(
          {
            status: "success",
            summary: "Done.",
            report: Array.from({ length: 2001 }, () => "line").join("\n"),
          },
          dir,
        ),
      /too many lines/,
    );
  });
});
describe("subagent model qualification", () => {
  it("qualifies the configured default model with its default provider", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.equal(typeof testApi.qualifyModelWithProvider, "function");

    const home = createTestDir();
    const cwd = createTestDir();
    const originalHome = process.env.HOME;

    try {
      process.env.HOME = home;
      mkdirSync(join(home, ".pi", "agent"), { recursive: true });
      writeFileSync(
        join(home, ".pi", "agent", "settings.json"),
        JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "gpt-5.4" }),
      );

      const qualified = testApi.qualifyModelWithProvider("gpt-5.4", { cwd });
      assert.equal(qualified, "openai-codex/gpt-5.4");
    } finally {
      process.env.HOME = originalHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not rewrite unrelated bare models just because a default provider exists", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.equal(typeof testApi.qualifyModelWithProvider, "function");

    const home = createTestDir();
    const cwd = createTestDir();
    const originalHome = process.env.HOME;

    try {
      process.env.HOME = home;
      mkdirSync(join(home, ".pi", "agent"), { recursive: true });
      writeFileSync(
        join(home, ".pi", "agent", "settings.json"),
        JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "gpt-5.4" }),
      );

      const qualified = testApi.qualifyModelWithProvider("claude-sonnet-4-5", { cwd });
      assert.equal(qualified, "claude-sonnet-4-5");
    } finally {
      process.env.HOME = originalHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("falls back to the current session model provider for matching bare ids", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.equal(typeof testApi.qualifyModelWithProvider, "function");

    const cwd = createTestDir();
    try {
      const qualified = testApi.qualifyModelWithProvider("gpt-5.4", {
        cwd,
        model: { id: "gpt-5.4", provider: "openai-codex" },
      });
      assert.equal(qualified, "openai-codex/gpt-5.4");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("subagent launch environment", () => {
  it("resolves relative child cwd against the parent before session creation", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.equal(
      testApi.resolveEffectiveChildCwd("agents/worker", "/workspace/project"),
      "/workspace/project/agents/worker",
    );
    assert.equal(
      testApi.resolveEffectiveChildCwd(undefined, "/workspace/project"),
      "/workspace/project",
    );
  });

  it("reasserts inherited profile selectors for child and resume commands", () => {
    const testApi = (subagentsModule as any).__test__;
    const originalProfile = process.env.PI_PROFILE;
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_PROFILE = "radius";
      process.env.PI_CODING_AGENT_DIR = "/tmp/profile root/radius";
      assert.deepEqual(testApi.inheritedProfileEnvParts(), [
        "PI_PROFILE='radius'",
        "PI_CODING_AGENT_DIR='/tmp/profile root/radius'",
      ]);
      assert.deepEqual(testApi.inheritedProfileEnvUnsets(), []);

      delete process.env.PI_PROFILE;
      delete process.env.PI_CODING_AGENT_DIR;
      assert.deepEqual(testApi.inheritedProfileEnvUnsets(), [
        "-u", "PI_PROFILE", "-u", "PI_CODING_AGENT_DIR",
      ]);
    } finally {
      if (originalProfile == null) delete process.env.PI_PROFILE;
      else process.env.PI_PROFILE = originalProfile;
      if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
  });
});

describe("subagent tool allow-list", () => {
  it("keeps child lifecycle tools available when an agent restricts native tools", () => {
    const testApi = (subagentsModule as any).__test__;
    const tools = testApi.buildSubagentToolAllowList(
      "read,bash,edit,write",
      new Set(),
      testApi.withChildOnlyTools(["read", "bash", "edit", "write", "write_artifact"]),
    );

    assert.ok(tools.includes("subagent_done"));
    assert.ok(tools.includes("write_artifact"));
    assert.ok(tools.includes("read"));
  });

  it("never denies the mandatory subagent_done lifecycle tool", () => {
    const testApi = (subagentsModule as any).__test__;
    const denySet = testApi.resolveDenyTools(
      { allowTools: "read,bash" },
      testApi.withChildOnlyTools(["read", "bash", "write_artifact"]),
    );
    denySet.delete("subagent_done");

    const tools = testApi.buildSubagentToolAllowList(
      "read,bash",
      denySet,
      testApi.withChildOnlyTools(["read", "bash", "write_artifact"]),
    );

    assert.ok(tools.includes("subagent_done"));
    assert.equal(tools.includes("write_artifact"), false);
    assert.equal(tools.includes("set_tab_title"), false);
  });
});

describe("subagents widget rendering", () => {
  it("keeps every rendered line within a very narrow width", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime: 1_000_000 - 13_000,
          sessionFile: "sess1",
          entries: 13,
          bytes: 55.6 * 1024,
        },
        {
          id: "a2",
          name: "B",
          task: "",
          surface: "s2",
          startTime: 1_000_000 - 21_000,
          sessionFile: "sess2",
          entries: 21,
          bytes: 115.6 * 1024,
        },
        {
          id: "a3",
          name: "C",
          task: "",
          surface: "s3",
          startTime: 1_000_000 - 27_000,
          sessionFile: "sess3",
          entries: 27,
          bytes: 106.8 * 1024,
        },
      ], 16);

      assert.deepEqual(
        lines.map((line: string) => visibleWidth(line)),
        [16, 16, 16, 16, 16],
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("truncates the right-hand status instead of overflowing when it alone is too wide", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.borderLine, "function");

    const line = testApi.borderLine(" A ", " 999 msgs (999.9KB) ", 16);
    assert.equal(visibleWidth(line), 16);
  });

  it("handles ultra-narrow widths without exceeding the width contract", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const widths = [0, 1, 2];
    for (const width of widths) {
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime: Date.now() - 5_000,
          sessionFile: "sess1",
          entries: 1,
          bytes: 1,
        },
      ], width);

      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("subagent IPC", () => {
  it("decodes fragmented length-prefixed frames", () => {
    const frame = encodeIpcFrame({
      version: 1,
      type: "activity",
      childId: "child-1",
      sequence: 1,
      payload: { entries: 4 },
    });
    const decoder = new IpcFrameDecoder();

    assert.deepEqual(decoder.push(frame.subarray(0, 3)), []);
    assert.deepEqual(decoder.push(frame.subarray(3, 9)), []);
    const messages = decoder.push(frame.subarray(9));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, "activity");
    assert.deepEqual(messages[0].payload, { entries: 4 });
  });

  it("authenticates a child and carries bidirectional messages", async () => {
    const dir = createTestDir();
    const socketPath = join(dir, "parent.sock");
    const token = "a".repeat(64);
    let resolveActivity!: () => void;
    let resolveCommand!: () => void;
    const activity = new Promise<void>((resolve) => { resolveActivity = resolve; });
    const command = new Promise<void>((resolve) => { resolveCommand = resolve; });

    const server = new ParentIpcServer({
      socketPath,
      onMessage(message) {
        if (message.type === "activity") resolveActivity();
      },
      onConnect(childId) {
        server.send(childId, "ping", { timestamp: 1 });
      },
    });
    server.registerChild("child-1", token);
    await server.start();

    const client = new ChildIpcClient({
      socketPath,
      childId: "child-1",
      token,
      helloPayload: () => ({ pid: process.pid }),
      onMessage(message) {
        if (message.type === "ping") resolveCommand();
      },
      reconnectDelayMs: 20,
    });
    client.start();
    client.send("activity", { entries: 1 });

    await Promise.race([
      Promise.all([activity, command]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("IPC test timed out")), 2000)),
    ]);

    client.stop();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a child with the wrong token", async () => {
    const dir = createTestDir();
    const socketPath = join(dir, "parent.sock");
    let connected = false;
    const server = new ParentIpcServer({
      socketPath,
      onMessage() {},
      onConnect() { connected = true; },
    });
    server.registerChild("child-1", "correct-token");
    await server.start();

    const client = new ChildIpcClient({
      socketPath,
      childId: "child-1",
      token: "wrong-token",
      helloPayload: () => ({}),
      reconnectDelayMs: 1000,
    });
    client.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(connected, false);
    assert.equal(server.isConnected("child-1"), false);
    client.stop();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmux.ts", () => {
  describe("shellEscape", () => {
    it("wraps in single quotes", () => {
      assert.equal(shellEscape("hello"), "'hello'");
    });

    it("escapes single quotes", () => {
      assert.equal(shellEscape("it's"), "'it'\\''s'");
    });

    it("handles empty string", () => {
      assert.equal(shellEscape(""), "''");
    });

    it("handles special characters", () => {
      const input = 'echo "hello $world" && rm -rf /';
      const escaped = shellEscape(input);
      assert.ok(escaped.startsWith("'"));
      assert.ok(escaped.endsWith("'"));
      // Inside single quotes, everything is literal
      assert.ok(escaped.includes("$world"));
    });
  });

  describe("isCmuxAvailable", () => {
    it("returns boolean based on CMUX_SOCKET_PATH", () => {
      // Can't easily mock env in node:test, just verify it returns a boolean
      const result = isCmuxAvailable();
      assert.equal(typeof result, "boolean");
    });
  });

  describe("isWezTermAvailable", () => {
    it("returns boolean based on WEZTERM_UNIX_SOCKET", () => {
      const result = isWezTermAvailable();
      assert.equal(typeof result, "boolean");
    });
  });
});
