/**
 * Tiny level-based logger. No dependency, no transport — stdout is enough for a
 * CLI, and anything worth keeping lands in the `runs` / `findings` tables.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
export type Level = keyof typeof LEVELS;

const configured = (process.env.LOG_LEVEL || 'info').toLowerCase() as Level;
const threshold = LEVELS[configured] ?? LEVELS.info;

function emit(level: Level, args: unknown[]) {
  if (LEVELS[level] > threshold) return;
  const stamp = new Date().toISOString().slice(11, 19);
  const tag = level.toUpperCase().padEnd(5);
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  stream(`${stamp} ${tag}`, ...args);
}

export const log = {
  error: (...a: unknown[]) => emit('error', a),
  warn: (...a: unknown[]) => emit('warn', a),
  info: (...a: unknown[]) => emit('info', a),
  debug: (...a: unknown[]) => emit('debug', a),

  /** Section heading, so a long CLI run stays readable. */
  heading(text: string) {
    console.log(`\n${text}\n${'─'.repeat(Math.min(text.length, 72))}`);
  },
};
