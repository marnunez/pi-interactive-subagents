import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { prepareLaunch } from "./launch-process.ts";
import { assertBackgroundLaunchAvailable, launchBackgroundSurface } from "./terminal-launch.ts";
import { loadAgentDefaults, resolveChildTools } from "./config.ts";
import { readChildRunConfig, legacyChildDefaults, type ChildRunConfig } from "./launch-config.ts";
import { isMuxAvailable, closeSurface } from "./cmux.ts";
import { readSubagentSessionCorrelation } from "./session.ts";
import { ensureSessionArtifactDir, getSessionArtifactDir, writeArtifactFile } from "../session-artifacts/paths.ts";
import { createIpcToken } from "./ipc.ts";
import { defineTool, SUBAGENT_COMPLETION_INSTRUCTION, SUBAGENT_ASYNC_GUIDANCE, withChildOnlyTools, muxUnavailableResult } from "./policy.ts";
import { type RunningSubagent } from "./types.ts";
import { childLaunchSpec } from "./launch.ts";
import { type RunRuntime, IPC_LAUNCH_ENTRY } from "./runtime.ts";
import { type RunController } from "./controller.ts";

export function registerResumeTool(pi: ExtensionAPI, runtime: RunRuntime, controller: RunController, shouldRegister: (name: string) => boolean) {
  const { serializeRunning, finishSubagent, reportChildren, scheduleConnectionFailure, recordSurface, awaitStartup, startWidgetRefresh } = controller;
  // ── subagent_resume tool ──
  if (shouldRegister("subagent_resume"))
    pi.registerTool(defineTool({
      name: "subagent_resume",
      label: "Resume Subagent",
      description:
        "Resume a previous sub-agent session with a direct, focus-safe background launch. " +
        "Waits for authenticated startup, not task completion. Results arrive later via a steer message. " +
        "Use when a sub-agent was cancelled or needs follow-up work. " + SUBAGENT_ASYNC_GUIDANCE,
      promptSnippet:
        "Resume a completed or cancelled session as a new background run, without stealing focus. " + SUBAGENT_ASYNC_GUIDANCE,
      parameters: Type.Object({
        sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
        name: Type.Optional(
          Type.String({ description: "Display name for the terminal tab. Default: 'Resume'" }),
        ),
        message: Type.Optional(
          Type.String({
            description: "Optional message to send after resuming (e.g. follow-up instructions)",
          }),
        ),
      }),

      renderCall(rawArgs, theme) {
        const args = rawArgs as { name?: string };
        const name = args.name ?? "Resume";
        const text =
          "▸ " + theme.fg("toolTitle", theme.bold(name)) + theme.fg("dim", " — resuming session");
        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "Resume";

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(name)) +
            theme.fg("dim", " — resumed, connected") +
            (details.backgroundWorkspace ? "\n" + theme.fg("dim", `Workspace: ${details.backgroundWorkspace}`) : ""),
            0,
            0,
          );
        }

        // Fallback
        const first = result.content?.[0];
        const text = first && "text" in first ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
        if (_signal?.aborted) throw new Error("Subagent startup cancelled before launch.");
        const params = rawParams as { sessionPath: string; name?: string; message?: string };
        const name = params.name ?? "Resume";
        const startTime = Date.now();

        if (!isMuxAvailable()) {
          return muxUnavailableResult("subagents");
        }

        if (!existsSync(resolve(ctx.cwd, params.sessionPath))) {
          return {
            content: [
              { type: "text", text: `Error: session file not found: ${params.sessionPath}` },
            ],
            details: { error: "session not found" },
          };
        }

        if (!runtime.parentIpcServer || !runtime.parentIpcSocketPath) {
          return {
            content: [{ type: "text", text: "Error: subagent IPC server is not ready." }],
            details: { error: "ipc unavailable" },
          };
        }

        const sessionFile = resolve(ctx.cwd, params.sessionPath);
        if ([...runtime.runningSubagents.values()].some((run) => run.sessionFile === sessionFile)) {
          throw new Error("This session already has an active subagent run. Finish or cancel it before resuming.");
        }
        const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
        if (!Number.isSafeInteger(depth) || depth >= 4) throw new Error("Subagent nesting limit (4) reached.");
        const correlation = readSubagentSessionCorrelation(sessionFile);
        const savedConfig = readChildRunConfig(join(getSessionArtifactDir(sessionFile), "context/subagent-config.json"));
        const legacyDefs = !savedConfig && correlation.agent
          ? loadAgentDefaults(correlation.agent, correlation.cwd, correlation.cwd === ctx.cwd && ctx.isProjectTrusted()) : null;
        const restoredConfig = savedConfig ?? legacyChildDefaults(correlation.agent, legacyDefs);
        const config: ChildRunConfig = {
          ...restoredConfig, schemaVersion: 1,
          tools: resolveChildTools({ ...legacyDefs, tools: restoredConfig.tools?.join(",") }, pi.getActiveTools(), pi.getAllTools().map((tool) => tool.name)),
          autoExit: false,
        };
        const runId = randomUUID();
        const ipcToken = createIpcToken();
        let surface: string | undefined;
        let resumeMessagePath: string | undefined;

        assertBackgroundLaunchAvailable();

        if (params.message) {
          const artifactDir = ensureSessionArtifactDir(sessionFile);
          resumeMessagePath = writeArtifactFile(
            artifactDir,
            `context/resume-${runId}.md`,
            `${params.message}\n\n${SUBAGENT_COMPLETION_INSTRUCTION}`,
          );
        }

        const spec = childLaunchSpec(runtime, config, runId, name, sessionFile, correlation.cwd, resumeMessagePath);
        spec.env.PI_SUBAGENT_TOKEN = ipcToken;
        spec.env.PI_DENY_TOOLS = withChildOnlyTools(pi.getAllTools().map((tool) => tool.name))!.filter((tool) => !config.tools.includes(tool)).join(",");
        const launch = prepareLaunch(spec);
        let running: RunningSubagent | undefined;
        let published = false;
        const epoch = runtime.epoch;
        try {
          running = {
            id: runId, runId, childSessionId: correlation.childSessionId,
            resumeOfRunId: correlation.originatingRunId, mode: "resume", name,
            agent: config.agent, task: params.message ?? "resumed session", surface: "",
            startTime, sessionFile, ipcToken, autoExit: false, config, launch,
          };
          runtime.parentIpcServer.registerChild(runId, ipcToken);
          pi.appendEntry(IPC_LAUNCH_ENTRY, serializeRunning(running));
          runtime.runningSubagents.set(runId, running);
          published = true;
          reportChildren();
          scheduleConnectionFailure(runId, 120_000, "Resumed subagent did not connect before the startup deadline. No task execution is confirmed; inspect its workspace/session for the cause.");
          Object.assign(running, launchBackgroundSurface({ runId, name, cwd: correlation.cwd, argv: launch.argv }));
          surface = running.surface;
          recordSurface(running);
          startWidgetRefresh();
          await awaitStartup(running, _signal, _onUpdate);
        } catch (error) {
          if (published && running) {
            if (runtime.epoch === epoch) finishSubagent({ id: runId, name, task: running.task, protocolStatus: "failed", protocolError: String(error), elapsed: 0 });
          } else {
            runtime.parentIpcServer?.unregisterChild(runId);
            launch.dispose();
            if (surface) { try { closeSurface(surface); } catch { } }
            if (resumeMessagePath) { try { unlinkSync(resumeMessagePath); } catch { } }
          }
          throw error;
        }
        startWidgetRefresh();

        return {
          content: [{ type: "text", text: `Session "${name}" resumed and connected without changing your focus. Task results arrive asynchronously. ${running?.backgroundWorkspace ? `WezTerm workspace: ${running.backgroundWorkspace}. ` : ""}${SUBAGENT_ASYNC_GUIDANCE}` }],
          details: {
            id: runId,
            runId,
            childSessionId: correlation.childSessionId,
            resumeOfRunId: correlation.originatingRunId,
            mode: "resume",
            backgroundWorkspace: running?.backgroundWorkspace,
            name,
            sessionPath: sessionFile,
            sessionFile,
            status: "started",
          },
        };
      },
    }));


}
