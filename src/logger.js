const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * @typedef {object} Logger
 * @property {(message: string, error?: unknown) => void} debug
 * @property {(message: string, error?: unknown) => void} info
 * @property {(message: string, error?: unknown) => void} warn
 * @property {(message: string, error?: unknown) => void} error
 */

/** A small leveled logger: one line per entry, errors to stderr. */
export function createLogger(level = 'info') {
  const min = LEVELS[level] ?? LEVELS.info;
  const make = (name, stream) => (message, error) => {
    if (LEVELS[name] < min) return;
    let line = `${new Date().toISOString()} ${name.toUpperCase().padEnd(5)} ${message}`;
    if (error !== undefined) {
      line += ` | ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
    }
    stream.write(`${line}\n`);
  };
  return {
    debug: make('debug', process.stdout),
    info: make('info', process.stdout),
    warn: make('warn', process.stderr),
    error: make('error', process.stderr),
  };
}

/** @type {Logger} */
export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
