import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface LaunchSpec {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  unset: string[];
}

/** Secrets and task arguments never enter a shell line or the mux CLI argv. */
export function prepareLaunch(spec: LaunchSpec) {
  const directory = mkdtempSync(join(tmpdir(), "pi-subagent-launch-"));
  const path = join(directory, "launch.json");
  try {
    writeFileSync(path, JSON.stringify(spec), { flag: "wx", mode: 0o600 });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    directory,
    argv: [process.execPath, join(dirname(fileURLToPath(import.meta.url)), "launch-process.mjs"), path],
    failure: () => {
      try { return JSON.parse(readFileSync(join(directory, "error.json"), "utf8")).error as string; }
      catch { return undefined; }
    },
    dispose: () => rmSync(directory, { recursive: true, force: true }),
    disposeIfConsumed: () => { if (!existsSync(path)) rmSync(directory, { recursive: true, force: true }); },
  };
}

/** Waiting for startup is not task completion. Aborting this wait is handled by the caller. */
export async function waitForConnection(options: {
  connected: () => boolean;
  failure: () => string | undefined;
  signal?: AbortSignal;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  while (true) {
    if (options.signal?.aborted) throw new Error("Subagent startup cancelled.");
    if (options.connected()) return;
    const failure = options.failure();
    if (failure) throw new Error(failure);
    if (Date.now() >= deadline) throw new Error("Subagent did not connect before the startup deadline. No task execution or success is confirmed.");
    await new Promise<void>((resolve) => setTimeout(resolve, options.intervalMs ?? 50));
  }
}
