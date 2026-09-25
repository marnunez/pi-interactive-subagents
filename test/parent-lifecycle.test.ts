import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import extension, { __test__ } from "../pi-extension/subagents/index.ts";
import { ChildIpcClient, getIpcSocketPath } from "../pi-extension/subagents/ipc.ts";
import { createSubagentSession, SUBAGENT_DONE_RESULT_TYPE } from "../pi-extension/subagents/session.ts";
import { restoreRunLedger, LAUNCH_ENTRY, FINISH_ENTRY } from "../pi-extension/subagents/run-ledger.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(predicate: () => boolean) {
  const end = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out waiting for test IPC");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function harness(entries: any[] = [], sessionId = crypto.randomUUID()) {
  const hooks = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const messages: any[] = [];
  const events = new EventEmitter();
  const pi = {
    on: (name: string, hook: Function) => hooks.set(name, [...(hooks.get(name) ?? []), hook]),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand() {}, registerMessageRenderer() {},
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    sendMessage: (message: any) => { messages.push(message); entries.push({ type: "custom_message", ...message }); },
    getAllTools: () => [], getActiveTools: () => [], events: {
      emit: (name: string, data: unknown) => { events.emit(name, data); },
      on: (name: string, fn: (...args: any[]) => void) => { events.on(name, fn); return () => { events.off(name, fn); }; },
    },
  };
  const ctx = {
    cwd: tmpdir(), hasUI: false, isProjectTrusted: () => true,
    ui: { notify() {} },
    sessionManager: { getEntries: () => entries, getBranch: () => entries, getSessionId: () => sessionId },
  };
  extension(pi as any);
  const emit = async (event: string, payload: any = {}) => {
    for (const hook of hooks.get(event) ?? []) await hook(payload, ctx);
  };
  cleanups.push(() => emit("session_shutdown", { reason: "reload" }));
  return { entries, tools, messages, emit, sessionId, ctx, events };
}
function childRun() {
  const dir = mkdtempSync(join(tmpdir(), "pi-run-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const runId = crypto.randomUUID();
  const created = createSubagentSession({ sessionDir: dir, cwd: dir, parentSessionId: "parent", parentSessionFile: join(dir, "parent.jsonl"), runId, name: "test", mode: "fresh", task: "test" });
  const run = { id: runId, runId, childSessionId: created.childSessionId, mode: "fresh", name: "test", task: "test", surface: "", startTime: Date.now(), sessionFile: created.sessionFile, ipcToken: "test-token", autoExit: false };
  return { run, entries: [{ type: "custom", customType: LAUNCH_ENTRY, data: run }] as any[], result: { schemaVersion: 1, runId, status: "success", summary: "done", completedAt: new Date().toISOString() } };
}
function connect(h: ReturnType<typeof harness>, run: any, received: string[] = []) {
  const client = new ChildIpcClient({ socketPath: getIpcSocketPath(h.sessionId), childId: run.id, token: run.ipcToken, helloPayload: () => ({ sessionFile: run.sessionFile }), onMessage: (m) => received.push(m.type) });
  client.start();
  cleanups.push(() => client.stop());
  return client;
}

test("nested child processes start their own orchestration socket", async () => {
  const previous = process.env.PI_SUBAGENT_ID;
  process.env.PI_SUBAGENT_ID = "outer-run";
  cleanups.push(() => { if (previous === undefined) delete process.env.PI_SUBAGENT_ID; else process.env.PI_SUBAGENT_ID = previous; });
  const { run, entries } = childRun();
  const h = harness(entries);
  await h.emit("session_start");
  const received: string[] = [];
  connect(h, run, received);
  await until(() => received.includes("welcome"));
  await h.emit("session_shutdown", { reason: "reload" });
  await h.emit("session_start", { reason: "reload" });
  let count = -1;
  h.events.on("subagent:children", (value) => { count = value; });
  h.events.emit("subagent:children-query");
  assert.equal(count, 1);
  assert.equal(h.events.listenerCount("subagent:drain"), 1);
});

test("completion is journalled once before ack and duplicate frames do not duplicate delivery", async () => {
  const { run, entries, result } = childRun();
  const h = harness(entries);
  await h.emit("session_start");
  const received: string[] = [];
  const client = connect(h, run, received);
  await until(() => received.includes("welcome"));
  client.send("completion", result);
  await until(() => received.includes("completion_ack"));
  assert.equal(h.entries.filter((e) => e.customType === FINISH_ENTRY).length, 1);
  assert.equal(h.messages.length, 1);
  client.send("completion", result);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.messages.length, 1);
});

test("reload recovers a persisted child completion whose IPC message was lost", async () => {
  const { run, entries, result } = childRun();
  appendFileSync(run.sessionFile, JSON.stringify({ type: "custom", id: "done", customType: SUBAGENT_DONE_RESULT_TYPE, data: result }) + "\n");
  const h = harness(entries);
  await h.emit("session_start", { reason: "reload" });
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].details.result.runId, run.runId);
  assert.equal(restoreRunLedger(h.entries).unresolved.length, 0);
});

