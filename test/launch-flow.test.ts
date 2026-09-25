import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import extension from '../pi-extension/subagents/index.ts';
import { restoreRunLedger } from '../pi-extension/subagents/run-ledger.ts';

async function fixture(action: (h: any) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-launch-flow-'));
  const parentFile = join(directory, 'parent.jsonl');
  const id = crypto.randomUUID();
  writeFileSync(parentFile, JSON.stringify({ type: 'session', version: 3, id, cwd: directory, timestamp: new Date().toISOString() }) + '\n');
  for (const [name, file] of [['wezterm', 'fake-mux.mjs'], ['pi', 'fake-pi.mjs']]) {
    writeFileSync(join(directory, name), `#!${process.execPath}\nimport ${JSON.stringify(new URL(`./fixtures/${file}`, import.meta.url).href)};\n`, { mode: 0o700 });
  }
  const overrides = { PATH: `${directory}:${process.env.PATH}`, PI_SUBAGENT_MUX: 'wezterm', WEZTERM_UNIX_SOCKET: 'test-only-no-real-gui', WEZTERM_PANE: '0', TEST_LAUNCH_DIR: directory, TEST_PARENT_SESSION: parentFile, TEST_CHILD_MODE: '', PI_DENY_TOOLS: '' };
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
    await action({ directory, tools, entries, messages, ctx, readLines, until, emit });
  } finally {
    await emit('session_shutdown', { reason: 'reload' });
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(directory, { recursive: true, force: true });
  }
}

test('fresh launch and resume use direct argv in visible splits, journal before execution, and wait for IPC', async () => {
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
    const calls = h.readLines('mux-calls.jsonl');
    assert.ok(calls.every((args: string[]) => ['split-pane', 'list', 'kill-pane'].includes(args[1])));
    const spawns = calls.filter((args: string[]) => args[1] === 'split-pane');
    assert.equal(spawns.length, 2);
    assert.ok(spawns.every((args: string[]) => args[args.indexOf('--pane-id') + 1] === '0' && args.includes('--right') && args.includes('--')));
    assert.ok(spawns.every((args: string[]) => !args.includes('--new-window') && !args.includes('--workspace')));
    assert.match(resumed.details.surface, /^\d+$/);
    assert.match(resumed.content[0].text, /visible pane/);
    const ledger = restoreRunLedger(h.entries);
    assert.equal(ledger.unresolved.length, 0);
    assert.equal(ledger.finishes.size, 2);
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

test('the active launch path contains no terminal typing, shell sleeps or automatic workspace switching', () => {
  const files = ['index.ts', 'launch.ts', 'resume-tool.ts', 'spawn-tool.ts', 'terminal-launch.ts', 'cmux.ts'];
  for (const name of files) {
    const source = readFileSync(fileURLToPath(new URL(`../pi-extension/subagents/${name}`, import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /send-text|send-keys|write-chars|swaymsg|setTimeout\(resolve, 500\)/, name);
  }
});
