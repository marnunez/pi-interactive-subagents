import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadAgentDefaults, resolveChildTools, restoreChildTools } from "../pi-extension/subagents/config.ts";
import { withChildOnlyTools } from "../pi-extension/subagents/policy.ts";
import { registerInspectionTools } from "../pi-extension/subagents/inspection-tools.ts";
import { boundedOutput, inspectionGitEnvironment, inspectChildGit, INSPECTION_MAX_BYTES, INSPECTION_MAX_LINES, searchChild } from "../pi-extension/subagents/inspection.ts";

async function fixture(action: (root: string, outside: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "pi-inspection-"));
  const root = join(dir, "child"), outside = join(dir, "outside");
  mkdirSync(root); mkdirSync(outside);
  try { await action(root, outside); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function git(root: string, ...argv: string[]): string {
  return execFileSync("git", ["-C", root, ...argv], { encoding: "utf8", env: inspectionGitEnvironment() }).trim();
}
function repository(root: string) {
  git(root, "init", "-q");
  git(root, "config", "user.name", "Inspection Test");
  git(root, "config", "user.email", "inspection@example.org");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "code.txt"), "base\n");
  writeFileSync(join(root, "other.txt"), "outside subdir\n");
  git(root, "add", "."); git(root, "commit", "-qm", "initial");
}

test("inspection tools are explicit, optional child-only capabilities; denials and spawning false win", () => {
  const optional = ["subagent_search", "subagent_git_inspect"];
  assert.ok(withChildOnlyTools([])!.includes(optional[0]));
  assert.ok(resolveChildTools({}, ["read", ...optional], ["read", ...optional]).every((name) => !optional.includes(name)));
  const tools = resolveChildTools({ tools: "read,subagent_search,subagent_git_inspect,subagent", spawning: false }, [], ["read", "subagent"]);
  assert.ok(optional.every((tool) => tools.includes(tool)));
  assert.equal(tools.includes("subagent"), false);
  assert.equal(resolveChildTools({ tools: optional.join(","), denyTools: optional.join(",") }, [], []).some((name) => optional.includes(name)), false);
  assert.equal(resolveChildTools({ tools: "read", allowTools: optional.join(",") }, [], ["read"]).some((name) => optional.includes(name)), false);
  for (const [env, expected] of [
    [{}, []],
    [{ PI_SUBAGENT_TOOLS: optional.join(",") }, []],
    [{ PI_SUBAGENT_ID: "run" }, []],
    [{ PI_SUBAGENT_ID: "run", PI_SUBAGENT_TOOLS: "read" }, []],
    [{ PI_SUBAGENT_ID: "run", PI_SUBAGENT_TOOLS: optional.join(",") }, optional],
    [{ PI_SUBAGENT_ID: "run", PI_SUBAGENT_TOOLS: optional.join(","), PI_DENY_TOOLS: "subagent_search" }, ["subagent_git_inspect"]],
  ] as [NodeJS.ProcessEnv, string[]][]) {
    const registered: string[] = [];
    registerInspectionTools({ registerTool: (tool: { name: string }) => { registered.push(tool.name); } } as ExtensionAPI, env);
    assert.deepEqual(registered, expected);
  }
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = join(process.cwd(), '.test-tmp', 'empty-profile');
    const reviewer = loadAgentDefaults("reviewer", process.cwd(), false)!;
    const selected = resolveChildTools(reviewer, [], ["read", "bash"]);
    assert.ok(optional.every((tool) => selected.includes(tool)));
    assert.equal(selected.includes("bash"), false);
    assert.equal(selected.includes("write_artifact"), false);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("resume preserves a reviewer's effective deny-tools selection and fails closed on unavailable tools", () => {
  const saved = resolveChildTools({ tools: "read,subagent_search,subagent_git_inspect", denyTools: "set_tab_title,write_artifact,read_artifact", spawning: false }, [], ["read"]);
  assert.deepEqual(restoreChildTools(saved, ["read", "bash", "subagent", "database_query"]), saved);
  assert.deepEqual(restoreChildTools(["read"], ["read"]), ["read", "subagent_done"]);
  assert.throws(() => restoreChildTools(["read", "missing_external"], ["read"]), /Unknown tool.*saved tools/);
});

test("literal discovery and content search include hidden files, avoid preprocessors and escape output", async () => {
  await fixture(async root => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "Literal [a-z]+\nHello world\nHELLO\n");
    writeFileSync(join(root, ".hidden"), "Hello\n");
    writeFileSync(join(root, "--pre=touch marker"), "-f malicious\n");
    writeFileSync(join(root, "control"), "Hello\x1b[31m\n");
    mkdirSync(join(root, ".git")); writeFileSync(join(root, ".git", "secret"), "Hello\n");
    const files = await searchChild(root, { operation: "files", query: ".ts" });
    assert.equal(files.text, '"src/a.ts"');
    const content = await searchChild(root, { operation: "content", query: "[a-z]+" });
    assert.match(content.text, /a.ts.*:1:/);
    const insensitive = await searchChild(root, { operation: "content", query: "hello", caseSensitive: false });
    assert.match(insensitive.text, /\.hidden/); assert.match(insensitive.text, /:3:/);
    assert.doesNotMatch(insensitive.text, /secret|\x1b/);
    assert.match(insensitive.text, /\\u001b/);
    assert.match((await searchChild(root, { operation: "content", path: "--pre=touch marker", query: "-f" })).text, /malicious/);
    assert.equal(existsSync(join(root, "marker")), false);
  });
});

