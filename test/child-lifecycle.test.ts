import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import childLifecycleExtension from "../pi-extension/subagents/subagent-done.ts";
import {
  findRunCompletion,
  readRunCompletion,
  SUBAGENT_DONE_RESULT_TYPE,
  type SessionEntry,
  type SubagentDoneResult,
} from "../pi-extension/subagents/session.ts";
import { ParentIpcServer } from "../pi-extension/subagents/ipc.ts";

const CHILD_ENV_NAMES = [
  "PI_SUBAGENT_NAME",
  "PI_SUBAGENT_AGENT",
  "PI_SUBAGENT_ID",
  "PI_SUBAGENT_SOCKET",
  "PI_SUBAGENT_TOKEN",
  "PI_SUBAGENT_AUTO_EXIT",
  "PI_SUBAGENT_MODEL",
  "PI_SUBAGENT_THINKING",
  "PI_SUBAGENT_TOOLS",
  "PI_SUBAGENT_INITIAL_TOOLS",
] as const;
const ORIGINAL_CHILD_ENV = new Map(
  CHILD_ENV_NAMES.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  for (const name of CHILD_ENV_NAMES) {
    const value = ORIGINAL_CHILD_ENV.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function configureChildEnv(options: {
  runId: string;
  socketPath?: string;
  token?: string;
  autoExit?: boolean;
}): void {
  for (const name of CHILD_ENV_NAMES) delete process.env[name];
  process.env.PI_SUBAGENT_NAME = "Lifecycle Test";
  process.env.PI_SUBAGENT_ID = options.runId;
  process.env.PI_SUBAGENT_AUTO_EXIT = options.autoExit ? "1" : "0";
  if (options.socketPath) process.env.PI_SUBAGENT_SOCKET = options.socketPath;
  if (options.token) process.env.PI_SUBAGENT_TOKEN = options.token;
}

function completion(runId: string, summary: string): SubagentDoneResult {
  return {
    schemaVersion: 1,
    runId,
    status: "success",
    summary,
    completedAt: "2026-09-25T12:00:00.000Z",
  };
}

function customCompletionEntry(
  id: string,
  result: SubagentDoneResult,
): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-09-25T12:00:00.000Z",
    customType: SUBAGENT_DONE_RESULT_TYPE,
    data: result,
  };
}

