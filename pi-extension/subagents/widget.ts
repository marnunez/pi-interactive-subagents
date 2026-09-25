import { renderSubagentWidgetLines } from "./presentation.ts";
import { type RunRuntime } from "./runtime.ts";

export function createWidget(runtime: RunRuntime) {
  function updateWidget() {
    if (!runtime.latestCtx?.hasUI) return;

    if (runtime.runningSubagents.size === 0) {
      runtime.latestCtx.ui.setWidget("subagent-status", undefined);
      if (runtime.widgetInterval) {
        clearInterval(runtime.widgetInterval);
        runtime.widgetInterval = null;
      }
      return;
    }

    runtime.latestCtx.ui.setWidget(
      "subagent-status",
      (_tui: any, _theme: any) => {
        return {
          invalidate() { },
          render(width: number) {
            return renderSubagentWidgetLines(Array.from(runtime.runningSubagents.values()), width);
          },
        };
      },
      { placement: "aboveEditor" },
    );
  }

  function startWidgetRefresh() {
    if (runtime.widgetInterval) return;
    updateWidget(); // immediate first render
    runtime.widgetInterval = setInterval(() => {
      updateWidget();
    }, 1000);
  }
  return { updateWidget, startWidgetRefresh };
}