test("search refuses hostile paths/arguments and never follows discovered or explicitly requested links", async () => {
  await fixture(async (root, outside) => {
    writeFileSync(join(outside, "secret"), "SECRET");
    writeFileSync(join(root, "safe"), "safe");
    symlinkSync(outside, join(root, "escape"));
    symlinkSync(join(root, "safe"), join(root, "internal-link"));
    for (const path of ["../outside", outside, "escape", "escape/secret", "internal-link", ".git/config", "x/../safe", "..\\outside", "bad\0path"]) {
      await assert.rejects(() => searchChild(root, { operation: "files", path }));
    }
    const discovered = await searchChild(root, { operation: "files" });
    assert.equal(discovered.text, '"safe"');
    const content = await searchChild(root, { operation: "content", query: "SECRET" });
    assert.equal(content.text, "No results.");
    for (const args of [{ operation: "shell" }, { operation: "content", query: "" }, { operation: "files", flags: "--pre=x" }, { operation: "files", cwd: outside }, { operation: "files", limit: 0 }, { operation: "files", caseSensitive: "false" }]) {
      await assert.rejects(() => searchChild(root, args as any));
    }
  });
});

test("Git catalogue refuses invalid filename bytes before they can alias an ignored Unicode file", async () => {
  await fixture(async root => {
    repository(root);
    const alias = 'bad-\uFFFD.txt';
    const rawPath = Buffer.concat([Buffer.from(`${root}/bad-`), Buffer.from([0xff]), Buffer.from('.txt')]);
    writeFileSync(join(root, '.gitignore'), `${alias}\n`);
    writeFileSync(join(root, alias), 'IGNORED_ALIAS_SECRET\n');
    writeFileSync(rawPath, 'raw filename content\n');
    writeFileSync(join(root, 'safe.txt'), 'SAFE_MATCH\n');
    const catalogue = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { env: inspectionGitEnvironment() });
    assert.ok(catalogue.includes(Buffer.from([0xff])));
    assert.equal(catalogue.includes(Buffer.from(alias)), false, 'Unicode alias really is ignored by Git');
    for (const operation of ['files', 'content'] as const) {
      await assert.rejects(() => searchChild(root, { operation, query: operation === 'files' ? 'safe' : 'IGNORED_ALIAS_SECRET' }), /non-UTF-8 filenames.*before opening catalogue paths/);
    }
    rmSync(rawPath);
    assert.equal((await searchChild(root, { operation: 'content', query: 'IGNORED_ALIAS_SECRET' })).text, 'No results.');
    writeFileSync(join(root, 'valid-\uFFFD.txt'), 'SAFE_UNICODE\n');
    assert.match((await searchChild(root, { operation: 'content', query: 'SAFE_UNICODE' })).text, /valid-\uFFFD.txt/);
  });
});

