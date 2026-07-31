import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

function assertRelativeArtifactName(name: string): void {
  if (!name || name.includes("\0") || isAbsolute(name)) {
    throw new Error(`Artifact name must be a non-empty relative path: ${name}`);
  }
}

function isContained(baseDir: string, candidate: string): boolean {
  const rel = relative(baseDir, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function assertDirectoryWithoutSymlink(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`Artifact path contains a symbolic link: ${path}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Artifact path component is not a directory: ${path}`);
  }
}

function ensureDirectoryWithoutSymlinks(baseDir: string, targetDir: string): void {
  if (!existsSync(baseDir)) {
    throw new Error(`Artifact directory does not exist: ${baseDir}`);
  }
  assertDirectoryWithoutSymlink(baseDir);

  const rel = relative(baseDir, targetDir);
  if (rel === "") return;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Artifact path escapes the artifact directory: ${targetDir}`);
  }

  let current = baseDir;
  for (const component of rel.split(sep).filter(Boolean)) {
    current = join(current, component);
    if (!existsSync(current)) mkdirSync(current);
    assertDirectoryWithoutSymlink(current);
  }
}

function assertExistingPathWithoutSymlinks(baseDir: string, filePath: string): void {
  assertDirectoryWithoutSymlink(baseDir);
  const rel = relative(baseDir, filePath);
  let current = baseDir;
  for (const component of rel.split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Artifact path contains a symbolic link: ${current}`);
    }
  }

  const realBase = realpathSync(baseDir);
  const realFile = realpathSync(filePath);
  if (!isContained(realBase, realFile)) {
    throw new Error(`Artifact path escapes the artifact directory: ${filePath}`);
  }
}

/** Return `<session-file-without-.jsonl>/artifacts`. */
export function getSessionArtifactDir(sessionFile: string): string {
  const absoluteSessionFile = resolve(sessionFile);
  const stem = absoluteSessionFile.endsWith(".jsonl")
    ? absoluteSessionFile.slice(0, -".jsonl".length)
    : absoluteSessionFile;
  return join(stem, "artifacts");
}

/**
 * Create the owning session sidecar and artifact directory one component at a
 * time, refusing existing symbolic links.
 */
export function ensureSessionArtifactDir(sessionFile: string): string {
  const absoluteSessionFile = resolve(sessionFile);
  const artifactDir = getSessionArtifactDir(absoluteSessionFile);
  const sidecarDir = dirname(artifactDir);
  const sessionDir = dirname(absoluteSessionFile);

  if (!existsSync(sessionDir)) {
    throw new Error(`Session directory does not exist: ${sessionDir}`);
  }
  assertDirectoryWithoutSymlink(sessionDir);

  if (!existsSync(sidecarDir)) mkdirSync(sidecarDir);
  assertDirectoryWithoutSymlink(sidecarDir);

  if (!existsSync(artifactDir)) mkdirSync(artifactDir);
  assertDirectoryWithoutSymlink(artifactDir);
  return artifactDir;
}

/** Resolve a relative artifact name with lexical containment. */
export function resolveArtifactPath(artifactDir: string, name: string): string {
  assertRelativeArtifactName(name);
  const absoluteArtifactDir = resolve(artifactDir);
  const filePath = resolve(absoluteArtifactDir, name);
  if (!isContained(absoluteArtifactDir, filePath)) {
    throw new Error(`Artifact name escapes the artifact directory: ${name}`);
  }
  return filePath;
}

/** Resolve a write target and reject symlinked path components. */
export function prepareArtifactWritePath(artifactDir: string, name: string): string {
  const absoluteArtifactDir = resolve(artifactDir);
  const filePath = resolveArtifactPath(absoluteArtifactDir, name);
  ensureDirectoryWithoutSymlinks(absoluteArtifactDir, dirname(filePath));
  if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`Artifact path contains a symbolic link: ${filePath}`);
  }
  return filePath;
}

/**
 * Write an artifact by atomically replacing the final path.  The temporary file
 * is created inside the validated parent directory, so a final-path symlink
 * swapped in after validation is replaced rather than followed.
 */
export function writeArtifactFile(artifactDir: string, name: string, content: string): string {
  const filePath = prepareArtifactWritePath(artifactDir, name);
  const parentDir = dirname(filePath);
  const tempPath = join(parentDir, `.artifact-${randomBytes(16).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    writeFileSync(fd, content, "utf8");
    closeSync(fd);
    fd = undefined;

    // Recheck the parent immediately before rename; rename never dereferences
    // the final destination, so it cannot write through a swapped leaf symlink.
    ensureDirectoryWithoutSymlinks(resolve(artifactDir), parentDir);
    renameSync(tempPath, filePath);
    return filePath;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tempPath);
    } catch {}
    throw error;
  }
}

/** Resolve an existing regular artifact and reject all symlink traversal. */
export function resolveExistingArtifactPath(artifactDir: string, name: string): string {
  const absoluteArtifactDir = resolve(artifactDir);
  const filePath = resolveArtifactPath(absoluteArtifactDir, name);
  if (!existsSync(filePath)) {
    throw new Error(`Listed artifact does not exist: ${name}`);
  }
  assertExistingPathWithoutSymlinks(absoluteArtifactDir, filePath);
  if (!statSync(filePath).isFile()) {
    throw new Error(`Listed artifact is not a file: ${name}`);
  }
  return filePath;
}
