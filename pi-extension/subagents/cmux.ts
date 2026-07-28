import { execSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type MuxBackend = "cmux" | "tmux" | "zellij" | "wezterm";

const commandAvailability = new Map<string, boolean>();

/** Max panes per WezTerm tab. 0 = no tabs, just split right (legacy). Default: 2. */
const maxPanesPerTab = Math.max(0, parseInt(process.env.PI_SUBAGENT_MAX_PANES_PER_TAB ?? "2", 10));

/** Panes in the current (not yet full) WezTerm tab. */
let currentTabPanes: string[] = [];

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execSync(`command -v ${command}`, { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

function muxPreference(): MuxBackend | null {
  const pref = (process.env.PI_SUBAGENT_MUX ?? "").trim().toLowerCase();
  if (pref === "cmux" || pref === "tmux" || pref === "zellij" || pref === "wezterm") return pref;
  return null;
}

function isCmuxRuntimeAvailable(): boolean {
  return !!process.env.CMUX_SOCKET_PATH && hasCommand("cmux");
}

function isTmuxRuntimeAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

function isZellijRuntimeAvailable(): boolean {
  return !!(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME) && hasCommand("zellij");
}

function isWezTermRuntimeAvailable(): boolean {
  return !!process.env.WEZTERM_UNIX_SOCKET && hasCommand("wezterm");
}

export function isCmuxAvailable(): boolean {
  return isCmuxRuntimeAvailable();
}

export function isTmuxAvailable(): boolean {
  return isTmuxRuntimeAvailable();
}

export function isZellijAvailable(): boolean {
  return isZellijRuntimeAvailable();
}

export function isWezTermAvailable(): boolean {
  return isWezTermRuntimeAvailable();
}

export function getMuxBackend(): MuxBackend | null {
  const pref = muxPreference();
  if (pref === "cmux") return isCmuxRuntimeAvailable() ? "cmux" : null;
  if (pref === "tmux") return isTmuxRuntimeAvailable() ? "tmux" : null;
  if (pref === "zellij") return isZellijRuntimeAvailable() ? "zellij" : null;
  if (pref === "wezterm") return isWezTermRuntimeAvailable() ? "wezterm" : null;

  if (isCmuxRuntimeAvailable()) return "cmux";
  if (isTmuxRuntimeAvailable()) return "tmux";
  if (isZellijRuntimeAvailable()) return "zellij";
  if (isWezTermRuntimeAvailable()) return "wezterm";
  return null;
}

export function isMuxAvailable(): boolean {
  return getMuxBackend() !== null;
}

export function muxSetupHint(): string {
  const pref = muxPreference();
  if (pref === "cmux") {
    return "Start pi inside cmux (`cmux pi`).";
  }
  if (pref === "tmux") {
    return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
  }
  if (pref === "zellij") {
    return "Start pi inside zellij (`zellij --session pi`, then run `pi`).";
  }
  if (pref === "wezterm") {
    return "Start pi inside WezTerm.";
  }
  return "Start pi inside cmux (`cmux pi`), tmux (`tmux new -A -s pi 'pi'`), zellij (`zellij --session pi`, then run `pi`), or WezTerm.";
}

function requireMuxBackend(): MuxBackend {
  const backend = getMuxBackend();
  if (!backend) {
    throw new Error(`No supported terminal multiplexer found. ${muxSetupHint()}`);
  }
  return backend;
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function zellijPaneId(surface: string): string {
  return surface.startsWith("pane:") ? surface.slice("pane:".length) : surface;
}

function zellijEnv(surface?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (surface) {
    env.ZELLIJ_PANE_ID = zellijPaneId(surface);
  }
  return env;
}

function waitForFile(path: string, timeoutMs = 5000): string {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) {
      return readFileSync(path, "utf8").trim();
    }
    Atomics.wait(sleeper, 0, 0, 20);
  }
  throw new Error(`Timed out waiting for zellij pane id file: ${path}`);
}

function zellijActionSync(args: string[], surface?: string): string {
  return execFileSync("zellij", ["action", ...args], {
    encoding: "utf8",
    env: zellijEnv(surface),
  });
}

/**
 * Create a new terminal pane as a right split and set its title.
 * Returns an identifier (`surface:42` in cmux, `%12` in tmux, `pane:7` in zellij, `42` in wezterm).
 */
export function createSurface(name: string): string {
  const backend = getMuxBackend();

  // WezTerm: use tabs with max N panes each
  if (backend === "wezterm") {
    // 0 = no tabs, split right from current pane (legacy behavior)
    if (maxPanesPerTab === 0) {
      return createSurfaceSplit(name, "right");
    }

    // Try to split into the current tab if it has room
    if (currentTabPanes.length > 0 && currentTabPanes.length < maxPanesPerTab) {
      try {
        const args = ["cli", "split-pane", "--right", "--pane-id", currentTabPanes[0], "--cwd", process.cwd()];
        const paneId = execFileSync("wezterm", args, { encoding: "utf8" }).trim();
        if (paneId && /^\d+$/.test(paneId)) {
          currentTabPanes.push(paneId);
          try {
            execFileSync("wezterm", ["cli", "set-tab-title", "--pane-id", paneId, name], { encoding: "utf8" });
          } catch {}
          return paneId;
        }
      } catch {
        // Pane died — reset and fall through to spawn
        currentTabPanes = [];
      }
    }

    // Spawn a new tab
    const paneId = execFileSync("wezterm", ["cli", "spawn", "--cwd", process.cwd()], { encoding: "utf8" }).trim();
    if (!paneId || !/^\d+$/.test(paneId)) {
      throw new Error(`Unexpected wezterm spawn output: ${paneId || "(empty)"}`);
    }
    currentTabPanes = [paneId];
    try {
      execFileSync("wezterm", ["cli", "set-tab-title", "--pane-id", paneId, name], { encoding: "utf8" });
    } catch {}
    return paneId;
  }

  // Other backends: split right as before
  return createSurfaceSplit(name, "right");
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns an identifier (`surface:42` in cmux, `%12` in tmux, `pane:7` in zellij, `42` in wezterm).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    const surfaceArg = fromSurface ? ` --surface ${shellEscape(fromSurface)}` : "";
    const out = execSync(`cmux new-split ${direction}${surfaceArg}`, {
      encoding: "utf8",
    }).trim();
    const match = out.match(/surface:\d+/);
    if (!match) {
      throw new Error(`Unexpected cmux new-split output: ${out}`);
    }
    const surface = match[0];
    execSync(`cmux rename-tab --surface ${shellEscape(surface)} ${shellEscape(name)}`, {
      encoding: "utf8",
    });
    return surface;
  }

  if (backend === "tmux") {
    const args = ["split-window"];
    if (direction === "left" || direction === "right") {
      args.push("-h");
    } else {
      args.push("-v");
    }
    if (direction === "left" || direction === "up") {
      args.push("-b");
    }
    if (fromSurface) {
      args.push("-t", fromSurface);
    }
    args.push("-P", "-F", "#{pane_id}");

    const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
    if (!pane.startsWith("%")) {
      throw new Error(`Unexpected tmux split-window output: ${pane}`);
    }

    try {
      execFileSync("tmux", ["select-pane", "-t", pane, "-T", name], { encoding: "utf8" });
    } catch {
      // Optional.
    }
    return pane;
  }

  if (backend === "wezterm") {
    const args = ["cli", "split-pane"];
    if (direction === "left") args.push("--left");
    else if (direction === "right") args.push("--right");
    else if (direction === "up") args.push("--top");
    else args.push("--bottom");
    args.push("--cwd", process.cwd());
    if (fromSurface) {
      args.push("--pane-id", fromSurface);
    }
    const paneId = execFileSync("wezterm", args, { encoding: "utf8" }).trim();
    if (!paneId || !/^\d+$/.test(paneId)) {
      throw new Error(`Unexpected wezterm split-pane output: ${paneId || "(empty)"}`);
    }
    try {
      execFileSync("wezterm", ["cli", "set-tab-title", "--pane-id", paneId, name], {
        encoding: "utf8",
      });
    } catch {
      // Optional — tab title is cosmetic.
    }
    return paneId;
  }

  // zellij
  const directionArg = direction === "left" || direction === "right" ? "right" : "down";
  const tokenPath = join(
    tmpdir(),
    `pi-subagent-zellij-pane-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  const args = ["new-pane", "--direction", directionArg, "--name", name, "--cwd", process.cwd()];

  try {
    zellijActionSync(args, fromSurface);
  } catch {
    if (!fromSurface) throw new Error("Failed to create zellij pane");
    zellijActionSync(args);
  }

  // IMPORTANT: do not pass a long-running command to `new-pane`.
  // zellij keeps the `action new-pane -- <cmd>` process attached until <cmd>
  // exits. If <cmd> is an interactive shell, the parent call hangs forever.
  // Instead, create a normal shell pane first, then ask the focused pane
  // to print its own $ZELLIJ_PANE_ID into a temp file.
  const captureIdCmd = `echo "$ZELLIJ_PANE_ID" > ${shellEscape(tokenPath)}`;
  zellijActionSync(["write-chars", captureIdCmd]);
  zellijActionSync(["write", "13"]);

  const paneId = waitForFile(tokenPath);
  try {
    rmSync(tokenPath, { force: true });
  } catch {}

  if (!paneId || !/^\d+$/.test(paneId)) {
    throw new Error(`Unexpected zellij pane id: ${paneId || "(empty)"}`);
  }

  const surface = `pane:${paneId}`;

  if (direction === "left" || direction === "up") {
    try {
      zellijActionSync(["move-pane", direction], surface);
    } catch {
      // Optional layout polish.
    }
  }

  try {
    zellijActionSync(["rename-pane", name], surface);
  } catch {
    // Optional.
  }

  return surface;
}

/**
 * Rename the current tab/window.
 */
export function renameCurrentTab(title: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    const surfaceId = process.env.CMUX_SURFACE_ID;
    if (!surfaceId) throw new Error("CMUX_SURFACE_ID not set");
    execSync(`cmux rename-tab --surface ${shellEscape(surfaceId)} ${shellEscape(title)}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "tmux") {
    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    const windowId = execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{window_id}"], {
      encoding: "utf8",
    }).trim();
    execFileSync("tmux", ["rename-window", "-t", windowId, title], { encoding: "utf8" });
    return;
  }

  if (backend === "wezterm") {
    const paneId = process.env.WEZTERM_PANE;
    const args = ["cli", "set-tab-title"];
    if (paneId) args.push("--pane-id", paneId);
    args.push(title);
    execFileSync("wezterm", args, { encoding: "utf8" });
    return;
  }

  zellijActionSync(["rename-tab", title]);
}

