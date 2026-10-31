import { type ExtensionAPI, keyHint } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type SubagentResult } from "./types.ts";
import { formatElapsed } from "./presentation.ts";
import { registerChildMessageRenderer } from "./message-renderers.ts";
import { renderSubagentCard } from "./card.ts";

export function registerRenderers(pi: ExtensionAPI) {
  registerChildMessageRenderer(pi);
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as SubagentResult | undefined;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const taskStatus = details.result?.status;
        let icon = theme.fg("success", "✓");
        let statusText = "completed";
        let background: "toolSuccessBg" | "toolPendingBg" | "toolErrorBg" = "toolSuccessBg";

        if (details.protocolStatus === "failed") {
          icon = theme.fg("error", "✗");
          statusText = "protocol failed";
          background = "toolErrorBg";
        } else if (details.protocolStatus === "cancelled") {
          icon = theme.fg("warning", "■");
          statusText = "cancelled";
          background = "toolPendingBg";
        } else if (taskStatus === "failed") {
          icon = theme.fg("error", "✗");
          statusText = "task failed";
          background = "toolErrorBg";
        } else if (taskStatus === "blocked") {
          icon = theme.fg("warning", "!");
          statusText = "blocked";
          background = "toolPendingBg";
        } else if (taskStatus === "success") {
          statusText = "success";
        }

        return renderSubagentCard(width, options, theme, background, contentWidth => {
          const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${theme.fg("toolOutput", statusText)} ${theme.fg("dim", `(${elapsed})`)}`;
          const lines = [truncateToWidth(header, contentWidth)];
          const pushText = (text: string, dim = false) => {
            lines.push(...wrapTextWithAnsi(text, contentWidth).map(line => theme.fg(dim ? "dim" : "toolOutput", line)));
          };

          if (details.protocolStatus === "completed" && details.result) {
            const result = details.result;
            if (options.expanded) {
              lines.push("");
              pushText(result.report ?? result.summary);
              if (result.artifacts?.length) {
                lines.push("", theme.fg("toolTitle", theme.bold("Artifacts:")));
                for (const artifact of result.artifacts) {
                  pushText(`- ${artifact.path ?? artifact.name}${artifact.description ? ` — ${artifact.description}` : ""}`, true);
                }
              }
              if (result.nextSteps?.length) {
                lines.push("", theme.fg("toolTitle", theme.bold("Next steps:")));
                result.nextSteps.forEach((step, i) => pushText(`${i + 1}. ${step}`, true));
              }
            } else {
              const summary = wrapTextWithAnsi(result.summary, contentWidth);
              lines.push(...summary.slice(0, 3).map(line => theme.fg("toolOutput", line)));
              const extras: string[] = [];
              if (summary.length > 3) extras.push("more text");
              if (result.report) extras.push("full report");
              if (result.artifacts?.length) extras.push(`${result.artifacts.length} artifact${result.artifacts.length === 1 ? "" : "s"}`);
              if (result.nextSteps?.length) extras.push(`${result.nextSteps.length} next step${result.nextSteps.length === 1 ? "" : "s"}`);
              lines.push(keyHint("app.tools.expand", `to expand${extras.length ? ` · ${extras.join(", ")}` : ""}`));
            }
          } else {
            const text = details.protocolError ?? details.diagnosticSummary ?? "No details available.";
            if (options.expanded) {
              lines.push("");
              pushText(text);
              if (details.diagnosticSummary && details.protocolError) {
                lines.push("", theme.fg("toolTitle", theme.bold("Diagnostic last assistant message:")));
                pushText(details.diagnosticSummary);
              }
            } else {
              lines.push(...wrapTextWithAnsi(text, contentWidth).slice(0, 3).map(line => theme.fg("toolOutput", line)));
              lines.push(keyHint("app.tools.expand", "to expand"));
            }
          }
          if (options.expanded && details.sessionFile) {
            lines.push("");
            pushText(`Session: ${details.sessionFile}`, true);
            pushText(`Resume:  pi --session ${details.sessionFile}`, true);
          }
          return new Text(lines.map(line => truncateToWidth(line, contentWidth)).join("\n"), 0, 0);
        });
      },
    };
  });
}