test("unsupported discovered Unix names are skipped/countable without hiding unrelated matches", async () => {
  await fixture(async (root, outside) => {
    repository(root);
    const names = ['bad\nname.txt', 'bad\tname.txt', 'bad\x1bname.txt', 'bad\u0085name.txt', 'bad\\name.txt'];
    for (const name of names) writeFileSync(join(root, name), 'UNSUPPORTED_CONTENT\n');
    mkdirSync(join(root, 'bad\nfolder'));
    writeFileSync(join(root, 'bad\nfolder', 'child.txt'), 'UNSUPPORTED_CONTENT\n');
    writeFileSync(join(root, 'good.txt'), 'SAFE_MATCH\n');
    for (const name of names) await assert.rejects(() => searchChild(root, { operation: 'files', path: name }));
    const content = await searchChild(root, { operation: 'content', query: 'SAFE_MATCH' });
    assert.match(content.text, /good.txt/);
    assert.match(content.limitations.join('\n'), /unsupported filenames skipped \(6\)/);
    const files = await searchChild(root, { operation: 'files', query: 'good' });
    assert.equal(files.text, '"good.txt"');
    assert.equal((await searchChild(root, { operation: 'content', query: 'UNSUPPORTED_CONTENT' })).text, 'No results.');
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = outside;
      // Fallback directory enumeration must also preserve raw filename bytes.
      const rawPath = Buffer.concat([Buffer.from(`${root}/raw-`), Buffer.from([0xff]), Buffer.from('.txt')]);
      writeFileSync(rawPath, 'RAW_CONTENT\n');
      const fallback = await searchChild(root, { operation: 'content', query: 'SAFE_MATCH' });
      assert.match(fallback.text, /good.txt/);
      assert.match(fallback.limitations.join('\n'), /unsupported filenames skipped \(7\)/);
      assert.equal((await searchChild(root, { operation: 'content', query: 'RAW_CONTENT' })).text, 'No results.');
    } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
  });
});

test("malformed repository or included configuration fails instead of scanning ignored secrets", async () => {
  await fixture(async root => {
    repository(root);
    writeFileSync(join(root, '.gitignore'), 'ignored-secrets.txt\n');
    writeFileSync(join(root, 'ignored-secrets.txt'), 'IGNORED_SECRET\n');
    const configPath = join(root, '.git', 'config'), original = readFileSync(configPath, 'utf8');
    writeFileSync(configPath, `${original}\n[malformed\n`);
    for (const operation of ['files', 'content'] as const) {
      await assert.rejects(() => searchChild(root, { operation, query: operation === 'files' ? 'ignored-secrets' : 'IGNORED_SECRET' }), /Git inspection failed: fatal: bad config/);
    }
    writeFileSync(configPath, original);
    const include = join(root, '.git', 'broken-include.config');
    writeFileSync(include, '[malformed\n');
    const branch = git(root, 'symbolic-ref', '--short', 'HEAD');
    git(root, 'config', `includeIf.onbranch:${branch}.path`, include);
    await assert.rejects(() => searchChild(root, { operation: 'content', query: 'IGNORED_SECRET' }), /Git inspection failed: fatal: bad config/);
  });
});

