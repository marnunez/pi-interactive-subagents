import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { messageToolRenderers } from "./message-renderers.ts";

export const CHILD_MESSAGE_SENT = "subagent_child_message_sent";
export const CHILD_MESSAGE_RECEIVED = "subagent_child_message_received";
export const CHILD_MESSAGE_ACK = "subagent_child_message_ack";
export const PARENT_MESSAGE_RECEIVED = "subagent_parent_message_received";
export const PARENT_REQUEST_RESOLVED = "subagent_parent_request_resolved";
export const MAX_MESSAGE_CHARS = 16_000;

export interface ChildMessage {
  runId: string;
  messageId: string;
  text: string;
  waitForReply: boolean;
}
export interface ParentMessage {
  runId: string;
  messageId: string;
  text: string;
  replyTo?: string;
}
export interface MessageEntry {
  type: string;
  customType?: string;
  data?: any;
  details?: any;
}
export function validMessageId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
}
export function validMessageText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_MESSAGE_CHARS && !!value.trim();
}
export function isChildMessage(value: any, runId: string): value is ChildMessage {
  return validMessageId(runId) && value?.runId === runId && validMessageId(value.messageId)
    && validMessageText(value.text) && typeof value.waitForReply === "boolean";
}
export function isParentMessage(value: any, runId: string): value is ParentMessage {
  return validMessageId(runId) && value?.runId === runId && validMessageId(value.messageId)
    && validMessageText(value.text) && (value.replyTo === undefined || validMessageId(value.replyTo));
}
export function messageKey(runId: string, messageId: string): string {
  return JSON.stringify([runId, messageId]);
}

/** A journaled inbox/outbox. Custom messages may still be queued when /reload occurs. */
export function restoreParentMailbox(entries: readonly MessageEntry[]) {
  const received = new Map<string, ChildMessage & { name: string }>();
  const delivered = new Set<string>();
  const questions = new Map<string, string>();
  for (const entry of entries) {
    const data = entry.data;
    const name = data?.name;
    if (entry.type === "custom" && entry.customType === CHILD_MESSAGE_RECEIVED
        && isChildMessage(data, data?.runId) && typeof name === "string") {
      received.set(messageKey(data.runId, data.messageId), { ...data, name });
      if (data.waitForReply) questions.set(data.runId, data.messageId);
    }
    if (entry.type === "custom" && entry.customType === PARENT_REQUEST_RESOLVED
        && questions.get(data?.runId) === data?.messageId) questions.delete(data.runId);
    if (entry.type === "custom_message" && entry.customType === "subagent_child_message") {
      const details = entry.details;
      if (typeof details?.runId === "string" && validMessageId(details.messageId)) {
        delivered.add(messageKey(details.runId, details.messageId));
      }
    }
  }
  return { received, delivered, questions };
}

/** Child side: delivery acknowledgement is separate from the eventual answer. */
export class ChildParentMessages {
  private sent = new Map<string, ChildMessage>();
  private acknowledged = new Set<string>();
  private parentMessages = new Map<string, ParentMessage>();
  private dispatchedParentMessages = new Set<string>();
  private pending = new Map<string, { stop: (acknowledged: boolean) => void }>();
  waitingForReply: string | undefined;

  private pi: ExtensionAPI;
  readonly runId: string;
  private send: (type: string, payload: unknown) => void;
  private active: () => boolean;

  constructor(pi: ExtensionAPI, runId: string,
    send: (type: string, payload: unknown) => void, active: () => boolean) {
    this.pi = pi;
    this.runId = runId;
    this.send = send;
    this.active = active;
  }

  start(entries: readonly MessageEntry[]): void {
    this.stop();
    this.sent.clear();
    this.acknowledged.clear();
    this.parentMessages.clear();
    this.dispatchedParentMessages.clear();
    this.waitingForReply = undefined;
    const delivered = new Set<string>();
    for (const entry of entries) {
      const data = entry.data;
      if (entry.type === "custom" && entry.customType === CHILD_MESSAGE_SENT && isChildMessage(data, this.runId)) {
        this.sent.set(data.messageId, data);
        if (data.waitForReply) this.waitingForReply = data.messageId;
      }
      if (entry.type === "custom" && entry.customType === CHILD_MESSAGE_ACK && data?.runId === this.runId) {
        this.acknowledged.add(data.messageId);
      }
      if (entry.type === "custom" && entry.customType === PARENT_MESSAGE_RECEIVED && isParentMessage(data, this.runId)) {
        this.parentMessages.set(data.messageId, data);
        if (data.replyTo === this.waitingForReply) this.waitingForReply = undefined;
      }
      if (entry.type === "custom_message" && entry.customType === "subagent_parent_message" && entry.details?.runId === this.runId) {
        delivered.add(entry.details.messageId);
      }
    }
    this.dispatchedParentMessages = delivered;
    for (const message of this.parentMessages.values()) this.deliverParentMessage(message);
    for (const message of this.sent.values()) {
      if (!this.acknowledged.has(message.messageId)) void this.beginDelivery(message);
    }
  }

