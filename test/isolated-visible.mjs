// Explicit opt-in: a NEW Xvfb display, private WezTerm configuration and mux
// socket. Never operate on the live desktop. Optional real-Pi smoke sends no task.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareLaunch, waitForConnection } from '../pi-extension/subagents/launch-process.ts';
import { launchVisibleSurface, refreshChildTabTitles } from '../pi-extension/subagents/terminal-launch.ts';
import { terminalTitle } from '../pi-extension/subagents/terminal-title.mjs';
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
  // Capture the label actually rendered by the isolated GUI, not just CLI arguments.
  writeFileSync(config, `local wezterm = require 'wezterm'
wezterm.on('format-tab-title', function(tab)
  local label = tab.tab_title ~= '' and tab.tab_title or tab.active_pane.title
  local f = io.open(${JSON.stringify(directory)} .. '/gui-tab-' .. tab.tab_id .. '.json', 'w')
  if f then f:write(wezterm.json_encode({label=label, title=tab.tab_title})); f:close() end
  return label
end)
return { enable_wayland = false, front_end = 'Software', check_for_updates = false, animation_fps = 1, max_fps = 10, enable_tab_bar = true, initial_cols = 160, initial_rows = 50 }`);
  writeFileSync(capture, `import {writeFileSync} from 'node:fs';
let text = ''; const path = process.argv[2];
const save = () => writeFileSync(path, JSON.stringify({text, pane: process.env.WEZTERM_PANE, socket: process.env.WEZTERM_UNIX_SOCKET, arg: process.argv[3], value: process.env.FIXTURE_VALUE, cwd: process.cwd()}));
process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', data => {text += data.toString(); save(); if (text.endsWith('pane-progress')) process.stdout.write('\\x1b]2;Optional pane progress\\x07');}); save(); console.log('Direct process is running.');\n`);
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
  const guiLabel = tabId => {
    try { return JSON.parse(readFileSync(join(directory, `gui-tab-${tabId}.json`), 'utf8')).label; } catch { return undefined; }
  };
  const waitTitle = (surface, title) => wait(() => panes().find(pane => String(pane.pane_id) === surface)?.title === title);
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
    // Unrelated panes/tabs and a focused foreign window must not become launch
    // targets. These are private test processes on this Xvfb display only.
    mux(['split-pane', '--pane-id', root.pane, '--right', '--', process.execPath, capture, join(directory, 'foreign-parent.json')]);
    mux(['spawn', '--window-id', String(origin.window_id), '--', process.execPath, capture, join(directory, 'foreign-tab.json')]);
    mux(['spawn', '--new-window', '--', process.execPath, capture, join(directory, 'foreign-window.json')]);
    await wait(() => existsSync(join(directory, 'foreign-window.json')));
    const baseline = panes();
    const childStates = [], surfaces = [], runs = [];
    const originBaseline = baseline.filter(pane => pane.window_id === origin.window_id);
    await wait(() => originBaseline.every(pane => guiLabel(pane.tab_id) !== undefined));
    const baselineLabels = new Map(originBaseline.map(pane => [pane.tab_id, guiLabel(pane.tab_id)]));
    const literal = `quotes ' " ; $(touch ${join(directory, 'injected')})`;
    let parentInput = '';
    mux(['activate-tab', '--tab-id', String(origin.tab_id)]);
    mux(['activate-pane', '--pane-id', root.pane]);
    x(['windowfocus', '--sync', window]);
    for (let i = 0; i < 5; i++) {
      const state = join(directory, `child-${i}.json`);
      childStates.push(state);
      const name = i === 4 ? '--isolated-test-4\x07\x1b]2;injection\x9c' : `isolated-test-${i}`;
      const launch = prepareLaunch({ argv: [process.execPath, capture, state, literal], cwd: directory, env: { FIXTURE_VALUE: literal }, unset: [], paneTitle: name });
      prepared.push(launch);
      const child = launchVisibleSurface({ runId: crypto.randomUUID(), name, cwd: directory, argv: launch.argv, siblingSurfaces: surfaces });
      surfaces.push(child.surface);
      runs.push({ surface: child.surface, name });
      refreshChildTabTitles(runs);
      await wait(() => existsSync(state));
      await waitTitle(child.surface, terminalTitle(name));
      const rows = panes(), pane = rows.find(pane => String(pane.pane_id) === child.surface);
      assert.notEqual(pane.tab_id, origin.tab_id, 'Parent tab must remain untouched');
      assert.equal(pane.window_id, origin.window_id, 'Child opened in a foreign or new window');
      assert.equal(pane.workspace, origin.workspace, 'Child was hidden in another workspace');
      assert.ok(pane.size.cols > 0 && pane.size.rows > 0);
      for (const previous of baseline) {
        const current = rows.find(pane => pane.pane_id === previous.pane_id);
        assert.equal(current.tab_id, previous.tab_id);
        assert.equal(current.window_id, previous.window_id);
        assert.deepEqual(current.size, previous.size, 'Launch changed parent/foreign pane space');
      }
      assert.ok(rows.filter(other => other.tab_id === pane.tab_id).length <= 2, 'Child tab exceeded two panes');
      const observed = JSON.parse(readFileSync(state, 'utf8'));
      assert.equal(observed.text, '', 'Launcher typed into the terminal');
      assert.equal(observed.arg, literal);
      assert.equal(observed.value, literal);
      assert.equal(observed.cwd, directory);
      // Actual keyboard input must still reach the originating parent, not
      // merely a pane marked active inside a background tab.
      const marker = `parent-${i}`;
      parentInput += marker;
      x(['type', '--clearmodifiers', '--delay', '4', marker]);
      await wait(() => JSON.parse(readFileSync(rootState, 'utf8')).text === parentInput);
      assert.equal(JSON.parse(readFileSync(state, 'utf8')).text, '');
    }
    assert.equal(existsSync(join(directory, 'injected')), false, 'Shell syntax executed');
    const text = 'visible-child-can-receive-user-input';
    const childRows = panes().filter(pane => surfaces.includes(String(pane.pane_id)));
    assert.deepEqual([...new Set(childRows.map(pane => pane.tab_id))].map(tab => childRows.filter(pane => pane.tab_id === tab).length), [2, 2, 1]);
    const active = panes().find(pane => String(pane.pane_id) === surfaces.at(-1) && pane.is_active);
    assert.ok(surfaces.includes(String(active.pane_id)), 'Expected the last child to be active within its tab');
    // Selecting a child is now an explicit user action.
    mux(['activate-tab', '--tab-id', String(active.tab_id)]);
    mux(['activate-pane', '--pane-id', String(active.pane_id)]);
    x(['windowfocus', '--sync', window]);
    x(['type', '--clearmodifiers', '--delay', '4', text]);
    const activeState = childStates[surfaces.indexOf(String(active.pane_id))];
    await wait(() => JSON.parse(readFileSync(activeState, 'utf8')).text === text);
    assert.equal(JSON.parse(readFileSync(rootState, 'utf8')).text, parentInput);
    const childTabs = [...new Set(childRows.map(pane => pane.tab_id))];
    const labels = ['isolated-test-0 | isolated-test-1', 'isolated-test-2 | isolated-test-3', terminalTitle(runs[4].name)];
    await wait(() => childTabs.every((tab, i) => guiLabel(tab) === labels[i]));
    // Own-pane progress cannot alter the parent-managed shared label.
    mux(['activate-tab', '--tab-id', String(childTabs[0])]);
    mux(['activate-pane', '--pane-id', surfaces[0]]);
    x(['type', '--clearmodifiers', '--delay', '4', 'pane-progress']);
    await waitTitle(surfaces[0], 'Optional pane progress');
    assert.equal(panes().find(pane => String(pane.pane_id) === surfaces[1]).title, runs[1].name);
    assert.equal(guiLabel(childTabs[0]), labels[0]);
    // Completion/cancellation leaves the surviving child's stable name visible,
    // even while the retiring pane is waiting for process cleanup.
    refreshChildTabTitles(runs.slice(1), [surfaces[0]]);
    await wait(() => guiLabel(childTabs[0]) === runs[1].name);
    mux(['kill-pane', '--pane-id', surfaces[0]]);
    refreshChildTabTitles(runs.slice(1));
    await wait(() => guiLabel(childTabs[0]) === runs[1].name);
    for (const [tabId, label] of baselineLabels) assert.equal(guiLabel(tabId), label, 'Parent/foreign GUI title was overwritten');
    console.log('PASS: isolated GUI renders automatic child pane names and combined 2/2/1 tab labels without model calls; safe OSC controls; pane progress leaves shared labels unchanged; surviving name remains after completion; parent focus preserved after every launch; parent/foreign titles and geometry untouched; literal argv/env and deliberate input verified.');
    for (const surface of surfaces.slice(1)) mux(['kill-pane', '--pane-id', surface]);

    if (process.env.PI_REAL_STARTUP_SMOKE === '1') {
      const runtime = createRunRuntime();
      runtime.parentIpcSocketPath = join(directory, 'parent.sock');
      const readyFrames = new Map();
      ipc = new ParentIpcServer({ socketPath: runtime.parentIpcSocketPath, onMessage(message) {
        if (message.type === 'ready') readyFrames.set(message.childId, (readyFrames.get(message.childId) ?? 0) + 1);
      } });
      await ipc.start();
      const smokeExtension = join(directory, 'title-smoke.ts');
      writeFileSync(smokeExtension, `import { registerManagementTools } from ${JSON.stringify(fileURLToPath(new URL('../pi-extension/subagents/management-tools.ts', import.meta.url)))};
export default function(pi) {
  const tools = new Map();
  registerManagementTools({registerTool: tool => tools.set(tool.name, tool)}, {}, {}, name => ['set_pane_title', 'set_tab_title'].includes(name));
  pi.registerCommand('title-smoke-progress', {description: 'Isolated test: exercise selected pane title tool without a model', handler: async (_args, ctx) => {
    const name = process.env.PI_SUBAGENT_TOOLS.includes('set_tab_title') ? 'set_tab_title' : 'set_pane_title';
    await tools.get(name).execute('isolated-progress', {title: 'Pi progress\\u0007\\u001b]2;unsafe'}, undefined, undefined, ctx);
  }});
}
`);
      const firstRun = crypto.randomUUID();
      const { sessionFile } = createSubagentSession({ sessionDir: directory, cwd: directory, parentSessionId: 'smoke-parent', parentSessionFile: join(directory, 'parent.jsonl'), runId: firstRun, name: 'real Pi smoke', mode: 'fresh', task: '' });
      for (const runId of [firstRun, crypto.randomUUID()]) {
        const token = crypto.randomUUID();
        ipc.registerChild(runId, token);
        const spec = childLaunchSpec(runtime, { schemaVersion: 1, tools: ['subagent_done', runId === firstRun ? 'set_pane_title' : 'set_tab_title'], autoExit: false }, runId, 'real Pi smoke', sessionFile, directory);
        // Test this checkout, not a second copy discovered via installed packages.
        // No prompt is passed, and offline mode forbids package updates.
        spec.argv.splice(1, 0, '--offline', '--no-extensions', '-e', fileURLToPath(new URL('../pi-extension/subagents/index.ts', import.meta.url)), '-e', smokeExtension);
        spec.env.PI_SUBAGENT_TOKEN = token;
        const launch = prepareLaunch(spec);
        prepared.push(launch);
        const child = launchVisibleSurface({ runId, name: 'real Pi smoke', cwd: directory, argv: launch.argv });
        refreshChildTabTitles([{ surface: child.surface, name: 'real Pi smoke' }]);
        await waitForConnection({ connected: () => ipc.isConnected(runId), failure: launch.failure, timeoutMs: 15000 });
        const pane = panes().find(pane => String(pane.pane_id) === child.surface);
        assert.notEqual(pane.tab_id, origin.tab_id);
        assert.equal(pane.window_id, origin.window_id);
        assert.equal(pane.workspace, origin.workspace);
        await waitTitle(child.surface, 'real Pi smoke');
        await wait(() => guiLabel(pane.tab_id) === 'real Pi smoke');
        await wait(() => readyFrames.get(runId) >= 1);
        const readyBeforeReload = readyFrames.get(runId);
        mux(['activate-tab', '--tab-id', String(pane.tab_id)]);
        mux(['activate-pane', '--pane-id', child.surface]);
        x(['type', '--clearmodifiers', '--delay', '4', '/title-smoke-progress']);
        x(['key', 'Return']);
        await waitTitle(child.surface, 'Pi progress]2;unsafe');
        assert.equal(guiLabel(pane.tab_id), 'real Pi smoke', 'Progress tool changed the GUI tab label');
        // /reload is a deliberate UI command, never a task/model request.
        x(['type', '--clearmodifiers', '--delay', '4', '/reload']);
        x(['key', 'Return']);
        await wait(() => readyFrames.get(runId) > readyBeforeReload);
        await waitTitle(child.surface, 'real Pi smoke');
        assert.equal(guiLabel(pane.tab_id), 'real Pi smoke');
        ipc.send(runId, 'shutdown', { runId });
        await wait(() => !panes().some(pane => String(pane.pane_id) === child.surface));
        ipc.unregisterChild(runId);
        const entries = readFileSync(sessionFile, 'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(entries.some(entry => entry.type === 'message'), false, 'Smoke unexpectedly sent a task/model request');
      }
      console.log('PASS: actual Pi CLI fresh/reload/resume automatic names survive Pi startup; new and legacy progress tools change only the pane; GUI tab labels remain stable; no task/model request sent.');
    }
  } catch (error) {
    console.error('Isolated files:', readdirSync(directory));
    console.error('GUI snapshots:', readdirSync(directory).filter(name => name.startsWith('gui-tab-')).map(name => [name, readFileSync(join(directory, name), 'utf8')]));
    console.error('Mux panes:', panes());
    console.error('GUI diagnostics:', diagnostics.slice(0, 1000));
    throw error;
  } finally {
    await ipc?.close();
    gui.kill('SIGTERM');
    await new Promise(resolve => { if (gui.exitCode !== null) return resolve(); gui.once('exit', resolve); setTimeout(() => { gui.kill('SIGKILL'); resolve(); }, 2000).unref(); });
    for (const launch of prepared) launch.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}