test("filesystem fallback requires a positively identified non-repository discovery failure", async () => {
  await fixture(async (root, outside) => {
    writeFileSync(join(root, 'visible.txt'), 'VISIBLE\n');
    const fakeGit = join(outside, 'git');
    const diagnostic = 'fatal: not a git repository (or any of the parent directories): .git\n';
    writeFileSync(fakeGit, `#!${process.execPath}\nif (process.argv.includes('config')) process.exit(1); process.stderr.write(${JSON.stringify(diagnostic)}); process.exit(128);\n`, { mode: 0o700 });
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = outside;
      const fallback = await searchChild(root, { operation: 'content', query: 'VISIBLE' });
      assert.match(fallback.text, /visible.txt/);
      assert.match(fallback.limitations.join('\n'), /No Git repository/);
      // The same exit/diagnostic from the config stage is NOT repository discovery.
      writeFileSync(fakeGit, `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(diagnostic)}); process.exit(128);\n`, { mode: 0o700 });
      await assert.rejects(() => searchChild(root, { operation: 'content', query: 'VISIBLE' }), /Git inspection failed/);
    } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
  });
});

test("catalogue capture overflow keeps only complete names and reports incomplete results", async () => {
  await fixture(async root => {
    repository(root);
    const suffix = 'x'.repeat(210);
    for (let index = 0; index < 5200; index++) writeFileSync(join(root, `item-${String(index).padStart(5, '0')}-${suffix}.txt`), '');
    writeFileSync(join(root, 'zz-late-target.txt'), 'outside captured catalogue\n');
    const early = await searchChild(root, { operation: 'files', query: 'item-', limit: 2 });
    assert.equal(early.truncated, true);
    assert.match(early.text, /Output incomplete/);
    assert.ok(Buffer.byteLength(early.text) <= INSPECTION_MAX_BYTES);
    const late = await searchChild(root, { operation: 'files', query: 'zz-late-target' });
    assert.equal(late.truncated, true);
    assert.match(late.text, /No results.*\n\[Output incomplete/);
  });
});

test("search and Git output are bounded and report skipped binary/large files without spill files", async () => {
  await fixture(async root => {
    writeFileSync(join(root, "many"), "needle\n".repeat(5000));
    writeFileSync(join(root, "long"), "needle" + "x".repeat(100_000));
    writeFileSync(join(root, "big"), "needle".repeat(200_000));
    writeFileSync(join(root, "binary"), Buffer.from("needle\0secret"));
    const small = await searchChild(root, { operation: "content", path: "many", query: "needle", limit: 3 });
    assert.equal(small.truncated, true);
    assert.match(small.text, /Output incomplete/);
    const long = await searchChild(root, { operation: "content", path: "long", query: "needle" });
    assert.equal(long.truncated, true); assert.ok(Buffer.byteLength(long.text) <= INSPECTION_MAX_BYTES);
    assert.equal((await searchChild(root, { operation: "content", path: "big", query: "needle" })).text, "No results.");
    assert.equal((await searchChild(root, { operation: "content", path: "binary", query: "needle" })).text, "No results.");
    const bounded = boundedOutput("\x1b[31m" + "é".repeat(100_000) + "\n".repeat(2000));
    assert.equal(bounded.truncated, true);
    assert.ok(Buffer.byteLength(bounded.text) <= INSPECTION_MAX_BYTES);
    assert.ok(bounded.text.split("\n").length <= INSPECTION_MAX_LINES);
    assert.doesNotMatch(bounded.text, /\x1b|\uFFFD/);
  });
});

test("registered tool output including limitations stays bounded and enforces its schema", async () => {
  await fixture(async root => {
    writeFileSync(join(root, 'large-line'), 'needle' + 'x'.repeat(100_000));
    const registered = new Map<string, any>();
    registerInspectionTools({ registerTool: (tool: any) => { registered.set(tool.name, tool); } } as ExtensionAPI, {
      PI_SUBAGENT_ID: 'run', PI_SUBAGENT_TOOLS: 'subagent_search,subagent_git_inspect',
    });
    const tool = registered.get('subagent_search');
    const result = await tool.execute('test', { operation: 'content', query: 'needle' }, undefined, undefined, { cwd: root });
    assert.equal(result.details.truncated, true);
    assert.ok(Buffer.byteLength(result.content[0].text) <= INSPECTION_MAX_BYTES);
    assert.ok(result.content[0].text.split('\n').length <= INSPECTION_MAX_LINES);
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(registered.get('subagent_git_inspect').parameters.additionalProperties, false);
    await assert.rejects(() => tool.execute('test', { operation: 'files', flags: '--pre=touch marker' }, undefined, undefined, { cwd: root }), /Unsupported argument/);
  });
});

test("Git enumerated operations review staged/unstaged/commit diffs and restrict nested cwd", async () => {
  await fixture(async root => {
    repository(root);
    writeFileSync(join(root, "src", "code.txt"), "staged\n"); git(root, "add", "src/code.txt");
    writeFileSync(join(root, "src", "code.txt"), "unstaged\n");
    writeFileSync(join(root, "other.txt"), "parent-only\n");
    writeFileSync(join(root, "new.txt"), "untracked\n");
    const src = join(root, "src");
    const status = (await inspectChildGit(src, { operation: "status" })).text;
    assert.match(status, /MM src\/code.txt/); assert.doesNotMatch(status, /other.txt|new.txt/);
    const staged = await inspectChildGit(src, { operation: "diff_staged" });
    assert.match(staged.text, /\+staged/); assert.doesNotMatch(staged.text, /parent-only|other.txt/);
    const unstaged = await inspectChildGit(src, { operation: "diff_unstaged" });
    assert.match(unstaged.text, /\+unstaged/); assert.doesNotMatch(unstaged.text, /parent-only|other.txt/);
    assert.match((await inspectChildGit(src, { operation: "diff_commit" })).text, /\+base/);
    assert.match((await inspectChildGit(src, { operation: "log", limit: 1 })).text, /initial/);
    assert.equal((await searchChild(src, { operation: 'files' })).text, '"code.txt"');
    assert.match((await searchChild(src, { operation: 'content', query: 'unstaged' })).text, /code.txt/);
    git(root, "add", "src/code.txt"); git(root, "commit", "-qm", "second");
    assert.match((await inspectChildGit(src, { operation: "diff_between", base: "HEAD~1" })).text, /\+unstaged/);
    // Deleted paths are safe literal scopes even though they no longer exist.
    rmSync(join(src, "code.txt"));
    assert.match((await inspectChildGit(src, { operation: "diff_unstaged", path: "code.txt" })).text, /-unstaged/);
    const blob = git(root, "rev-parse", "HEAD:src/code.txt");
    await assert.rejects(() => inspectChildGit(root, { operation: "diff_commit", commit: blob }), /Git inspection failed/);
  });
});

test("Git refuses traversal, symlinks, raw flags, pathspec magic and non-commit refs", async () => {
  await fixture(async (root, outside) => {
    repository(root);
    const original = readFileSync(join(root, "src", "code.txt"));
    for (const path of ["../outside", outside, "src/../../outside", ".git/config", "..\\outside", "bad\0path"]) {
      await assert.rejects(() => inspectChildGit(root, { operation: "status", path }));
    }
    for (const commit of ["--output=owned", "HEAD:other.txt", "HEAD..HEAD", "HEAD@{1}", "main", "HEAD^", "HEAD~10000", "HEAD; touch marker"]) {
      await assert.rejects(() => inspectChildGit(root, { operation: "diff_commit", commit }));
    }
    for (const args of [{ operation: "reset" }, { operation: "status", cwd: outside }, { operation: "diff_unstaged", flags: ["--output=owned"] }, { operation: "status", commit: "HEAD" }, { operation: "diff_between" }, { operation: "status", limit: 10 }]) {
      await assert.rejects(() => inspectChildGit(root, args as any));
    }
    assert.equal((await inspectChildGit(root, { operation: "diff_unstaged", path: ":(top)**" })).text, "No results.");
    symlinkSync(outside, join(root, "escape"));
    assert.match((await inspectChildGit(root, { operation: "status" })).text, /escape/);
    await assert.rejects(() => inspectChildGit(root, { operation: "status", path: "escape" }), /symbolic link/);
    await assert.rejects(() => inspectChildGit(root, { operation: "status", path: "escape/file" }), /symbolic link/);
    assert.equal((await inspectChildGit(root, { operation: "status", path: "src" })).text, "No results.");
    assert.deepEqual(readFileSync(join(root, "src", "code.txt")), original);
    rmSync(join(root, "escape"));
    git(root, "config", "core.worktree", outside);
    await assert.rejects(() => inspectChildGit(root, { operation: "status" }), /outside child cwd ancestry/);
  });
});

test("root operations ignore huge dependency/nested trees and search respects Git ignore rules", async () => {
  await fixture(async (root, outside) => {
    repository(root);
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n.pi/git/\ncustom-cache/\n');
    const dependencies = join(root, 'node_modules');
    for (let folder = 0; folder < 210; folder++) {
      const dir = join(dependencies, `package-${folder}`, 'nested');
      mkdirSync(dir, { recursive: true });
      for (let file = 0; file < 100; file++) writeFileSync(join(dir, `${file}.txt`), 'ignored secret\n');
    }
    mkdirSync(join(dependencies, '.bin')); symlinkSync(outside, join(dependencies, '.bin', 'tool'));
    for (const cache of ['.pi/git/cloned/deep', 'custom-cache/deep']) {
      mkdirSync(join(root, cache), { recursive: true });
      writeFileSync(join(root, cache, 'presets.json'), 'ignored secret\n');
    }
    const nested = join(root, 'clones', 'foreign');
    mkdirSync(nested, { recursive: true }); repository(nested);
    writeFileSync(join(nested, 'presets.json'), 'ignored secret\n');
    mkdirSync(join(root, '.pi', 'config')); writeFileSync(join(root, '.pi', 'config', 'presets.json'), 'visible needle\n');
    writeFileSync(join(root, 'src', 'code.txt'), 'staged\n'); git(root, 'add', 'src/code.txt');
    writeFileSync(join(root, 'src', 'code.txt'), 'unstaged\n');
    const files = await searchChild(root, { operation: 'files', query: 'presets.json', limit: 20 });
    assert.equal(files.text, '".pi/config/presets.json"'); assert.equal(files.truncated, false);
    assert.equal((await searchChild(root, { operation: 'content', query: 'ignored secret' })).text, 'No results.');
    assert.match((await searchChild(root, { operation: 'content', query: 'visible needle' })).text, /presets.json/);
    assert.match((await inspectChildGit(root, { operation: 'status' })).text, /MM src\/code.txt/);
    assert.match((await inspectChildGit(root, { operation: 'diff_staged' })).text, /\+staged/);
    assert.match((await inspectChildGit(root, { operation: 'diff_unstaged' })).text, /\+unstaged/);
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = outside; // No Git executable: exercise dependency-pruned fallback.
      const fallback = await searchChild(root, { operation: 'files', query: 'presets.json' });
      assert.match(fallback.text, /\.pi\/config\/presets.json/);
      assert.doesNotMatch(fallback.text, /node_modules|\.pi\/git/);
      assert.equal(fallback.truncated, false);
      assert.match(fallback.limitations.join('\n'), /filesystem fallback/);
    } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
  });
});

