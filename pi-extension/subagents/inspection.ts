import { constants } from "node:fs";
import { isUtf8 } from "node:buffer";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";

export const OPTIONAL_CHILD_INSPECTION_TOOLS = ["subagent_search", "subagent_git_inspect"] as const;
export const INSPECTION_MAX_BYTES = 50 * 1024;
export const INSPECTION_MAX_LINES = 1000;
const MAX_ENTRIES = 20_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_READ_BYTES = 16 * 1024 * 1024;
const MAX_PROCESS_BYTES = 1024 * 1024;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
const DEPENDENCY_DIRECTORIES = new Set(["node_modules", ".venv", "venv", ".cache"]);
class SymlinkPathError extends Error {}
class GitInspectionError extends Error {
  readonly code: string | number | undefined;
  readonly notRepository: boolean;
  constructor(message: string, code: string | number | undefined, notRepository = false) {
    super(message); this.code = code; this.notRepository = notRepository;
  }
}
interface GitOutput { text: string; bytes: Buffer; truncated: boolean; }

export interface InspectionResult {
  text: string;
  truncated: boolean;
  limitations: string[];
}

function checkObject(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an argument object.");
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`Unsupported argument: ${key}`);
  }
}

function boundedString(value: unknown, label: string, max: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.length) || value.length > max || CONTROL.test(value)) {
    throw new Error(`${label} must be a ${empty ? "possibly empty " : "non-empty "}string of at most ${max} characters without control characters.`);
  }
  return value;
}

function limit(value: unknown): number {
  if (value === undefined) return 200;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > INSPECTION_MAX_LINES) {
    throw new Error(`limit must be an integer from 1 to ${INSPECTION_MAX_LINES}.`);
  }
  return value as number;
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function supportedRelativePath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && !CONTROL.test(path) && !isAbsolute(path)
    && !path.includes("\\") && !path.split("/").some((part) => part === ".." || part === ".git");
}

// Refuse all requested symlinks, including links pointing back inside the root.
// O_NOFOLLOW also protects a file replaced between validation and opening. These
// checks are not an OS sandbox: concurrent ancestor replacement and hard links
// require a separate filesystem/process isolation boundary.
async function checkedPath(root: string, raw: unknown = ".", allowMissing = false): Promise<string> {
  const path = boundedString(raw, "path", 4096);
  if (!supportedRelativePath(path)) {
    throw new Error("path must stay within child cwd, without traversal, backslashes or .git components.");
  }
  const target = resolve(root, path);
  if (!inside(root, target)) throw new Error("path is outside child cwd.");
  let cursor = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    let stat;
    try { stat = await lstat(cursor); }
    catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return target;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new SymlinkPathError("path cannot traverse a symbolic link.");
    if (!inside(root, await realpath(cursor))) throw new Error("path resolved outside child cwd.");
  }
  return target;
}

