import { config } from './config.ts';

type Level = 'error' | 'warn' | 'info' | 'debug';

const LEVELS: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level: Level, args: unknown[]) {
  if (LEVELS[level] > threshold) return;
  const timestamp = new Date().toISOString();
  const line = `${timestamp} [${level.toUpperCase()}]`;
  if (level === 'error') console.error(line, ...args);
  else if (level === 'warn') console.warn(line, ...args);
  else console.log(line, ...args);
}

export const logger = {
  error: (...args: unknown[]) => emit('error', args),
  warn: (...args: unknown[]) => emit('warn', args),
  info: (...args: unknown[]) => emit('info', args),
  debug: (...args: unknown[]) => emit('debug', args),
};