/**
 * Rename the current workspace/session where supported.
 */
export function renameWorkspace(title: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    execSync(`cmux workspace-action --action rename --title ${shellEscape(title)}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "tmux") {
    if (process.env.PI_SUBAGENT_RENAME_TMUX_SESSION !== "1") {
      return;
    }

    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    const sessionId = execFileSync(
      "tmux",
      ["display-message", "-p", "-t", paneId, "#{session_id}"],
      {
        encoding: "utf8",
      },
    ).trim();
    execFileSync("tmux", ["rename-session", "-t", sessionId, title], { encoding: "utf8" });
    return;
  }

  if (backend === "wezterm") {
    const paneId = process.env.WEZTERM_PANE;
    const args = ["cli", "set-window-title"];
    if (paneId) args.push("--pane-id", paneId);
    args.push(title);
    try {
      execFileSync("wezterm", args, { encoding: "utf8" });
    } catch {
      // Optional — window title is cosmetic.
    }
    return;
  }

  // Skip session rename for zellij. rename-session renames the socket file
  // but the ZELLIJ_SESSION_NAME env var in the parent process keeps the old
  // name, so all subsequent `zellij action ...` CLI calls fail with
  // "There is no active session!" because the CLI can't find the socket.
  // Additionally, pi titles often contain special characters (em dashes,
  // spaces) that fail zellij's session name validation on lookup.
  // rename-tab (called separately) is sufficient for user-visible naming.
}

/**
 * Send a command string to a pane and execute it.
 */
export function sendCommand(surface: string, command: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    execSync(`cmux send --surface ${shellEscape(surface)} ${shellEscape(command + "\n")}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "tmux") {
    execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
    execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
    return;
  }

  if (backend === "wezterm") {
    execFileSync("wezterm", ["cli", "send-text", "--pane-id", surface, "--no-paste", command + "\n"], {
      encoding: "utf8",
    });
    return;
  }

  zellijActionSync(["write-chars", command], surface);
  zellijActionSync(["write", "13"], surface);
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    execSync(`cmux close-surface --surface ${shellEscape(surface)}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "tmux") {
    execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
    return;
  }

  if (backend === "wezterm") {
    const idx = currentTabPanes.indexOf(surface);
    if (idx !== -1) currentTabPanes.splice(idx, 1);
    execFileSync("wezterm", ["cli", "kill-pane", "--pane-id", surface], {
      encoding: "utf8",
    });
    return;
  }

  zellijActionSync(["close-pane"], surface);
}
