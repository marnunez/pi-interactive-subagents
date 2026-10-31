import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component } from "@earendil-works/pi-tui";

type CardBackground = "toolSuccessBg" | "toolPendingBg" | "toolErrorBg";

/** Custom messages own their shell; match Pi's ordinary tool padding and colours. */
export function renderSubagentCard(
  width: number,
  options: { outputPad?: number },
  theme: Theme,
  background: CardBackground,
  content: (contentWidth: number) => Component,
): string[] {
  if (width <= 0) return [];
  // Leave at least one content column, including in very narrow terminals.
  const padding = Math.min(Math.max(0, Math.floor(options.outputPad ?? 1)), Math.floor((width - 1) / 2));
  const box = new Box(padding, 1, text => theme.bg(background, text));
  box.addChild(content(width - padding * 2));
  // Pi's custom-message wrapper already supplies the inter-message spacer.
  return box.render(width);
}
