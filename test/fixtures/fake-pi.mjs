import { appendFileSync } from 'node:fs';
import { ChildIpcClient } from '../../pi-extension/subagents/ipc.ts';
import { SUBAGENT_DONE_RESULT_TYPE } from '../../pi-extension/subagents/session.ts';
const runId = process.env.PI_SUBAGENT_ID;
const sessionFile = process.argv[process.argv.indexOf('--session') + 1];
if (process.env.TEST_CHILD_MODE === 'exit-before-connect') process.exit(23);
const client = new ChildIpcClient({
  socketPath: process.env.PI_SUBAGENT_SOCKET, childId: runId, token: process.env.PI_SUBAGENT_TOKEN,
  helloPayload: () => ({ pid: process.pid, sessionFile }),
  onMessage(message) {
    if (message.type === 'completion_ack' || message.type === 'shutdown') {
      client.send('shutdown_ready', { runId });
      setTimeout(() => { client.stop(); process.exit(0); }, 40);
    }
  },
});
// Deliberately delayed handshake: a spawn request alone must never mean started.
setTimeout(() => client.start(), 140);
setTimeout(() => {
  const result = { schemaVersion: 1, runId, status: 'success', summary: 'fake child completed', completedAt: new Date().toISOString() };
  appendFileSync(sessionFile, JSON.stringify({ type: 'custom', customType: SUBAGENT_DONE_RESULT_TYPE, data: result }) + '\n');
  client.send('completion', result);
}, 350);
setTimeout(() => { client.stop(); process.exit(2); }, 8000).unref();
