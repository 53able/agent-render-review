// Structured diagnostic log: one JSON line per event in <dir>/logs/director.jsonl (docs/logging.md).
// The only module that imports @logtape/*. It overrides the LogTape 2.4.2 defaults that would write to stdout,
// lose the last events or leak Error properties; test/log.mts pins each of them. The file sink is our own (fileSink).
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { compareLogLevel, configureSync, getJsonLinesFormatter, getLogger, isLogLevel, resetSync, withContext } from '@logtape/logtape';
import type { LogLevel, Sink } from '@logtape/logtape';

export type { LogLevel };
const SERVICE = 'render-director';
/** Keys the flattened JSON line already has; a property with one of these names would overwrite it. */
const RESERVED = new Set(['message', 'level', 'logger', '@timestamp']);
const fmt = getJsonLinesFormatter({ properties: 'flatten' });
/** Fields kept in the file only: stderr goes to server.log in ADE mode, which has no size limit. */
const FILE_ONLY = ['vorkLogTail', 'stack'];
/** A V8 stack frame: "    at fn (file:line:col)", "    at file:line:col" or "    at fn (native)"-like forms ending in a location. */
const FRAME = /^\s+at (?:.+ \((?:.+:\d+:\d+|native|<anonymous>|index \d+)\)|.+:\d+:\d+|<anonymous>)$/;
let active = false;

/**
 * Appends each record to file and rotates it to file.1 … file.<maxFiles> (the names @logtape/file used) once the next
 * record would take it past maxSize. It holds no file descriptor: @logtape/file 2.4.2 keeps writing to a closed fd when
 * the file is deleted while it runs (docs/logging.md section 7). Never throws; each kind of failure goes to stderr once.
 */
function fileSink(file: string, maxSize: number, maxFiles: number): Sink {
  const dir = path.dirname(file);
  const reported = new Set<string>();
  // Each kind of failure, by event and error code, goes to stderr once (stderr is server.log in ADE mode, which has
  // no size limit), so a later lasting failure is not hidden by an earlier passing one.
  const report = (event: string, message: string, e: unknown) => {
    const key = `${event}:${(e as NodeJS.ErrnoException)?.code ?? ''}`;
    if (reported.has(key)) return;
    reported.add(key);
    try {
      process.stderr.write(JSON.stringify({
        '@timestamp': new Date().toISOString(), level: 'ERROR', logger: `${SERVICE}.log`, message,
        event, service: SERVICE, component: 'log', errorType: errFields(e).errorType, code: (e as NodeJS.ErrnoException)?.code ?? null,
      }) + '\n');
    } catch {}
  };
  const notPlainFile = Object.assign(new Error('not a plain file with one link'), { code: 'ELINK' });
  return (r) => {
    try {
      // .vork/ is writable by the agent. A symlink or a hard link put in place of logs/ or the log file must not
      // redirect the writes to another file (the same nlink and O_NOFOLLOW checks /runs/ makes, src/http.mts).
      // logs/ removed, or replaced by a symlink: our own name of it is removed and the folder made again.
      let d: fs.Stats | null = null;
      try { d = fs.lstatSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (d && d.isSymbolicLink()) { fs.unlinkSync(dir); d = null; report('log.dir_replaced', 'logs/ was a symlink; it was unlinked and made again', notPlainFile); }
      if (!d) fs.mkdirSync(dir);
      else if (!d.isDirectory()) throw Object.assign(new Error('logs is not a directory'), { code: 'ENOTDIR' });
      let st: fs.Stats | null = null;
      try { st = fs.lstatSync(file); } catch {}
      if (st && (!st.isFile() || st.nlink !== 1)) {
        // Unlinking our own name of it leaves the file it points at, or shares its data with, as it was.
        fs.unlinkSync(file); st = null; // throws for a directory: reported as log.write_failed below
        report('log.file_replaced', 'The log file was not a plain file with one link; it was unlinked and started again', notPlainFile);
      }
      const line = Buffer.from(fmt(r));
      if (st && st.size > 0 && st.size + line.length > maxSize) {
        for (let i = maxFiles - 1; i > 0; i--) { try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch {} }
        try { fs.renameSync(file, `${file}.1`); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') report('log.rotate_failed', 'Could not rotate the log file', e); }
      }
      // O_NONBLOCK: a FIFO put there between lstat and open would otherwise block open, and with it the whole process.
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
      try {
        // Checked again on the open file: the name could have been swapped between lstat and open.
        const o = fs.fstatSync(fd);
        if (!o.isFile() || o.nlink !== 1) throw notPlainFile;
        fs.writeSync(fd, line);
      } finally { fs.closeSync(fd); }
    } catch (e) {
      report('log.write_failed', 'Could not write the log file', e);
    }
  };
}

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
  // At least one rotated file and a positive size, so that "at most maxFiles + 1 files" holds.
  maxFiles = Math.max(1, Math.floor(maxFiles)); maxSize = Math.max(1, maxSize);
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(logs, { recursive: true }); // the file sink does not create folders
  const write = (r: Parameters<Sink>[0]) => { process.stderr.write(fmt(r)); };
  // Own synchronous sinks: getStreamSink has an async dispose, which configureSync refuses (config.js:361-362),
  // and getConsoleSink writes info to stdout.
  const sinks: Record<string, Sink> = {
    // Written at once, record by record: a buffer would lose the last events before exit.
    file: fileSink(path.join(logs, 'director.jsonl'), maxSize, maxFiles),
    stderr: (r) => {
      if (compareLogLevel(r.level, stderrLevel) < 0) return;
      const properties = { ...r.properties }; for (const k of FILE_ONLY) delete properties[k];
      write({ ...r, properties });
    },
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

/** Removes the logging setup. Idempotent; logging afterwards does nothing. */
export function shutdownLogging(): void {
  if (!active) return;
  active = false;
  // Callers run this on the way to process.exit; a failure here must not stop them.
  try { resetSync(); } catch {}
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
    let stack = e.stack;
    if (!message) {
      // The stack starts with `${name}: ${message}`, and the message can hold lines that look like frames ("    at x").
      const head = e.message ? `${e.name}: ${e.message}` : String(e.name);
      if (stack.startsWith(head)) stack = stack.slice(head.length);
      // Only lines shaped like V8 frames are kept, also when the head did not match (a name or message changed later).
      stack = stack.split('\n').filter((l) => FRAME.test(l)).join('\n');
    }
    if (stack) out.stack = stack.slice(0, 4000);
  }
  return out;
}
