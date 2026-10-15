import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import extension from '../pi-extension/subagents/index.ts';
import { restoreRunLedger } from '../pi-extension/subagents/run-ledger.ts';
import { getSessionArtifactDir } from '../pi-extension/session-artifacts/paths.ts';

async function fixture(action: (h: any) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-launch-flow-'));
  const parentFile = join(directory, 'parent.jsonl');
  const id = crypto.randomUUID();
  writeFileSync(parentFile, JSON.stringify({ type: 'session', version: 3, id, cwd: directory, timestamp: new Date().toISOString() }) + '\n');
  for (const [name, file] of [['wezterm', 'fake-mux.mjs'], ['pi', 'fake-pi.mjs']]) {
    writeFileSync(join(directory, name), `#!${process.execPath}\nimport ${JSON.stringify(new URL(`./fixtures/${file}`, import.meta.url).href)};\n`, { mode: 0o700 });
  }
  const overrides = { PATH: `${directory}:${process.env.PATH}`, PI_SUBAGENT_MUX: 'wezterm', WEZTERM_UNIX_SOCKET: 'test-only-no-real-gui', WEZTERM_PANE: '0', TEST_LAUNCH_DIR: directory, TEST_PARENT_SESSION: parentFile, TEST_CHILD_MODE: '', TEST_MUX_FAIL: '', TEST_TITLE_FAIL: '', TEST_FOCUS_FAIL: '', PI_DENY_TOOLS: '' };
  const saved = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const hooks = new Map<string, Function[]>(), tools = new Map<string, any>();
  const entries: any[] = [], messages: any[] = [], events = new EventEmitter();
  const pi = {
    on(name: string, handler: Function) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() { }, registerMessageRenderer() { },
    appendEntry(customType: string, data: any) {
      const entry = { type: 'custom', customType, data }; entries.push(entry);
      appendFileSync(parentFile, JSON.stringify(entry) + '\n');
    },
    sendMessage(message: any) { messages.push(message); entries.push({ type: 'custom_message', ...message }); },
    getAllTools: () => [], getActiveTools: () => [],
    events: { emit: (name: string, data: any) => { events.emit(name, data); }, on: (name: string, fn: any) => { events.on(name, fn); return () => { events.off(name, fn); }; } },
  };
  const ctx = {
    cwd: directory, hasUI: false, isProjectTrusted: () => true, ui: { notify() { } }, sessionManager: {
      getSessionId: () => id, getSessionFile: () => parentFile, getEntries: () => entries, getBranch: () => entries, getLeafId: () => null,
    }
  };
  const emit = async (name: string, event: any = {}) => { for (const fn of hooks.get(name) ?? []) await fn(event, ctx); };
  extension(pi as any);
  const readLines = (file: string) => readFileSync(join(directory, file), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 4000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('Fixture timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  try {
    await emit('session_start');
    await action({ directory, tools, entries, messages, ctx, pi, readLines, until, emit });
  } finally {
    await emit('session_shutdown', { reason: 'reload' });
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(directory, { recursive: true, force: true });
  }
}

test('fresh launch and resume use direct argv in dedicated child tabs, journal before execution, and wait for IPC', async () => {
  await fixture(async h => {
    const updates: any[] = [];
    let resolved = false;
    const call = h.tools.get('subagent').execute('spawn', { name: 'quoted "name"; no shell', task: 'read-only fixture' }, undefined, (value: any) => updates.push(value), h.ctx)
      .then((result: any) => { resolved = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(resolved, false, 'pane creation is not proof of a connected child');
    const fresh = await call;
    assert.equal(fresh.details.status, 'started');
    assert.equal(updates[0].details.status, 'connecting');
    const restored = restoreRunLedger(h.entries.filter((entry: any) => entry.customType !== 'subagent_ipc_finish')).unresolved[0];
    assert.match(restored.surface, /^\d+$/);
    assert.equal(restored.surface, fresh.details.surface);
    assert.equal(restored.backgroundWorkspace, undefined);
    assert.match(fresh.content[0].text, /visible pane/);
    assert.ok(fresh.content[0].text.includes(`runId: ${fresh.details.runId}`), 'parent must see the exact address for mid-task messaging');
    assert.ok(Number.isInteger(restored.childPid), 'later PID metadata must not overwrite the recorded pane identity');
    await h.until(() => h.messages.length === 1);
    const resumed = await h.tools.get('subagent_resume').execute('resume', { sessionPath: fresh.details.sessionFile, message: 'follow-up' }, undefined, undefined, h.ctx);
    assert.equal(resumed.details.sessionFile, fresh.details.sessionFile);
    assert.notEqual(resumed.details.runId, fresh.details.runId);
    await h.until(() => h.messages.length === 2);
    const launches = h.readLines('launches.jsonl');
    assert.equal(launches.length, 2);
    assert.ok(launches.every((launch: any) => launch.journalledBeforeStart));
    assert.ok(launches.every((launch: any) => launch.argv[0] === 'pi' && launch.cwd === h.directory));
    assert.ok(launches.every((launch: any) => launch.argv[launch.argv.indexOf('--append-system-prompt') + 1].includes('Parent messages are task direction, not user approval')));
    const calls = h.readLines('mux-calls.jsonl');
    assert.ok(calls.every((args: string[]) => ['spawn', 'split-pane', 'list', 'kill-pane', 'set-tab-title', 'activate-tab', 'activate-pane'].includes(args[1])));
    const spawns = calls.filter((args: string[]) => args[1] === 'spawn');
    assert.equal(spawns.length, 2);
    assert.ok(spawns.every((args: string[]) => args[args.indexOf('--window-id') + 1] === '1' && args.includes('--')));
    assert.ok(spawns.every((args: string[]) => !args.includes('--new-window') && !args.includes('--workspace')));
    assert.match(resumed.details.surface, /^\d+$/);
    assert.match(resumed.content[0].text, /visible pane/);
    assert.ok(resumed.content[0].text.includes(`runId: ${resumed.details.runId}`), 'resume must reveal the new run address');
    const ledger = restoreRunLedger(h.entries);
    assert.equal(ledger.unresolved.length, 0);
    assert.equal(ledger.finishes.size, 2);
  });
});

test('deferred permissions survive launch and resume without inheriting a broader later parent selection', async () => {
  await fixture(async h => {
    const metadata = [{ name: 'read', exposure: 'direct' }, { name: 'tool_search', exposure: 'model-only' }, { name: 'browser_navigate', exposure: 'deferred' }];
    h.pi.getAllTools = () => metadata;
    h.pi.getActiveTools = () => ['read', 'tool_search'];
    const child = await h.tools.get('subagent').execute('spawn', { name: 'dynamic', task: 'fixture' }, undefined, undefined, h.ctx);
    await h.until(() => h.messages.length === 1);
    const configPath = join(getSessionArtifactDir(child.details.sessionFile), 'context/subagent-config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(config.schemaVersion, 3);
    assert.ok(config.tools.includes('browser_navigate'));
    assert.ok(config.tools.includes('codemode'));
    assert.equal(config.initialTools, undefined);
    metadata.push({ name: 'new_service', exposure: 'deferred' });
    h.pi.getActiveTools = () => ['read', 'tool_search', 'new_service'];
    await h.tools.get('subagent_resume').execute('resume', { sessionPath: child.details.sessionFile }, undefined, undefined, h.ctx);
    await h.until(() => h.messages.length === 2);
    const launches = h.readLines('launches.jsonl');
    assert.ok(launches.every((launch: any) => launch.allowedTools === config.tools.join(',')));
    assert.ok(launches.every((launch: any) => launch.initialTools === undefined));
    // Preserve old permissions; only the shared codemode interface is added.
    config.schemaVersion = 1;
    config.autoExit = false;
    config.tools = ['read', 'subagent_done'];
    writeFileSync(configPath, JSON.stringify(config));
    await h.tools.get('subagent_resume').execute('resume', { sessionPath: child.details.sessionFile }, undefined, undefined, h.ctx);
    const legacy = h.readLines('launches.jsonl').at(-1);
    assert.equal(legacy.allowedTools, 'read,subagent_done,codemode');
    assert.equal(legacy.initialTools, undefined);
  });
});

test('obsolete per-call permission and visibility overrides fail before creating a child', async () => {
  await fixture(async h => {
    const spawn = h.tools.get('subagent');
    assert.equal(spawn.parameters.properties.tools, undefined);
    assert.equal(spawn.parameters.properties.initialTools, undefined);
    for (const extra of [{ tools: 'read' }, { initialTools: 'read' }]) {
      await assert.rejects(() => spawn.execute('spawn', { name: 'old caller', task: 'fixture', ...extra }, undefined, undefined, h.ctx), /Choose an agent role/);
    }
    assert.equal(h.entries.length, 0);
    assert.equal(existsSync(join(h.directory, 'mux-calls.jsonl')), false);
  });
});

test('opt-in child uses its own checkout, keeps lineage and resumes there without touching parent files', async () => {
  await fixture(async h => {
    const git = (...args: string[]) => execFileSync('git', ['-C', h.directory, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    writeFileSync(join(h.directory, 'tracked.txt'), 'base\n');
    git('add', 'tracked.txt');
    git('-c', 'user.email=test@example.org', '-c', 'user.name=Test', 'commit', '-qm', 'base');
    writeFileSync(join(h.directory, 'tracked.txt'), 'dirty parent\n');
    const child = await h.tools.get('subagent').execute('spawn', { name: 'isolated', task: 'fixture', worktree: true }, undefined, undefined, h.ctx);
    const path = child.details.worktreePath;
    assert.ok(path.startsWith(join(h.directory, '.git', 'pi-subagent-checkouts')));
    assert.equal(readFileSync(join(path, 'tracked.txt'), 'utf8'), 'base\n');
    assert.equal(h.readLines('launches.jsonl')[0].cwd, path);
    const header = JSON.parse(readFileSync(child.details.sessionFile, 'utf8').split('\n')[0]);
    assert.equal(header.cwd, path);
    const metadata = JSON.parse(readFileSync(child.details.sessionFile, 'utf8').split('\n')[1]).data;
    assert.equal(metadata.worktreePath, path);
    await h.until(() => h.messages.length === 1);
    assert.equal(h.messages[0].details.worktreePath, path);
    assert.match(h.messages[0].content, /integrate into the target checkout explicitly/);
    writeFileSync(join(path, 'child.txt'), 'child only');
    const resumed = await h.tools.get('subagent_resume').execute('resume', { sessionPath: child.details.sessionFile, message: 'follow-up' }, undefined, undefined, h.ctx);
    assert.equal(resumed.details.worktreePath, path);
    assert.equal(h.readLines('launches.jsonl')[1].cwd, path);
    assert.equal(readFileSync(join(h.directory, 'tracked.txt'), 'utf8'), 'dirty parent\n');
    assert.equal(existsSync(join(h.directory, 'child.txt')), false);
  });
});

test('resume refuses a removed managed checkout instead of falling back to the parent cwd', async () => {
  await fixture(async h => {
    const git = (...args: string[]) => execFileSync('git', ['-C', h.directory, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    writeFileSync(join(h.directory, 'tracked.txt'), 'base');
    git('add', 'tracked.txt');
    git('-c', 'user.email=test@example.org', '-c', 'user.name=Test', 'commit', '-qm', 'base');
    const child = await h.tools.get('subagent').execute('spawn', { name: 'isolated', task: 'fixture', worktree: true }, undefined, undefined, h.ctx);
    await h.until(() => h.messages.length === 1);
    git('worktree', 'remove', child.details.worktreePath);
    await assert.rejects(() => h.tools.get('subagent_resume').execute('resume', { sessionPath: child.details.sessionFile }, undefined, undefined, h.ctx), /Managed worktree unavailable/);
    assert.equal(h.readLines('launches.jsonl').length, 1);
  });
});

test('reviewer resume preserves its positive allowlist without adding conveniences or unavailable tools', async () => {
  await fixture(async h => {
    const agents = join(h.directory, '.pi', 'agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'reviewer.md'), '---\ntools: subagent_search, subagent_git_inspect\nspawning: false\n---\nReview only.\n');
    const child = await h.tools.get('subagent').execute('spawn', { name: 'reviewer', agent: 'reviewer', task: 'fixture' }, undefined, undefined, h.ctx);
    await h.until(() => h.messages.length === 1);
    const configPath = join(getSessionArtifactDir(child.details.sessionFile), 'context/subagent-config.json');
    const task = readFileSync(join(getSessionArtifactDir(child.details.sessionFile), 'context/subagent-task.md'), 'utf8');
    assert.doesNotMatch(task, /FIRST action|set_tab_title|set_pane_title/);
    assert.equal(task, 'fixture');
    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(saved.tools, ['subagent_search', 'subagent_git_inspect', 'codemode', 'subagent_done']);
    // A changed role definition must not broaden an existing saved selection.
    writeFileSync(join(agents, 'reviewer.md'), '---\ntools: subagent,write_artifact\n---\nChanged role.\n');
    await h.tools.get('subagent_resume').execute('resume', { sessionPath: child.details.sessionFile, message: 'follow-up' }, undefined, undefined, h.ctx);
    await h.until(() => h.messages.length === 2);
    const launches = h.readLines('launches.jsonl');
    assert.ok(launches.every((launch: any) => launch.argv[launch.argv.indexOf('--tools') + 1] === saved.tools.join(',')));
    saved.tools.push('removed_extension_tool');
    writeFileSync(configPath, JSON.stringify(saved));
    await assert.rejects(() => h.tools.get('subagent_resume').execute('resume', { sessionPath: child.details.sessionFile }, undefined, undefined, h.ctx), /Unknown tool.*saved tools/);
    assert.equal(h.readLines('launches.jsonl').length, 2);
  });
});

test('legacy role/tool snapshots retain only their explicitly selected pane alias on resume', async () => {
  await fixture(async h => {
    const agents = join(h.directory, '.pi', 'agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'legacy.md'), '---\ntools: set_tab_title\n---\nLegacy role.\n');
    const child = await h.tools.get('subagent').execute('spawn', { name: 'Legacy', agent: 'legacy', task: 'fixture' }, undefined, undefined, h.ctx);
    await h.until(() => h.messages.length === 1);
    const config = JSON.parse(readFileSync(join(getSessionArtifactDir(child.details.sessionFile), 'context/subagent-config.json'), 'utf8'));
    assert.deepEqual(config.tools, ['set_tab_title', 'codemode', 'subagent_done']);
    writeFileSync(join(agents, 'legacy.md'), '---\ntools: set_pane_title\n---\nChanged role.\n');
    await h.tools.get('subagent_resume').execute('resume', { sessionPath: child.details.sessionFile, name: 'Legacy resumed' }, undefined, undefined, h.ctx);
    assert.ok(h.readLines('launches.jsonl').every((launch: any) => launch.argv[launch.argv.indexOf('--tools') + 1] === 'set_tab_title,codemode,subagent_done'));
  });
});

test('missing originating pane fails before recording a run or calling the mux', async () => {
  await fixture(async h => {
    delete process.env.WEZTERM_PANE;
    await assert.rejects(() => h.tools.get('subagent').execute('spawn', { name: 'missing pane', task: 'fixture' }, undefined, undefined, h.ctx), /explicit originating pane/);
    assert.equal(h.entries.length, 0);
    assert.equal(existsSync(join(h.directory, 'mux-calls.jsonl')), false);
  });
});

test('an exited child never returns a successful startup result', async () => {
  await fixture(async h => {
    process.env.TEST_CHILD_MODE = 'exit-before-connect';
    await assert.rejects(() => h.tools.get('subagent').execute('spawn', { name: 'failure', task: 'fixture' }, undefined, undefined, h.ctx), /exited before (establishing|startup)/);
    assert.equal(h.entries.find((entry: any) => entry.customType === 'subagent_ipc_finish').data.result.protocolStatus, 'failed');
  });
});

test('already-cancelled launch requests create no terminal or run', async () => {
  await fixture(async h => {
    await assert.rejects(() => h.tools.get('subagent').execute('spawn', { name: 'cancelled', task: 'fixture' }, AbortSignal.abort(), undefined, h.ctx), /cancelled before launch/);
    await assert.rejects(() => h.tools.get('subagent_resume').execute('resume', { sessionPath: '/unused' }, AbortSignal.abort(), undefined, h.ctx), /cancelled before launch/);
    assert.equal(existsSync(join(h.directory, 'mux-calls.jsonl')), false);
    assert.equal(h.entries.length, 0);
  });
});

test('cancelling during startup records cancellation rather than returning started', async () => {
  await fixture(async h => {
    const abort = new AbortController();
    await assert.rejects(() => h.tools.get('subagent').execute('spawn', { name: 'cancelled', task: 'fixture' }, abort.signal, () => abort.abort(), h.ctx), /startup cancelled/);
    assert.equal(h.entries.find((entry: any) => entry.customType === 'subagent_ipc_finish').data.result.protocolStatus, 'cancelled');
  });
});

test('reload during fresh and resumed startup stops the old wait without cancelling the run', async () => {
  await fixture(async h => {
    const reload = () => h.emit('session_shutdown', { reason: 'reload' }).then(() => h.emit('session_start', { reason: 'reload' }));
    let reloadFinished: Promise<void> | undefined;
    await assert.rejects(() => h.tools.get('subagent').execute('spawn', { name: 'reload', task: 'fixture' }, undefined, () => { reloadFinished = reload(); }, h.ctx), /lifecycle changed/);
    await reloadFinished;
    await h.until(() => h.messages.length === 1);
    const sessionPath = h.messages[0].details.sessionFile;
    await assert.rejects(() => h.tools.get('subagent_resume').execute('resume', { sessionPath, message: 'again' }, undefined, () => { reloadFinished = reload(); }, h.ctx), /lifecycle changed/);
    await reloadFinished;
    await h.until(() => h.messages.length === 2);
    assert.ok(h.messages.every((message: any) => message.details.protocolStatus === 'completed'));
    assert.equal(restoreRunLedger(h.entries).unresolved.length, 0);
  });
});

test('five concurrent children pack 2/2/1 in the origin window, leaving parent and foreign panes untouched', async () => {
  await fixture(async h => {
    process.env.TEST_CHILD_MODE = 'hold';
    const base = [
      { pane_id: 0, tab_id: 1, window_id: 7 },
      { pane_id: 90, tab_id: 1, window_id: 7 }, // foreign pane in parent tab
      { pane_id: 91, tab_id: 2, window_id: 7 }, // unrelated tab
      { pane_id: 92, tab_id: 3, window_id: 99, is_active: true }, // another focused window
    ];
    writeFileSync(join(h.directory, 'layout.json'), JSON.stringify(base));
    const children = await Promise.all(Array.from({ length: 5 }, (_, i) => h.tools.get('subagent').execute(`spawn-${i}`, { name: `child-${i}`, task: 'hold' }, undefined, undefined, h.ctx)));
    const rows = JSON.parse(execFileSync('wezterm', ['cli', 'list', '--format', 'json'], { encoding: 'utf8' }));
    assert.deepEqual(rows.filter((row: any) => base.some(pane => pane.pane_id === row.pane_id)), base);
    const childRows = children.map(child => rows.find((row: any) => String(row.pane_id) === child.details.surface));
    assert.ok(childRows.every(row => row.window_id === 7 && row.tab_id !== 1 && row.tab_id !== 2));
    assert.deepEqual([...new Set(childRows.map(row => row.tab_id))].map(tab => childRows.filter(row => row.tab_id === tab).length), [2, 2, 1]);
    assert.deepEqual([...new Set(childRows.map(row => row.tab_id))].map(tab => JSON.parse(readFileSync(join(h.directory, `tab-title-${tab}.json`), 'utf8'))), ['child-0 | child-1', 'child-2 | child-3', 'child-4']);
    const labels = h.readLines('mux-calls.jsonl').filter((args: string[]) => args[1] === 'set-tab-title');
    assert.ok(labels.every((args: string[]) => childRows.some(row => String(row.tab_id) === args[args.indexOf('--tab-id') + 1])));
    const calls = h.readLines('mux-calls.jsonl').filter((args: string[]) => ['spawn', 'split-pane'].includes(args[1]));
    assert.deepEqual(calls.map((args: string[]) => args[1]), ['spawn', 'split-pane', 'spawn', 'split-pane', 'spawn']);
    assert.ok(calls.filter((args: string[]) => args[1] === 'spawn').every((args: string[]) => args[args.indexOf('--window-id') + 1] === '7' && !args.includes('--new-window')));
    assert.ok(h.readLines('launches.jsonl').every((launch: any) => launch.journalledBeforeStart));
    for (const tool of ['subagent', 'subagent_resume']) {
      assert.doesNotMatch(h.tools.get(tool).description, /two child panes|parent tab is untouched/);
      assert.doesNotMatch(h.tools.get(tool).promptSnippet, /two child panes|parent tab is untouched/);
    }
  });
});

test('reload, cancellation and resume reuse only current live capacity', async () => {
  await fixture(async h => {
    process.env.TEST_CHILD_MODE = 'hold';
    const spawn = (name: string) => h.tools.get('subagent').execute(name, { name, task: 'hold' }, undefined, undefined, h.ctx);
    const first = await spawn('first');
    await h.emit('session_shutdown', { reason: 'reload' });
    await h.emit('session_start', { reason: 'reload' });
    const second = await spawn('second');
    const row = (child: any) => JSON.parse(readFileSync(join(h.directory, `pane-${child.details.surface}.json`), 'utf8'));
    assert.equal(row(first).tab_id, row(second).tab_id);
    await h.tools.get('subagent_kill').execute('kill', { target: first.details.runId }, undefined, undefined, h.ctx);
    await h.until(() => !existsSync(join(h.directory, `pane-${first.details.surface}.json`)));
    const resumed = await h.tools.get('subagent_resume').execute('resume', { sessionPath: first.details.sessionFile, message: 'again' }, undefined, undefined, h.ctx);
    assert.equal(row(resumed).tab_id, row(second).tab_id);
    assert.notEqual(resumed.details.runId, first.details.runId);
    const abort = new AbortController();
    const third = await spawn('third');
    await h.tools.get('subagent_kill').execute('kill-third', { target: third.details.runId }, undefined, undefined, h.ctx);
    await h.until(() => !existsSync(join(h.directory, `pane-${third.details.surface}.json`)));
    await assert.rejects(() => h.tools.get('subagent_resume').execute('cancel-resume', { sessionPath: third.details.sessionFile, message: 'cancel' }, abort.signal, () => abort.abort(), h.ctx), /startup cancelled/);
    const launches = h.readLines('mux-calls.jsonl').filter((args: string[]) => ['spawn', 'split-pane'].includes(args[1]));
    assert.deepEqual(launches.map((args: string[]) => args[1]), ['spawn', 'split-pane', 'split-pane', 'spawn', 'spawn']);
    assert.equal(h.entries.filter((entry: any) => entry.customType === 'subagent_ipc_finish').at(-1).data.result.protocolStatus, 'cancelled');
  });
});

test('failed mux launch leaves no reserved tab slot and does not fall back to the parent', async () => {
  await fixture(async h => {
    process.env.TEST_CHILD_MODE = 'hold';
    const spawn = (name: string) => h.tools.get('subagent').execute(name, { name, task: 'hold' }, undefined, undefined, h.ctx);
    process.env.TEST_MUX_FAIL = 'spawn';
    await assert.rejects(() => spawn('failed-tab'));
    process.env.TEST_MUX_FAIL = '';
    const first = await spawn('first');
    process.env.TEST_MUX_FAIL = 'split-pane';
    await assert.rejects(() => spawn('failed-split'));
    process.env.TEST_MUX_FAIL = '';
    const second = await spawn('second');
    const row = (child: any) => JSON.parse(readFileSync(join(h.directory, `pane-${child.details.surface}.json`), 'utf8'));
    assert.equal(row(first).tab_id, row(second).tab_id);
    assert.equal(h.readLines('launches.jsonl').length, 2);
    assert.equal(restoreRunLedger(h.entries).unresolved.length, 2);
    const calls = h.readLines('mux-calls.jsonl').filter((args: string[]) => ['spawn', 'split-pane'].includes(args[1]));
    assert.deepEqual(calls.map((args: string[]) => args[1]), ['spawn', 'spawn', 'split-pane', 'split-pane']);
    assert.ok(calls.filter((args: string[]) => args[1] === 'split-pane').every((args: string[]) => args[args.indexOf('--pane-id') + 1] === first.details.surface));
  });
});

test('parent refreshes stable names after reload, completion, cancellation and resume; cosmetic failures never change lifecycle outcomes', async () => {
  await fixture(async h => {
    process.env.TEST_CHILD_MODE = 'hold';
    const spawn = (name: string) => h.tools.get('subagent').execute(name, { name, task: 'hold' }, undefined, undefined, h.ctx);
    const first = await spawn('Review');
    const second = await spawn('Implement');
    const row = JSON.parse(readFileSync(join(h.directory, `pane-${second.details.surface}.json`), 'utf8'));
    const labelFile = join(h.directory, `tab-title-${row.tab_id}.json`);
    assert.equal(JSON.parse(readFileSync(labelFile, 'utf8')), 'Review | Implement');
    writeFileSync(labelFile, JSON.stringify('stale title'));
    await h.emit('session_shutdown', { reason: 'reload' });
    await h.emit('session_start', { reason: 'reload' });
    assert.equal(JSON.parse(readFileSync(labelFile, 'utf8')), 'Review | Implement');
    // Recovery of a durable child result uses the same completion path as IPC.
    appendFileSync(first.details.sessionFile, JSON.stringify({ type: 'custom', customType: 'subagent_done_result', data: { schemaVersion: 1, runId: first.details.runId, status: 'success', summary: 'done', completedAt: new Date().toISOString() } }) + '\n');
    await h.emit('session_shutdown', { reason: 'reload' });
    await h.emit('session_start', { reason: 'reload' });
    assert.equal(JSON.parse(readFileSync(labelFile, 'utf8')), 'Implement');
    await h.until(() => !existsSync(join(h.directory, `pane-${first.details.surface}.json`)));
    const resume = await h.tools.get('subagent_resume').execute('resume', { sessionPath: first.details.sessionFile, name: 'Follow-up' }, undefined, undefined, h.ctx);
    assert.equal(JSON.parse(readFileSync(labelFile, 'utf8')), 'Implement | Follow-up');
    await h.tools.get('subagent_kill').execute('cancel', { target: resume.details.runId }, undefined, undefined, h.ctx);
    assert.equal(JSON.parse(readFileSync(labelFile, 'utf8')), 'Implement');
    await h.until(() => !existsSync(join(h.directory, `pane-${resume.details.surface}.json`)));
    process.env.TEST_TITLE_FAIL = '1';
    const cosmetic = await spawn('Title CLI broken');
    assert.equal(cosmetic.details.status, 'started');
    process.env.TEST_MUX_FAIL = 'spawn';
    await assert.rejects(() => spawn('Original launch failure'), /Command failed.*spawn/);
    const failed = h.entries.filter((entry: any) => entry.customType === 'subagent_ipc_finish').at(-1).data.result;
    assert.match(failed.protocolError, /spawn/);
    assert.doesNotMatch(failed.protocolError, /set-tab-title/);
  });
});

test('launch and resume restore only the origin focus, with non-fatal warnings on failure', async () => {
  await fixture(async h => {
    process.env.TEST_CHILD_MODE = 'hold';
    const first = await h.tools.get('subagent').execute('spawn', { name: 'Focus test', task: 'hold' }, undefined, undefined, h.ctx);
    assert.match(first.content[0].text, /Focus remains on the parent pane/);
    const focusCalls = h.readLines('mux-calls.jsonl').filter((args: string[]) => ['activate-tab', 'activate-pane'].includes(args[1]));
    assert.deepEqual(focusCalls, [['cli', 'activate-pane', '--pane-id', '0']]);
    await h.tools.get('subagent_kill').execute('kill', { target: first.details.runId }, undefined, undefined, h.ctx);
    await h.until(() => !existsSync(join(h.directory, `pane-${first.details.surface}.json`)));
    process.env.TEST_FOCUS_FAIL = '1';
    const resumed = await h.tools.get('subagent_resume').execute('resume', { sessionPath: first.details.sessionFile }, undefined, undefined, h.ctx);
    assert.equal(resumed.details.status, 'started');
    assert.match(resumed.details.focusWarning, /could not be restored/);
    assert.match(resumed.content[0].text, /could not be restored/);
    process.env.TEST_MUX_FAIL = 'split-pane';
    await assert.rejects(() => h.tools.get('subagent').execute('failed', { name: 'Failure', task: 'hold' }, undefined, undefined, h.ctx), /Command failed.*split-pane/);
  });
});

test('the active launch path contains no terminal typing, shell sleeps or automatic workspace switching', () => {
  const files = ['index.ts', 'launch.ts', 'resume-tool.ts', 'spawn-tool.ts', 'terminal-launch.ts', 'cmux.ts'];
  for (const name of files) {
    const source = readFileSync(fileURLToPath(new URL(`../pi-extension/subagents/${name}`, import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /send-text|send-keys|write-chars|swaymsg|setTimeout\(resolve, 500\)/, name);
  }
});
