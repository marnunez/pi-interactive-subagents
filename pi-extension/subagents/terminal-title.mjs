// Shared by the direct-launch bootstrap and the extension. Never let a title
// terminate OSC or introduce another terminal sequence. Bound Unicode code points.
export const MAX_TERMINAL_TITLE_CHARS = 160;
export function terminalTitle(value, fallback = 'Subagent', limit = MAX_TERMINAL_TITLE_CHARS) {
  if (typeof value !== 'string') throw new Error('Terminal title must be a string.');
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(clean || fallback).slice(0, limit).join('');
}

export function paneTitleOsc(value) {
  return `\x1b]2;${terminalTitle(value)}\x07`;
}
