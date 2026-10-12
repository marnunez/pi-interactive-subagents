import { execFileSync } from "node:child_process";
import { getMuxBackend, type MuxBackend } from "./cmux.ts";

export interface TerminalLaunch {
  runId: string;
  name: string;
  cwd: string;
  argv: string[];
  siblingSurfaces?: string[];
}

interface WezTermPane {
  pane_id: number;
  tab_id: number;
  window_id: number;
  size?: { rows: number };
}

export function assertDirectLaunchAvailable(backend = getMuxBackend()): void {
  if (backend !== "wezterm" && backend !== "tmux") {
    throw new Error("Direct launches require WezTerm or tmux. No terminal input was sent; this backend has no verified direct launch implementation.");
  }
  const parent = backend === "wezterm" ? process.env.WEZTERM_PANE : process.env.TMUX_PANE;
  if (!parent || !(backend === "wezterm" ? /^\d+$/ : /^%\d+$/).test(parent)) {
    throw new Error(`${backend} launch requires an explicit originating pane`);
  }
}

export function directLaunchCommand(backend: MuxBackend | null, launch: TerminalLaunch, panes: WezTermPane[] = []) {
  assertDirectLaunchAvailable(backend);
  if (!/^[a-zA-Z0-9_-]+$/.test(launch.runId)) throw new Error("Invalid launch run ID");
  if (!launch.argv.length) throw new Error("A direct launch programme is required");
  if (backend === "wezterm") {
    const parent = process.env.WEZTERM_PANE!;
    const origin = panes.find(pane => String(pane.pane_id) === parent);
    if (!origin || !Number.isSafeInteger(origin.window_id) || !Number.isSafeInteger(origin.tab_id)) {
      throw new Error("Originating WezTerm pane is absent from the live mux; no child was launched.");
    }
    // Reconcile active run ownership with the live layout on every launch.
    // Only an owned, solitary child outside the parent tab can be split. Count
    // ALL panes, including foreign/completed ones; never use focused panes or
    // cached tab assignments (children may have moved or died since launch).
    const siblings = new Set(launch.siblingSurfaces);
    const sibling = panes.find(pane =>
      siblings.has(String(pane.pane_id)) && pane.window_id === origin.window_id &&
      pane.tab_id !== origin.tab_id &&
      panes.filter(other => other.window_id === pane.window_id && other.tab_id === pane.tab_id).length === 1,
    );
    const args = sibling
      ? ["cli", "split-pane", "--pane-id", String(sibling.pane_id), "--bottom", "--percent", "50"]
      : ["cli", "spawn", "--window-id", String(origin.window_id)];
    return { executable: "wezterm", args: [...args, "--cwd", launch.cwd, "--", ...launch.argv] };
  }
  return { executable: "tmux", args: ["split-window", "-d", "-h", "-t", process.env.TMUX_PANE!, "-c", launch.cwd, "-P", "-F", "#{pane_id}", "--", ...launch.argv] };
}

export function launchVisibleSurface(launch: TerminalLaunch) {
  const backend = getMuxBackend();
  assertDirectLaunchAvailable(backend);
  // Selection, direct launch and the caller's surface registration are
  // synchronous: parallel tools/reload cannot reserve the same slot in this
  // parent process. No packing counters survive failure or runtime reload.
  const panes: WezTermPane[] = backend === "wezterm"
    ? JSON.parse(execFileSync("wezterm", ["cli", "list", "--format", "json"], { encoding: "utf8", timeout: 3000 }))
    : [];
  const command = directLaunchCommand(backend, launch, panes);
  const surface = execFileSync(command.executable, command.args, { encoding: "utf8", timeout: 15_000 }).trim();
  if (!(command.executable === "wezterm" ? /^\d+$/ : /^%\d+$/).test(surface)) {
    throw new Error("Terminal launch did not return a valid pane identity; inspect the mux before retrying.");
  }
  return { surface };
}

export function surfaceAlive(surface: string): boolean | undefined {
  try {
    if (getMuxBackend() === "wezterm") {
      const rows = JSON.parse(execFileSync("wezterm", ["cli", "list", "--format", "json"], { encoding: "utf8", timeout: 3000 }));
      return rows.some((row: { pane_id: number }) => String(row.pane_id) === surface);
    }
    if (getMuxBackend() === "tmux") {
      execFileSync("tmux", ["display-message", "-p", "-t", surface, "#{pane_id}"], { encoding: "utf8", timeout: 3000 });
      return true;
    }
  } catch { /* A failed inspection is not proof that a process exited. */ }
  return undefined;
}
