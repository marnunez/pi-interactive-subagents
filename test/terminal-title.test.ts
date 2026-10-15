import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { terminalTitle, paneTitleOsc } from '../pi-extension/subagents/terminal-title.mjs';
import { childTabLabels } from '../pi-extension/subagents/terminal-launch.ts';
import { registerManagementTools } from '../pi-extension/subagents/management-tools.ts';
import { prepareLaunch } from '../pi-extension/subagents/launch-process.ts';
import { registerCommands } from '../pi-extension/subagents/commands.ts';

const pane = (pane_id: number, tab_id: number, window_id = 7) => ({ pane_id, tab_id, window_id });
const origin = pane(0, 1);

test('terminal titles strip all C0/C1 controls, bound Unicode and cannot inject OSC', () => {
  const controls = Array.from({ length: 160 }, (_, i) => String.fromCharCode(i)).filter(c => /[\u0000-\u001f\u007f-\u009f]/.test(c)).join('');
  const hostile = `Review${controls}\x1b]52;c;injected\x07\x1b\\`;
  const clean = terminalTitle(hostile);
  assert.doesNotMatch(clean, /[\u0000-\u001f\u007f-\u009f]/);
  assert.equal(paneTitleOsc(hostile), `\x1b]2;${clean}\x07`);
  assert.equal(Array.from(terminalTitle('🧪'.repeat(1000))).length, 160);
  assert.equal(terminalTitle('\x07\x1b\n'), 'Subagent');
  assert.throws(() => terminalTitle(null), /must be a string/);
  assert.equal(terminalTitle('literal ; $(echo nope) "name"'), 'literal ; $(echo nope) "name"');
});

test('labels combine stable live child names; completion removes only the finished name', () => {
  const runs = [{ surface: '10', name: 'Review' }, { surface: '11', name: 'Implement' }];
  const rows = [origin, pane(10, 2), pane(11, 2)];
  assert.deepEqual(childTabLabels(runs, rows, '0'), [{ tabId: 2, title: 'Review | Implement' }]);
  assert.deepEqual(childTabLabels(runs.toReversed(), rows.toReversed(), '0'), [{ tabId: 2, title: 'Review | Implement' }]);
  assert.deepEqual(childTabLabels([runs[1]], rows, '0', ['10']), [{ tabId: 2, title: 'Implement' }]);
  assert.deepEqual(childTabLabels([runs[1]], [origin, pane(11, 2)], '0'), [{ tabId: 2, title: 'Implement' }]);
  const long = childTabLabels(runs.map(run => ({ ...run, name: '\x1b' + 'x'.repeat(1000) })), rows, '0')[0].title;
  assert.ok(long.length <= 160 && long.includes(' | '));
  assert.doesNotMatch(long, /\x1b/);
});

test('parent, foreign, mixed/full tabs and foreign windows never receive labels', () => {
  const runs = [{ surface: '10', name: 'Review' }];
  for (const rows of [
    [origin, pane(10, 1)], [origin, pane(10, 2), pane(99, 2)],
    [origin, pane(10, 2), pane(11, 2), pane(12, 2)],
    [origin, pane(10, 2, 99)], [origin, pane(99, 2)], [pane(10, 2)],
  ]) assert.deepEqual(childTabLabels(runs, rows, '0', ['11', '12']), []);
});

test('progress and legacy alias call only ctx.ui.setTitle; deny/selected snapshots are honoured', async () => {
  const saved = { name: process.env.PI_SUBAGENT_NAME, tools: process.env.PI_SUBAGENT_TOOLS };
  try {
    process.env.PI_SUBAGENT_NAME = 'Review';
    const register = (selection: string, denied: string[] = []) => {
      process.env.PI_SUBAGENT_TOOLS = selection;
      const tools = new Map<string, any>();
      registerManagementTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, {} as any, {} as any, name => ['set_pane_title', 'set_tab_title'].includes(name) && !denied.includes(name));
      return tools;
    };
    const tools = register('set_pane_title');
    assert.equal(tools.has('set_tab_title'), false);
    delete process.env.PI_SUBAGENT_NAME;
    assert.equal(register('set_pane_title,set_tab_title').size, 0, 'Parent must not register child title tools');
    process.env.PI_SUBAGENT_NAME = 'Review';
    const legacy = register('set_tab_title');
    const titles: string[] = [];
    for (const tool of [tools.get('set_pane_title'), legacy.get('set_tab_title')]) {
      assert.match(tool.description, /only this child's terminal pane/);
      const result = await tool.execute('progress', { title: 'Checking\x07\x1b]2;payload' }, undefined, undefined, { mode: 'tui', ui: { setTitle: (title: string) => titles.push(title) } });
      assert.equal(result.details.title, 'Checking]2;payload');
      await assert.rejects(() => tool.execute('bad', { title: 42 }, undefined, undefined, { mode: 'tui' }), /must be a string/);
      await assert.rejects(() => tool.execute('rpc', { title: 'No' }, undefined, undefined, { mode: 'rpc' }), /terminal UI/);
    }
    assert.deepEqual(titles, ['Checking]2;payload', 'Checking]2;payload']);
    assert.equal(register('set_tab_title,set_pane_title', ['set_tab_title', 'set_pane_title']).size, 0);
  } finally {
    for (const [key, value] of [['PI_SUBAGENT_NAME', saved.name], ['PI_SUBAGENT_TOOLS', saved.tools]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
});

test('/plan never renames the parent or shared tab/workspace/window', async () => {
  const commands = new Map<string, any>();
  const messages: string[] = [];
  registerCommands({ registerCommand: (name: string, command: any) => commands.set(name, command), sendUserMessage: (message: string) => messages.push(message) } as any);
  await commands.get('plan').handler('title\x07\x1b]2;payload', { ui: { notify() {}, setTitle() { throw new Error('Parent title must remain untouched'); } } });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Pane display names are automatic/);
});

test('bootstrap title output never contaminates redirected stdout or changes literal argv/env', () => {
  const hostile = 'name\x07\x1b]2;injected';
  const launch = prepareLaunch({ argv: [process.execPath, '-e', 'console.log(JSON.stringify({value: process.env.VALUE, arg: process.argv[1]}))', hostile], env: { VALUE: hostile }, cwd: '/tmp', unset: [], paneTitle: hostile });
  try {
    const child = spawnSync(launch.argv[0], launch.argv.slice(1), { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { value: hostile, arg: hostile });
  } finally { launch.dispose(); }
});
