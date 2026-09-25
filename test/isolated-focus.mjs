// Explicit opt-in integration test. All GUI/input operations use a NEW Xvfb
// display, private WezTerm configuration and separate mux socket, never the desktop.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareLaunch } from '../pi-extension/subagents/launch-process.ts';
import { launchBackgroundSurface } from '../pi-extension/subagents/terminal-launch.ts';

if (!process.argv.includes('--inside-isolated-display')) {
  const env = { ...process.env, PI_TEST_ORIGINAL_DISPLAY: process.env.DISPLAY ?? '' };
  delete env.WAYLAND_DISPLAY; delete env.WEZTERM_UNIX_SOCKET; delete env.WEZTERM_PANE;
  const child = spawn(process.env.XVFB_RUN ?? 'xvfb-run', ['-a', process.execPath, fileURLToPath(import.meta.url), '--inside-isolated-display'], { env, stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  assert.ok(process.env.DISPLAY && process.env.DISPLAY !== process.env.PI_TEST_ORIGINAL_DISPLAY, 'Refusing to use the live desktop display');
  assert.equal(process.env.WAYLAND_DISPLAY, undefined);
  const directory = mkdtempSync(join(tmpdir(), 'pi-isolated-focus-'));
  const capture = join(directory, 'capture.mjs');
  const rootState = join(directory, 'root.json');
  const config = join(directory, 'wezterm.lua');
  writeFileSync(config, `return { enable_wayland = false, front_end = 'Software', check_for_updates = false, animation_fps = 1, max_fps = 10, enable_tab_bar = false }`);
  writeFileSync(capture, `import {writeFileSync} from 'node:fs';
let text = ''; const path = process.argv[2];
const save = () => writeFileSync(path, JSON.stringify({text, pane: process.env.WEZTERM_PANE, socket: process.env.WEZTERM_UNIX_SOCKET}));
process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', data => {text += data.toString(); save();}); save();\n`);
  const gui = spawn('wezterm', ['--config-file', config, 'start', '--always-new-process', '--no-auto-connect', '--workspace', 'isolated-root', '--', process.execPath, capture, rootState], { stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  gui.stdout.on('data', data => { diagnostics += data; });
  gui.stderr.on('data', data => { diagnostics += data; });
  const prepared = [];
  const wait = async predicate => {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Isolated GUI fixture timed out: ${diagnostics.slice(-3000)}`);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  const xdotool = process.env.XDOTOOL ?? 'xdotool';
  const x = args => execFileSync(xdotool, args, { encoding: 'utf8', timeout: 5000 }).trim();
  try {
    await wait(() => existsSync(rootState));
    const root = JSON.parse(readFileSync(rootState, 'utf8'));
    assert.ok(root.socket && root.pane, 'Missing isolated mux identity');
    process.env.WEZTERM_UNIX_SOCKET = root.socket;
    process.env.WEZTERM_PANE = root.pane;
    process.env.PI_SUBAGENT_MUX = 'wezterm';
    let window;
    await wait(() => {
      try { window = x(['search', '--onlyvisible', '--class', 'org.wezfurlong.wezterm']).split('\n')[0]; return !!window; } catch { return false; }
    });
    x(['windowfocus', '--sync', window]);
    const focusBefore = x(['getwindowfocus']);
    const text = 'typing-must-stay-in-the-original-pane-'.repeat(8);
    const typer = spawn(xdotool, ['type', '--clearmodifiers', '--delay', '4', text], { stdio: 'ignore' });
    const typed = new Promise((resolve, reject) => { typer.on('error', reject); typer.on('exit', code => code === 0 ? resolve() : reject(new Error('Input fixture failed'))); });
    const childStates = [];
    for (let i = 0; i < 3; i++) {
      const state = join(directory, `child-${i}.json`);
      childStates.push(state);
      const launch = prepareLaunch({ argv: [process.execPath, capture, state], cwd: directory, env: {}, unset: [] });
      prepared.push(launch);
      launchBackgroundSurface({ runId: crypto.randomUUID(), name: `isolated-test-${i}`, cwd: directory, argv: launch.argv });
    }
    await typed;
    await wait(() => childStates.every(existsSync) && JSON.parse(readFileSync(rootState, 'utf8')).text.length >= text.length);
    assert.equal(x(['getwindowfocus']), focusBefore, 'GUI focus moved');
    assert.equal(JSON.parse(readFileSync(rootState, 'utf8')).text, text, 'Typing was lost or redirected');
    for (const path of childStates) assert.equal(JSON.parse(readFileSync(path, 'utf8')).text, '', 'A child intercepted typing');
    console.log('PASS: three real WezTerm direct launches; original focus preserved; all 296 typed characters stayed in the original pane; children received none.');
  } finally {
    gui.kill('SIGTERM');
    await new Promise(resolve => { if (gui.exitCode !== null) return resolve(); gui.once('exit', resolve); setTimeout(() => { gui.kill('SIGKILL'); resolve(); }, 2000).unref(); });
    for (const launch of prepared) launch.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}
