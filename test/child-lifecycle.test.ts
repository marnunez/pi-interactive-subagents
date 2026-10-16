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
  activeToolUpdates: string[][];
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
  const activeToolUpdates: string[][] = [];
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
      activeToolUpdates.push([...names]);
      activeTools = names.filter(name => tools.has(name));
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
    activeToolUpdates,
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

describe("native discovery and child execution permissions", () => {
  it("honours native exposure at startup, then leaves discoveries intact throughout a run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "child-native-discovery-"));
    configureChildEnv({ runId: "native-discovery" });
    process.env.PI_SUBAGENT_TOOLS = "read,tool_search,codemode,browser_navigate,subagent_done";
    const h = createExtensionHarness(createSessionFile(dir));
    for (const name of ["read", "tool_search", "codemode", "browser_navigate"]) {
      h.tools.set(name, { name, exposure: name === "browser_navigate" ? "deferred" : "direct" });
    }
    h.pi.setActiveTools(["read", "tool_search", "codemode", "browser_navigate"]);
    try {
      await h.emit("session_start");
      assert.deepEqual(h.pi.getActiveTools(), ["read", "tool_search", "codemode", "subagent_done"]);
      assert.equal(h.tools.get("subagent_done").prepareLoadout, undefined);
      // Native discovery can activate or withdraw a declaration without a child snapshot.
      for (const visible of [true, false, true]) {
        const tools = ["read", "tool_search", "codemode", "subagent_done", ...(visible ? ["browser_navigate"] : [])];
        h.pi.setActiveTools(tools);
        const updates = h.activeToolUpdates.length;
        await h.emit("tool_result", { toolName: "tool_search" });
        await h.emit("agent_end");
        await h.emit("session_tree");
        await h.emit("before_agent_start");
        await Promise.resolve();
        assert.deepEqual(h.pi.getActiveTools(), tools);
        assert.equal(h.activeToolUpdates.length, updates, "Lifecycle events must not reset native declarations");
      }
      h.pi.setActiveTools(["read", "browser_navigate"]); // A preset hid the common interfaces.
      await h.emit("before_agent_start");
      assert.ok(h.pi.getActiveTools().includes("codemode"));
      assert.ok(h.pi.getActiveTools().includes("subagent_done"));
      assert.ok(h.pi.getActiveTools().includes("browser_navigate"), "Re-adding common interfaces must preserve discoveries");
      await h.emit("session_shutdown", { reason: "reload" });
      const updates = h.activeToolUpdates.length;
      await h.emit("session_start", { reason: "reload" });
      assert.ok(!h.pi.getActiveTools().includes("browser_navigate"), "Restarted children rediscover deferred schemas instead of replaying a custom loadout");
      assert.equal(h.activeToolUpdates.length, updates + 1, "Only the startup exposure adjustment is needed");
      assert.equal(h.entries.some(entry => entry.type === "custom"), false, "Discovery must not persist custom entries");
    } finally {
      await h.emit("session_shutdown", { reason: "reload" });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks direct and nested forbidden calls even if another extension activates them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "child-permissions-"));
    configureChildEnv({ runId: "read-only" });
    process.env.PI_SUBAGENT_TOOLS = "read,codemode,subagent_search,subagent_git_inspect,subagent_done";
    const h = createExtensionHarness(createSessionFile(dir));
    for (const name of ["read", "codemode", "tool_search", "write", "edit", "bash"]) h.tools.set(name, { name });
    h.pi.setActiveTools(["read", "codemode"]);
    try {
      await h.emit("session_start");
      assert.ok(!h.pi.getActiveTools().includes("tool_search"), "There is no automatic role discovery fallback");
      // Visibility is not an authorisation boundary, including for codemode's nested calls.
      h.pi.setActiveTools([...h.tools.keys()]);
      await h.emit("before_agent_start");
      const gate = h.handlers.get("tool_call")![0];
      for (const parentToolCallId of [undefined, "script/1", "script/1/2"]) {
        for (const toolName of ["read", "codemode", "subagent_search", "subagent_git_inspect", "subagent_done"]) {
          assert.equal(await gate({ toolName, parentToolCallId }, h.ctx), undefined);
        }
        for (const toolName of ["write", "edit", "bash", "tool_search", "unregistered"]) {
          const blocked = await gate({ toolName, parentToolCallId }, h.ctx) as any;
          assert.equal(blocked.block, true);
          assert.match(blocked.reason, /not allowed for this subagent run/);
        }
      }
    } finally {
      await h.emit("session_shutdown", { reason: "reload" });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const ceiling of ["read,subagent_done", ""]) {
    it(`does not broaden a saved permission ceiling (${ceiling || "empty"})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "child-saved-permissions-"));
      configureChildEnv({ runId: "saved-policy" });
      process.env.PI_SUBAGENT_TOOLS = ceiling;
      const h = createExtensionHarness(createSessionFile(dir));
      h.tools.set("codemode", { name: "codemode" });
      h.tools.set("read", { name: "read" });
      h.pi.setActiveTools(["read", "codemode"]);
      try {
        await h.emit("session_start");
        await h.emit("before_agent_start");
        const gate = h.handlers.get("tool_call")![0];
        assert.equal((await gate({ toolName: "codemode" }, h.ctx) as any).block, true);
        assert.equal((await gate({ toolName: "codemode", parentToolCallId: "script/1" }, h.ctx) as any).block, true);
        assert.equal(await gate({ toolName: "subagent_done" }, h.ctx), undefined);
        const readResult = await gate({ toolName: "read" }, h.ctx) as any;
        if (ceiling) assert.equal(readResult, undefined);
        else assert.equal(readResult.block, true, "An explicit empty ceiling is not unrestricted");
      } finally {
        await h.emit("session_shutdown", { reason: "reload" });
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
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
  it("keeps settled runs open and refuses explicit handback while children are pending", async () => {
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

  for (const outcome of ["ordinary final reply", "idle pause", "user interrupt", "assistant error"]) {
    it(`does not hand back on ${outcome}, even with the old auto-exit flag`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "child-explicit-handback-"));
      const assistantEntry = {
        type: "message",
        id: "assistant-final",
        parentId: null,
        timestamp: "2026-09-25T12:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "This is an ordinary response, not a delegation result." }],
          stopReason: outcome === "user interrupt" ? "aborted" : outcome === "assistant error" ? "error" : "stop",
        },
      } as SessionEntry;
      const sessionFile = createSessionFile(dir, outcome === "idle pause" ? [] : [assistantEntry]);
      const socketPath = join(dir, "parent.sock");
      const token = "e".repeat(64);
      const runId = "explicit-handback";
      const frames: any[] = [];
      const server = new ParentIpcServer({ socketPath, onMessage(message) {
        frames.push(message);
        if (message.type === "completion") server.send(runId, "completion_ack", { runId });
      } });
      server.registerChild(runId, token);
      await server.start();
      configureChildEnv({ runId, socketPath, token, autoExit: true });
      process.env.PI_SUBAGENT_TOOLS = "read,codemode,subagent_done";
      const h = createExtensionHarness(sessionFile);
      let aborts = 0;
      h.ctx.abort = async () => { aborts++; };
      try {
        await h.emit("session_start");
        await waitFor(() => server.isConnected(runId));
        await h.emit("agent_start");
        if (outcome === "user interrupt") await h.ctx.abort();
        if (outcome !== "idle pause") await h.emit("message_end");
        await h.emit("agent_end");
        await h.emit("agent_settled");
        await waitFor(() => frames.some(frame => frame.type === "settled"));
        assert.equal(aborts, outcome === "user interrupt" ? 1 : 0);
        assert.equal(readRunCompletion(sessionFile, runId), undefined);
        assert.equal(frames.some(frame => frame.type === "completion"), false, "Idle status is not a terminal result");
        assert.equal(h.shutdownCount(), 0, "The visible session must remain available");
        const gate = h.handlers.get("tool_call")![0];
        assert.equal(await gate({ toolName: "read" }, h.ctx), undefined, "The delegation is still active");
        assert.equal(await gate({ toolName: "read", parentToolCallId: "script/1" }, h.ctx), undefined);
        // A later turn may explicitly finish the same delegation after the pause.
        await h.emit("before_agent_start");
        await h.emit("agent_start");
        await h.tools.get("subagent_done").execute("done", { status: "success", summary: "Explicitly handed back" }, undefined, undefined, h.ctx);
        await waitFor(() => h.shutdownCount() === 1);
        assert.equal(readRunCompletion(sessionFile, runId)?.summary, "Explicitly handed back");
        assert.equal(frames.filter(frame => frame.type === "completion").length, 1);
        assert.equal((await gate({ toolName: "read" }, h.ctx) as any).terminate, true);
      } finally {
        await h.emit("session_shutdown", { reason: "quit" });
        await server.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  for (const signal of ["abort", "shutdown"]) {
    it(`keeps deliberate ${signal} separate from structured handback`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "child-cancellation-"));
      const sessionFile = createSessionFile(dir);
      const socketPath = join(dir, "parent.sock");
      const token = "f".repeat(64);
      const runId = "cancelled-child";
      const frames: any[] = [];
      const server = new ParentIpcServer({ socketPath, onMessage(message) { frames.push(message); } });
      server.registerChild(runId, token);
      await server.start();
      configureChildEnv({ runId, socketPath, token, autoExit: true });
      const h = createExtensionHarness(sessionFile);
      let aborts = 0;
      h.ctx.abort = async () => { aborts++; };
      try {
        await h.emit("session_start");
        await waitFor(() => server.isConnected(runId));
        server.send(runId, signal, { runId });
        await waitFor(() => aborts === 1);
        await h.emit("agent_settled");
        await waitFor(() => frames.some(frame => frame.type === "settled"));
        assert.equal(readRunCompletion(sessionFile, runId), undefined);
        assert.equal(frames.some(frame => frame.type === "completion"), false);
        assert.equal(h.shutdownCount(), signal === "shutdown" ? 1 : 0);
        if (signal === "shutdown") assert.ok(frames.some(frame => frame.type === "shutdown_ready"));
      } finally {
        await h.emit("session_shutdown", { reason: "quit" });
        await server.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
