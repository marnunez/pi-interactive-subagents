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
    // Keep the parent half intact: subsequent agents subdivide the tallest
    // owned sibling in the same tab. Never split an arbitrary active pane.
    const siblings = new Set(launch.siblingSurfaces);
    const sibling = origin && panes
      .filter(pane => String(pane.pane_id) !== parent && siblings.has(String(pane.pane_id)) && pane.tab_id === origin.tab_id && pane.window_id === origin.window_id)
      .sort((a, b) => (b.size?.rows ?? 0) - (a.size?.rows ?? 0))[0];
    const target = sibling ? String(sibling.pane_id) : parent;
    return { executable: "wezterm", args: ["cli", "split-pane", "--pane-id", target, sibling ? "--bottom" : "--right", "--percent", "50", "--cwd", launch.cwd, "--", ...launch.argv] };
  }
  return { executable: "tmux", args: ["split-window", "-d", "-h", "-t", process.env.TMUX_PANE!, "-c", launch.cwd, "-P", "-F", "#{pane_id}", "--", ...launch.argv] };
}

export function launchVisibleSurface(launch: TerminalLaunch) {
  const backend = getMuxBackend();
  assertDirectLaunchAvailable(backend);
  const panes: WezTermPane[] = backend === "wezterm" && launch.siblingSurfaces?.length
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
