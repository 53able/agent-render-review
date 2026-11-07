// Tests of src/http.mts that need no vork: the route http.request logs, unparsable request targets, and the level and
// fields of http.request. The server runs in this process with a Director whose Renderer is never called.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createDirector } from '../src/director.mts';
import { createHttp, parseTarget, routeOf } from '../src/http.mts';
import { setupLogging, shutdownLogging } from '../src/log.mts';
import type { Scene } from '../src/policy.mts';
import type { Renderer } from '../src/vork.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vd-http-')));
let pass = 0, failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e: any) { failures++; console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ')}`); }
}

const logged: Record<string, unknown>[] = [];
setupLogging({ dir: path.join(tmp, 'log'), level: 'debug', stderrLevel: 'fatal', testSink: (e) => logged.push(e) });
const starter = JSON.parse(fs.readFileSync(path.join(ROOT, 'scenes', 'starter.json'), 'utf8')) as Scene;
const renderer: Renderer = { version: 'fake 1.0', render: async () => ({ ok: false, code: 1, timedOut: false, log: 'not used', seconds: 0 }) };
const runs = path.join(tmp, 'runs'); fs.mkdirSync(runs);
const director = createDirector({ runs, project: null, renderer, starter });
const web = createHttp({ director, root: ROOT, publicDir: path.join(ROOT, 'public'), vorkVersion: 'fake 1.0', model: 'none', port: 0 });
await new Promise<void>((ok) => web.server.listen(0, '127.0.0.1', ok));
web.port = (web.server.address() as AddressInfo).port;
const BASE = `http://127.0.0.1:${web.port}`;
const seen = new Set<unknown>();
/** The http.request event of the request answered last; it is written on finish, which can come after the response. */
const lastRequest = async (): Promise<Record<string, any>> => {
  for (let i = 0; i < 100; i++) {
    const e = logged.findLast((x) => x.event === 'http.request');
    if (e && !seen.has(e)) { seen.add(e); return e; }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no new http.request');
};

await check('routeOf logs a normalized route, never the raw path', async () => {
  const cases: [string, string][] = [
    ['/', '/static'], ['/app.js', '/static'], ['/whatever/v001/x', '/static'],
    ['/runs/v001/draft.png', '/runs/*'], ['/runs/anything', '/runs/*'],
    ['/api/jobs/abc', '/api/jobs/:id'], ['/api/jobs/abc/cancel', '/api/jobs/:id/cancel'], ['/api/jobs/a/b', '/api/other'],
    ['/api/state', '/api/state'], ['/api/agent/propose', '/api/agent/propose'], ['/api/secret-v001', '/api/other'],
  ];
  for (const [p, want] of cases) assert.equal(routeOf(p), want, p);
  assert.equal(routeOf(parseTarget('/api/state?token=SECRET')!.pathname), '/api/state');
  assert.equal(routeOf(parseTarget('/runs/v001/draft.png?0123456789abcdef')!.pathname), '/runs/*');
});

await check('parseTarget returns null for a target new URL rejects', async () => {
  assert.equal(parseTarget('//x:99999'), null);
  assert.equal(parseTarget('/api/state')!.pathname, '/api/state');
  assert.equal(parseTarget(undefined)!.pathname, '/');
});

await check('an unparsable request target is answered 400 with route /invalid, and the server keeps running', async () => {
  const reply = await new Promise<string>((ok, bad) => {
    const s = net.connect(web.port, '127.0.0.1', () => s.write(`GET //x:99999 HTTP/1.1\r\nHost: 127.0.0.1:${web.port}\r\nConnection: close\r\n\r\n`));
    let text = ''; s.on('data', (d) => { text += d; }); s.on('end', () => ok(text)); s.on('error', bad);
  });
  assert.match(reply, /^HTTP\/1\.1 400 /);
  const e = await lastRequest();
  assert.deepEqual([e.route, e.status, e.level], ['/invalid', 400, 'INFO']);
  assert.equal((await fetch(`${BASE}/`)).status, 200);
  await lastRequest();
});

await check('a GET refused with 403 (a tab with a stale session polling) is logged at debug', async () => {
  for (const p of ['/api/state', '/api/jobs/abc']) {
    assert.equal((await fetch(`${BASE}${p}`)).status, 403);
    const e = await lastRequest();
    assert.deepEqual([e.route, e.status, e.level], [routeOf(p), 403, 'DEBUG']);
  }
  const post = await fetch(`${BASE}/api/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(post.status, 403);
  assert.equal((await lastRequest()).level, 'INFO');
});

await check('a 500 from an unexpected exception logs http.request at error with errorType and no token', async () => {
  director.agentRender = async () => { throw new RangeError('unexpected'); };
  const r = await fetch(`${BASE}/api/agent/render?version=v001`, { headers: { authorization: `Bearer ${web.agentToken}` } });
  assert.equal(r.status, 500); assert.deepEqual(await r.json(), { error: 'internal error' });
  const e = await lastRequest();
  assert.deepEqual([e.route, e.status, e.level, e.errorType, e.error], ['/api/agent/render', 500, 'ERROR', 'RangeError', 'unexpected']);
  assert.match(e.reqId, /^[0-9a-f]{8}$/);
  const all = JSON.stringify(logged);
  assert.ok(!all.includes(web.agentToken), 'agentToken in the log'); assert.ok(!all.includes('version=v001'), 'raw query in the log');
});

await new Promise((r) => web.server.close(r));
shutdownLogging();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
