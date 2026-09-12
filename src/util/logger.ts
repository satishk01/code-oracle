/**
 * Structured Logger
 *
 * A lightweight leveled logger that replaces scattered `console.log` calls.
 * Supports debug, info, warn, and error levels. The active level is driven
 * by the `LOG_LEVEL` env var (default: "info").
 *
 * This is intentionally dependency-free to avoid pulling in pino/etc. It
 * writes to stdout/stderr with an ISO timestamp, level tag, and optional
 * scope. It does NOT change existing behavior — callers that previously
 * used `console.log` get the same output, just structured.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function levelFromEnv(): LogLevel {
  const v = (process.env.LOG_LEVEL ?? '').trim().toLowerCase();
  if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error' || v === 'silent') {
    return v;
  }
  return 'info';
}

class Logger {
  private level: LogLevel;
  private scope: string;

  constructor(scope: string = 'app', level?: LogLevel) {
    this.scope = scope;
    this.level = level ?? levelFromEnv();
  }

  /** Create a child logger with a narrower scope. */
  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`, this.level);
  }

  /** Override the level at runtime (e.g. from config). */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }

  private format(level: LogLevel, msg: string, meta?: Record<string, unknown>): string {
    const ts = new Date().toISOString();
    const metaStr = meta && Object.keys(meta).length > 0 ? ' ' + JSON.stringify(meta) : '';
    return `[${ts}] ${level.toUpperCase()} [${this.scope}] ${msg}${metaStr}`;
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('debug')) console.debug(this.format('debug', msg, meta));
  }

  info(msg: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('info')) console.log(this.format('info', msg, meta));
  }

  warn(msg: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('warn')) console.warn(this.format('warn', msg, meta));
  }

  error(msg: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('error')) console.error(this.format('error', msg, meta));
  }
}

/** Root logger instance. Use `logger.child('myscope')` for scoped logging. */
export const logger = new Logger('codebase-oracle');

// Apply the configured log level (from LOG_LEVEL env var) on import.
// We read the env directly to avoid a circular import with config.ts.
const envLevel = (process.env.LOG_LEVEL ?? '').trim().toLowerCase() as LogLevel;
if (envLevel) logger.setLevel(envLevel);

export { Logger };
