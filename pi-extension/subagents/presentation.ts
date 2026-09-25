import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type SubagentResult, type PendingUiRequest, type RunningSubagent } from "./types.ts";

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)}MB`;
}

export function buildSubagentResultContent(details: SubagentResult): string {
  const lines: string[] = [];
  const agentTag = details.agent ? ` (${details.agent})` : "";

  if (details.protocolStatus === "completed" && details.result) {
    lines.push(
      `Sub-agent "${details.name}"${agentTag} completed with task status "${details.result.status}" (${formatElapsed(details.elapsed)}).`,
    );
    lines.push("", `Summary: ${details.result.summary}`);

    if (details.result.artifacts?.length) {
      lines.push("", "Artifacts:");
      for (const artifact of details.result.artifacts) {
        const path = artifact.path ?? artifact.name;
        const description = artifact.description ? ` — ${artifact.description}` : "";
        lines.push(`- ${path}${description}`);
      }
    }

    if (details.result.nextSteps?.length) {
      lines.push("", "Next steps:");
      details.result.nextSteps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
    }
  } else if (details.protocolStatus === "cancelled") {
    lines.push(
      `Sub-agent "${details.name}"${agentTag} was cancelled after ${formatElapsed(details.elapsed)}.`,
    );
    if (details.protocolError) lines.push("", details.protocolError);
  } else {
    lines.push(
      `Sub-agent "${details.name}"${agentTag} failed the completion protocol after ${formatElapsed(details.elapsed)}.`,
    );
    if (details.protocolError) lines.push("", details.protocolError);
    if (details.diagnosticSummary) {
      lines.push("", "Last assistant message (diagnostic only):", details.diagnosticSummary);
    }
  }

  if (details.sessionFile) {
    lines.push("", `Session: ${details.sessionFile}`, `Resume: pi --session ${details.sessionFile}`);
  }

  return lines.join("\n");
}

export const MAX_DISPLAY_UI_REQUESTS = 20;

export function parsePendingUiRequest(value: unknown): PendingUiRequest | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Partial<PendingUiRequest>;
  if (typeof request.id !== "string" || typeof request.method !== "string") return null;
  const title = typeof request.title === "string"
    ? request.title
      .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200) || undefined
    : undefined;
  return {
    id: request.id.slice(0, 100),
    method: request.method.slice(0, 50),
    title,
    startedAt: typeof request.startedAt === "number" ? request.startedAt : undefined,
  };
}

export function parsePendingUiRequestCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

export function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export const ACCENT = "\x1b[38;2;77;163;255m";

export const RST = "\x1b[0m";

export function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

export function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

export function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

export function formatSubagentState(agent: RunningSubagent): string {
  if (!agent.connected) return "connecting…";
  if (agent.state === "waiting_input") {
    const request = agent.uiRequests?.[agent.uiRequests.length - 1];
    if (request?.title) return `waiting: ${request.title}`;
    const count = agent.pendingUiRequestCount ?? agent.uiRequests?.length ?? 0;
    return count > 1 ? `waiting for ${count} inputs` : "waiting for input";
  }
  if (agent.state === "idle") return "idle";
  if (agent.state === "running") {
    return agent.entries != null ? `running · ${agent.entries} msgs` : "running";
  }
  if (agent.entries != null && agent.bytes != null) {
    return `${agent.entries} msgs (${formatBytes(agent.bytes)})`;
  }
  return "connected";
}

export function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
  const count = agents.length;
  const title = "Subagents";
  const info = `${count} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const left = ` ${elapsed}  ${agent.name}${agentTag} `;
    const right = ` ${formatSubagentState(agent)} `;

    lines.push(borderLine(left, right, width));
  }

  lines.push(borderBottom(width));
  return lines;
}
