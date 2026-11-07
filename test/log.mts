// Tests of src/log.mts: the LogTape settings that keep stdout clean, rotate the file and keep the event fields intact.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errFields, log, setupLogging, shutdownLogging, withJob } from '../src/log.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vd-log-')));
let pass = 0, failures = 0, n = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e: any) { failures++; console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ')}`); }
  finally { shutdownLogging(); }
}
const newDir = () => path.join(tmp, `case-${++n}`);
const lines = (dir: string) => fs.readFileSync(path.join(dir, 'logs', 'director.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// Created before any setupLogging, as modules do at import time.
const L = log('test');

await check('T6 a process that sets up logging writes nothing to stdout and only warning or above to stderr', async () => {
  const dir = newDir();
  const child = `
    import { setupLogging, log } from ${JSON.stringify(path.join(ROOT, 'src', 'log.mts'))};
    setupLogging({ dir: ${JSON.stringify(dir)}, level: 'debug' });
    const L = log('child');
    L.debug('t6.debug', 'debug line'); L.info('t6.info', 'info line'); L.warn('t6.warn', 'warn line'); L.error('t6.error', 'error line');
  `; // ends on its own, without process.exit
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.length, 0, `stdout: ${r.stdout}`);
  const err = r.stderr.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(err.map((e) => [e.event, e.level]), [['t6.warn', 'WARN'], ['t6.error', 'ERROR']]);
  assert.deepEqual(lines(dir).map((e) => e.event), ['t6.debug', 't6.info', 't6.warn', 't6.error']); // the last event is not left in a buffer
});

await check('T7 with the production settings and maxSize 10000, 1000 events rotate into at most maxFiles + 1 files of JSON lines', async () => {
  const dir = newDir(); const maxFiles = 3;
  setupLogging({ dir, level: 'info', maxSize: 10_000, maxFiles });
  for (let i = 0; i < 1000; i++) L.info('t7.event', 'one of many', { i, pad: 'x'.repeat(40) });
  shutdownLogging();
  const files = fs.readdirSync(path.join(dir, 'logs'));
  assert.ok(files.length > 1, `no rotation: ${files}`);
  assert.ok(files.length <= maxFiles + 1, `too many files: ${files}`);
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, 'logs', f), 'utf8');
    for (const l of text.split('\n').filter(Boolean)) JSON.parse(l);
  }
  assert.equal(lines(dir).at(-1).i, 999);
});

await check('T8 a property named message is renamed to x_message and does not replace the message', async () => {
  const dir = newDir(); const got: Record<string, unknown>[] = [];
  setupLogging({ dir, testSink: (e) => got.push(e) });
  L.info('x', 'x', { message: 'y', level: 'l', logger: 'g', '@timestamp': 't', n: 1 });
  const [e] = lines(dir);
  assert.equal(e.message, 'x'); assert.equal(e.x_message, 'y');
  assert.equal(e.level, 'INFO'); assert.equal(e.x_level, 'l');
  assert.equal(e.logger, 'render-director.test'); assert.equal(e.x_logger, 'g');
  assert.notEqual(e['@timestamp'], 't'); assert.equal(e['x_@timestamp'], 't');
  assert.deepEqual([e.event, e.service, e.component, e.n], ['x', 'render-director', 'test', 1]);
  assert.deepEqual(got, [e]);
});

await check('T8b WARN level, an invalid level, a missing folder and logging after shutdown do not break logging', async () => {
  const dir = path.join(newDir(), 'not', 'yet');
  setupLogging({ dir, level: 'loud', stderrLevel: 'fatal' });
  assert.ok(fs.statSync(path.join(dir, 'logs')).isDirectory());
  L.debug('t8b.debug', 'below info');
  L.warn('t8b.warn', 'a warning');
  L.info('t8b.brace', 'a {literal} brace', { literal: 'replaced' });
  shutdownLogging(); shutdownLogging();
  L.error('t8b.after', 'after shutdown');
  assert.equal(withJob({ id: 'j', kind: 'render', versionId: 'v001' }, () => 7), 7);
  const ev = lines(dir);
  assert.deepEqual(ev.map((e) => e.event), ['config.invalid', 't8b.warn', 't8b.brace']);
  assert.deepEqual([ev[0].level, ev[0].source, ev[0].fallback], ['WARN', 'setupLogging', 'info']);
  assert.equal(ev[1].level, 'WARN');
  assert.equal(ev[2].message, 'a {literal} brace');
});

await check('withJob puts the job keys on every event in the job, across awaits', async () => {
  const dir = newDir();
  setupLogging({ dir });
  await withJob({ id: 'job-1', kind: 'render', versionId: 'v002' }, async () => { await new Promise((r) => setTimeout(r, 1)); L.info('in.job', 'inside'); });
  L.info('out.job', 'outside');
  const [inside, outside] = lines(dir);
  assert.deepEqual([inside.jobId, inside.kind, inside.versionId], ['job-1', 'render', 'v002']);
  assert.equal(outside.jobId, undefined);
});

await check('errFields keeps only type, message and stack, and message: false removes the message from the stack too', async () => {
  const e = Object.assign(new Error('spawn opener ENOENT'), { spawnargs: ['http://127.0.0.1/#pair=SECRET'] });
  assert.deepEqual(Object.keys(errFields(e)), ['errorType', 'error', 'stack']);
  assert.ok(!JSON.stringify(errFields(e)).includes('SECRET'));
  const user = new Error('claude exited 1: UNIQUE-INSTR\nsecond line');
  const f = errFields(user, { message: false });
  assert.equal(f.errorType, 'Error'); assert.equal(f.error, undefined);
  assert.ok(f.stack && f.stack.includes(' at '), String(f.stack)); assert.ok(!f.stack.includes('UNIQUE-INSTR') && !f.stack.includes('second line'));
  assert.equal(errFields(new Error('m'.repeat(3000))).error!.length, 2000);
  assert.deepEqual(errFields('plain', { message: false }), { errorType: 'string' });
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
