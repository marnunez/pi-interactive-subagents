import { execFileSync } from "node:child_process";
import { getMuxBackend, type MuxBackend } from "./cmux.ts";

export interface TerminalLaunch {
  runId: string;
  name: string;
  cwd: string;
  argv: string[];
  workspaceLabel?: string;
}

export function assertBackgroundLaunchAvailable(backend = getMuxBackend()): void {
  if (backend !== "wezterm" && backend !== "tmux") {
    throw new Error("Focus-safe direct launches require WezTerm or tmux. No terminal input was sent; this backend has no verified background launch implementation.");
  }
}

export function backgroundLaunchCommand(backend: MuxBackend | null, launch: TerminalLaunch) {
  assertBackgroundLaunchAvailable(backend);
  if (!/^[a-zA-Z0-9_-]+$/.test(launch.runId)) throw new Error("Invalid launch run ID");
  if (!launch.argv.length) throw new Error("A direct launch programme is required");
  if (backend === "wezterm") {
    // CLI spawn always activates its new tab. A unique, inactive workspace has
    // no GUI window to focus: the GUI only materialises the active workspace.
    // Never switch then restore focus; even that brief switch can steal typing.
    const label = (launch.workspaceLabel ?? launch.name).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 60);
    const workspace = `pi-subagent · ${label} · ${launch.runId}`;
    return { executable: "wezterm", args: ["cli", "spawn", "--new-window", "--domain-name", "local", "--workspace", workspace, "--cwd", launch.cwd, "--", ...launch.argv], workspace };
  }
  const parent = process.env.TMUX_PANE;
  if (!parent || !/^%\d+$/.test(parent)) throw new Error("tmux launch requires an explicit originating pane");
  return { executable: "tmux", args: ["split-window", "-d", "-h", "-t", parent, "-c", launch.cwd, "-P", "-F", "#{pane_id}", "--", ...launch.argv], workspace: undefined };
}

export function launchBackgroundSurface(launch: TerminalLaunch) {
  const command = backgroundLaunchCommand(getMuxBackend(), launch);
  const surface = execFileSync(command.executable, command.args, { encoding: "utf8", timeout: 15_000 }).trim();
  if (!(command.executable === "wezterm" ? /^\d+$/ : /^%\d+$/).test(surface)) {
    throw new Error("Terminal launch did not return a valid pane identity; inspect the mux before retrying.");
  }
  return { surface, backgroundWorkspace: command.workspace };
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
