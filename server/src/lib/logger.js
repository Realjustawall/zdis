import { config } from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? (config.isProd ? LEVELS.info : LEVELS.debug);

const COLORS = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

function emit(level, message, meta) {
  if (LEVELS[level] < threshold) return;
  const time = new Date().toISOString();
  const stream = level === 'error' ? process.stderr : process.stdout;
  if (config.isProd) {
    stream.write(`${JSON.stringify({ time, level, message, ...meta })}\n`);
    return;
  }
  const tail = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  stream.write(`${COLORS[level]}${level.padEnd(5)}${RESET} ${time} ${message}${tail}\n`);
}

export const logger = {
  debug: (message, meta) => emit('debug', message, meta),
  info: (message, meta) => emit('info', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  error: (message, meta) => emit('error', message, meta),
};
