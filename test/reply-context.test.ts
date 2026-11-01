import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { messageToolRenderers } from "../pi-extension/subagents/message-renderers.ts";
import { registerMessageTool } from "../pi-extension/subagents/message-tool.ts";

const theme = { fg: (_colour: string, text: string) => text, bold: (text: string) => text } as any;
const clean = (lines: string[]) => lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).join("\n");
const target = { runId: "run-123456789", replyTo: "question-123", recipientName: "Display demo", question: "Shall I use Compact for the sample label?" };
const args = { runId: target.runId, replyTo: target.replyTo, message: "Use Compact for the sample label." };
const receipt = { content: [{ type: "text", text: "Receipt confirmed (not task completion)." }], details: { ...target, acknowledged: true } } as any;

test("reply cards identify the agent and quote the question before the answer", () => {
  const renderer = messageToolRenderers(false, () => ({ ...target }));
  const context = { state: {}, expanded: false } as any;
  const text = clean(renderer.renderCall!(args, theme, context).render(100));
  assert.match(text, /Reply to Display demo/);
  assert.match(text, /Question: Shall I use Compact for the sample label\?/);
  assert.match(text, /Reply: Use Compact for the sample label\./);
  assert.doesNotMatch(text, /run-123456789|question-123/);
});

test("saved reply metadata restores the heading even when no live child exists", () => {
  const renderer = messageToolRenderers(false);
  const context = { state: {}, expanded: false } as any;
  // Native Pi calls renderCall, then renderResult, then draws the components.
  const call = renderer.renderCall!(args, theme, context);
  const persisted = JSON.parse(JSON.stringify(receipt));
  renderer.renderResult!(persisted, { expanded: false, isPartial: false }, theme, context);
  const text = clean(call.render(100));
  assert.match(text, /Reply to Display demo/);
  assert.match(text, /Question: Shall I use Compact/);
  assert.match(text, /Reply: Use Compact/);
});

test("live identity remains available if the child exits before delivery fails", () => {
  let active = true;
  const renderer = messageToolRenderers(false, (runId, replyTo) => active ? { ...target } : { runId, replyTo });
  const context = { state: {}, expanded: false, isError: true } as any;
  const call = renderer.renderCall!(args, theme, context);
  call.render(100);
  active = false;
  const error = { content: [{ type: "text", text: "Run ended before acknowledgement; delivery uncertain." }], details: undefined } as any;
  const status = clean(renderer.renderResult!(error, { expanded: false, isPartial: false }, theme, context).render(100));
  assert.match(clean(call.render(100)), /Reply to Display demo/);
  assert.match(status, /delivery uncertain/);
  assert.doesNotMatch(status, /Receipt confirmed/);
});

test("legacy receipts do not erase previously resolved identity and question text", () => {
  let active = true;
  const renderer = messageToolRenderers(false, (runId, replyTo) => active ? { ...target } : { runId, replyTo });
  const context = { state: {}, expanded: false } as any;
  const call = renderer.renderCall!(args, theme, context);
  call.render(100);
  active = false;
  renderer.renderResult!({ ...receipt, details: { runId: target.runId, replyTo: target.replyTo, acknowledged: true } }, { expanded: false, isPartial: false }, theme, context);
  assert.match(clean(call.render(100)), /Reply to Display demo/);
  assert.match(clean(call.render(100)), /Question: Shall I use Compact/);
});

test("a different run or question can never supply the quoted context", () => {
  for (const wrong of [{ ...target, runId: "other-run" }, { ...target, replyTo: "other-question" }]) {
    const renderer = messageToolRenderers(false, () => wrong);
    const context = { state: { messageTarget: wrong }, expanded: false } as any;
    const text = clean(renderer.renderCall!(args, theme, context).render(100));
    assert.doesNotMatch(text, /Display demo|Shall I use Compact/);
    assert.match(text, /Question text unavailable/);
    assert.match(text, /Reply to subagent run-1234/);
  }
});

test("ordinary messages show the recipient and message without suggesting a reply", () => {
  const renderer = messageToolRenderers(false, runId => ({ runId, recipientName: "Scout", question: "Unrelated pending question" }));
  const context = { state: {}, expanded: false } as any;
  const text = clean(renderer.renderCall!({ runId: "run", message: "Check the error path." }, theme, context).render(80));
  assert.match(text, /Message Scout\nMessage: Check the error path\./);
  assert.doesNotMatch(text, /Reply:|Question:|Unrelated pending/);
});

test("reply previews stay bounded and expansion preserves full questions, answers and IDs", () => {
  const question = `${"A long question ".repeat(40)}QUESTION-END`;
  const answer = `${"A long answer ".repeat(40)}ANSWER-END`;
  const renderer = messageToolRenderers(false, () => ({ ...target, question }));
  for (const width of [0, 1, 2, 8, 20, 80]) {
    const lines = renderer.renderCall!({ ...args, message: answer }, theme, { state: {}, expanded: false } as any).render(width);
    assert.ok(lines.length <= 5);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.doesNotMatch(clean(lines), /QUESTION-END|ANSWER-END/);
  }
  const full = clean(renderer.renderCall!({ ...args, message: answer }, theme, { state: {}, expanded: true } as any).render(100));
  for (const text of ["QUESTION-END", "ANSWER-END", "Run: run-123456789", "Reply to: question-123"]) assert.ok(full.includes(text));
  assert.doesNotThrow(() => renderer.renderCall!({}, theme, {} as any).render(8));
});

test("the tool captures context before receipt clears the question, without changing its model-facing text", async () => {
  let tool: any;
  const calls: any[] = [];
  let current = { ...target };
  const pi = { registerTool: (registered: any) => { tool = registered; } } as any;
  const controller = {
    getMessageContext(runId: string, replyTo?: string) {
      assert.equal(runId, target.runId);
      assert.equal(replyTo, target.replyTo);
      return { ...current };
    },
    async sendToChild(...values: any[]) {
      calls.push(values);
      current = { ...current, question: undefined as any };
    },
  } as any;
  registerMessageTool(pi, controller, () => true);
  const result = await tool.execute("call", args);
  assert.deepEqual(calls, [[args.runId, args.message, args.replyTo]]);
  assert.deepEqual(result.details, { ...target, acknowledged: true });
  assert.equal(result.content[0].text, `Child run ${args.runId} acknowledged receipt of the parent message (not task completion).`);
});
