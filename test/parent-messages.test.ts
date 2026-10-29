import { test } from "node:test";
import assert from "node:assert/strict";
import { ChildParentMessages, CHILD_MESSAGE_SENT, CHILD_MESSAGE_RECEIVED, PARENT_REQUEST_RESOLVED,
  isChildMessage, isParentMessage, restoreParentMailbox } from "../pi-extension/subagents/parent-messages.ts";

function fixture(entries: any[] = []) {
  const messages: any[] = [], frames: any[] = [], tools = new Map<string, any>();
  let active = true;
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    sendMessage: (message: any, options: any) => messages.push({ message, options }),
  };
  let autoAck = true;
  const mailbox = new ChildParentMessages(pi as any, "run", (type, payload: any) => {
    frames.push({ type, payload });
    if (type === "child_message" && autoAck) queueMicrotask(() => mailbox.acknowledge(payload));
  }, () => active);
  mailbox.register();
  mailbox.start(entries);
  const send = (params: any, signal?: AbortSignal) => tools.get("message_parent").execute("call", params, signal);
  return { mailbox, entries, messages, frames, tools, send, deactivate: () => { active = false; }, noAck: () => { autoAck = false; } };
}

test("advisories continue and questions pause without completing a run; receipt is not an answer", async () => {
  const h = fixture();
  try {
    assert.equal(h.tools.get("message_parent").exposure, "model-only");
    assert.equal((await h.send({ message: "Finding" })).terminate, false);
    const result = await h.send({ message: "Which API?", waitForReply: true });
    assert.equal(result.details.acknowledged, true);
    assert.equal(result.terminate, true);
    assert.equal(h.mailbox.waitingForReply, result.details.messageId);
    assert.equal(h.mailbox.receive({ runId: "old", messageId: "old", text: "Wrong run", replyTo: result.details.messageId }), false);
    assert.equal(h.mailbox.receive({ runId: "run", messageId: "wrong", text: "Wrong question", replyTo: "unknown" }), false);
    assert.equal(h.mailbox.receive({ runId: "run", messageId: "advice", text: "Other information" }), true);
    assert.equal(h.messages.at(-1).options.triggerTurn, false);
    assert.equal(h.mailbox.waitingForReply, result.details.messageId);
    const reply = { runId: "run", messageId: "reply", text: "Use v2", replyTo: result.details.messageId };
    assert.equal(h.mailbox.receive(reply), true);
    assert.equal(h.mailbox.waitingForReply, undefined);
    assert.equal(h.messages.at(-1).options.triggerTurn, true);
    assert.match(h.messages.at(-1).message.content, /not user approval/);
    assert.equal(h.mailbox.receive(reply), true);
    assert.equal(h.messages.length, 2, "Retry must not dispatch twice");
    assert.equal(h.mailbox.receive({ ...reply, text: "Conflicting retry" }), false);
    assert.equal(h.entries.some(e => e.customType === "subagent_done_result"), false);
  } finally { h.mailbox.stop(); }
});

test("child reload restores pending clarification and deduplicates persisted parent replies", async () => {
  const h = fixture();
  const question = await h.send({ message: "Which path?", waitForReply: true });
  h.mailbox.stop();
  const reloaded = fixture(h.entries);
  try {
    assert.equal(reloaded.mailbox.waitingForReply, question.details.messageId);
    const reply = { runId: "run", messageId: "answer", text: "src/", replyTo: question.details.messageId };
    reloaded.mailbox.receive(reply);
    reloaded.mailbox.stop();
    // The advisory was queued, not yet written as a custom_message: replay it.
    const replay = fixture(h.entries);
    assert.equal(replay.messages.length, 1);
    assert.equal(replay.mailbox.waitingForReply, undefined);
    replay.mailbox.stop();
    h.entries.push({ type: "custom_message", customType: "subagent_parent_message", details: reply });
    const settled = fixture(h.entries);
    assert.equal(settled.messages.length, 0);
    assert.equal(settled.mailbox.receive(reply), true);
    assert.equal(settled.messages.length, 0);
    settled.mailbox.reconnect();
    assert.ok(settled.frames.some(f => f.type === "parent_request_resolved" && f.payload.messageId === question.details.messageId));
    settled.mailbox.stop();
  } finally { reloaded.mailbox.stop(); }
});