test("intentional shutdown durably cancels runs so reopen does not resurrect them", async () => {
  const { entries } = childRun();
  const h = harness(entries);
  await h.emit("session_start");
  await h.emit("session_shutdown", { reason: "quit" });
  assert.equal(restoreRunLedger(entries).unresolved.length, 0);
  assert.equal(entries.find((e) => e.customType === FINISH_ENTRY)?.data.result.protocolStatus, "cancelled");
  assert.equal(h.messages.length, 0);
  await h.emit("session_start", { reason: "resume" });
  assert.equal(h.messages.length, 0);
});

test("parent shutdown waits for explicit subtree-drained acknowledgement", async () => {
  const { run, entries } = childRun();
  const h = harness(entries);
  await h.emit("session_start");
  let connected = false;
  let drained = false;
  const client = new ChildIpcClient({
    socketPath: getIpcSocketPath(h.sessionId), childId: run.id, token: run.ipcToken,
    helloPayload: () => ({}),
    onMessage: (message) => {
      if (message.type === "welcome") connected = true;
      if (message.type === "shutdown") setTimeout(() => {
        drained = true;
        client.send("shutdown_ready", { runId: run.id });
      }, 80);
    },
  });
  client.start();
  cleanups.push(() => client.stop());
  await until(() => connected);
  await h.emit("session_shutdown", { reason: "quit" });
  assert.equal(drained, true);
  assert.equal(restoreRunLedger(entries).unresolved.length, 0);
});

test("kill uses the same durable terminal path", async () => {
  const { run, entries } = childRun();
  const h = harness(entries);
  await h.emit("session_start");
  await h.tools.get("subagent_kill").execute("call", { target: run.id });
  assert.equal(restoreRunLedger(entries).unresolved.length, 0);
  assert.equal(entries.find((e) => e.customType === FINISH_ENTRY)?.data.result.protocolStatus, "cancelled");
});

test("cancellation retries on reconnect rather than instantly killing a disconnected subtree", async () => {
  const { run, entries } = childRun();
  const h = harness(entries);
  await h.emit("session_start");
  await h.tools.get("subagent_kill").execute("call", { target: run.id });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(entries.some((e) => e.customType === "subagent_ipc_closed"), false);
  let requestedShutdown = false;
  const client = new ChildIpcClient({
    socketPath: getIpcSocketPath(h.sessionId), childId: run.id, token: run.ipcToken,
    helloPayload: () => ({}),
    onMessage: (message) => {
      if (message.type === "shutdown") {
        requestedShutdown = true;
        client.send("shutdown_ready", { runId: run.id });
      }
    },
  });
  client.start();
  cleanups.push(() => client.stop());
  await until(() => entries.some((e) => e.customType === "subagent_ipc_closed"));
  assert.equal(requestedShutdown, true);
});

test("outbox replays committed-but-undelivered results, not delivered results", () => {
  const result = { runId: "r", id: "r" };
  const entries: any[] = [{ type: "custom", customType: FINISH_ENTRY, data: { runId: "r", result } }];
  assert.deepEqual(restoreRunLedger(entries).pendingResults, [result]);
  entries.push({ type: "custom_message", customType: "subagent_result", details: result });
  assert.deepEqual(restoreRunLedger(entries).pendingResults, []);
});

test("fork inherits conversation but never parent's run ledger", () => {
  const time = new Date().toISOString();
  const branch = [
    { type: "message", id: "a", parentId: null, timestamp: time, message: { role: "user" } },
    { type: "custom", id: "b", parentId: "a", timestamp: time, customType: LAUNCH_ENTRY },
    { type: "message", id: "c", parentId: "b", timestamp: time, message: { role: "assistant" } },
    { type: "message", id: "d", parentId: "c", timestamp: time, message: { role: "user" } },
  ];
  const copied = __test__.forkConversation(branch);
  assert.deepEqual(copied.map((e) => e.id), ["a", "c"]);
  assert.equal(copied[1].parentId, "a");
});
