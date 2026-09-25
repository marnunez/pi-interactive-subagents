import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareLaunch, waitForConnection } from '../pi-extension/subagents/launch-process.ts';
import { directLaunchCommand } from '../pi-extension/subagents/terminal-launch.ts';
import { childLaunchSpec } from '../pi-extension/subagents/launch.ts';
import { createRunRuntime } from '../pi-extension/subagents/runtime.ts';

test('direct launcher preserves literal argv, cwd and environment without executing shell syntax', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi literal launch '));
  const literal = `quotes ' " ; $(touch ${join(cwd, 'injected')})\nsecond line`;
  const launch = prepareLaunch({
    argv: [process.execPath, '-e', 'console.log(JSON.stringify({arg:process.argv[1],cwd:process.cwd(),value:process.env.VALUE,old:process.env.OLD}))', literal],
    cwd, env: { VALUE: literal }, unset: ['OLD'],
  });
  try {
    assert.equal(statSync(launch.directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(launch.directory, 'launch.json')).mode & 0o777, 0o600);
    const child = spawnSync(launch.argv[0], launch.argv.slice(1), { encoding: 'utf8', env: { ...process.env, OLD: 'stale' } });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { arg: literal, cwd, value: literal });
    assert.equal(existsSync(join(cwd, 'injected')), false);
    assert.equal(existsSync(join(launch.directory, 'launch.json')), false, 'one-shot launch specification is deleted before exec');
  } finally { launch.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});

test('direct exec failures are available to the parent without leaking the environment', () => {
  const launch = prepareLaunch({ argv: ['/no-such-programme'], cwd: tmpdir(), env: { SECRET: 'must-not-appear' }, unset: [] });
  try {
    const child = spawnSync(launch.argv[0], launch.argv.slice(1), { encoding: 'utf8' });
    assert.notEqual(child.status, 0);
    assert.match(launch.failure()!, /Direct child launch failed/);
    assert.doesNotMatch(launch.failure()!, /must-not-appear/);
  } finally { launch.dispose(); }
});

test('direct launch plans use visible targeted splits and never default to the active pane', () => {
  const spec = { name: 'same name', runId: 'one', cwd: tmpdir(), argv: ['/node', '/launcher', '/private-spec'] };
  const old = { WEZTERM_PANE: process.env.WEZTERM_PANE, TMUX_PANE: process.env.TMUX_PANE };
  try {
    process.env.WEZTERM_PANE = '0';
    const one = directLaunchCommand('wezterm', spec);
    assert.deepEqual(one.args, ['cli', 'split-pane', '--pane-id', '0', '--right', '--percent', '50', '--cwd', spec.cwd, '--', ...spec.argv]);
    assert.ok(!one.args.includes('--new-window') && !one.args.includes('--workspace'));
    process.env.TMUX_PANE = '%9';
    const tmux = directLaunchCommand('tmux', spec);
    assert.ok(tmux.args.includes('-d'));
    assert.equal(tmux.args[tmux.args.indexOf('-t') + 1], '%9');
    assert.deepEqual(tmux.args.slice(tmux.args.indexOf('--') + 1), spec.argv);
    for (const backend of ['wezterm', 'tmux'] as const) {
      const key = backend === 'wezterm' ? 'WEZTERM_PANE' : 'TMUX_PANE';
      for (const value of [undefined, '', 'not-a-pane']) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
        assert.throws(() => directLaunchCommand(backend, spec), /explicit originating pane/);
      }
    }
  } finally {
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  for (const backend of ['cmux', 'zellij', null] as const) assert.throws(() => directLaunchCommand(backend, spec), /No terminal input was sent/);
});

test('subsequent splits target only owned siblings in the originating tab and preserve parent space', () => {
  const old = process.env.WEZTERM_PANE;
  try {
    process.env.WEZTERM_PANE = '0';
    const spec = { name: 'next', runId: 'two', cwd: tmpdir(), argv: ['/node'], siblingSurfaces: ['0', '2', '3', '4', '5'] };
    const panes = [
      { pane_id: 0, tab_id: 1, window_id: 1, size: { rows: 100 } },
      { pane_id: 1, tab_id: 1, window_id: 1, size: { rows: 200 } }, // Not owned.
      { pane_id: 2, tab_id: 1, window_id: 1, size: { rows: 20 } },
      { pane_id: 3, tab_id: 1, window_id: 1, size: { rows: 40 } },
      { pane_id: 4, tab_id: 9, window_id: 1, size: { rows: 200 } }, // Other tab.
      { pane_id: 5, tab_id: 1, window_id: 9, size: { rows: 200 } }, // Other window.
    ];
    const next = directLaunchCommand('wezterm', spec, panes);
    assert.equal(next.args[next.args.indexOf('--pane-id') + 1], '3');
    assert.ok(next.args.includes('--bottom'));
    const fallback = directLaunchCommand('wezterm', { ...spec, siblingSurfaces: ['4', '5', '999'] }, panes);
    assert.equal(fallback.args[fallback.args.indexOf('--pane-id') + 1], '0');
    assert.ok(fallback.args.includes('--right'));
  } finally { if (old === undefined) delete process.env.WEZTERM_PANE; else process.env.WEZTERM_PANE = old; }
});

test('startup observation waits for a connection, not simply a successful spawn', async () => {
  let connected = false, resolved = false;
  const pending = waitForConnection({ connected: () => connected, failure: () => undefined, intervalMs: 2, timeoutMs: 1000 }).then(() => { resolved = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(resolved, false);
  connected = true;
  await pending;
  await assert.rejects(() => waitForConnection({ connected: () => false, failure: () => undefined, timeoutMs: 5, intervalMs: 1 }), /No task execution/);
  await assert.rejects(() => waitForConnection({ connected: () => false, failure: () => 'launch failed' }), /launch failed/);
  await assert.rejects(() => waitForConnection({ connected: () => false, failure: () => undefined, signal: AbortSignal.abort() }), /cancelled/);
});

test('runtime state is per extension instance, and direct launch preserves profile/policy overrides', () => {
  const a = createRunRuntime(), b = createRunRuntime();
  assert.notEqual(a.runningSubagents, b.runningSubagents);
  const config = { schemaVersion: 1 as const, tools: ['subagent_done'], autoExit: false, skills: 'one,two', systemPrompt: 'literal "role"\ntext', env: 'PI_SUBAGENT_TOKEN=bad PI_PROFILE=bad EXTRA=ok' };
  const spec = childLaunchSpec(a, config, 'run', 'name', '/a session.jsonl', '/tmp', '/a task.md');
  assert.equal(spec.env.PI_SUBAGENT_TOKEN, '');
  assert.equal(spec.env.PI_PROFILE, process.env.PI_PROFILE);
  assert.equal(spec.env.EXTRA, 'ok');
  assert.ok(spec.unset.includes('PI_SESSION_LEASE_OWNER_PID'));
  assert.ok(spec.unset.includes('PI_SUBAGENT_TOKEN'));
  assert.ok(spec.argv.includes(config.systemPrompt));
  assert.ok(spec.argv.includes('/skill:one'));
  assert.ok(spec.argv.includes('@/a task.md'));
});