  reconnect(): void {
    if (!this.active()) return;
    for (const message of this.sent.values()) {
      if (!this.acknowledged.has(message.messageId)) this.send("child_message", message);
    }
    for (const message of this.parentMessages.values()) {
      if (message.replyTo) this.send("parent_request_resolved", { runId: this.runId, messageId: message.replyTo });
    }
  }

  acknowledge(payload: any): void {
    if (payload?.runId !== this.runId || !this.sent.has(payload.messageId)) return;
    if (!this.acknowledged.has(payload.messageId)) {
      this.pi.appendEntry(CHILD_MESSAGE_ACK, { runId: this.runId, messageId: payload.messageId });
      this.acknowledged.add(payload.messageId);
    }
    this.pending.get(payload.messageId)?.stop(true);
  }

  receive(payload: unknown): boolean {
    if (!this.active() || !isParentMessage(payload, this.runId)) return false;
    const previous = this.parentMessages.get(payload.messageId);
    if (previous) {
      if (previous.text !== payload.text || previous.replyTo !== payload.replyTo) return false;
    } else {
      // A stale/mismatched answer is never silently treated as a new advisory.
      if (payload.replyTo !== undefined && payload.replyTo !== this.waitingForReply) return false;
      const accepted: ParentMessage = { runId: this.runId, messageId: payload.messageId, text: payload.text,
        ...(payload.replyTo ? { replyTo: payload.replyTo } : {}) };
      this.pi.appendEntry(PARENT_MESSAGE_RECEIVED, accepted);
      this.parentMessages.set(payload.messageId, accepted);
      if (payload.replyTo !== undefined) this.waitingForReply = undefined;
    }
    this.deliverParentMessage(this.parentMessages.get(payload.messageId)!);
    this.send("parent_message_ack", { runId: this.runId, messageId: payload.messageId });
    if (payload.replyTo) this.send("parent_request_resolved", { runId: this.runId, messageId: payload.replyTo });
    return true;
  }

  private deliverParentMessage(message: ParentMessage): void {
    if (this.dispatchedParentMessages.has(message.messageId)) return;
    this.pi.sendMessage({
      customType: "subagent_parent_message",
      content: `[Message from parent agent, not the user; this is not user approval]\n${message.text}`,
      display: true,
      details: message,
    }, { triggerTurn: !this.waitingForReply, deliverAs: "steer" });
    this.dispatchedParentMessages.add(message.messageId);
  }

  private beginDelivery(message: ChildMessage, signal?: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
      const stop = (acknowledged: boolean) => {
        clearInterval(retry);
        clearTimeout(deadline);
        signal?.removeEventListener("abort", aborted);
        this.pending.delete(message.messageId);
        resolve(acknowledged);
      };
      const aborted = () => stop(false);
      const retrySend = () => {
        if (this.active()) this.send("child_message", message);
      };
      const retry = setInterval(retrySend, 250);
      const deadline = setTimeout(() => stop(false), 10_000);
      this.pending.set(message.messageId, { stop });
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) stop(false);
      else retrySend();
    });
  }

  stop(): void {
    for (const pending of [...this.pending.values()]) pending.stop(false);
  }

  register(): void {
    const tool = {
      name: "message_parent",
      label: "Message Parent",
      ...messageToolRenderers(true),
      exposure: "model-only",
      executionMode: "sequential" as const,
      promptGuidelines: ["Call message_parent with waitForReply=true on its own, not alongside other tools. It pauses, not completes, the run."],
      description: "Send the parent agent a question, finding or warning without completing this run. With waitForReply=true, pause until a reply addressed to the returned messageId arrives. Receipt is not an answer. Agent messages are never human approval.",
      parameters: Type.Object({
        message: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_CHARS }),
        waitForReply: Type.Optional(Type.Boolean({ default: false, description: "Pause this run for clarification rather than continuing work." })),
      }),
      execute: async (_id: string, params: { message: string; waitForReply?: boolean }, signal?: AbortSignal) => {
        if (!this.active()) throw new Error("message_parent requires an active child run with parent IPC configured.");
        if (!validMessageText(params.message) || (params.waitForReply !== undefined && typeof params.waitForReply !== "boolean")) {
          throw new Error("Message must contain 1–16,000 characters and waitForReply must be boolean.");
        }
        if (this.waitingForReply) throw new Error("Already waiting for a parent reply.");
        const message: ChildMessage = { runId: this.runId, messageId: randomUUID(), text: params.message, waitForReply: params.waitForReply ?? false };
        this.pi.appendEntry(CHILD_MESSAGE_SENT, message);
        this.sent.set(message.messageId, message);
        if (message.waitForReply) this.waitingForReply = message.messageId;
        const acknowledged = await this.beginDelivery(message, signal);
        const waiting = this.waitingForReply === message.messageId;
        return {
          content: [{ type: "text" as const, text: `${acknowledged ? "Parent acknowledged receipt (not an answer)." : "Delivery was interrupted or timed out without parent acknowledgement; delivery is uncertain."} Message ID: ${message.messageId}.${waiting ? " Paused awaiting a correlated parent reply; this run is still open." : ""}` }],
          details: { runId: this.runId, messageId: message.messageId, acknowledged, waitingForReply: waiting },
          ...(acknowledged ? {} : { isError: true }),
          terminate: waiting,
        };
      },
    };
    this.pi.registerTool(tool);
  }
}
