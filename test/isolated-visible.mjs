// Explicit opt-in: a NEW Xvfb display, private WezTerm configuration and mux
// socket. Never operate on the live desktop. Optional real-Pi smoke sends no task.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareLaunch, waitForConnection } from '../pi-extension/subagents/launch-process.ts';
import { launchVisibleSurface } from '../pi-extension/subagents/terminal-launch.ts';
import { childLaunchSpec } from '../pi-extension/subagents/launch.ts';
import { createRunRuntime } from '../pi-extension/subagents/runtime.ts';
import { ParentIpcServer } from '../pi-extension/subagents/ipc.ts';
import { createSubagentSession } from '../pi-extension/subagents/session.ts';

if (!process.argv.includes('--inside-isolated-display')) {
  const env = { ...process.env, PI_TEST_ORIGINAL_DISPLAY: process.env.DISPLAY ?? '' };
  delete env.WAYLAND_DISPLAY; delete env.WEZTERM_UNIX_SOCKET; delete env.WEZTERM_PANE;
  const child = spawn(process.env.XVFB_RUN ?? 'xvfb-run', ['-a', process.execPath, fileURLToPath(import.meta.url), '--inside-isolated-display'], { env, stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  assert.ok(process.env.DISPLAY && process.env.DISPLAY !== process.env.PI_TEST_ORIGINAL_DISPLAY, 'Refusing to use the live desktop display');
  assert.equal(process.env.WAYLAND_DISPLAY, undefined);
  const directory = mkdtempSync(join(tmpdir(), 'pi-isolated-visible-'));
  const capture = join(directory, 'capture.mjs');
  const rootState = join(directory, 'root.json');
  const config = join(directory, 'wezterm.lua');
  writeFileSync(config, `return { enable_wayland = false, front_end = 'Software', check_for_updates = false, animation_fps = 1, max_fps = 10, enable_tab_bar = false, initial_cols = 160, initial_rows = 50 }`);
  writeFileSync(capture, `import {writeFileSync} from 'node:fs';
let text = ''; const path = process.argv[2];
const save = () => writeFileSync(path, JSON.stringify({text, pane: process.env.WEZTERM_PANE, socket: process.env.WEZTERM_UNIX_SOCKET, arg: process.argv[3], value: process.env.FIXTURE_VALUE, cwd: process.cwd()}));
process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', data => {text += data.toString(); save();}); save(); console.log('Direct process is running.');\n`);
  const gui = spawn('wezterm', ['--config-file', config, 'start', '--always-new-process', '--no-auto-connect', '--workspace', 'isolated-root', '--', process.execPath, capture, rootState], { stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  gui.stdout.on('data', data => { diagnostics += data; });
  gui.stderr.on('data', data => { diagnostics += data; });
  const prepared = [];
  let ipc;
  const wait = async predicate => {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Isolated GUI fixture timed out: ${diagnostics.slice(-3000)}`);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  const xdotool = process.env.XDOTOOL ?? 'xdotool';
  const x = args => execFileSync(xdotool, args, { encoding: 'utf8', timeout: 5000 }).trim();
  const mux = args => execFileSync('wezterm', ['cli', ...args], { encoding: 'utf8', timeout: 5000 }).trim();
  const panes = () => JSON.parse(mux(['list', '--format', 'json']));
  try {
    await wait(() => existsSync(rootState));
    const root = JSON.parse(readFileSync(rootState, 'utf8'));
    assert.ok(root.socket && root.pane, 'Missing isolated mux identity');
    process.env.WEZTERM_UNIX_SOCKET = root.socket;
    process.env.WEZTERM_PANE = root.pane;
    process.env.PI_SUBAGENT_MUX = 'wezterm';
    const origin = panes().find(pane => String(pane.pane_id) === root.pane);
    let window;
    await wait(() => {
      try { window = x(['search', '--onlyvisible', '--class', 'org.wezfurlong.wezterm']).split('\n')[0]; return !!window; } catch { return false; }
    });
    x(['windowfocus', '--sync', window]);
    const childStates = [], surfaces = [];
    const literal = `quotes ' " ; $(touch ${join(directory, 'injected')})`;
    let parentWidth;
    for (let i = 0; i < 3; i++) {
      const state = join(directory, `child-${i}.json`);
      childStates.push(state);
      const launch = prepareLaunch({ argv: [process.execPath, capture, state, literal], cwd: directory, env: { FIXTURE_VALUE: literal }, unset: [] });
      prepared.push(launch);
      const child = launchVisibleSurface({ runId: crypto.randomUUID(), name: `isolated-test-${i}`, cwd: directory, argv: launch.argv, siblingSurfaces: surfaces });
      surfaces.push(child.surface);
      await wait(() => existsSync(state));
      const rows = panes(), pane = rows.find(pane => String(pane.pane_id) === child.surface);
      assert.equal(pane.tab_id, origin.tab_id, 'Child was hidden in another tab');
      assert.equal(pane.window_id, origin.window_id, 'Child was hidden in another window');
      assert.equal(pane.workspace, origin.workspace, 'Child was hidden in another workspace');
      assert.ok(pane.size.cols > 0 && pane.size.rows > 0);
      const width = rows.find(pane => String(pane.pane_id) === root.pane).size.cols;
      if (parentWidth === undefined) parentWidth = width; else assert.equal(width, parentWidth, 'Further children shrank the parent');
      const observed = JSON.parse(readFileSync(state, 'utf8'));
      assert.equal(observed.text, '', 'Launcher typed into the terminal');
      assert.equal(observed.arg, literal);
      assert.equal(observed.value, literal);
      assert.equal(observed.cwd, directory);
    }
    assert.equal(existsSync(join(directory, 'injected')), false, 'Shell syntax executed');
    const text = 'visible-child-can-receive-user-input';
    const active = panes().find(pane => pane.is_active && pane.tab_id === origin.tab_id);
    assert.ok(surfaces.includes(String(active.pane_id)), 'Expected the visible child to be focused');
    x(['type', '--clearmodifiers', '--delay', '4', text]);
    const activeState = childStates[surfaces.indexOf(String(active.pane_id))];
    await wait(() => JSON.parse(readFileSync(activeState, 'utf8')).text === text);
    assert.equal(JSON.parse(readFileSync(rootState, 'utf8')).text, '');
    console.log('PASS: three direct launches visible in the parent tab; parent space preserved; literal argv/env intact; no launch typing; focused child receives deliberate input.');
    for (const surface of surfaces) mux(['kill-pane', '--pane-id', surface]);

    if (process.env.PI_REAL_STARTUP_SMOKE === '1') {
      const runtime = createRunRuntime();
      runtime.parentIpcSocketPath = join(directory, 'parent.sock');
      ipc = new ParentIpcServer({ socketPath: runtime.parentIpcSocketPath, onMessage() {} });
      await ipc.start();
      const firstRun = crypto.randomUUID();
      const { sessionFile } = createSubagentSession({ sessionDir: directory, cwd: directory, parentSessionId: 'smoke-parent', parentSessionFile: join(directory, 'parent.jsonl'), runId: firstRun, name: 'real Pi smoke', mode: 'fresh', task: '' });
      for (const runId of [firstRun, crypto.randomUUID()]) {
        const token = crypto.randomUUID();
        ipc.registerChild(runId, token);
        const spec = childLaunchSpec(runtime, { schemaVersion: 1, tools: ['read', 'bash', 'subagent_done', 'set_tab_title'], autoExit: false }, runId, 'real Pi smoke', sessionFile, directory);
        // Test this checkout, not a second copy discovered via installed packages.
        // No prompt is passed, and offline mode forbids package updates.
        spec.argv.splice(1, 0, '--offline', '--no-extensions', '-e', fileURLToPath(new URL('../pi-extension/subagents/index.ts', import.meta.url)));
        spec.env.PI_SUBAGENT_TOKEN = token;
        const launch = prepareLaunch(spec);
        prepared.push(launch);
        const child = launchVisibleSurface({ runId, name: 'real Pi smoke', cwd: directory, argv: launch.argv });
        await waitForConnection({ connected: () => ipc.isConnected(runId), failure: launch.failure, timeoutMs: 15000 });
        const pane = panes().find(pane => String(pane.pane_id) === child.surface);
        assert.equal(pane.tab_id, origin.tab_id);
        assert.equal(pane.workspace, origin.workspace);
        ipc.send(runId, 'shutdown', { runId });
        await wait(() => !panes().some(pane => String(pane.pane_id) === child.surface));
        ipc.unregisterChild(runId);
      }
      console.log('PASS: actual Pi CLI authenticated in visible splits for a fresh session and its resume; no task/model request sent.');
    }
  } finally {
    await ipc?.close();
    gui.kill('SIGTERM');
    await new Promise(resolve => { if (gui.exitCode !== null) return resolve(); gui.once('exit', resolve); setTimeout(() => { gui.kill('SIGKILL'); resolve(); }, 2000).unref(); });
    for (const launch of prepared) launch.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}