test("Git root diffs inspect tracked links/type changes without following targets or directory replacements", async () => {
  await fixture(async (root, outside) => {
    repository(root);
    writeFileSync(join(outside, 'code.txt'), 'OUTSIDE_SECRET\n');
    symlinkSync(join(outside, 'code.txt'), join(root, 'link.txt'));
    git(root, 'add', 'link.txt'); git(root, 'commit', '-qm', 'tracked symlink');
    rmSync(join(root, 'link.txt')); symlinkSync(join(outside, 'elsewhere'), join(root, 'link.txt'));
    rmSync(join(root, 'src'), { recursive: true }); symlinkSync(outside, join(root, 'src'));
    const index = readFileSync(join(root, '.git', 'index'));
    const status = await inspectChildGit(root, { operation: 'status' });
    const diff = await inspectChildGit(root, { operation: 'diff_unstaged' });
    assert.match(status.text, /link.txt/); assert.match(diff.text, /elsewhere/);
    assert.doesNotMatch(diff.text, /OUTSIDE_SECRET/);
    assert.deepEqual(readFileSync(join(root, '.git', 'index')), index);
    assert.equal((await searchChild(root, { operation: 'content', query: 'OUTSIDE_SECRET' })).text, 'No results.');
    for (const path of ['link.txt', 'src', 'src/code.txt']) {
      await assert.rejects(() => inspectChildGit(root, { operation: 'diff_unstaged', path }), /symbolic link/);
      await assert.rejects(() => searchChild(root, { operation: 'files', path }), /symbolic link/);
    }
  });
});

