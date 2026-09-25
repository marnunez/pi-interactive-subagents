import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { listAgentDefinitions } from "./config.ts";
import { isMuxAvailable, renameCurrentTab, renameWorkspace } from "./cmux.ts";
import { defineTool, SUBAGENT_KILL_GUIDANCE, muxUnavailableResult } from "./policy.ts";
import { type RunningSubagent } from "./types.ts";
import { formatElapsed, formatElapsedMMSS, formatSubagentState } from "./presentation.ts";
import { type RunRuntime } from "./runtime.ts";
import { type RunController } from "./controller.ts";

export function registerManagementTools(pi: ExtensionAPI, runtime: RunRuntime, controller: RunController, shouldRegister: (name: string) => boolean) {
  const { finishSubagent, updateWidget } = controller;
  // ── subagents_list tool ──
  if (shouldRegister("subagents_list"))
    pi.registerTool(defineTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List effective subagent definitions: trusted project .pi/agents, active profile agents, then bundled defaults. Chain files are not supported.",
      promptSnippet:
        "List effective subagent definitions from the trusted project, active profile and bundled defaults.",
      parameters: Type.Object({}),

      async execute(_id, _params, _signal, _update, ctx) {
        const list = listAgentDefinitions(ctx.cwd, ctx.isProjectTrusted());
        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    }));

  // ── set_tab_title tool ──
  // Only useful for sub-agents reporting progress to the orchestrator.
  if (shouldRegister("set_tab_title") && !!process.env.PI_SUBAGENT_NAME)
    pi.registerTool(defineTool({
      name: "set_tab_title",
      label: "Set Tab Title",
      description:
        "Update the current tab/window and workspace/session title. Use to show progress during multi-phase workflows " +
        "(e.g. planning, executing todos, reviewing). Keep titles short and informative.",
      promptSnippet:
        "Update the current tab/window and workspace/session title. Use to show progress during multi-phase workflows " +
        "(e.g. planning, executing todos, reviewing). Keep titles short and informative.",
      parameters: Type.Object({
        title: Type.String({
          description: "New tab title (also applied to workspace/session when supported)",
        }),
      }),

      async execute(_toolCallId, rawParams): Promise<any> {
        const params = rawParams as { title: string };
        if (!isMuxAvailable()) {
          return muxUnavailableResult("tab-title");
        }
        try {
          renameCurrentTab(params.title);
          renameWorkspace(params.title);
          return {
            content: [{ type: "text" as const, text: `Title set to: ${params.title}` }],
            details: { title: params.title },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `Failed to set title: ${err?.message}` }],
            details: { error: err?.message },
          };
        }
      },
    }));

  // ── subagent_kill tool ──
  if (shouldRegister("subagent_kill"))
    pi.registerTool(defineTool({
      name: "subagent_kill",
      label: "Kill Subagent",
      description: SUBAGENT_KILL_GUIDANCE,
      promptSnippet: SUBAGENT_KILL_GUIDANCE,
      promptGuidelines: [
        "Never call subagent_kill to poll child status. Omit its target only when the user explicitly asks to inspect running sub-agents.",
      ],
      parameters: Type.Object({
        target: Type.Optional(
          Type.String({
            description:
              "Subagent to kill: an id, a name (case-insensitive partial match), or 'all'. Omit only when the user explicitly asks to inspect running subagents.",
          }),
        ),
      }),

      renderCall(rawArgs, theme) {
        const args = rawArgs as { target?: string };
        const target = args.target ?? "(list)";
        return new Text(
          "▸ " + theme.fg("toolTitle", theme.bold("Kill Subagent")) + theme.fg("dim", ` — ${target}`),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const first = result.content?.[0];
        const text = first && "text" in first ? first.text : "";
        const details = result.details as any;
        if (details?.killed) {
          const names = details.killed.map((k: any) => k.name).join(", ");
          return new Text(
            theme.fg("error", "✗") + " Killed: " + theme.fg("toolTitle", names),
            0,
            0,
          );
        }
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, rawParams) {
        const params = rawParams as { target?: string };
        const agents = Array.from(runtime.runningSubagents.values());

        // No target: list running subagents
        if (!params.target) {
          if (agents.length === 0) {
            return {
              content: [{ type: "text", text: "No sub-agents currently running." }],
              details: { running: [] },
            };
          }
          const lines = agents.map((a) => {
            const elapsed = formatElapsedMMSS(a.startTime);
            const agentTag = a.agent ? ` (${a.agent})` : "";
            return `• ${a.name}${agentTag} [id: ${a.id}] — ${formatSubagentState(a)} · elapsed ${elapsed}`;
          });
          return {
            content: [
              {
                type: "text",
                text: `Running sub-agents (${agents.length}):\n${lines.join("\n")}\n\nPass a name, id, or 'all' to kill. Do not poll again; completion will arrive automatically via a steer message.`,
              },
            ],
            details: {
              running: agents.map((a) => ({
                id: a.id,
                name: a.name,
                agent: a.agent,
                status: formatSubagentState(a),
                backgroundWorkspace: a.backgroundWorkspace,
                surface: a.surface,
                pendingUiRequestCount: a.pendingUiRequestCount,
                uiRequests: a.uiRequests,
              })),
            },
          };
        }

        // Resolve targets
        let targets: RunningSubagent[];
        if (params.target.toLowerCase() === "all") {
          targets = agents;
        } else {
          const query = params.target.toLowerCase();
          targets = agents.filter(
            (a) =>
              a.id === params.target ||
              a.name.toLowerCase().includes(query) ||
              (a.agent && a.agent.toLowerCase().includes(query)),
          );
        }

        if (targets.length === 0) {
          const available =
            agents.length > 0
              ? `\nRunning: ${agents.map((a) => `${a.name} [${a.id}]`).join(", ")}`
              : "\nNo sub-agents currently running.";
          return {
            content: [
              {
                type: "text",
                text: `No sub-agent matching "${params.target}".${available}`,
              },
            ],
            details: { error: "not found" },
          };
        }

        // Kill each target
        const killed: { id: string; name: string; agent?: string; elapsed: number }[] = [];
        for (const agent of targets) {
          const elapsed = Math.floor((Date.now() - agent.startTime) / 1000);
          finishSubagent({
            id: agent.id, name: agent.name, task: agent.task, agent: agent.agent,
            protocolStatus: "cancelled", protocolError: "Cancelled by the parent.", elapsed,
          }, false);
          killed.push({ id: agent.id, name: agent.name, agent: agent.agent, elapsed });
        }

        updateWidget();

        const summary = killed
          .map((k) => {
            const agentTag = k.agent ? ` (${k.agent})` : "";
            return `• ${k.name}${agentTag} — killed after ${formatElapsed(k.elapsed)}`;
          })
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Killed ${killed.length} sub-agent${killed.length !== 1 ? "s" : ""}:\n${summary}`,
            },
          ],
          details: { killed },
        };
      },
    }));


}
