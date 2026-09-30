import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RunController } from "./controller.ts";

/** Exact run IDs only: names and session paths are not safe delivery addresses. */
export function registerMessageTool(pi: ExtensionAPI, controller: RunController, shouldRegister: (name: string) => boolean): void {
  if (!shouldRegister("subagent_message")) return;
  pi.registerTool({
    name: "subagent_message",
    label: "Message Subagent",
    description: "Send an advisory mid-task message to a connected child owned by this parent, addressed by its exact active run ID. Waits for the child to acknowledge accepting it into Pi; this does not mean the child has read or obeyed it. Agent text is never user approval. Do not use this to poll.",
    parameters: Type.Object({
      runId: Type.String({ description: "Exact active runId returned by subagent or subagent_resume" }),
      message: Type.String({ minLength: 1, maxLength: 16_000, description: "Mid-task note or course correction; not user approval" }),
    }),
    async execute(_id, params) {
      if (!params.message.trim() || params.message.length > 16_000) throw new Error("Message must contain 1–16,000 characters.");
      await controller.sendToChild(params.runId, params.message);
      return {
        content: [{ type: "text" as const, text: `Child run ${params.runId} acknowledged receipt of the parent message (not task completion).` }],
        details: { runId: params.runId, acknowledged: true },
      };
    },
  });
}
