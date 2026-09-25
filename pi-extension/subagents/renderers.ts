import { type ExtensionAPI, keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { type SubagentResult } from "./types.ts";
import { formatElapsed } from "./presentation.ts";

export function registerRenderers(pi: ExtensionAPI) {
  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as SubagentResult | undefined;
    if (!details) return undefined;

    const fit = (line: string, width: number) => truncateToWidth(line, Math.max(0, width - 6), "…");
    const pushWrapped = (lines: string[], text: string, width: number, color?: (s: string) => string) => {
      for (const line of text.split("\n")) {
        const fitted = fit(line, width);
        lines.push(color ? color(fitted) : fitted);
      }
    };

    return {
      invalidate() { },
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const taskStatus = details.result?.status;

        let icon = theme.fg("success", "✓");
        let statusText = "completed";
        let bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        if (details.protocolStatus === "failed") {
          icon = theme.fg("error", "✗");
          statusText = "protocol failed";
          bgFn = (text: string) => theme.bg("toolErrorBg", text);
        } else if (details.protocolStatus === "cancelled") {
          icon = theme.fg("warning", "■");
          statusText = "cancelled";
          bgFn = (text: string) => theme.bg("toolPendingBg", text);
        } else if (taskStatus === "failed") {
          icon = theme.fg("error", "✗");
          statusText = "task failed";
          bgFn = (text: string) => theme.bg("toolErrorBg", text);
        } else if (taskStatus === "blocked") {
          icon = theme.fg("warning", "!");
          statusText = "blocked";
          bgFn = (text: string) => theme.bg("toolPendingBg", text);
        } else if (taskStatus === "success") {
          statusText = "success";
        }

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${statusText} ${theme.fg("dim", `(${elapsed})`)}`;
        const contentLines = [header];

        if (details.protocolStatus === "completed" && details.result) {
          const result = details.result;
          const expandedText = result.report ?? result.summary;

          if (options.expanded) {
            contentLines.push("");
            pushWrapped(contentLines, expandedText, width);

            if (result.artifacts?.length) {
              contentLines.push("", theme.fg("toolTitle", theme.bold("Artifacts:")));
              for (const artifact of result.artifacts) {
                const path = artifact.path ?? artifact.name;
                const description = artifact.description ? ` — ${artifact.description}` : "";
                contentLines.push(theme.fg("dim", fit(`- ${path}${description}`, width)));
              }
            }

            if (result.nextSteps?.length) {
              contentLines.push("", theme.fg("toolTitle", theme.bold("Next steps:")));
              result.nextSteps.forEach((step, i) => {
                contentLines.push(theme.fg("dim", fit(`${i + 1}. ${step}`, width)));
              });
            }

            if (details.sessionFile) {
              contentLines.push("", theme.fg("dim", fit(`Session: ${details.sessionFile}`, width)));
              contentLines.push(theme.fg("dim", fit(`Resume:  pi --session ${details.sessionFile}`, width)));
            }
          } else {
            pushWrapped(contentLines, result.summary, width, (line) => theme.fg("dim", line));
            const extras: string[] = [];
            if (result.report) extras.push("full report");
            if (result.artifacts?.length) extras.push(`${result.artifacts.length} artifact${result.artifacts.length === 1 ? "" : "s"}`);
            if (result.nextSteps?.length) extras.push(`${result.nextSteps.length} next step${result.nextSteps.length === 1 ? "" : "s"}`);
            if (extras.length) {
              contentLines.push(theme.fg("muted", fit(`… ${extras.join(", ")}`, width)));
            }
            contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
          }
        } else {
          const messageText = details.protocolError ?? details.diagnosticSummary ?? "No details available.";
          if (options.expanded) {
            pushWrapped(contentLines, messageText, width, (line) => theme.fg("dim", line));
            if (details.diagnosticSummary && details.protocolError) {
              contentLines.push("", theme.fg("toolTitle", theme.bold("Diagnostic last assistant message:")));
              pushWrapped(contentLines, details.diagnosticSummary, width, (line) => theme.fg("dim", line));
            }
            if (details.sessionFile) {
              contentLines.push("", theme.fg("dim", fit(`Session: ${details.sessionFile}`, width)));
              contentLines.push(theme.fg("dim", fit(`Resume:  pi --session ${details.sessionFile}`, width)));
            }
          } else {
            pushWrapped(contentLines, messageText.split("\n").slice(0, 3).join("\n"), width, (line) => theme.fg("dim", line));
            contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
          }
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });


}
