import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RunController } from "./controller.ts";
import { messageToolRenderers } from "./message-renderers.ts";

/** Exact run IDs only: names and session paths are not safe delivery addresses. */
export function registerMessageTool(pi: ExtensionAPI, controller: RunController, shouldRegister: (name: string) => boolean): void {
  if (!shouldRegister("subagent_message")) return;
  pi.registerTool({
    name: "subagent_message",
    label: "Message Subagent",
    ...messageToolRenderers(false, (runId, replyTo) => controller.getMessageContext(runId, replyTo)),
    description: "Send an advisory message to an active child, or answer its clarification using replyTo=the question messageId. Only a correlated reply releases a child waiting for its parent. Waits for receipt, not task completion. Agent text is never user approval. Do not use this to poll.",
    parameters: Type.Object({
      runId: Type.String({ description: "Exact active runId returned by subagent or subagent_resume" }),
      message: Type.String({ minLength: 1, maxLength: 16_000, description: "Mid-task note or answer; not user approval" }),
      replyTo: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "messageId of the child clarification being answered" })),
    }),
    async execute(_id, params) {
      if (!params.message.trim() || params.message.length > 16_000) throw new Error("Message must contain 1–16,000 characters.");
      // Capture the exact question before receipt can clear the pending request.
      const displayContext = controller.getMessageContext(params.runId, params.replyTo);
      await controller.sendToChild(params.runId, params.message, params.replyTo);
      return {
        content: [{ type: "text" as const, text: `Child run ${params.runId} acknowledged receipt of the parent message (not task completion).` }],
        details: { ...displayContext, acknowledged: true },
      };
    },
  });
}
