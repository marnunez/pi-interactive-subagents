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
function harness(entries: any[] = [], sessionId = crypto.randomUUID(), deniedTools = "") {
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
  // Model the synthetic parent's policy, not whichever worker launches the test
  // process. Registration samples the policy synchronously; restore it before
  // running any hooks so this fixture never relaxes its caller's restrictions.
  const inheritedDenials = process.env.PI_DENY_TOOLS;
  try {
    process.env.PI_DENY_TOOLS = deniedTools;
    extension(pi as any);
  } finally {
    if (inheritedDenials === undefined) delete process.env.PI_DENY_TOOLS;
    else process.env.PI_DENY_TOOLS = inheritedDenials;
  }
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

test("parent fixture isolates and restores an ambient worker tool policy", () => {
  const previous = process.env.PI_DENY_TOOLS;
  const workerPolicy = "subagent,subagent_resume,subagents_list,subagent_kill";
  try {
    process.env.PI_DENY_TOOLS = workerPolicy;
    const h = harness();
    for (const name of workerPolicy.split(",")) assert.ok(h.tools.has(name), name);
    assert.equal(process.env.PI_DENY_TOOLS, workerPolicy);
  } finally {
    if (previous === undefined) delete process.env.PI_DENY_TOOLS;
    else process.env.PI_DENY_TOOLS = previous;
  }
});

test("named-agent guidance uses the live catalogue rather than suggesting bundled roles", () => {
  const { tools } = harness();
  const subagent = tools.get("subagent");
  assert.match(subagent.parameters.properties.agent.description, /subagents_list/);
  assert.doesNotMatch(subagent.parameters.properties.agent.description, /worker, scout/);
  assert.ok(subagent.promptGuidelines.some((guideline: string) => guideline.includes("subagents_list")));
});

test("an explicitly restricted parent still does not register denied tools", () => {
  const policy = "subagent,subagent_resume,subagents_list,subagent_kill";
  const h = harness([], crypto.randomUUID(), policy);
  for (const name of policy.split(",")) assert.equal(h.tools.has(name), false, name);
});

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

test("mid-task message requires an exact owned run and its matching acknowledgement", async () => {
  const a = childRun();
  const b = childRun();
  const parent = harness(a.entries);
  const otherParent = harness(b.entries);
  await parent.emit("session_start");
  await otherParent.emit("session_start");
  const delivered: any[] = [];
  let welcomed = false;
  const child = new ChildIpcClient({
    socketPath: getIpcSocketPath(parent.sessionId), childId: a.run.id, token: a.run.ipcToken,
    helloPayload: () => ({}),
    onMessage: (frame) => {
      if (frame.type === "welcome") welcomed = true;
      if (frame.type === "parent_message") delivered.push(frame.payload);
    },
  });
  child.start();
  cleanups.push(() => child.stop());
  await until(() => welcomed);
  await assert.rejects(() => otherParent.tools.get("subagent_message").execute("x", { runId: a.run.id, message: "wrong parent" }), /No connected, active child/);
  await assert.rejects(() => parent.tools.get("subagent_message").execute("x", { runId: b.run.id, message: "wrong run" }), /No connected, active child/);
  const call = parent.tools.get("subagent_message").execute("x", { runId: a.run.id, message: "Check edge case" });
  await until(() => delivered.length > 0);
  const first = delivered[0];
  assert.equal(first.runId, a.run.id);
  assert.equal(first.text, "Check edge case");
  child.send("parent_message_ack", { runId: b.run.id, messageId: first.messageId });
  child.send("parent_message_ack", { runId: a.run.id, messageId: "wrong-id" });
  await until(() => delivered.length >= 2);
  assert.equal(delivered[1].messageId, first.messageId);
  child.send("parent_message_ack", { runId: a.run.id, messageId: first.messageId });
  const result = await call;
  assert.equal(result.details.acknowledged, true);
  assert.equal(result.details.runId, a.run.id);
});

test("message retries across a brief disconnect, and fails when the addressed run ends", async () => {
  const { run, entries } = childRun();
  const h = harness(entries);
  await h.emit("session_start");
  let welcomed = false;
  let firstMessage: any;
  const child = new ChildIpcClient({
    socketPath: getIpcSocketPath(h.sessionId), childId: run.id, token: run.ipcToken,
    helloPayload: () => ({}),
    onMessage: (frame) => {
      if (frame.type === "welcome") welcomed = true;
      if (frame.type === "parent_message") firstMessage = frame.payload;
    },
  });
  child.start();
  cleanups.push(() => child.stop());
  await until(() => welcomed);
  const pending = h.tools.get("subagent_message").execute("x", { runId: run.id, message: "retry me" });
  await until(() => !!firstMessage);
  child.stop();
  await new Promise((resolve) => setTimeout(resolve, 25));
  welcomed = false;
  const replay: any[] = [];
  let acknowledge = true;
  const reconnected = new ChildIpcClient({
    socketPath: getIpcSocketPath(h.sessionId), childId: run.id, token: run.ipcToken,
    helloPayload: () => ({}),
    onMessage: (frame) => {
      if (frame.type === "welcome") welcomed = true;
      if (frame.type === "parent_message") {
        replay.push(frame.payload);
        if (acknowledge) reconnected.send("parent_message_ack", { runId: run.id, messageId: frame.payload.messageId });
      }
    },
  });
  reconnected.start();
  cleanups.push(() => reconnected.stop());
  await pending;
  assert.equal(replay[0].messageId, firstMessage.messageId);
  acknowledge = false;
  const next = h.tools.get("subagent_message").execute("y", { runId: run.id, message: "cancel me" });
  // Attach a rejection handler before cancelling, so the rejected promise is observed.
  const failed = assert.rejects(next, /run ended before delivery acknowledgement/);
  await until(() => replay.length >= 2);
  await h.tools.get("subagent_kill").execute("kill", { target: run.id });
  await failed;
  await assert.rejects(() => h.tools.get("subagent_message").execute("z", { runId: run.id, message: "too late" }), /No connected, active child/);
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
