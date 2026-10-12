// Non-interactive pane entry point. Never reads input or writes commands to the PTY.
// Use a tiny supervisor rather than experimental process.execve: some Node
// versions abort (including a core dump) when execve fails instead of throwing.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paneTitleOsc } from './terminal-title.mjs';

const path = process.argv[2];
function reportFailure(message) {
  try { writeFileSync(join(dirname(path), 'error.json'), JSON.stringify({ error: message }), { mode: 0o600 }); } catch {}
  console.error(message);
}
try {
  const spec = JSON.parse(readFileSync(path, 'utf8'));
  unlinkSync(path);
  if (!Array.isArray(spec.argv) || !spec.argv.length || spec.argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('Invalid launch argument vector');
  }
  const env = { ...process.env };
  for (const name of spec.unset) delete env[name];
  Object.assign(env, spec.env);
  // Set the pane's initial name before Pi starts; session_start reasserts it
  // after Pi's own startup title. Cosmetic failures must not prevent execution.
  if (process.stdout.isTTY && typeof spec.paneTitle === 'string') {
    try { process.stdout.write(paneTitleOsc(spec.paneTitle)); } catch {}
  }
  const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env, stdio: 'inherit', shell: false });
  const handlers = new Map();
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
    const handler = () => { child.kill(signal); };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  const release = () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
  child.once('error', error => {
    release();
    // Codes only: never include a command argument vector or environment values.
    reportFailure(`Direct child launch failed: ${error.code ?? 'spawn error'}`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    release();
    if (code !== 0) reportFailure(`Child process exited before startup was confirmed (status ${code ?? signal}).`);
    process.exitCode = code ?? 1;
  });
} catch (error) {
  reportFailure(`Direct child launch failed: ${error.code ?? 'invalid launch specification'}`);
  process.exitCode = 1;
}
