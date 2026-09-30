import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A separate checkout, not an OS-level filesystem or permission sandbox. */
export function createManagedWorktree(cwd: string, runId: string): { path: string; cwd: string } {
  // Fail closed: an explicit cwd must already exist in a non-bare Git checkout.
  const source = realpathSync(cwd);
  const root = realpathSync(git(source, "rev-parse", "--show-toplevel"));
  if (git(source, "rev-parse", "--is-bare-repository") !== "false") throw new Error("Worktree isolation requires a non-bare Git checkout.");
  git(source, "rev-parse", "--verify", "HEAD^{commit}");
  const suffix = relative(root, source);
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error("Child cwd escapes the Git checkout.");
  const commonDir = realpathSync(git(source, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const container = join(commonDir, "pi-subagent-checkouts");
  mkdirSync(container, { recursive: true, mode: 0o700 });
  if (realpathSync(container) !== container) throw new Error(`Managed worktree directory is a symlink: ${container}`);
  const path = join(container, runId);
  if (existsSync(path)) throw new Error(`Managed worktree already exists: ${path}`);
  // Detached at the source checkout's HEAD. Dirty/ignored parent files are not copied.
  try { git(source, "worktree", "add", "--detach", "--", path, "HEAD"); }
  catch (error) {
    if (existsSync(path) && !discardCleanManagedWorktree(path)) {
      throw new Error(`Git worktree creation failed; inspect preserved path ${path}: ${String(error)}`, { cause: error });
    }
    throw error;
  }
  const childCwd = resolve(path, suffix);
  // Tracked subdirectories exist after checkout; an untracked-only cwd is not reproducible.
  if (!existsSync(childCwd) || realpathSync(childCwd) !== childCwd) {
    // Do not force removal if checkout hooks or other processes left files behind.
    const removed = discardCleanManagedWorktree(path);
    throw new Error(`Child cwd is not present as an ordinary directory in the new checkout: ${suffix}.${removed ? "" : ` Worktree preserved at ${path}.`}`);
  }
  return { path, cwd: childCwd };
}

/** Roll back only an unchanged, registered checkout. Never discard child edits. */
export function discardCleanManagedWorktree(path: string): boolean {
  try {
    const common = realpathSync(git(path, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    if (resolve(path) !== join(common, "pi-subagent-checkouts", path.split(sep).at(-1)!)) return false;
    const status = git(path, "status", "--porcelain", "--untracked-files=all", "--ignored=matching");
    if (status) return false;
    git(path, "worktree", "remove", "--", path);
    try { rmdirSync(join(common, "pi-subagent-checkouts")); } catch { /* other checkouts remain */ }
    return true;
  } catch { return false; }
}

/** Resume must never silently fall back to the parent's checkout. */
export function assertManagedWorktree(path: string, cwd: string): void {
  try {
    const root = realpathSync(git(cwd, "rev-parse", "--show-toplevel"));
    const common = realpathSync(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    const canonicalPath = realpathSync(path);
    if (canonicalPath !== resolve(path) || root !== canonicalPath ||
        resolve(path) !== join(common, "pi-subagent-checkouts", path.split(sep).at(-1)!) ||
        !git(cwd, "worktree", "list", "--porcelain").split("\n").includes(`worktree ${root}`)) {
      throw new Error("not a registered checkout");
    }
  } catch {
    throw new Error(`Managed worktree unavailable: ${path}. Restore it before resuming; the parent checkout will not be used.`);
  }
}
