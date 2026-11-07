// Structured diagnostic log: one JSON line per event in <dir>/logs/director.jsonl (docs/logging.md).
// The only module that imports @logtape/*. It overrides the LogTape 2.4.2 defaults that would write to stdout,
// lose the last events or leak Error properties; test/log.mts pins each of them.
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { compareLogLevel, configureSync, getJsonLinesFormatter, getLogger, isLogLevel, resetSync, withContext } from '@logtape/logtape';
import type { LogLevel, Sink } from '@logtape/logtape';
import { getRotatingFileSink } from '@logtape/file';

export type { LogLevel };
const SERVICE = 'render-director';
/** Keys the flattened JSON line already has; a property with one of these names would overwrite it. */
const RESERVED = new Set(['message', 'level', 'logger', '@timestamp']);
const fmt = getJsonLinesFormatter({ properties: 'flatten' });
let active = false;

export interface LoggingOptions {
  /** Director's state folder (.vork/ or runs/); events go to <dir>/logs/director.jsonl. */
  dir: string;
  /** Lowest level written to the file. Default RENDER_DIRECTOR_LOG_LEVEL, else info. An invalid value means info. */
  level?: string;
  /** Lowest level also written to stderr (server.log in ADE mode). */
  stderrLevel?: LogLevel;
  maxSize?: number;
  maxFiles?: number;
  /** Receives every event written to the file, parsed, for tests. */
  testSink?: (event: Record<string, unknown>) => void;
}

export function setupLogging({ dir, level, stderrLevel = 'warning', maxSize = 5_000_000, maxFiles = 3, testSink }: LoggingOptions): void {
  const wanted = level ?? (process.env.RENDER_DIRECTOR_LOG_LEVEL || 'info');
  // An invalid level would make every later log call throw a TypeError (compareLogLevel, level.js:66).
  const lowest: LogLevel = isLogLevel(wanted) ? wanted : 'info';
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(logs, { recursive: true }); // the file sink does not create folders
  const write = (r: Parameters<Sink>[0]) => { process.stderr.write(fmt(r)); };
  // Own synchronous sinks: getStreamSink has an async dispose, which configureSync refuses (config.js:361-362),
  // and getConsoleSink writes info to stdout.
  const sinks: Record<string, Sink> = {
    // bufferSize 0: the default 8KB buffer would lose the last events before exit (filesink.base.js:432-434).
    file: getRotatingFileSink(path.join(logs, 'director.jsonl'), { bufferSize: 0, maxSize, maxFiles, formatter: fmt }),
    stderr: (r) => { if (compareLogLevel(r.level, stderrLevel) >= 0) write(r); },
    meta: write,
  };
  if (testSink) sinks.test = (r) => testSink(JSON.parse(fmt(r)));
  configureSync({
    reset: true,
    contextLocalStorage: new AsyncLocalStorage<Record<string, unknown>>(),
    sinks,
    loggers: [
      { category: SERVICE, sinks: Object.keys(sinks).filter((s) => s !== 'meta'), lowestLevel: lowest },
      // Without this LogTape adds a console sink to the meta logger and prints an info line to stdout (config.js:378-380).
      { category: ['logtape', 'meta'], sinks: ['meta'], lowestLevel: 'warning' },
    ],
  });
  active = true;
  if (lowest !== wanted) log('log').warn('config.invalid', 'Unknown log level, using info', { source: level === undefined ? 'RENDER_DIRECTOR_LOG_LEVEL' : 'setupLogging', fallback: 'info' });
}

/** Flushes and closes the file. Idempotent; logging afterwards does nothing. */
export function shutdownLogging(): void {
  if (!active) return;
  active = false;
  resetSync();
}

type Emit = (event: string, msg: string, props?: Record<string, unknown>) => void;
export interface Log { debug: Emit; info: Emit; warn: Emit; error: Emit; fatal: Emit }

/**
 * A logger for one module. msg is a fixed sentence for people; data goes in props, never a raw Error (use errFields)
 * and never user input or secrets (docs/logging.md section 6).
 */
export function log(component: string): Log {
  const logger = getLogger([SERVICE, component]);
  const emit = (level: 'debug' | 'info' | 'warning' | 'error' | 'fatal'): Emit => (event, msg, props = {}) => {
    if (!active) return;
    const p: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) p[RESERVED.has(k) ? `x_${k}` : k] = v;
    // msg is a template: {key} would be replaced by a property; doubled braces stay literal.
    logger[level](msg.includes('{') ? msg.replace(/[{}]/g, '$&$&') : msg, { ...p, event, service: SERVICE, component });
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warning'), error: emit('error'), fatal: emit('fatal') };
}

/**
 * Runs fn with the job's correlation keys (jobId, kind, versionId) on every event it logs, across awaits.
 * Contract for #81: this is where job.start is written, once per job body; job.end is written once where the job ends
 * (#70's endJob) with the keys taken from the job object, because cancelJob runs in the cancel request's context.
 */
export function withJob<T>(job: { id: string; kind: string; versionId: string }, fn: () => T): T {
  if (!active) return fn();
  return withContext({ jobId: job.id, kind: job.kind, versionId: job.versionId }, fn);
}

/** Runs fn with reqId on every event it logs, across awaits, and on the jobs it starts (#79). */
export function withRequest<T>(reqId: string, fn: () => T): T {
  if (!active) return fn();
  return withContext({ reqId }, fn);
}

export interface ErrFields { errorType: string; error?: string; stack?: string }

/**
 * The only form in which an Error goes to the log. LogTape would copy every own key of an Error (formatter.js:295),
 * such as spawnargs, which holds the pairing link. message: false drops the message, also from the stack's first line,
 * for errors whose message can carry user input.
 */
export function errFields(e: unknown, { message = true }: { message?: boolean } = {}): ErrFields {
  if (!(e instanceof Error)) return message ? { errorType: typeof e, error: String(e).slice(0, 2000) } : { errorType: typeof e };
  const out: ErrFields = { errorType: String(e.name) };
  if (message) out.error = String(e.message).slice(0, 2000);
  if (typeof e.stack === 'string') {
    const stack = message ? e.stack : e.stack.split('\n').filter((l) => /^\s+at /.test(l)).join('\n');
    if (stack) out.stack = stack.slice(0, 4000);
  }
  return out;
}