function createSessionFile(dir: string, entries: SessionEntry[] = []): string {
  const sessionFile = join(dir, "child-session.jsonl");
  const header = {
    type: "session",
    version: 3,
    id: "child-session-id",
    timestamp: "2026-09-25T12:00:00.000Z",
    cwd: dir,
  };
  writeFileSync(
    sessionFile,
    [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  return sessionFile;
}

interface ExtensionHarness {
  events: EventEmitter;
  pi: any;
  entries: SessionEntry[];
  handlers: Map<string, Array<(event: any, ctx: any) => unknown>>;
  tools: Map<string, any>;
  ctx: any;
  shutdownCount: () => number;
  messages: any[];
  titles: string[];
  emit: (eventName: string, event?: Record<string, unknown>) => Promise<void>;
}

function createExtensionHarness(sessionFile: string): ExtensionHarness {
  const entries = readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type !== "session") as SessionEntry[];
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const tools = new Map<string, any>();
  const messages: any[] = [];
  const titles: string[] = [];
  let shutdowns = 0;
  let nextEntry = entries.length;
  let activeTools: string[] = [];
  const events = new EventEmitter();

  const ui = {
    setTitle(title: string) { titles.push(title); },
    setWidget() {},
    async select() { return undefined; },
    async confirm() { return false; },
    async input() { return undefined; },
    async editor() { return undefined; },
    async custom() { return undefined; },
  };
  const ctx = {
    ui,
    mode: "tui",
    model: undefined,
    modelRegistry: { find() { return undefined; } },
    sessionManager: {
      getSessionId() { return "child-session-id"; },
      getSessionFile() { return sessionFile; },
      getEntries() { return entries; },
      getBranch() { return entries; },
    },
    isIdle() { return true; },
    async abort() {},
    shutdown() { shutdowns++; },
  };
  const pi = {
    events: {
      on(name: string, handler: (...args: any[]) => void) { events.on(name, handler); return () => events.off(name, handler); },
      emit(name: string, data: unknown) { events.emit(name, data); },
    },
    on(eventName: string, handler: (event: any, context: any) => unknown) {
      const eventHandlers = handlers.get(eventName) ?? [];
      eventHandlers.push(handler);
      handlers.set(eventName, eventHandlers);
      return () => {
        const index = eventHandlers.indexOf(handler);
        if (index >= 0) eventHandlers.splice(index, 1);
      };
    },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerShortcut() {},
    appendEntry(customType: string, data: unknown) {
      const entry: SessionEntry = {
        type: "custom",
        id: `entry-${++nextEntry}`,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        customType,
        data,
      };
      entries.push(entry);
      appendFileSync(sessionFile, JSON.stringify(entry) + "\n");
    },
    getAllTools() {
      return [...tools.values()];
    },
    getActiveTools() { return activeTools; },
    setActiveTools(names: string[]) {
      activeTools = names.filter(name => tools.has(name));
      for (const name of activeTools) tools.get(name)?.prepareLoadout?.({
        declared: activeTools.map(name => tools.get(name)),
        registered: [...tools.values()],
        getExposure: (name: string) => tools.get(name)?.exposure ?? "direct",
      });
    },
    async setModel() { return true; },
    setThinkingLevel() {},
    getSessionName() { return entries.findLast(entry => entry.type === "session_info")?.name; },
    setSessionName(name: string) {
      const entry: SessionEntry = { type: "session_info", id: `entry-${++nextEntry}`, parentId: entries.at(-1)?.id ?? null, name };
      entries.push(entry);
      appendFileSync(sessionFile, JSON.stringify(entry) + "\n");
    },
    sendUserMessage() { throw new Error("Parent messages must never be sent as user messages"); },
    sendMessage(message: any, options: any) { messages.push({ message, options }); },
  };

  childLifecycleExtension(pi as any);

  return {
    events,
    pi,
    entries,
    handlers,
    tools,
    ctx,
    shutdownCount: () => shutdowns,
    messages,
    titles,
    async emit(eventName, event = {}) {
      for (const handler of handlers.get(eventName) ?? []) {
        await handler({ type: eventName, ...event }, ctx);
      }
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for lifecycle condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("separate child permissions and visibility", () => {
  it("keeps discovery within the ceiling across turns, reload, resume and branch changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "child-loadout-"));
    const sessionFile = createSessionFile(dir);
    configureChildEnv({ runId: "dynamic-one" });
    process.env.PI_SUBAGENT_TOOLS = "read,tool_search,codemode,browser_navigate,subagent_done";
    process.env.PI_SUBAGENT_INITIAL_TOOLS = "read,tool_search,codemode,subagent_done";
    const setup = () => {
      const h = createExtensionHarness(sessionFile);
      for (const name of ["read", "tool_search", "codemode", "browser_navigate", "forbidden"]) h.tools.set(name, { name, exposure: name === "browser_navigate" ? "deferred" : "direct" });
      // Simulate startup presets eagerly enabling everything before the child hook.
      h.pi.setActiveTools([...h.tools.keys()]);
      return h;
    };
    const h = setup();
    try {
      await h.emit("session_start");
      assert.ok(!h.pi.getActiveTools().includes("browser_navigate"));
      const branchPoint = h.entries.slice();
      h.pi.setActiveTools([...h.pi.getActiveTools(), "browser_navigate", "forbidden"]);
      await h.emit("tool_result", { toolName: "tool_search" });
      await h.emit("before_agent_start");
      assert.ok(h.pi.getActiveTools().includes("browser_navigate"));
      assert.ok(!h.pi.getActiveTools().includes("forbidden"));
      const gate = h.handlers.get("tool_call")![0];
      assert.equal((await gate({ toolName: "browser_navigate", parentToolCallId: "script/1" }, h.ctx)), undefined);
      assert.equal((await gate({ toolName: "forbidden", parentToolCallId: "script/1" }, h.ctx) as any).block, true);
      assert.equal((await gate({ toolName: "forbidden" }, h.ctx) as any).block, true);
      await h.emit("session_shutdown", { reason: "reload" });
      const reload = setup();
      await reload.emit("session_start");
      assert.ok(reload.pi.getActiveTools().includes("browser_navigate"));
      await reload.emit("session_shutdown", { reason: "reload" });
      process.env.PI_SUBAGENT_ID = "dynamic-resume";
      const resumed = setup();
      await resumed.emit("session_start");
      assert.ok(resumed.pi.getActiveTools().includes("browser_navigate"));
      resumed.ctx.sessionManager.getBranch = () => branchPoint;
      await resumed.emit("session_tree");
      assert.ok(!resumed.pi.getActiveTools().includes("browser_navigate"), "An abandoned branch's discovery must not leak");
      await resumed.emit("session_shutdown", { reason: "reload" });
      const fork = setup();
      fork.ctx.sessionManager.getSessionId = () => "different-child-session";
      await fork.emit("session_start");
      assert.ok(!fork.pi.getActiveTools().includes("browser_navigate"), "Fork history is not the new child's visibility policy");
      await fork.emit("session_shutdown", { reason: "reload" });
    } finally {
      await h.emit("session_shutdown", { reason: "reload" });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retains pending declarations while a permitted tool reconnects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "child-loadout-pending-"));
    const sessionFile = createSessionFile(dir);
    configureChildEnv({ runId: "pending" });
    process.env.PI_SUBAGENT_TOOLS = "read,mcp__docs__search,subagent_done";
    process.env.PI_SUBAGENT_INITIAL_TOOLS = "read,mcp__docs__search,subagent_done";
    const h = createExtensionHarness(sessionFile);
    h.tools.set("read", { name: "read" });
    try {
      await h.emit("session_start");
      await h.emit("before_agent_start");
      const snapshot = h.entries.findLast((entry: any) => entry.customType === "subagent_tool_loadout")?.data as { activeTools: string[] } | undefined;
      assert.ok(snapshot?.activeTools.includes("mcp__docs__search"));
      h.tools.set("mcp__docs__search", { name: "mcp__docs__search", exposure: "deferred" });
      h.pi.setActiveTools(h.pi.getActiveTools()); // Native registry refresh runs prepareLoadout.
      await Promise.resolve();
      assert.ok(h.pi.getActiveTools().includes("mcp__docs__search"), "Registration recovers during this run, without a second before_agent_start");
      h.pi.setActiveTools(["read", "subagent_done"]); // Queue another retry, then invalidate it.
      await h.emit("session_shutdown", { reason: "reload" });
      assert.ok(!h.pi.getActiveTools().includes("mcp__docs__search"), "Queued work must not mutate a shutdown/reloaded extension");
    } finally {
      await h.emit("session_shutdown", { reason: "reload" });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a visibility override outside the saved permissions before startup", () => {
    const dir = mkdtempSync(join(tmpdir(), "child-loadout-invalid-"));
    try {
      configureChildEnv({ runId: "invalid" });
      process.env.PI_SUBAGENT_TOOLS = "read,subagent_done";
      process.env.PI_SUBAGENT_INITIAL_TOOLS = "write";
      assert.throws(() => createExtensionHarness(createSessionFile(dir)), /subset of the permission ceiling/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("automatic child pane names", () => {
  it("survives delayed core title resets by persisting only the child's display name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "child-title-delayed-"));
    const sessionFile = createSessionFile(dir);
    configureChildEnv({ runId: "delayed-title" });
    const h = createExtensionHarness(sessionFile);
    try {
      await h.emit("session_start");
      // Simulate a later startup handler/provider discovery outlasting one
      // setImmediate, then Pi rebuilding its title from session metadata.
      await new Promise(resolve => setTimeout(resolve, 25));
      const name = h.entries.findLast(entry => entry.type === "session_info")?.name;
      h.ctx.ui.setTitle(name ? `π - ${name} - cwd` : "π - cwd");
      assert.equal(h.titles.at(-1), "π - Lifecycle Test - cwd");
      await h.emit("session_shutdown", { reason: "reload" });
      await h.emit("session_start", { reason: "reload" });
      assert.equal(h.entries.filter(entry => entry.type === "session_info").length, 1, "Reload must not append duplicate names");
      h.ctx.ui.setTitle("Optional progress");
      assert.equal(h.entries.findLast(entry => entry.type === "session_info")?.name, "Lifecycle Test", "Progress must not rename the session");
      await h.emit("session_shutdown", { reason: "reload" });
      configureChildEnv({ runId: "new-run" });
      process.env.PI_SUBAGENT_NAME = "Renamed resume";
      const resumed = createExtensionHarness(sessionFile);
      await resumed.emit("session_start");
      assert.equal(resumed.entries.findLast(entry => entry.type === "session_info")?.name, "Renamed resume");
      await resumed.emit("session_shutdown", { reason: "reload" });
    } finally {
      await h.emit("session_shutdown", { reason: "reload" });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names startup/reload/resume without any model event or tool request, even with all optional tools denied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "child-title-startup-"));
    const sessionFile = createSessionFile(dir);
    configureChildEnv({ runId: "title-one" });
    process.env.PI_SUBAGENT_NAME = "Review\u0007\u001b]2;unsafe\u009c";
    process.env.PI_SUBAGENT_TOOLS = "subagent_done";
    const h = createExtensionHarness(sessionFile);
    try {
      await h.emit("session_start");
      assert.deepEqual(h.titles, ["Review]2;unsafe"]);
      await h.emit("session_shutdown", { reason: "reload" });
      await h.emit("session_start", { reason: "reload" });
      assert.deepEqual(h.titles, ["Review]2;unsafe", "Review]2;unsafe"]);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(h.titles.at(-1), "Review]2;unsafe", "Name must survive Pi's post-session_start default title");
      h.ctx.ui.setTitle("Working");
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(h.titles.at(-1), "Working", "Startup naming must not keep overwriting later progress");
      h.ctx.ui.setTitle = () => { throw new Error("Cosmetic failure"); };
      await h.emit("session_start", { reason: "reload" });
      await h.emit("session_shutdown", { reason: "reload" });
      configureChildEnv({ runId: "title-two" });
      process.env.PI_SUBAGENT_NAME = "Resumed review";
      const resumed = createExtensionHarness(sessionFile);
      await resumed.emit("session_start");
      assert.deepEqual(resumed.titles, ["Resumed review"]);
      resumed.ctx.mode = "rpc";
      await resumed.emit("session_start");
      assert.equal(resumed.titles.length, 1, "RPC must not set terminal titles");
      await resumed.emit("session_shutdown", { reason: "reload" });
      process.env.PI_SUBAGENT_NAME = "";
      const emptyName = createExtensionHarness(sessionFile);
      await emptyName.emit("session_start");
      assert.deepEqual(emptyName.titles, ["Subagent"]);
      await emptyName.emit("session_shutdown", { reason: "reload" });
    } finally {
      await h.emit("session_shutdown", { reason: "reload" });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("run-scoped durable completion", () => {
  it("selects two independent runs, ignores legacy/other results, and rejects conflicts", () => {
    const runA = completion("run-a", "First run complete");
    const runB = completion("run-b", "Second run complete");
    const legacy = { ...completion("legacy-placeholder", "Legacy"), runId: undefined };
    const entries = [
      customCompletionEntry("legacy", legacy),
      customCompletionEntry("a", runA),
      customCompletionEntry("b", runB),
      customCompletionEntry("a-copy", { ...runA }),
    ];

    assert.deepEqual(findRunCompletion(entries, "run-a"), runA);
    assert.deepEqual(findRunCompletion(entries, "run-b"), runB);
    assert.equal(findRunCompletion(entries, "run-c"), undefined);

    assert.throws(
      () => findRunCompletion([
        ...entries,
        customCompletionEntry("a-conflict", { ...runA, summary: "Different result" }),
      ], "run-a"),
      /Conflicting subagent completion results/,
    );
  });

  it("reconstructs the same-run guard after reload while allowing a resumed run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "child-lifecycle-runs-"));
    const first = completion("run-one", "Initial run complete");
    const sessionFile = createSessionFile(dir, [customCompletionEntry("done-one", first)]);

    try {
      configureChildEnv({ runId: "run-one" });
      const reloaded = createExtensionHarness(sessionFile);
      await reloaded.emit("session_start", { reason: "reload" });
      await assert.rejects(
        () => reloaded.tools.get("subagent_done").execute(
          "call-one",
          { status: "success", summary: "Duplicate" },
          undefined,
          undefined,
          reloaded.ctx,
        ),
        /already been called for this run/,
      );
      await reloaded.emit("session_shutdown", { reason: "reload" });

      configureChildEnv({ runId: "run-two" });
      const resumed = createExtensionHarness(sessionFile);
      await resumed.emit("session_start", { reason: "startup" });
      const toolResult = await resumed.tools.get("subagent_done").execute(
        "call-two",
        { status: "success", summary: "Resumed run complete" },
        undefined,
        undefined,
        resumed.ctx,
      );

      assert.equal(toolResult.terminate, true);
      assert.equal(toolResult.details.runId, "run-two");
      assert.deepEqual(readRunCompletion(sessionFile, "run-one"), first);
      assert.equal(readRunCompletion(sessionFile, "run-two")?.summary, "Resumed run complete");
      await resumed.emit("session_shutdown", { reason: "quit" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("child descendant guard", () => {
  it("does not auto-complete or explicitly complete while children are pending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "child-descendants-"));
    configureChildEnv({ runId: "parent-run", autoExit: true });
    const h = createExtensionHarness(createSessionFile(dir));
    try {
      await h.emit("session_start");
      let childCount = 0;
      h.events.on("subagent:children-query", () => h.events.emit("subagent:children", childCount));
      h.events.emit("subagent:children-query");
      await h.emit("session_shutdown", { reason: "reload" });
      await h.emit("session_start", { reason: "reload" });
      childCount = 1;
      await h.emit("agent_settled");
      assert.equal(readRunCompletion(h.ctx.sessionManager.getSessionFile(), "parent-run"), undefined);
      await assert.rejects(() => h.tools.get("subagent_done").execute("done", { status: "success", summary: "done" }, undefined, undefined, h.ctx), /Finish or cancel/);
      let drained = false;
      h.events.on("subagent:drain", (request) => request.pending.push(new Promise<void>((resolve) => setTimeout(() => { drained = true; resolve(); }, 30))));
      await h.emit("session_shutdown", { reason: "quit" });
      assert.equal(drained, true);
    } finally {
      await h.emit("session_shutdown", { reason: "reload" });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parent-to-child messaging", () => {
  it("accepts only same-run, active advisory messages; deduplicates retries and acknowledges after dispatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "child-parent-message-"));
    const sessionFile = createSessionFile(dir);
    const socketPath = join(dir, "parent.sock");
    const runId = "run-message";
    const token = "d".repeat(64);
    const acks: any[] = [];
    const server = new ParentIpcServer({ socketPath, onMessage(message) {
      if (message.type === "parent_message_ack") acks.push(message.payload);
    } });
    server.registerChild(runId, token);
    await server.start();
    configureChildEnv({ runId, socketPath, token });
    const h = createExtensionHarness(sessionFile);
    try {
      await h.emit("session_start");
      await waitFor(() => server.isConnected(runId));
      server.send(runId, "parent_message", { runId: "old-run", messageId: "wrong", text: "Ignore" });
      server.send(runId, "parent_message", { runId, messageId: "m1", text: "Check this path" });
      await waitFor(() => acks.length === 1);
      assert.deepEqual(acks, [{ runId, messageId: "m1" }]);
      assert.equal(h.messages.length, 1);
      assert.equal(h.messages[0].message.customType, "subagent_parent_message");
      assert.match(h.messages[0].message.content, /not the user; this is not user approval/);
      assert.deepEqual(h.messages[0].options, { triggerTurn: true, deliverAs: "steer" });
      server.send(runId, "parent_message", { runId, messageId: "m1", text: "Check this path" });
      await waitFor(() => acks.length === 2);
      assert.equal(h.messages.length, 1);
      await h.tools.get("subagent_done").execute("done", { status: "success", summary: "done" }, undefined, undefined, h.ctx);
      server.send(runId, "parent_message", { runId, messageId: "m2", text: "Too late" });
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(h.messages.length, 1);
      assert.equal(acks.length, 2);
    } finally {
      await h.emit("session_shutdown", { reason: "reload" });
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("child completion delivery", () => {
  it("persists once, retries until a matching acknowledgement, then shuts down", async () => {
    const dir = mkdtempSync(join(tmpdir(), "child-lifecycle-ipc-"));
    const sessionFile = createSessionFile(dir);
    const socketPath = join(dir, "parent.sock");
    const token = "a".repeat(64);
    const runId = "run-retry";
    let completionFrames = 0;
    const server = new ParentIpcServer({
      socketPath,
      onMessage(message) {
        if (message.type !== "completion") return;
        completionFrames++;
        const payload = message.payload as SubagentDoneResult;
        assert.equal(payload.runId, runId);
        if (completionFrames === 1) {
          server.send(runId, "completion_ack", { runId: "wrong-run" });
        } else if (completionFrames === 2) {
          server.send(runId, "completion_ack", { runId });
        }
      },
    });
    server.registerChild(runId, token);
    await server.start();
    configureChildEnv({ runId, socketPath, token });
    const harness = createExtensionHarness(sessionFile);

    try {
      await harness.emit("session_start", { reason: "startup" });
      await waitFor(() => server.isConnected(runId));
      // Let the authenticated welcome frame reach the child before completing,
      // so the second frame below is an actual timed retry rather than reconnect replay.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const toolResult = await harness.tools.get("subagent_done").execute(
        "call-retry",
        { status: "success", summary: "Delivered reliably" },
        undefined,
        undefined,
        harness.ctx,
      );
      assert.equal(toolResult.terminate, true);

      await waitFor(() => harness.shutdownCount() === 1);
      assert.equal(completionFrames, 2);
      assert.equal(
        harness.entries.filter(
          (entry) => entry.type === "custom" && entry.customType === SUBAGENT_DONE_RESULT_TYPE,
        ).length,
        1,
      );
      assert.equal(readRunCompletion(sessionFile, runId)?.summary, "Delivered reliably");
    } finally {
      await harness.emit("session_shutdown", { reason: "quit" });
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replays a persisted same-run result after extension reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "child-lifecycle-replay-"));
    const runId = "run-replay";
    const persisted = completion(runId, "Persisted before reload");
    const sessionFile = createSessionFile(dir, [customCompletionEntry("done-replay", persisted)]);
    const socketPath = join(dir, "parent.sock");
    const token = "b".repeat(64);
    let replayed: SubagentDoneResult | undefined;
    const server = new ParentIpcServer({
      socketPath,
      onMessage(message) {
        if (message.type !== "completion") return;
        replayed = message.payload as SubagentDoneResult;
        server.send(runId, "completion_ack", { runId });
      },
    });
    server.registerChild(runId, token);
    await server.start();
    configureChildEnv({ runId, socketPath, token });
    const harness = createExtensionHarness(sessionFile);

    try {
      await harness.emit("session_start", { reason: "reload" });
      await waitFor(() => harness.shutdownCount() === 1);
      assert.deepEqual(replayed, persisted);
      await assert.rejects(
        () => harness.tools.get("subagent_done").execute(
          "call-replay",
          { status: "success", summary: "Duplicate after reload" },
          undefined,
          undefined,
          harness.ctx,
        ),
        /already been called for this run/,
      );
    } finally {
      await harness.emit("session_shutdown", { reason: "quit" });
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleans up and recreates IPC and UI monitoring across reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "child-lifecycle-cleanup-"));
    const sessionFile = createSessionFile(dir);
    const socketPath = join(dir, "parent.sock");
    const token = "c".repeat(64);
    const runId = "run-cleanup";
    const server = new ParentIpcServer({ socketPath, onMessage() {} });
    server.registerChild(runId, token);
    await server.start();
    configureChildEnv({ runId, socketPath, token });
    const harness = createExtensionHarness(sessionFile);
    const originalSelect = harness.ctx.ui.select;

    try {
      await harness.emit("session_start", { reason: "startup" });
      await waitFor(() => server.isConnected(runId));
      assert.notEqual(harness.ctx.ui.select, originalSelect);

      await harness.emit("session_shutdown", { reason: "reload" });
      await waitFor(() => !server.isConnected(runId));
      assert.equal(harness.ctx.ui.select, originalSelect);

      await harness.emit("session_start", { reason: "reload" });
      await waitFor(() => server.isConnected(runId));
      assert.notEqual(harness.ctx.ui.select, originalSelect);
    } finally {
      await harness.emit("session_shutdown", { reason: "quit" });
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records automatic settling as blocked and preserves the assistant report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "child-lifecycle-fallback-"));
    const assistantEntry = {
      type: "message",
      id: "assistant-final",
      parentId: null,
      timestamp: "2026-09-25T12:00:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I could not establish an explicit outcome." }],
      },
    } as SessionEntry;
    const sessionFile = createSessionFile(dir, [assistantEntry]);
    configureChildEnv({ runId: "run-fallback", autoExit: true });
    const harness = createExtensionHarness(sessionFile);

    try {
      await harness.emit("session_start", { reason: "startup" });
      await harness.emit("agent_settled");

      const result = readRunCompletion(sessionFile, "run-fallback");
      assert.equal(result?.status, "blocked");
      assert.match(result?.summary ?? "", /no explicit outcome/i);
      assert.equal(result?.report, "I could not establish an explicit outcome.");
      assert.equal(result?.runId, "run-fallback");
    } finally {
      await harness.emit("session_shutdown", { reason: "quit" });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
