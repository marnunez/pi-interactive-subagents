import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export type ExtensionUiRequestMethod = "select" | "confirm" | "input" | "editor" | "custom";

export interface ExtensionUiRequest {
  id: string;
  method: ExtensionUiRequestMethod;
  title?: string;
  startedAt: number;
}

export type ExtensionUiRequestEvent =
  | { phase: "started"; request: ExtensionUiRequest }
  | { phase: "resolved"; request: ExtensionUiRequest };

function boundedTitle(title: unknown): string | undefined {
  if (typeof title !== "string") return undefined;
  const normalized = title.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 200) : undefined;
}

/**
 * Observe extension-owned, keyboard-focused UI without knowing which extension
 * or tool requested it. The returned disposer restores the original UI methods.
 */
export function monitorExtensionUi(
  ui: ExtensionUIContext,
  onEvent: (event: ExtensionUiRequestEvent) => void,
): () => void {
  let sequence = 0;
  let disposed = false;

  const run = async <T>(
    method: ExtensionUiRequestMethod,
    title: unknown,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const request: ExtensionUiRequest = {
      id: `ui-${Date.now().toString(36)}-${++sequence}`,
      method,
      title: boundedTitle(title),
      startedAt: Date.now(),
    };
    if (!disposed) onEvent({ phase: "started", request });
    try {
      return await operation();
    } finally {
      if (!disposed) onEvent({ phase: "resolved", request });
    }
  };

  const originalSelect = ui.select;
  const originalConfirm = ui.confirm;
  const originalInput = ui.input;
  const originalEditor = ui.editor;
  const originalCustom = ui.custom;

  const wrappedSelect: typeof ui.select = (title, options, opts) =>
    run("select", title, () => originalSelect.call(ui, title, options, opts));
  const wrappedConfirm: typeof ui.confirm = (title, message, opts) =>
    run("confirm", title, () => originalConfirm.call(ui, title, message, opts));
  const wrappedInput: typeof ui.input = (title, placeholder, opts) =>
    run("input", title, () => originalInput.call(ui, title, placeholder, opts));
  const wrappedEditor: typeof ui.editor = (title, prefill) =>
    run("editor", title, () => originalEditor.call(ui, title, prefill));
  const wrappedCustom = ((...args: Parameters<typeof originalCustom>) =>
    run("custom", undefined, () => originalCustom.apply(ui, args))) as typeof ui.custom;

  ui.select = wrappedSelect;
  ui.confirm = wrappedConfirm;
  ui.input = wrappedInput;
  ui.editor = wrappedEditor;
  ui.custom = wrappedCustom;

  return () => {
    disposed = true;
    if (ui.select === wrappedSelect) ui.select = originalSelect;
    if (ui.confirm === wrappedConfirm) ui.confirm = originalConfirm;
    if (ui.input === wrappedInput) ui.input = originalInput;
    if (ui.editor === wrappedEditor) ui.editor = originalEditor;
    if (ui.custom === wrappedCustom) ui.custom = originalCustom;
  };
}
