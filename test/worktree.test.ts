import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createManagedWorktree, discardCleanManagedWorktree, assertManagedWorktree } from '../pi-extension/subagents/worktree.ts';

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function fixture(fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'pi-managed-worktree-'));
  try {
    git(root, 'init', '-q');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'tracked.txt'), 'base\n');
    git(root, 'add', 'src/tracked.txt');
    git(root, '-c', 'user.email=test@example.org', '-c', 'user.name=Test', 'commit', '-qm', 'base');
    fn(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('managed checkout starts detached at HEAD, maps tracked subdirectories and does not copy dirty parent files', () => fixture(root => {
  writeFileSync(join(root, 'src', 'tracked.txt'), 'dirty parent\n');
  writeFileSync(join(root, 'src', 'untracked.txt'), 'parent only\n');
  const child = createManagedWorktree(join(root, 'src'), crypto.randomUUID());
  assert.equal(child.cwd, join(child.path, 'src'));
  assert.equal(readFileSync(join(child.cwd, 'tracked.txt'), 'utf8'), 'base\n');
  assert.equal(existsSync(join(child.cwd, 'untracked.txt')), false);
  assert.equal(git(child.path, 'rev-parse', 'HEAD'), git(root, 'rev-parse', 'HEAD'));
  assertManagedWorktree(child.path, child.cwd);
  assert.equal(discardCleanManagedWorktree(child.path), true);
  assert.equal(existsSync(child.path), false);
  assert.equal(readFileSync(join(root, 'src', 'tracked.txt'), 'utf8'), 'dirty parent\n');
}));

test('rollback refuses modified, untracked and ignored child files, and resume fails if checkout disappears', () => fixture(root => {
  const modified = createManagedWorktree(root, crypto.randomUUID());
  writeFileSync(join(modified.path, 'src', 'tracked.txt'), 'child edit');
  assert.equal(discardCleanManagedWorktree(modified.path), false);
  assert.ok(existsSync(modified.path));
  const untracked = createManagedWorktree(root, crypto.randomUUID());
  writeFileSync(join(untracked.path, 'new.txt'), 'untracked');
  assert.equal(discardCleanManagedWorktree(untracked.path), false);
  const ignored = createManagedWorktree(root, crypto.randomUUID());
  writeFileSync(join(ignored.path, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(ignored.path, 'ignored.txt'), 'ignored');
  assert.equal(discardCleanManagedWorktree(ignored.path), false);
  const clean = createManagedWorktree(root, crypto.randomUUID());
  assert.equal(discardCleanManagedWorktree(clean.path), true);
  assert.throws(() => assertManagedWorktree(clean.path, clean.cwd), /Managed worktree unavailable/);
}));

test('resume rejects a symlink from the removed checkout to the parent repository', () => fixture(root => {
  const child = createManagedWorktree(root, crypto.randomUUID());
  const path = child.path;
  git(root, 'worktree', 'remove', path);
  symlinkSync(root, path, 'dir');
  assert.throws(() => assertManagedWorktree(path, path), /Managed worktree unavailable/);
}));

test('nested delegation creates a distinct sibling checkout and leaves the first child alone', () => fixture(root => {
  const parentChild = createManagedWorktree(root, crypto.randomUUID());
  writeFileSync(join(parentChild.path, 'src', 'tracked.txt'), 'first child edit');
  const nested = createManagedWorktree(join(parentChild.path, 'src'), crypto.randomUUID());
  assert.notEqual(nested.path, parentChild.path);
  assert.equal(readFileSync(join(nested.cwd, 'tracked.txt'), 'utf8'), 'base\n');
  assert.equal(readFileSync(join(parentChild.path, 'src', 'tracked.txt'), 'utf8'), 'first child edit');
  assert.equal(discardCleanManagedWorktree(nested.path), true);
  assert.equal(discardCleanManagedWorktree(parentChild.path), false);
}));

test('invalid source and untracked-only cwd do not create a child session checkout', () => fixture(root => {
  assert.throws(() => createManagedWorktree(tmpdir(), crypto.randomUUID()));
  mkdirSync(join(root, 'newdir'));
  assert.throws(() => createManagedWorktree(join(root, 'newdir'), crypto.randomUUID()), /not present/);
  assert.equal(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)?.length, 1);
}));
