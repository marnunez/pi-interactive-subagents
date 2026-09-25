import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_ASYNC_GUIDANCE, SUBAGENT_KILL_GUIDANCE, withChildOnlyTools, qualifyModelWithProvider, resolveEffectiveChildCwd, inheritedProfileEnvParts, inheritedProfileEnvUnsets, customAgentEnvParts } from "./policy.ts";
import { borderLine, renderSubagentWidgetLines } from "./presentation.ts";
import { forkConversation } from "./launch.ts";
import { createRunRuntime } from "./runtime.ts";
import { createController } from "./controller.ts";
import { registerSpawnTool } from "./spawn-tool.ts";
import { registerResumeTool } from "./resume-tool.ts";
import { registerManagementTools } from "./management-tools.ts";
import { registerCommands } from "./commands.ts";
import { registerRenderers } from "./renderers.ts";

export const __test__ = {
  forkConversation,
  borderLine,
  renderSubagentWidgetLines,
  qualifyModelWithProvider,
  withChildOnlyTools,
  resolveEffectiveChildCwd,
  inheritedProfileEnvParts,
  inheritedProfileEnvUnsets,
  customAgentEnvParts,
  SUBAGENT_ASYNC_GUIDANCE,
  SUBAGENT_KILL_GUIDANCE,
};

export default function subagentsExtension(pi: ExtensionAPI) {
  const runtime = createRunRuntime();
  const controller = createController(pi, runtime);
  const denied = new Set((process.env.PI_DENY_TOOLS ?? '').split(',').map(name => name.trim()).filter(Boolean));
  const shouldRegister = (name: string) => !denied.has(name);
  registerSpawnTool(pi, runtime, controller, shouldRegister);
  registerResumeTool(pi, runtime, controller, shouldRegister);
  registerManagementTools(pi, runtime, controller, shouldRegister);
  registerCommands(pi);
  registerRenderers(pi);
}