test("Git clean/process filters from local, included and worktree config never execute in status/diff", async () => {
  await fixture(async root => {
    repository(root);
    const drivers = ['direct-clean', 'included-clean', 'included-process', 'worktree-process', 'conditional-clean', 'conditional-process'];
    writeFileSync(join(root, '.gitattributes'), drivers.map(driver => `${driver}.txt filter=${driver}`).join('\n') + '\n');
    for (const driver of drivers) writeFileSync(join(root, `${driver}.txt`), 'base\n');
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'filter attributes without configured commands');
    const include = join(root, '.git', 'filter-include.config');
    git(root, 'config', 'include.path', include);
    git(root, 'config', 'extensions.worktreeConfig', 'true');
    const conditionalInclude = join(root, '.git', 'conditional-filters.config');
    const branch = git(root, 'symbolic-ref', '--short', 'HEAD');
    git(root, 'config', `includeIf.onbranch:${branch}.path`, conditionalInclude);
    for (const driver of drivers) {
      const script = join(root, `${driver}.sh`), marker = join(root, `${driver}.executed`);
      writeFileSync(script, `#!/bin/sh\nprintf ran > '${marker}'\ncat\n`, { mode: 0o700 });
      const key = `filter.${driver}.${driver.endsWith('process') ? 'process' : 'clean'}`;
      const location = driver.startsWith('conditional') ? ['--file', conditionalInclude]
        : driver.startsWith('included') ? ['--file', include] : driver.startsWith('worktree') ? ['--worktree'] : [];
      git(root, 'config', ...location, key, script);
      git(root, 'config', ...location, `filter.${driver}.required`, 'true');
      writeFileSync(join(root, `${driver}.txt`), 'changed\n');
    }
    const index = readFileSync(join(root, '.git', 'index')), mtime = statSync(join(root, '.git', 'index')).mtimeMs;
    for (const operation of ['status', 'diff_unstaged'] as const) {
      const inspected = await inspectChildGit(root, { operation });
      assert.match(inspected.text, operation === 'status' ? /direct-clean.txt/ : /\+changed/);
      for (const driver of drivers) assert.equal(existsSync(join(root, `${driver}.executed`)), false, `${driver} must not execute during ${operation}`);
      assert.deepEqual(readFileSync(join(root, '.git', 'index')), index);
      assert.equal(statSync(join(root, '.git', 'index')).mtimeMs, mtime);
    }
    assert.match((await searchChild(root, { operation: 'content', query: 'changed' })).text, /conditional-clean.txt/);
    for (const driver of drivers) assert.equal(existsSync(join(root, `${driver}.executed`)), false, 'search must not execute configured filters');
    git(root, 'config', 'filter.unsupported driver.clean', 'touch forbidden');
    await assert.rejects(() => inspectChildGit(root, { operation: 'status' }), /Unsupported Git filter driver name/);
    assert.equal(existsSync(join(root, 'forbidden')), false);
  });
});

