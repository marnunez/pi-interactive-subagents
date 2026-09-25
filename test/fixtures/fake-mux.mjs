import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const directory = process.env.TEST_LAUNCH_DIR;
const args = process.argv.slice(2);
appendFileSync(join(directory, 'mux-calls.jsonl'), JSON.stringify(args) + '\n');
if (args[0] !== 'cli') throw new Error('Unexpected fake mux invocation');
if (args[1] === 'split-pane') {
  const argv = args.slice(args.indexOf('--') + 1);
  const spec = JSON.parse(readFileSync(argv.at(-1), 'utf8'));
  const journal = readFileSync(process.env.TEST_PARENT_SESSION, 'utf8').trim().split('\n').map(JSON.parse);
  appendFileSync(join(directory, 'launches.jsonl'), JSON.stringify({
    argv: spec.argv, cwd: spec.cwd, runId: spec.env.PI_SUBAGENT_ID,
    journalledBeforeStart: journal.some(entry => entry.customType === 'subagent_ipc_launch' && entry.data.runId === spec.env.PI_SUBAGENT_ID),
  }) + '\n');
  const child = spawn(argv[0], argv.slice(1), { stdio: 'ignore', detached: true });
  child.unref();
  writeFileSync(join(directory, `pane-${child.pid}.json`), JSON.stringify({ pane_id: child.pid, tab_id: 1, window_id: 1 }));
  console.log(child.pid);
} else if (args[1] === 'list') {
  const rows = [{ pane_id: 0, tab_id: 1, window_id: 1 }];
  for (const file of readdirSync(directory).filter(name => name.startsWith('pane-'))) {
    const row = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    try { process.kill(row.pane_id, 0); rows.push(row); } catch {}
  }
  console.log(JSON.stringify(rows));
} else if (args[1] === 'kill-pane') {
  const pid = Number(args[args.indexOf('--pane-id') + 1]);
  // Only a process created by this fixture can be signalled.
  const owned = JSON.parse(readFileSync(join(directory, `pane-${pid}.json`), 'utf8'));
  if (owned.pane_id !== pid) throw new Error('Not owned by the test fixture');
  try { process.kill(pid, 'SIGTERM'); } catch {}
} else throw new Error(`Forbidden terminal operation: ${args[1]}`);
