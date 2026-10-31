import { getMarkdownTheme, keyHint, type ExtensionAPI, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Keep routing and authority instructions in model context, not the default UI. */
function messageCard(message: any, options: { expanded: boolean }, theme: Theme, fromChild: boolean) {
  const details = message.details;
  // Old or malformed entries must remain readable through Pi's default renderer.
  if (typeof details?.text !== "string") return undefined;
  const question = fromChild && details.waitForReply === true;
  const sender = fromChild ? `Subagent ${typeof details.name === "string" ? details.name : "agent"}` : "Parent agent";
  const kind = question ? "Question for parent" : !fromChild && details.replyTo ? "Reply" : "Update";
  return {
    invalidate() {},
    render(width: number): string[] {
      if (width <= 0) return [];
      const heading = `${theme.fg(question ? "warning" : "accent", question ? "?" : "↳")} ${theme.fg("toolTitle", theme.bold(sender))} ${theme.fg("dim", `— ${kind}`)}`;
      const lines = [truncateToWidth(heading, width)];
      if (options.expanded) {
        lines.push(...new Markdown(details.text, 0, 0, getMarkdownTheme()).render(width));
        lines.push(theme.fg("dim", "Agent message · not user approval"));
        for (const [label, value] of [["Run", details.runId], ["Message", details.messageId], ["Reply to", details.replyTo]]) {
          if (typeof value === "string") lines.push(...wrapTextWithAnsi(theme.fg("dim", `${label}: ${value}`), width));
        }
      } else {
        const body = wrapTextWithAnsi(details.text, width);
        lines.push(...body.slice(0, 3));
        lines.push(theme.fg("muted", `${body.length > 3 ? "… · " : ""}${keyHint("app.tools.expand", "for details")}`));
      }
      return lines.map(line => truncateToWidth(line, width));
    },
  };
}

export function registerChildMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("subagent_child_message", (message, options, theme) => messageCard(message, options, theme, true));
}

export function registerParentMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("subagent_parent_message", (message, options, theme) => messageCard(message, options, theme, false));
}

/** Shared presentation for both directions; delivery/pausing semantics stay in the tools. */
export function messageToolRenderers(toParent: boolean): Pick<ToolDefinition, "renderCall" | "renderResult"> {
  return {
    renderCall(rawArgs, theme, context) {
      const args = rawArgs as { message?: string; waitForReply?: boolean; replyTo?: string; runId?: string };
      const title = toParent ? args.waitForReply ? "Ask parent" : "Update parent"
        : args.replyTo ? "Reply to subagent" : "Message subagent";
      return {
        invalidate() {},
        render(width: number): string[] {
          if (width <= 0) return [];
          const heading = theme.fg("toolTitle", theme.bold(title));
          const message = typeof args.message === "string" ? args.message : "";
          if (context?.expanded) {
            const lines = [heading, message];
            if (args.runId) lines.push(theme.fg("dim", `Run: ${args.runId}`));
            if (args.replyTo) lines.push(theme.fg("dim", `Reply to: ${args.replyTo}`));
            return new Text(lines.join("\n"), 0, 0).render(width);
          }
          const preview = message.replace(/\s+/g, " ").trim();
          return [truncateToWidth(`${heading}${preview ? ` — ${theme.fg("dim", preview)}` : ""}`, width)];
        },
      };
    },
    renderResult(result, options, theme, context) {
      const details = result.details as { acknowledged?: boolean; waitingForReply?: boolean } | undefined;
      const raw = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      const failed = context?.isError || (result as { isError?: boolean }).isError || details?.acknowledged === false;
      if (options.isPartial && !failed) return new Text(theme.fg("dim", "Sending…"), 0, 0);
      // Never manufacture a success from missing details, especially on thrown errors.
      if (failed || options.expanded || details?.acknowledged !== true) {
        return new Text(theme.fg(failed ? "error" : "dim", raw), 0, 0);
      }
      const status = toParent
        ? details.waitingForReply ? "Receipt confirmed · awaiting parent reply" : "Receipt confirmed · not an answer"
        : "Receipt confirmed · not task completion";
      return new Text(theme.fg("dim", status), 0, 0);
    },
  };
}
