import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
const directory = process.env.TEST_LAUNCH_DIR;
const args = process.argv.slice(2);
appendFileSync(join(directory, 'mux-calls.jsonl'), JSON.stringify(args) + '\n');
if (args[0] !== 'cli') throw new Error('Unexpected fake mux invocation');
const rows = existsSync(join(directory, 'layout.json'))
  ? JSON.parse(readFileSync(join(directory, 'layout.json'), 'utf8'))
  : [{ pane_id: 0, tab_id: 1, window_id: 1 }];
for (const file of readdirSync(directory).filter(name => name.startsWith('pane-'))) {
  const row = JSON.parse(readFileSync(join(directory, file), 'utf8'));
  try { process.kill(row.pane_id, 0); rows.push(row); } catch {}
}
if (args[1] === 'split-pane' || args[1] === 'spawn') {
  if (process.env.TEST_MUX_FAIL === args[1]) process.exit(17);
  const target = args[1] === 'split-pane' && rows.find(row => String(row.pane_id) === args[args.indexOf('--pane-id') + 1]);
  if (args[1] === 'split-pane' && !target) throw new Error('Missing split target');
  const windowId = target ? target.window_id : Number(args[args.indexOf('--window-id') + 1]);
  if (!Number.isSafeInteger(windowId) || !rows.some(row => row.window_id === windowId)) throw new Error('Missing window target');
  const tabId = target ? target.tab_id : Math.max(...rows.map(row => row.tab_id)) + 1;
  const argv = args.slice(args.indexOf('--') + 1);
  const spec = JSON.parse(readFileSync(argv.at(-1), 'utf8'));
  const journal = readFileSync(process.env.TEST_PARENT_SESSION, 'utf8').trim().split('\n').map(JSON.parse);
  appendFileSync(join(directory, 'launches.jsonl'), JSON.stringify({
    argv: spec.argv, cwd: spec.cwd, runId: spec.env.PI_SUBAGENT_ID,
    journalledBeforeStart: journal.some(entry => entry.customType === 'subagent_ipc_launch' && entry.data.runId === spec.env.PI_SUBAGENT_ID),
  }) + '\n');
  const child = spawn(argv[0], argv.slice(1), { stdio: 'ignore', detached: true });
  child.unref();
  writeFileSync(join(directory, `pane-${child.pid}.json`), JSON.stringify({ pane_id: child.pid, tab_id: tabId, window_id: windowId }));
  console.log(child.pid);
} else if (args[1] === 'list') {
  console.log(JSON.stringify(rows));
} else if (args[1] === 'set-tab-title') {
  if (process.env.TEST_TITLE_FAIL === '1') process.exit(19);
  const tabId = Number(args[args.indexOf('--tab-id') + 1]);
  if (!rows.some(row => row.tab_id === tabId)) throw new Error('Missing title target');
  writeFileSync(join(directory, `tab-title-${tabId}.json`), JSON.stringify(args.at(-1)));
} else if (args[1] === 'activate-tab' || args[1] === 'activate-pane') {
  if (process.env.TEST_FOCUS_FAIL === '1') process.exit(18);
  if (args[1] === 'activate-tab') {
    if (args.includes('--pane-id') && args.includes('--tab-id')) throw new Error('Conflicting tab/pane flags');
  } else if (!rows.some(row => String(row.pane_id) === args[args.indexOf('--pane-id') + 1])) throw new Error('Missing focus target');
} else if (args[1] === 'kill-pane') {
  const pid = Number(args[args.indexOf('--pane-id') + 1]);
  // Only a process created by this fixture can be signalled.
  const owned = JSON.parse(readFileSync(join(directory, `pane-${pid}.json`), 'utf8'));
  if (owned.pane_id !== pid) throw new Error('Not owned by the test fixture');
  try { process.kill(pid, 'SIGTERM'); } catch {}
  unlinkSync(join(directory, `pane-${pid}.json`));
} else throw new Error(`Forbidden terminal operation: ${args[1]}`);
