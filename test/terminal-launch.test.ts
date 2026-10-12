import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directLaunchCommand } from '../pi-extension/subagents/terminal-launch.ts';

const launch = { runId: 'test-run', name: 'literal ; name', cwd: '/tmp/literal path', argv: ['node', '/tmp/file ; literal'] };
const pane = (pane_id: number, tab_id = 11, window_id = 7) => ({ pane_id, tab_id, window_id });
const origin = pane(10, 10);

function withOrigin(action: () => void) {
  const saved = process.env.WEZTERM_PANE;
  process.env.WEZTERM_PANE = '10';
  try { action(); } finally {
    if (saved === undefined) delete process.env.WEZTERM_PANE; else process.env.WEZTERM_PANE = saved;
  }
}

test('first child opens a dedicated tab explicitly in the live origin window', () => withOrigin(() => {
  const command = directLaunchCommand('wezterm', launch, [origin, pane(90, 90, 99)]);
  assert.deepEqual(command, { executable: 'wezterm', args: ['cli', 'spawn', '--window-id', '7', '--cwd', launch.cwd, '--', ...launch.argv] });
  assert.throws(() => directLaunchCommand('wezterm', launch, [pane(90, 90, 99)]), /Originating.*absent/);
}));

test('second child splits only a solitary live sibling in a different tab', () => withOrigin(() => {
  const command = directLaunchCommand('wezterm', { ...launch, siblingSurfaces: ['20', 'dead'] }, [origin, pane(20)]);
  assert.deepEqual(command.args, ['cli', 'split-pane', '--pane-id', '20', '--bottom', '--percent', '50', '--cwd', launch.cwd, '--', ...launch.argv]);
}));

test('foreign panes, full tabs, completed/dead children, parent tab and foreign windows are not split', () => withOrigin(() => {
  for (const [rows, siblings] of [
    [[origin, pane(20), pane(21)], ['20', '21']], // two live children
    [[origin, pane(20), pane(99)], ['20']], // foreign or completed pane
    [[origin, pane(20)], []], // completed sole child
    [[origin], ['20']], // dead child
    [[origin, pane(20, 10)], ['20']], // moved into parent tab
    [[origin, pane(20, 11, 99)], ['20']], // moved to another window
    [[origin, pane(99)], ['dead']], // focused foreign pane must not be split
  ] as const) {
    const command = directLaunchCommand('wezterm', { ...launch, siblingSurfaces: [...siblings] }, [...rows]);
    assert.equal(command.args[1], 'spawn');
    assert.equal(command.args[command.args.indexOf('--window-id') + 1], '7');
  }
}));

test('live moves and freed capacity are re-evaluated rather than cached', () => withOrigin(() => {
  const siblingSurfaces = ['20', '21'];
  assert.equal(directLaunchCommand('wezterm', { ...launch, siblingSurfaces }, [origin, pane(20), pane(21)]).args[1], 'spawn');
  const moved = directLaunchCommand('wezterm', { ...launch, siblingSurfaces }, [origin, pane(20, 15), pane(21)]);
  assert.equal(moved.args[moved.args.indexOf('--pane-id') + 1], '20');
  const freed = directLaunchCommand('wezterm', { ...launch, siblingSurfaces: ['21'] }, [origin, pane(21)]);
  assert.equal(freed.args[freed.args.indexOf('--pane-id') + 1], '21');
}));

test('tmux direct split argv is unchanged and needs no WezTerm layout', () => {
  const saved = process.env.TMUX_PANE;
  process.env.TMUX_PANE = '%42';
  try {
    assert.deepEqual(directLaunchCommand('tmux', launch), { executable: 'tmux', args: ['split-window', '-d', '-h', '-t', '%42', '-c', launch.cwd, '-P', '-F', '#{pane_id}', '--', ...launch.argv] });
  } finally {
    if (saved === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = saved;
  }
});
