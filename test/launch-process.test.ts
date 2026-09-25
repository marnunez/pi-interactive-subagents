import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareLaunch, waitForConnection } from '../pi-extension/subagents/launch-process.ts';
import { backgroundLaunchCommand } from '../pi-extension/subagents/terminal-launch.ts';
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

test('background launch plans use unique workspaces or detached targeted splits, and fail closed otherwise', () => {
  const spec = { name: 'same name', runId: 'one', cwd: tmpdir(), argv: ['/node', '/launcher', '/private-spec'] };
  const one = backgroundLaunchCommand('wezterm', spec);
  const two = backgroundLaunchCommand('wezterm', { ...spec, runId: 'two' });
  assert.notEqual(one.workspace, two.workspace);
  assert.ok(one.args.includes('--new-window'));
  assert.ok(one.args.includes('--workspace'));
  assert.deepEqual(one.args.slice(one.args.indexOf('--') + 1), spec.argv);
  const old = process.env.TMUX_PANE;
  try {
    process.env.TMUX_PANE = '%9';
    const tmux = backgroundLaunchCommand('tmux', spec);
    assert.ok(tmux.args.includes('-d'));
    assert.equal(tmux.args[tmux.args.indexOf('-t') + 1], '%9');
    assert.deepEqual(tmux.args.slice(tmux.args.indexOf('--') + 1), spec.argv);
  } finally { if (old === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = old; }
  for (const backend of ['cmux', 'zellij', null] as const) assert.throws(() => backgroundLaunchCommand(backend, spec), /No terminal input was sent/);
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