test("Git ignores hostile inherited environment and local execution hooks without refreshing index", async () => {
  await fixture(async (root, outside) => {
    repository(root); repository(outside);
    const marker = join(root, "executed");
    const script = join(root, "malicious");
    writeFileSync(script, `#!/bin/sh\nprintf ran > '${marker}'\ncat \"$1\"\n`, { mode: 0o700 });
    writeFileSync(join(root, ".gitattributes"), "*.txt diff=hostile\n");
    git(root, "add", ".gitattributes"); git(root, "commit", "-qm", "attributes");
    mkdirSync(join(root, "hooks")); writeFileSync(join(root, "hooks", "post-index-change"), `#!/bin/sh\nprintf hook > '${marker}'\n`, { mode: 0o700 });
    for (const [key, value] of [["core.fsmonitor", script], ["diff.external", script], ["diff.hostile.command", script], ["diff.hostile.textconv", script], ["core.pager", script], ["pager.status", "true"], ["pager.diff", "true"], ["core.hooksPath", join(root, "hooks")]]) git(root, "config", key, value);
    // Identical content with stale timestamps would ordinarily invite index refresh.
    const tracked = join(root, "src", "code.txt"); utimesSync(tracked, new Date(), new Date(Date.now() + 10_000));
    const index = join(root, ".git", "index");
    const indexBefore = readFileSync(index), mtime = statSync(index).mtimeMs;
    const hostile: NodeJS.ProcessEnv = {
      GIT_DIR: join(outside, ".git"), GIT_WORK_TREE: outside, GIT_INDEX_FILE: join(outside, ".git", "index"),
      GIT_EXTERNAL_DIFF: script, GIT_DIFF_OPTS: "--output=owned", GIT_PAGER: script, PAGER: script,
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: script,
      GIT_CONFIG_PARAMETERS: "'diff.external=malicious'", GIT_CONFIG_SYSTEM: script, GIT_CONFIG_GLOBAL: script,
      GIT_OPTIONAL_LOCKS: "1", GIT_CONFIG: script,
    };
    const before = Object.fromEntries(Object.keys(hostile).map((name) => [name, process.env[name]]));
    try {
      Object.assign(process.env, hostile);
      const status = await inspectChildGit(root, { operation: "status", path: "src" });
      assert.equal(status.text, "No results.");
      assert.deepEqual(readFileSync(index), indexBefore); assert.equal(statSync(index).mtimeMs, mtime);
      writeFileSync(tracked, "changed\n");
      assert.match((await inspectChildGit(root, { operation: "diff_unstaged", path: "src" })).text, /\+changed/);
      assert.match((await inspectChildGit(root, { operation: "diff_commit", path: "src", commit: "HEAD~1" })).text, /\+base/);
      const env = inspectionGitEnvironment();
      assert.equal(env.GIT_DIR, undefined); assert.equal(env.GIT_CONFIG_COUNT, undefined);
      assert.equal(env.GIT_EXTERNAL_DIFF, undefined); assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
      assert.equal(existsSync(marker), false);
      assert.deepEqual(readFileSync(index), indexBefore); assert.equal(statSync(index).mtimeMs, mtime);
      assert.equal(existsSync(join(root, ".git", "index.lock")), false);
    } finally {
      for (const [name, value] of Object.entries(before)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
  });
});

test("Git inspection supports linked worktrees, bounded capture and cancellation without writes", async () => {
  await fixture(async (root, outside) => {
    repository(root);
    const linked = join(outside, "linked"); git(root, "worktree", "add", "--detach", linked, "HEAD");
    writeFileSync(join(linked, "src", "code.txt"), "change\n".repeat(200_000));
    const inspected = await inspectChildGit(linked, { operation: "diff_unstaged", path: "src" });
    assert.equal(inspected.truncated, true); assert.match(inspected.text, /Output incomplete/);
    assert.ok(Buffer.byteLength(inspected.text) <= INSPECTION_MAX_BYTES);
    assert.ok(inspected.text.split("\n").length <= INSPECTION_MAX_LINES);
    assert.equal(readFileSync(join(root, "src", "code.txt"), "utf8"), "base\n");
    await assert.rejects(() => inspectChildGit(linked, { operation: "status" }, AbortSignal.abort()));
    await assert.rejects(() => searchChild(linked, { operation: "files" }, AbortSignal.abort()));
  });
});
