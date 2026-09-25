import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { loadAgentDefaults } from "./config.ts";
import { isMuxAvailable } from "./cmux.ts";
import { defineTool, SUBAGENT_ASYNC_GUIDANCE, SubagentParams, type SubagentParamsValue, muxUnavailableResult } from "./policy.ts";
import { launchSubagent } from "./launch.ts";
import { type RunRuntime, IPC_LAUNCH_ENTRY } from "./runtime.ts";
import { type RunController } from "./controller.ts";

export function registerSpawnTool(pi: ExtensionAPI, runtime: RunRuntime, controller: RunController, shouldRegister: (name: string) => boolean) {
  const { serializeRunning, finishSubagent, reportChildren, scheduleConnectionFailure, recordSurface, awaitStartup, startWidgetRefresh } = controller;
  // ── subagent tool ──
  if (shouldRegister("subagent"))
    pi.registerTool(defineTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Launch a sub-agent directly without terminal typing or stealing focus. " +
        "Waits for the child's authenticated startup connection, then returns while the task runs asynchronously. " +
        "Do not fabricate or assume its result. " + SUBAGENT_ASYNC_GUIDANCE,
      promptSnippet:
        "Spawn a sub-agent asynchronously. Do not fabricate its result. " + SUBAGENT_ASYNC_GUIDANCE,
      promptGuidelines: [
        "After using subagent, never poll child status. If no independent work remains, end the turn silently with no text and no further tool calls; child completion arrives as a steer message and triggers the next turn.",
      ],
      parameters: SubagentParams,

      async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
        if (_signal?.aborted) throw new Error("Subagent startup cancelled before launch.");
        const params = rawParams as SubagentParamsValue;
        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        // Enforce max-instances limit
        if (params.agent) {
          const agentDefs = loadAgentDefaults(params.agent, ctx.cwd, ctx.isProjectTrusted());
          if (agentDefs?.maxInstances != null) {
            const running = Array.from(runtime.runningSubagents.values()).filter(
              (a) => a.agent === params.agent,
            );
            if (running.length >= agentDefs.maxInstances) {
              const names = running.map((a) => a.name).join(", ");
              return {
                content: [
                  {
                    type: "text",
                    text: `Cannot spawn another ${params.agent} agent — max ${agentDefs.maxInstances} instance${agentDefs.maxInstances !== 1 ? "s" : ""} allowed (running: ${names}). Wait for it to finish or kill it first.`,
                  },
                ],
                details: { error: "max-instances reached", running: running.map((a) => a.id) },
              };
            }
          }
        }

        // Validate prerequisites
        if (!isMuxAvailable()) {
          return muxUnavailableResult("subagents");
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // Prepare a durable run, then create its pane with a direct programme argv.
        const allToolNames = pi.getAllTools().map((t: any) => t.name);
        const running = await launchSubagent(runtime, params, ctx, {
          allToolNames, activeToolNames: pi.getActiveTools(), projectTrusted: ctx.isProjectTrusted(),
          onPrepared: (running) => {
            pi.appendEntry(IPC_LAUNCH_ENTRY, serializeRunning(running));
            runtime.runningSubagents.set(running.id, running);
            reportChildren();
            scheduleConnectionFailure(running.id, 120_000, "Subagent did not connect before the startup deadline. No task execution is confirmed; inspect its workspace/session for the cause.");
          },
          onLaunched: recordSurface,
          onFailed: (running, error) => finishSubagent({
            id: running.id, name: running.name, task: running.task, agent: running.agent,
            protocolStatus: "failed", protocolError: `Launch failed: ${String(error)}`, elapsed: 0,
          }),
        });

        // Start widget refresh when first agent launches. Lifecycle now arrives over IPC.
        startWidgetRefresh();

        await awaitStartup(running, _signal, _onUpdate);
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" connected without changing your focus. Task results are delivered asynchronously. ` +
                (running.backgroundWorkspace ? `WezTerm workspace: ${running.backgroundWorkspace}. ` : "") +
                `Do not generate or assume any result. ${SUBAGENT_ASYNC_GUIDANCE}`,
            },
          ],
          details: {
            id: running.id,
            runId: running.runId,
            childSessionId: running.childSessionId,
            mode: running.mode,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            backgroundWorkspace: running.backgroundWorkspace,
            status: "started",
          },
        };
      },

      renderCall(rawArgs, theme) {
        const args = rawArgs as Partial<SubagentParamsValue>;
        const agent = args.agent ? theme.fg("dim", ` (${args.agent})`) : "";
        const cwdHint = args.cwd ? theme.fg("dim", ` in ${args.cwd}`) : "";
        let text =
          "▸ " + theme.fg("toolTitle", theme.bold(args.name ?? "(unnamed)")) + agent + cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        const task = args.task ?? "";
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" is only reported after the child authenticates over IPC.
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(name)) +
            theme.fg("dim", " — connected") +
            (details.backgroundWorkspace ? "\n" + theme.fg("dim", `Workspace: ${details.backgroundWorkspace}`) : ""),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const first = result.content?.[0];
        const text = first && "text" in first ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    }));


}