function escaped(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// Includes the notice in the hard output cap. No spill files are written.
export function boundedOutput(text: string, alreadyTruncated = false): InspectionResult {
  const safe = escaped(text);
  const notice = "\n[Output incomplete: limit reached; narrow path/query or inspect another commit.]";
  const lines = safe.split("\n");
  const byteLimit = INSPECTION_MAX_BYTES - Buffer.byteLength(notice);
  let output = lines.slice(0, INSPECTION_MAX_LINES - 1).join("\n");
  let truncated = alreadyTruncated || lines.length > INSPECTION_MAX_LINES - 1;
  if (Buffer.byteLength(output) > byteLimit) {
    output = Buffer.from(output).subarray(0, byteLimit).toString("utf8").replace(/\uFFFD$/, "");
    truncated = true;
  }
  return { text: (output || "No results.") + (truncated ? notice : ""), truncated, limitations: [] };
}

interface WalkState {
  entries: number;
  skippedLinks: number;
  skippedNames: number;
  prunedDirectories: number;
  catalogTruncated: boolean;
  mode: string;
}
async function* files(root: string, path: string, state: WalkState, signal?: AbortSignal): AsyncGenerator<string> {
  signal?.throwIfAborted();
  if (++state.entries > MAX_ENTRIES) throw new Error("Entry limit reached; narrow path.");
  const checked = await checkedPath(root, relative(root, path) || ".");
  const stat = await lstat(checked);
  if (stat.isFile()) { yield checked; return; }
  if (!stat.isDirectory()) return;
  // Preserve directory-entry bytes too: fallback must never decode an invalid
  // filename into a different, valid Unicode path.
  // Node supports "buffer" here, but the installed OpenDirOptions typing only
  // lists string encodings. Each actual entry is checked as a Buffer below.
  const directory = await opendir(checked, { encoding: "buffer" as BufferEncoding });
  for await (const entry of directory) {
    signal?.throwIfAborted();
    const rawName: unknown = entry.name;
    if (!Buffer.isBuffer(rawName)) throw new Error("Filesystem entry encoding was not byte-preserving; search refused.");
    if (!isUtf8(rawName)) {
      if (++state.entries > MAX_ENTRIES) throw new Error("Entry limit reached; narrow path.");
      state.skippedNames++; continue;
    }
    const name = rawName.toString("utf8");
    if (name === ".git") {
      if (entry.isSymbolicLink()) throw new Error(".git cannot be a symbolic link.");
      continue;
    }
    if (entry.isSymbolicLink()) {
      if (++state.entries > MAX_ENTRIES) throw new Error("Entry limit reached; narrow path.");
      state.skippedLinks++; continue;
    }
    const child = join(checked, name);
    if (!supportedRelativePath(relative(root, child))) {
      if (++state.entries > MAX_ENTRIES) throw new Error("Entry limit reached; narrow path.");
      state.skippedNames++; continue;
    }
    if (entry.isDirectory()) {
      if (DEPENDENCY_DIRECTORIES.has(name) || (name === "git" && checked.endsWith(`${sep}.pi`))) {
        if (++state.entries > MAX_ENTRIES) throw new Error("Entry limit reached; narrow path.");
        state.prunedDirectories++; continue;
      }
      const nestedGit = await lstat(join(child, ".git")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (nestedGit) {
        if (++state.entries > MAX_ENTRIES) throw new Error("Entry limit reached; narrow path.");
        state.prunedDirectories++; continue;
      }
    }
    yield* files(root, child, state, signal);
  }
}

async function* searchFiles(root: string, path: string, state: WalkState, signal?: AbortSignal): AsyncGenerator<string> {
  signal?.throwIfAborted();
  if ((await lstat(path)).isFile()) { yield path; return; }
  let worktree: string;
  try {
    const discovered = await git(root, ["rev-parse", "--show-toplevel"], signal);
    if (discovered.truncated) throw new Error("Git repository discovery exceeded output limit.");
    worktree = await realpath(discovered.text.trim());
  } catch (error) {
    if (!(error instanceof GitInspectionError) || (!error.notRepository && error.code !== "ENOENT")) throw error;
    state.mode = "No Git repository or missing Git executable; filesystem fallback prunes dependency/cache directories, .pi/git and nested checkouts";
    yield* files(root, path, state, signal);
    return;
  }
  if (!inside(worktree, root)) throw new Error("Git worktree is outside child cwd ancestry.");
  state.mode = "Git tracked and non-ignored untracked files; ignored files/directories and nested untracked checkouts excluded";
  const scope = relative(root, path).split(sep).join("/") || ".";
  const catalog = await git(root, [`--work-tree=${worktree}`, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", scope], signal);
  state.catalogTruncated = catalog.truncated;
  // Validate the entire complete-name prefix before opening ANY catalogue
  // path. Lossy decoding could alias an ignored U+FFFD filename to a raw 0xff
  // filename. Discard the partial final name when subprocess capture is capped.
  const complete = catalog.bytes.subarray(0, catalog.bytes.lastIndexOf(0) + 1);
  if (!isUtf8(complete)) throw new Error("Git catalogue contains non-UTF-8 filenames; search refused before opening catalogue paths.");
  const names = complete.toString("utf8").split("\0");
  names.pop();
  for (const name of new Set(names)) {
    signal?.throwIfAborted();
    if (++state.entries > MAX_ENTRIES) { state.catalogTruncated = true; break; }
    if (name.split("/").includes(".git")) continue;
    if (!supportedRelativePath(name)) { state.skippedNames++; continue; }
    try {
      const checked = await checkedPath(root, name);
      if ((await lstat(checked)).isFile()) yield checked;
    } catch (error) {
      if (error instanceof SymlinkPathError) { state.skippedLinks++; continue; }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

export interface SearchArgs {
  operation: "files" | "content";
  path?: string;
  query?: string;
  caseSensitive?: boolean;
  limit?: number;
}

export async function searchChild(cwd: string, args: SearchArgs, signal?: AbortSignal): Promise<InspectionResult> {
  checkObject(args, ["operation", "path", "query", "caseSensitive", "limit"]);
  if (args.operation !== "files" && args.operation !== "content") throw new Error("Unknown search operation.");
  const query = boundedString(args.query ?? "", "query", 1024, args.operation === "files");
  if (args.caseSensitive !== undefined && typeof args.caseSensitive !== "boolean") throw new Error("caseSensitive must be boolean.");
  const max = limit(args.limit);
  const root = await realpath(cwd);
  const path = await checkedPath(root, args.path);
  const state: WalkState = { entries: 0, skippedLinks: 0, skippedNames: 0, prunedDirectories: 0, catalogTruncated: false, mode: "Explicit regular file" };
  const output: string[] = [];
  let bytesRead = 0;
  let outputBytes = 0;
  let skippedFiles = 0;
  let truncated = false;
  const needle = args.caseSensitive === false ? query.toLowerCase() : query;
  const matches = (text: string) => (args.caseSensitive === false ? text.toLowerCase() : text).includes(needle);
  const add = (text: string) => {
    if (output.length >= max || outputBytes + Buffer.byteLength(text) > INSPECTION_MAX_BYTES) { truncated = true; return false; }
    output.push(text);
    outputBytes += Buffer.byteLength(text) + 1;
    return true;
  };
  for await (const file of searchFiles(root, path, state, signal)) {
    const name = relative(root, file).split(sep).join("/");
    if (args.operation === "files") {
      if (matches(name) && !add(JSON.stringify(name))) break;
      continue;
    }
    const handle = await open(await checkedPath(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let buffer: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) { skippedFiles++; continue; }
      if (bytesRead >= MAX_READ_BYTES || bytesRead + stat.size > MAX_READ_BYTES) { truncated = true; break; }
      // Fixed-size read bounds files which grow after stat; never readFile on a device.
      const remaining = MAX_READ_BYTES - bytesRead;
      buffer = Buffer.alloc(Math.min(MAX_FILE_BYTES + 1, remaining));
      const { bytesRead: count } = await handle.read(buffer, 0, buffer.length, 0);
      bytesRead += count;
      buffer = buffer.subarray(0, count);
      if (count === remaining) { truncated = true; break; }
      if (count > MAX_FILE_BYTES || buffer.includes(0)) { skippedFiles++; continue; }
    } finally { await handle.close(); }
    for (const [index, line] of buffer.toString("utf8").split("\n").entries()) {
      if (matches(line) && !add(`${JSON.stringify(name)}:${index + 1}:${JSON.stringify(line)}`)) break;
    }
    if (truncated) break;
  }
  const result = boundedOutput(output.join("\n"), truncated || state.catalogTruncated);
  result.limitations = [`Literal search; ${state.mode}. .git excluded, discovered symlinks skipped (${state.skippedLinks}), unsupported filenames skipped (${state.skippedNames}), fallback directories pruned (${state.prunedDirectories}); binary/oversized files skipped (${skippedFiles}).`, "Scan caps: 20,000 entries, 1 MiB/file and Git catalogue capture, 16 MiB total content. Catalogue exhaustion reports incomplete output; fallback entry-cap exhaustion fails. Explicit regular files can be searched even if ignored."];
  return result;
}

// No inherited Git configuration/environment injection, pager or shell. Local
// repository config/attributes still provide Git metadata; dangerous execution
// features are overridden on every invocation, including discovery commands.
export function inspectionGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1", GIT_LITERAL_PATHSPECS: "1", GIT_PAGER: "cat",
  };
}
const GIT_PREFIX = [
  "--no-pager", "--no-optional-locks",
  "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
  "-c", "core.hooksPath=/dev/null", "-c", "core.pager=cat",
  "-c", "core.attributesFile=/dev/null", "-c", "core.quotePath=true",
  "-c", "diff.external=", "-c", "color.ui=false", "-c", "log.showSignature=false",
];

async function runGit(cwd: string, argv: string[], signal?: AbortSignal): Promise<GitOutput> {
  return new Promise((done, reject) => {
    execFile("git", [...GIT_PREFIX, ...argv], {
      cwd, env: inspectionGitEnvironment(), encoding: "buffer", maxBuffer: MAX_PROCESS_BYTES,
      timeout: 10_000, signal, windowsHide: true,
    }, (error, stdout, stderr) => {
      const output = { text: stdout.toString("utf8"), bytes: stdout, truncated: false };
      if (error) {
        if ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          done({ ...output, truncated: true });
        } else {
          const diagnostic = stderr.toString("utf8");
          // Exit 128 also covers malformed config, invalid gitdir pointers, etc.
          // Only these complete, C-locale discovery diagnostics positively mean
          // no repository. Never classify filter/config-query failures this way.
          const notRepository = error.code === 128 && argv.includes("rev-parse") && argv.includes("--show-toplevel")
            && (/^fatal: not a git repository \(or any of the parent directories\): \.git\n?$/.test(diagnostic)
              || /^fatal: not a git repository \(or any parent up to mount point [^\n]+\)\nStopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.\n?$/.test(diagnostic));
          reject(new GitInspectionError(`Git inspection failed: ${boundedOutput(diagnostic || error.message).text}`, error.code, notRepository));
        }
      } else done(output);
    });
  });
}

// Clean/process filters are independent of external diff/textconv. Enumerate
// effective local/include/worktree config without evaluating attributes, then
// override every configured executable filter before any inspection command.
async function git(cwd: string, argv: string[], signal?: AbortSignal): Promise<GitOutput> {
  const config = await runGit(cwd, ["config", "--includes", "--null", "--get-regexp", "^filter\\..*\\.(clean|process)$"], signal).catch((error) => {
    if (error instanceof GitInspectionError && error.code === 1) return { text: "", bytes: Buffer.alloc(0), truncated: false };
    throw error;
  });
  if (config.truncated) throw new Error("Git filter configuration exceeded capture limit; inspection refused.");
  const drivers = new Set<string>();
  for (const entry of config.text.split("\0").filter(Boolean)) {
    const key = entry.slice(0, entry.indexOf("\n"));
    const match = /^filter\.(.+)\.(?:clean|process)$/.exec(key);
    if (!match || !/^[A-Za-z0-9_./-]+$/.test(match[1])) throw new Error("Unsupported Git filter driver name; inspection refused.");
    drivers.add(match[1]);
    if (drivers.size > 512) throw new Error("Too many Git filter drivers; inspection refused.");
  }
  const overrides = [...drivers].flatMap((driver) => [
    "-c", `filter.${driver}.clean=`, "-c", `filter.${driver}.process=`,
    "-c", `filter.${driver}.smudge=`, "-c", `filter.${driver}.required=false`,
  ]);
  return runGit(cwd, [...overrides, ...argv], signal);
}

export interface GitInspectArgs {
  operation: "status" | "log" | "diff_unstaged" | "diff_staged" | "diff_commit" | "diff_between";
  path?: string;
  commit?: string;
  base?: string;
  limit?: number;
}
function commit(value: unknown): string {
  const ref = boundedString(value, "commit/base", 64);
  if (!/^(?:HEAD(?:~(?:0|[1-9][0-9]{0,3}))?|[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(ref)) {
    throw new Error("commit/base must be HEAD, HEAD~N (0–9999), or a full 40/64-character object ID.");
  }
  return ref;
}

export async function inspectChildGit(cwd: string, args: GitInspectArgs, signal?: AbortSignal): Promise<InspectionResult> {
  checkObject(args, ["operation", "path", "commit", "base", "limit"]);
  if (!["status", "log", "diff_unstaged", "diff_staged", "diff_commit", "diff_between"].includes(args.operation)) throw new Error("Unknown Git inspection operation.");
  if (args.commit !== undefined && !["diff_commit", "diff_between"].includes(args.operation)) throw new Error("commit is only valid for commit diffs.");
  if (args.base !== undefined && args.operation !== "diff_between") throw new Error("base is only valid for diff_between.");
  if (args.limit !== undefined && args.operation !== "log") throw new Error("limit is only valid for log.");
  const ref = ["diff_commit", "diff_between"].includes(args.operation) ? commit(args.commit ?? "HEAD") : undefined;
  const base = args.operation === "diff_between" ? commit(args.base) : undefined;
  const count = limit(args.limit);
  const root = await realpath(cwd);
  const path = await checkedPath(root, args.path, true);
  // Validate only the explicitly selected path/ancestors. Git represents
  // symlinks as link text/type changes; it does not follow them as source files.
  // Ignored dependencies must not trigger a recursive pre-scan. External
  // diff/textconv, executable filters and submodule recursion remain disabled.
  const discovered = await git(root, ["rev-parse", "--show-toplevel"], signal);
  if (discovered.truncated) throw new Error("Git repository discovery exceeded output limit.");
  const worktree = await realpath(discovered.text.trim());
  if (!inside(worktree, root)) throw new Error("Git worktree is outside child cwd ancestry.");
  // Pin the discovered checkout, preventing core.worktree from redirecting the
  // actual inspection. Linked-worktree Git metadata remains intentionally shared.
  const prefix = [`--work-tree=${worktree}`];
  const resolveCommit = async (value: string) => {
    const resolved = await git(root, [...prefix, "rev-parse", "--verify", `${value}^{commit}`], signal);
    const oid = resolved.text.trim();
    if (resolved.truncated || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) throw new Error("Invalid resolved commit ID.");
    return oid;
  };
  const resolvedRef = ref === undefined ? undefined : await resolveCommit(ref);
  const resolvedBase = base === undefined ? undefined : await resolveCommit(base);
  const scope = relative(root, path).split(sep).join("/") || ".";
  const diffFlags = ["--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=all", "--no-color", "--relative", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3"];
  let argv: string[];
  switch (args.operation) {
    case "status": argv = ["status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=all", "--no-renames"]; break;
    case "log": argv = ["log", "--no-show-signature", `--max-count=${count}`, "--format=%H %s"]; break;
    case "diff_unstaged": argv = ["diff", ...diffFlags]; break;
    case "diff_staged": argv = ["diff", "--cached", ...diffFlags]; break;
    case "diff_commit": argv = ["show", "--no-show-signature", "--format=fuller", ...diffFlags, resolvedRef!]; break;
    case "diff_between": argv = ["diff", ...diffFlags, resolvedBase!, resolvedRef!]; break;
  }
  const output = await git(root, [...prefix, ...argv, "--", scope], signal);
  const result = boundedOutput(output.text, output.truncated);
  result.limitations = ["Only child-cwd paths; explicitly selected symlink paths/ancestors refused. Git reports discovered links as link text/type changes without reading their targets. Status filenames are repository-root-relative. No submodule inspection, rename detection, external diff, textconv, clean/process filters, signatures, pager, hooks, fsmonitor or index refresh. Configured filters are disabled, so raw diff/status may differ from normal Git. Untracked contents are not part of Git diffs.", "Git reads repository/shared worktree metadata and local config; this is not an OS sandbox. 10-second/process timeout, 1 MiB subprocess capture; no spill files. Partial-clone lazy fetching disabled."];
  return result;
}
