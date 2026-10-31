import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { messageToolRenderers, registerChildMessageRenderer, registerParentMessageRenderer } from "../pi-extension/subagents/message-renderers.ts";
import { ChildParentMessages } from "../pi-extension/subagents/parent-messages.ts";
import { registerMessageTool } from "../pi-extension/subagents/message-tool.ts";

initTheme("dark", false);
const clean = (lines: string[]) => lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).join("\n");
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
function fixture() {
  const renderers = new Map<string, any>();
  const pi = { registerMessageRenderer: (type: string, renderer: any) => renderers.set(type, renderer) } as any;
  registerChildMessageRenderer(pi);
  registerParentMessageRenderer(pi);
  const render = (type: string, details: any, expanded = false, width = 80) => {
    const message = { content: "MODEL-ONLY routing and authority instructions", details };
    const before = JSON.stringify(message);
    const component = renderers.get(type)(message, { expanded }, theme);
    const lines = component?.render(width);
    assert.equal(JSON.stringify(message), before, "Rendering must not change model context");
    for (const line of lines ?? []) assert.ok(visibleWidth(line) <= width, `Line exceeds ${width} columns: ${line}`);
    return lines ? clean(lines) : undefined;
  };
  return { render, renderers };
}
const question = { name: "Scout", text: "Which API should I use?", waitForReply: true, runId: "run-123", messageId: "msg-456" };

test("child questions and updates use readable headings without protocol text or IDs", () => {
  const { render } = fixture();
  const text = render("subagent_child_message", question)!;
  assert.match(text, /Subagent Scout.*Question for parent/);
  assert.match(text, /Which API should I use\?/);
  assert.doesNotMatch(text, /subagent_child_message|run-123|msg-456|MODEL-ONLY|replyTo/);
  assert.match(render("subagent_child_message", { ...question, waitForReply: false })!, /— Update/);
});

test("parent replies and advisories retain their agent provenance", () => {
  const { render } = fixture();
  const reply = { text: "Use v2.", runId: "run-123", messageId: "answer", replyTo: "msg-456" };
  assert.match(render("subagent_parent_message", reply)!, /Parent agent.*Reply\nUse v2/);
  assert.match(render("subagent_parent_message", { ...reply, replyTo: undefined })!, /Parent agent.*Update/);
  const expanded = render("subagent_parent_message", reply, true)!;
  assert.match(expanded, /not user approval/);
  assert.match(expanded, /Reply to: msg-456/);
});

test("long and wide messages wrap with bounded previews; expansion preserves the full text", () => {
  const { render } = fixture();
  const details = { ...question, text: `界 café ${"a long message ".repeat(60)}\nFINAL-LINE` };
  for (const width of [1, 2, 8, 20, 80]) {
    const compact = render("subagent_child_message", details, false, width)!;
    assert.ok(compact.split("\n").length <= 5);
    assert.doesNotMatch(compact, /FINAL-LINE/);
    render("subagent_child_message", details, true, width);
  }
  const expanded = render("subagent_child_message", details, true)!;
  assert.match(expanded, /FINAL-LINE/);
  assert.match(expanded, /Run: run-123/);
  assert.equal(render("subagent_child_message", details, true, 0), "");
});

test("old or malformed entries fall back rather than hiding original content", () => {
  const { render } = fixture();
  for (const details of [undefined, {}, { text: 42 }]) assert.equal(render("subagent_child_message", details), undefined);
});

test("messaging tool calls are compact, expandable, and tolerate partial arguments", () => {
  for (const toParent of [true, false]) {
    const renderer = messageToolRenderers(toParent);
    const args = { message: "First line\nSecond line", runId: "private-run-id", waitForReply: true, replyTo: "private-message-id" };
    const compact = renderer.renderCall!(args, theme, { expanded: false } as any).render(45).join("\n");
    assert.match(compact, toParent ? /Ask parent/ : /Reply to subagent/);
    assert.doesNotMatch(compact, /private-/);
    assert.equal(compact.split("\n").length, 1);
    assert.match(renderer.renderCall!(args, theme, { expanded: true } as any).render(80).map(line => line.trimEnd()).join("\n"), /First line\nSecond line/);
    assert.doesNotThrow(() => renderer.renderCall!({}, theme, {} as any).render(10));
  }
});

test("receipts are distinct from answers/completion, and errors never render as success", () => {
  const result = { content: [{ type: "text", text: "Detailed receipt with run-123" }], details: { acknowledged: true, waitingForReply: true } } as any;
  for (const toParent of [true, false]) {
    const renderer = messageToolRenderers(toParent);
    const render = (value: any, options: any = {}, context: any = {}) => clean(renderer.renderResult!(value, options, theme, context).render(100));
    assert.match(render(result), toParent ? /awaiting parent reply/ : /not task completion/);
    assert.doesNotMatch(render(result), /run-123/);
    assert.match(render(result, { expanded: true }), /run-123/);
    assert.equal(render(result, { isPartial: true }), "Sending…");
    const error = { content: [{ type: "text", text: "Delivery timed out; uncertain." }], details: { acknowledged: false } };
    assert.match(render(error), /timed out; uncertain/);
    assert.match(render({ ...error, details: undefined }, {}, { isError: true }), /timed out/);
    assert.doesNotMatch(render({ ...error, isError: true, details: { acknowledged: true } }), /Receipt confirmed/);
    assert.equal(render({ content: [{ type: "text", text: "Legacy response" }] }), "Legacy response");
  }
});

test("both actual messaging tools register the presentation without changing delivery", () => {
  const tools = new Map<string, any>();
  const pi = { registerTool: (tool: any) => tools.set(tool.name, tool) } as any;
  new ChildParentMessages(pi, "run", () => {}, () => true).register();
  registerMessageTool(pi, {} as any, () => true);
  for (const name of ["message_parent", "subagent_message"]) {
    assert.equal(typeof tools.get(name).renderCall, "function");
    assert.equal(typeof tools.get(name).renderResult, "function");
  }
});