test("reply arriving before the receipt acknowledgement does not leave a stale pause", async () => {
  const h = fixture();
  h.noAck();
  try {
    const call = h.send({ message: "Choose", waitForReply: true });
    const payload = h.frames.at(-1).payload;
    h.mailbox.receive({ runId: "run", messageId: "fast-answer", text: "A", replyTo: payload.messageId });
    h.mailbox.acknowledge(payload);
    assert.equal((await call).terminate, false);
    assert.equal(h.mailbox.waitingForReply, undefined);
  } finally { h.mailbox.stop(); }
});

test("interrupted delivery reports uncertainty without losing the pending question, and replays on reload", async () => {
  const h = fixture();
  h.noAck();
  const abort = new AbortController();
  const call = h.send({ message: "Question", waitForReply: true }, abort.signal);
  abort.abort();
  const result = await call;
  assert.equal(result.isError, true);
  assert.equal(result.terminate, true);
  assert.equal(result.details.acknowledged, false);
  h.mailbox.stop();
  const next = fixture(h.entries);
  try {
    assert.equal(next.frames[0].type, "child_message");
    assert.equal(next.frames[0].payload.messageId, result.details.messageId);
    await new Promise<void>(resolve => queueMicrotask(resolve));
    assert.equal(next.mailbox.waitingForReply, result.details.messageId);
  } finally { next.mailbox.stop(); }
});

test("delivery timeout is bounded and does not silently release a clarification", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = fixture(); h.noAck();
  try {
    const call = h.send({ message: "Question", waitForReply: true });
    t.mock.timers.tick(10_000);
    const result = await call;
    assert.equal(result.isError, true);
    assert.equal(result.details.acknowledged, false);
    assert.equal(result.terminate, true);
    assert.equal(h.mailbox.waitingForReply, result.details.messageId);
  } finally { h.mailbox.stop(); }
});

test("validation and lifecycle guards refuse malformed, duplicate outstanding and inactive messages", async () => {
  const h = fixture();
  try {
    for (const params of [{ message: " " }, { message: "a".repeat(16001) }, { message: "x", waitForReply: "true" }]) {
      await assert.rejects(() => h.send(params), /Message must contain/);
    }
    await h.send({ message: "Question", waitForReply: true });
    await assert.rejects(() => h.send({ message: "Another" }), /Already waiting/);
    h.deactivate();
    await assert.rejects(() => h.send({ message: "Ended" }), /active child run/);
    const valid = { runId: "run", messageId: "id", text: "x", waitForReply: false };
    for (const patch of [{ runId: undefined }, { messageId: "x".repeat(101) }, { messageId: "../id" }, { text: "" }, { waitForReply: 1 }]) {
      assert.equal(isChildMessage({ ...valid, ...patch }, "run"), false);
    }
    assert.equal(isParentMessage({ runId: "run", messageId: "id", text: "x", replyTo: "" }, "run"), false);
  } finally { h.mailbox.stop(); }
});

test("parent inbox reconstruction separates model delivery and resolution from receipt", () => {
  const question = { runId: "run", messageId: "q", text: "Question", waitForReply: true, name: "Child" };
  const entries: any[] = [{ type: "custom", customType: CHILD_MESSAGE_RECEIVED, data: question }];
  let inbox = restoreParentMailbox(entries);
  assert.equal(inbox.questions.get("run"), "q");
  assert.equal(inbox.received.size, 1);
  assert.equal(inbox.delivered.size, 0);
  entries.push({ type: "custom_message", customType: "subagent_child_message", details: question });
  entries.push({ type: "custom", customType: PARENT_REQUEST_RESOLVED, data: { runId: "run", messageId: "wrong" } });
  assert.equal(restoreParentMailbox(entries).questions.get("run"), "q");
  entries.push({ type: "custom", customType: PARENT_REQUEST_RESOLVED, data: { runId: "run", messageId: "q" } });
  inbox = restoreParentMailbox(entries);
  assert.equal(inbox.questions.size, 0);
  assert.equal(inbox.delivered.size, 1);
  assert.equal(CHILD_MESSAGE_SENT, "subagent_child_message_sent");
});
