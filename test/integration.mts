// Integration test: a real MCP client drives mcp.mts (which starts Director in ADE mode) and a
// simulated human uses the Director HTTP API with the UI cookie. Requires vork on PATH.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Loose on purpose: the test pokes at arbitrary JSON from Director and the MCP tools.
type Json = any;
// MCP content part; fields are all typed string because the test reads them after checking .type itself.
interface Part { type: string; text: string; data: string; mimeType: string }
interface ToolResult { content: Part[]; isError?: boolean }
interface SceneNode { name: string; materials: { inputs: Record<string, unknown> }[] }

import { acquireGpuLock } from './gpu-lock.mts';
await acquireGpuLock('integration');

process.env.RENDER_DIRECTOR_IMPORT = '1';
const { reportFromAudit } = await import('../server.mts');
delete process.env.RENDER_DIRECTOR_IMPORT; // must not leak into the Director that mcp.mts starts

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vd-int-')));
const PROJECT = path.join(tmp, 'landing');
fs.cpSync(path.join(ROOT, 'examples', 'landing'), PROJECT, { recursive: true });
fs.rmSync(path.join(PROJECT, '.vork'), { recursive: true, force: true });
const runsBefore = fs.existsSync(path.join(ROOT, 'runs')) ? JSON.stringify(fs.readdirSync(path.join(ROOT, 'runs'))) : '[]';

let pass = 0, failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e: Json) { failures++; console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ')}`); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Test-only vork wrapper: while GATE exists, `vork render` waits before it runs, so a test can act in the middle of a
// render. Each waiting render appends its pid to GATE.waiting.
const BIN = path.join(tmp, 'bin'); fs.mkdirSync(BIN);
const realVork = process.env.PATH!.split(path.delimiter).map((d) => path.join(d, 'vork')).find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return true; } catch { return false; } });
if (!realVork) throw new Error('vork not found on PATH');
const GATE = path.join(tmp, 'gate');
// Every `vork render` also appends its --out path to GATE.calls, so a test can count renders.
fs.writeFileSync(path.join(BIN, 'vork'), `#!/bin/sh\nif [ "$1" = render ]; then echo "$4" >> '${GATE}.calls'; fi\nif [ "$1" = render ] && [ -e '${GATE}' ]; then\n  echo $$ >> '${GATE}.waiting'\n  while [ -e '${GATE}' ]; do sleep 0.05; done\nfi\nexec '${realVork}' "$@"\n`, { mode: 0o755 });
const holdRenders = () => { fs.rmSync(`${GATE}.waiting`, { force: true }); fs.writeFileSync(GATE, ''); };
const releaseRenders = () => fs.rmSync(GATE, { force: true });
/** Waits until a render is held at the gate; returns the pid of the waiting process. */
const renderWaiting = async (): Promise<number> => {
  for (let i = 0; i < 200; i++) { const t = fs.existsSync(`${GATE}.waiting`) ? fs.readFileSync(`${GATE}.waiting`, 'utf8').trim() : ''; if (t) return Number(t.split('\n')[0]); await sleep(50); }
  throw new Error('no render reached the gate');
};
const PATH_WITH_GATE = `${BIN}${path.delimiter}${process.env.PATH}`;

const PAIR = crypto.randomBytes(16).toString('hex'); // test-only: lets the simulated human pair without a real browser opener
const client = new Client({ name: 'integration-test', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp.mts'), '--project', PROJECT], stderr: 'pipe', env: { ...process.env, PATH: PATH_WITH_GATE, RENDER_DIRECTOR_NO_OPEN: '1', RENDER_DIRECTOR_PAIR_TOKEN: PAIR } }));
const tool = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => client.callTool({ name, arguments: args }) as unknown as Promise<ToolResult>;
const textOf = (r: ToolResult): Json => JSON.parse(r.content.find((c) => c.type === 'text')!.text);

// the human side
const status = textOf(await tool('director_status'));
const BASE = status.director_url;
const pairWith = (token: string) => fetch(`${BASE}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
await check('AC-06 the page itself hands out no session; pairing is one-time', async () => {
  assert.equal((await fetch(`${BASE}/`)).headers.get('set-cookie'), null);
  assert.equal((await pairWith('wrong')).status, 403);
});
const paired = await pairWith(PAIR);
const uiCookie = paired.headers.get('set-cookie')!.split(';')[0];
await check('AC-06 a used pairing token cannot be replayed', async () => { assert.equal((await pairWith(PAIR)).status, 403); });
const human = async (route: string, body?: unknown, { cookie = uiCookie }: { cookie?: string | null } = {}): Promise<{ status: number; json: Json }> => {
  const r = await fetch(`${BASE}${route}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const state = async (): Promise<Json> => (await human('/api/state')).json;
const waitJob = async (id: string) => { for (;;) { const j = (await human(`/api/jobs/${id}`)).json; if (j.status !== 'running') return j; await new Promise((r) => setTimeout(r, 300)); } };

await check('AC-01 state lives in <project>/.vork and standalone runs/ is untouched', async () => {
  assert.equal(status.mode, 'ade'); assert.equal(status.project, PROJECT);
  assert.ok(fs.existsSync(path.join(PROJECT, '.vork', 'state.json')));
  assert.ok(fs.existsSync(path.join(PROJECT, '.vork', 'v001', 'scene.json')));
  const cfg = JSON.parse(fs.readFileSync(path.join(PROJECT, '.vork', 'config.json'), 'utf8'));
  assert.deepEqual(Object.keys(cfg).sort(), ['assetDir', 'assetUrlPattern', 'pageUrl']);
});

await check('AC-02 MCP exposes the five required tools', async () => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ['vork_help', 'propose_scene', 'get_render', 'wait_for_feedback', 'request_adoption']) assert.ok(names.includes(n), `missing ${n}`);
});

await check('AC-06 MCP has no tool that accepts, discards or approves', async () => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.deepEqual(names.filter((n) => /accept|discard|approve|decide|checkout|^adopt/.test(n)), []);
});

const base = textOf(await tool('get_scene')).scene;
const versionsBefore = (await state()).versions.length;

await check('AC-03 policy violations create no version', async () => {
  const bad = [
    { ...base, nodes: [...base.nodes, { type: 'asset', name: 'x', file: '/etc/passwd' }] },
    { ...base, programs: { p: { source: 'x' } } },
    { ...base, render: { resolution: [8000, 8000] } },
  ];
  for (const scene of bad) {
    const r = await tool('propose_scene', { scene, interpretation: 'bad', claimed_changes: [] });
    assert.equal(r.isError, true); assert.match(r.content[0].text, /No version was created/);
  }
  assert.equal((await state()).versions.length, versionsBefore);
});

await check('#51 a bad scene_file is refused before Director sees it, and creates no version', async () => {
  fs.writeFileSync(path.join(PROJECT, 'bad.json'), '{ not json'); fs.writeFileSync(path.join(tmp, 'outside.json'), JSON.stringify(base));
  fs.symlinkSync(path.join(tmp, 'outside.json'), path.join(PROJECT, 'link.json'));
  fs.linkSync(path.join(tmp, 'outside.json'), path.join(PROJECT, 'hard.json'));
  fs.writeFileSync(path.join(PROJECT, 'secret.json'), 'AWS_SECRET=abc');
  try {
    for (const [args, why] of [
      [{ scene: base, scene_file: 'scene.json' }, /exactly one/], [{}, /exactly one/], [{ scene_file: '../outside.json' }, /inside the project/],
      [{ scene_file: path.join(tmp, 'outside.json') }, /inside the project/], [{ scene_file: 'link.json' }, /outside the project|symlink/], [{ scene_file: 'bad.json' }, /not valid JSON/], [{ scene_file: 'missing.json' }, /not a file/], [{ scene_file: 'hard.json' }, /more than one link/],
    ] as const) {
      const r = await tool('propose_scene', { ...args, interpretation: 'file', claimed_changes: [] });
      assert.equal(r.isError, true, JSON.stringify(args)); assert.match(r.content[0].text, why); assert.match(r.content[0].text, /No version was created/);
    }
    const leak = await tool('propose_scene', { scene_file: 'secret.json', interpretation: 'file', claimed_changes: [] });
    assert.doesNotMatch(leak.content[0].text, /AWS_SECRET/, 'a parse error does not quote the file');
  } finally { for (const f of ['bad.json', 'link.json', 'hard.json', 'secret.json']) fs.rmSync(path.join(PROJECT, f), { force: true }); }
  assert.equal((await state()).versions.length, versionsBefore);
});

let proposed: string;
const INTERPRETATION = 'blue vase UNIQUE-INSTR-INTEGRATION';
await check('propose_scene creates a proposed agent version, HEAD unchanged, draft image returned', async () => {
  const scene = structuredClone(base); scene.nodes.find((n: SceneNode) => n.name === 'vase').materials[0].inputs.base_color = [0.1, 0.3, 0.6];
  const headBefore = (await state()).head;
  // INTERPRETATION is checked to be absent from the logs at the end (T4b).
  const r = await tool('propose_scene', { scene, interpretation: INTERPRETATION, claimed_changes: [{ node: 'vase', what: 'blue', why: 'test' }] });
  assert.ok(!r.isError, r.content[0].text);
  const t = textOf(r); proposed = t.version;
  assert.equal(t.status, 'proposed'); assert.equal(t.head, headBefore);
  assert.ok(r.content.some((c) => c.type === 'image' && c.mimeType === 'image/png' && c.data.length > 1000));
  const v = (await state()).versions.find((x: { id: string }) => x.id === proposed);
  assert.equal(v.origin, 'agent'); assert.equal((await state()).head, headBefore);
});

await check('AC-04 get_render returns an image and text with exposure and object_ids', async () => {
  const r = await tool('get_render', { version: proposed });
  const img = r.content.find((c) => c.type === 'image');
  assert.ok(img && Buffer.from(img.data, 'base64').subarray(1, 4).toString() === 'PNG');
  const t = textOf(r); assert.ok(t.render.exposure && typeof t.render.exposure.mean === 'number'); assert.ok(t.render.object_ids.some((o: { name: string }) => o.name === 'vase'));
  const f = await tool('get_render', { version: proposed, profile: 'final' });
  assert.equal(f.isError, true); assert.match(f.content[0].text, /human approval/);
});

await check('AC-06 human endpoints refuse requests without the UI cookie (also with the agent token)', async () => {
  const agentToken = JSON.parse(fs.readFileSync(path.join(PROJECT, '.vork', 'server.json'), 'utf8')).agentToken;
  const routes: [string, Record<string, string>][] = [['/api/decide', { versionId: proposed, decision: 'accept' }], ['/api/checkout', { versionId: 'v001' }], ['/api/final/plan', { versionId: proposed }], ['/api/adopt/plan', { requestId: 'a001' }], ['/api/adopt', { ticket: 'x' }], ['/api/feedback', { versionId: proposed, comment: 'x' }]];
  for (const [route, body] of routes) {
    assert.equal((await human(route, body, { cookie: null })).status, 403, route);
    const r = await fetch(`${BASE}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` }, body: JSON.stringify(body) });
    assert.equal(r.status, 403, `${route} with agent token`);
  }
  assert.equal((await fetch(`${BASE}/api/agent/status`)).status, 401);
  assert.equal((await fetch(`${BASE}/runs/${proposed}/draft.png`)).status, 403, 'render files need a session');
  assert.equal((await fetch(`${BASE}/runs/${proposed}/draft.png`, { headers: { cookie: uiCookie } })).status, 200);
  assert.equal((await state()).versions.find((v: { id: string }) => v.id === proposed).status, 'proposed');
});

await check('AC-05 wait_for_feedback times out, then delivers selection + comment (and wakes early)', async () => {
  const t0 = Date.now();
  const idle = textOf(await tool('wait_for_feedback', { timeout_sec: 1 }));
  assert.equal(idle.timeout, true); assert.ok(Date.now() - t0 >= 900);
  const waiting = tool('wait_for_feedback', { timeout_sec: 20 });
  await new Promise((r) => setTimeout(r, 400));
  const t1 = Date.now();
  assert.equal((await human('/api/feedback', { versionId: proposed, selection: ['vase', 'ring'], comment: 'もっと暗い青に' })).status, 200);
  const got = textOf(await waiting);
  assert.ok(Date.now() - t1 < 5000, 'long-poll should wake on the event');
  assert.equal(got.timeout, false);
  const ev = got.events.find((e: { type: string }) => e.type === 'feedback');
  assert.equal(ev.version, proposed); assert.deepEqual(ev.selection, ['vase', 'ring']); assert.equal(ev.comment, 'もっと暗い青に');
  assert.equal(textOf(await tool('wait_for_feedback', { timeout_sec: 0 })).timeout, true, 'events are delivered once');
});

await check('AC-05 an aborted long-poll does not swallow the next event', async () => {
  const token = JSON.parse(fs.readFileSync(path.join(PROJECT, '.vork', 'server.json'), 'utf8')).agentToken;
  const ac = new AbortController();
  const p = fetch(`${BASE}/api/agent/feedback?wait=10`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal }).catch(() => null);
  await new Promise((r) => setTimeout(r, 300)); ac.abort(); await p;
  await new Promise((r) => setTimeout(r, 100));
  await human('/api/feedback', { versionId: proposed, selection: [], comment: 'after abort' });
  await new Promise((r) => setTimeout(r, 200));
  const got = textOf(await tool('wait_for_feedback', { timeout_sec: 2 }));
  assert.ok(got.events.some((e: { comment: string }) => e.comment === 'after abort'), JSON.stringify(got));
});

const adopt = async (slug: string) => {
  const req = textOf(await tool('request_adoption', { version: proposed, slug, reason: 'hero for landing' }));
  assert.equal(req.status, 'pending_human_approval');
  const plan = await human('/api/adopt/plan', { requestId: req.request });
  assert.equal(plan.status, 200, JSON.stringify(plan.json));
  return { req, plan: plan.json };
};

await check('AC-07 approved adoption writes the PNG and a manifest with matching sha256; agent is told', async () => {
  const { plan } = await adopt('hero');
  assert.deepEqual(plan.writes, ['public/vork/hero.png', '.vork/adopted/hero.json']);
  assert.equal(plan.overwrites, fs.existsSync(path.join(PROJECT, 'public/vork/hero.png')));
  const job = await waitJob((await human('/api/adopt', { ticket: plan.ticket })).json.id);
  assert.equal(job.status, 'done', JSON.stringify(job));
  const png = fs.readFileSync(path.join(PROJECT, 'public/vork/hero.png'));
  const m = JSON.parse(fs.readFileSync(path.join(PROJECT, '.vork/adopted/hero.json'), 'utf8'));
  assert.equal(m.sha256, crypto.createHash('sha256').update(png).digest('hex'));
  for (const k of ['scene', 'sceneHash', 'vork', 'profile', 'reason']) assert.ok(m[k], `manifest.${k}`);
  assert.equal(m.version, proposed);
  const s = await state(); assert.equal(s.head, proposed, 'adopting a proposal accepts it');
  const ev = textOf(await tool('wait_for_feedback', { timeout_sec: 2 })).events.find((e: { type: string }) => e.type === 'adopted');
  assert.equal(ev.asset, 'public/vork/hero.png');
});

await check('AC-07 a second adoption to the same slug reports overwrites:true; a used ticket is refused', async () => {
  const { plan } = await adopt('hero');
  assert.equal(plan.overwrites, true);
  await waitJob((await human('/api/adopt', { ticket: plan.ticket })).json.id);
  assert.equal((await human('/api/adopt', { ticket: plan.ticket })).status, 403);
});

await check('AC-07 approval pins the target: changing assetDir after approval aborts the write', async () => {
  const { plan } = await adopt('pinned');
  const cfgFile = path.join(PROJECT, '.vork', 'config.json'); const cfg = fs.readFileSync(cfgFile, 'utf8');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(cfg), assetDir: 'public/elsewhere' }));
  const job = await waitJob((await human('/api/adopt', { ticket: plan.ticket })).json.id);
  fs.writeFileSync(cfgFile, cfg);
  assert.equal(job.status, 'failed'); assert.match(job.error, /asset path changed/);
  assert.equal(fs.existsSync(path.join(PROJECT, 'public/elsewhere/pinned.png')), false);
  assert.equal(fs.existsSync(path.join(PROJECT, 'public/vork/pinned.png')), false);
});

await check('AC-07 approval pins the scene: editing scene.json after approval is refused', async () => {
  const { plan } = await adopt('tamper');
  const f = path.join(PROJECT, '.vork', proposed, 'scene.json'); const orig = fs.readFileSync(f, 'utf8');
  const tampered = JSON.parse(orig); tampered.nodes.find((n: SceneNode) => n.name === 'vase').materials[0].inputs.base_color = [1, 0, 0];
  fs.writeFileSync(f, JSON.stringify(tampered, null, 2));
  const r = await human('/api/adopt', { ticket: plan.ticket });
  fs.writeFileSync(f, orig);
  assert.equal(r.status, 403);
  assert.equal(fs.existsSync(path.join(PROJECT, 'public/vork/tamper.png')), false);
});

await check('one Director per project: a second instance refuses to start', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'server.mts'), '--project', PROJECT], { env: { ...process.env, RENDER_DIRECTOR_NO_OPEN: '1' }, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 3, r.stderr + r.stdout); assert.match(r.stderr, /already running/);
});

await check('AC-08 bad slugs and a symlinked asset dir escaping the project are rejected', async () => {
  const r = await tool('request_adoption', { version: proposed, slug: '../evil', reason: 'x' });
  assert.equal(r.isError, true);
  const token = JSON.parse(fs.readFileSync(path.join(PROJECT, '.vork', 'server.json'), 'utf8')).agentToken;
  const direct = await fetch(`${BASE}/api/agent/adoption-request`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ version: proposed, slug: '../evil', reason: 'x' }) });
  assert.equal(direct.status, 400);
  const outside = path.join(tmp, 'outside'); fs.mkdirSync(outside);
  const req = textOf(await tool('request_adoption', { version: proposed, slug: 'escape', reason: 'x' }));
  fs.renameSync(path.join(PROJECT, 'public/vork'), path.join(PROJECT, 'public/vork-real'));
  fs.symlinkSync(outside, path.join(PROJECT, 'public/vork'));
  const plan = await human('/api/adopt/plan', { requestId: req.request });
  assert.equal(plan.status, 400); assert.match(plan.json.error, /outside the project/);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.rmSync(path.join(PROJECT, 'public/vork')); fs.renameSync(path.join(PROJECT, 'public/vork-real'), path.join(PROJECT, 'public/vork'));
});

// raw requests: the body is sent as given, so tests can send JSON that is not an object
const agentToken = (): string => JSON.parse(fs.readFileSync(path.join(PROJECT, '.vork', 'server.json'), 'utf8')).agentToken;
const raw = async (route: string, body: string, { agent = false, method = 'POST' }: { agent?: boolean; method?: string } = {}): Promise<{ status: number; json: Json }> => {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(agent ? { authorization: `Bearer ${agentToken()}` } : { cookie: uiCookie }) };
  const r = await fetch(`${BASE}${route}`, { method, headers, body: method === 'GET' ? undefined : body });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

// #17: the shape of /api/state and /api/agent/* responses (keys and value types only; not times, paths or hashes).
// A spec is a type name ('a|b' allows either, 'any' anything), [spec] for an array whose items all match spec, an object
// spec whose keys must match exactly ('k?' marks an optional key), or a function that checks the value itself.
type Spec = string | Spec[] | { [k: string]: Spec } | ((x: Json, at: string) => void);
const typeOf = (x: unknown) => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x);
function assertShape(x: Json, spec: Spec, at = '$'): void {
  if (typeof spec === 'function') return spec(x, at);
  if (typeof spec === 'string') { assert.ok(spec === 'any' || spec.split('|').includes(typeOf(x)), `${at}: ${typeOf(x)} is not ${spec}`); return; }
  if (Array.isArray(spec)) { assert.ok(Array.isArray(x), `${at}: ${typeOf(x)} is not an array`); x.forEach((item: Json, i: number) => assertShape(item, spec[0], `${at}[${i}]`)); return; }
  assert.equal(typeOf(x), 'object', `${at}: not an object`);
  const keys = Object.keys(spec).map((k) => k.replace(/\?$/, ''));
  for (const k of Object.keys(x)) assert.ok(keys.includes(k), `${at}: unexpected key ${k}`);
  for (const [k, s] of Object.entries(spec)) {
    const key = k.replace(/\?$/, '');
    if (!Object.hasOwn(x, key)) { assert.ok(k.endsWith('?'), `${at}: missing key ${key}`); continue; }
    assertShape(x[key], s, `${at}.${key}`);
  }
}
const orNull = (spec: Spec): Spec => (x, at) => { if (x !== null) assertShape(x, spec, at); };
// exposure and objects are passed through from vork's meta.json: these keys at least, and whatever else vork adds.
const atLeast = (spec: Record<string, Spec>): Spec => (x, at) => { assert.equal(typeOf(x), 'object', at); for (const [k, s] of Object.entries(spec)) assertShape(x[k], s, `${at}.${k}`); };
const EXPOSURE = atLeast({ mean: 'number', clipped: 'number', near_black: 'number' });
const OBJECTS: Spec = [atLeast({ pass_index: 'number', name: 'string' })];
const RENDER_INFO: Spec = {
  profile: 'string', seconds: 'number', width: 'number', height: 'number', image: 'string', ids: 'string|null', sha256: 'string',
  'idsSha256?': 'string', sceneHash: 'string|null', objects: OBJECTS, exposure: EXPOSURE, settings: { integrator: 'any', samples: 'number', denoiser: 'any' }, warnings: ['string'],
};
const RENDER_SUMMARY: Spec = { profile: 'string', seconds: 'number', width: 'number', height: 'number', file: 'string', exposure: EXPOSURE, objects: OBJECTS, warnings: ['string'] };
const POLICY: Spec = { blockers: ['string'], flags: [{ level: 'string', msg: 'string' }] };
const DIFF: Spec = [{ node: 'string', path: 'string', 'before?': 'any', 'after?': 'any' }];
const PROPOSAL: Spec = {
  interpretation: 'string', assumptions: ['string'], claimed_changes: [{ node: 'string', what: 'string', why: 'string' }], policy: POLICY, context: ['string'],
  via: 'string', 'cost?': 'number|null', 'clarifying_question?': 'string|null', 'respondsTo?': 'number|null',
};
const PAGE_PREVIEW: Spec = { ok: 'boolean', matched: 'number', image: 'string', warning: 'string|null', sha256: 'string', source: 'string' };
const VERSION: Spec = {
  id: 'string', parent: 'string|null', origin: 'string', instruction: 'string|null', proposal: orNull(PROPOSAL), status: 'string', created: 'string',
  renders: { 'previs?': RENDER_INFO, 'draft?': RENDER_INFO, 'final?': RENDER_INFO }, 'pagePreviews?': { 'previs?': PAGE_PREVIEW, 'draft?': PAGE_PREVIEW, 'final?': PAGE_PREVIEW },
  scene: 'object', diff: DIFF, headDiff: orNull(DIFF), hash: 'string',
};
const EVENT_BODIES: Record<string, Record<string, Spec>> = {
  feedback: { version: 'string', versionStatus: 'string', selection: ['string'], comment: 'string' },
  decision: { version: 'string', decision: 'string', head: 'string|null', comment: 'string|null' },
  checkout: { head: 'string' },
  adoption_rejected: { request: 'string', version: 'string', comment: 'string|null' },
  adopted: { request: 'string', version: 'string', slug: 'string', asset: 'string', manifest: 'string', sha256: 'string' },
  direct_edit: { version: 'string', parent: 'string', node: 'string', field: 'string', value: 'any', head: 'string|null' },
};
const EVENT: Spec = (e, at) => {
  assert.ok(Object.hasOwn(EVENT_BODIES, e?.type), `${at}: unknown event type ${e?.type}`);
  assertShape(e, { seq: 'number', t: 'string', type: 'string', ...EVENT_BODIES[e.type] }, at);
};
const CONFIG: Spec = { assetDir: 'string', pageUrl: 'string|null', assetUrlPattern: 'string|null' };

await check('#3 a body that is not a JSON object gets 400 without internal error text', async () => {
  for (const body of ['null', '1', '"x"', '[]', 'true', '{not json']) {
    for (const [route, agent] of [['/api/edit', false], ['/api/render', false], ['/api/agent/adoption-request', true], ['/api/agent/propose', true]] as const) {
      const r = await raw(route, body, { agent });
      assert.equal(r.status, 400, `${route} ${body}`);
      assert.doesNotMatch(r.json.error, /Cannot|undefined|null \(reading/, `${route} ${body}`);
    }
  }
});

await check('#4 adoption-request needs a string slug; propose needs { node, what, why } strings in claimed_changes', async () => {
  const before = (await state()).adoptionRequests.length;
  for (const slug of [['hero'], 1, { s: 'hero' }, null]) {
    const r = await raw('/api/agent/adoption-request', JSON.stringify({ version: 'v001', slug, reason: 'x' }), { agent: true });
    assert.equal(r.status, 400, JSON.stringify(slug)); assert.match(r.json.error, /slug/);
  }
  assert.equal((await state()).adoptionRequests.length, before);
  const versions = (await state()).versions.length;
  for (const claimed_changes of [[1, 'x'], [{ node: 'vase', what: 'x' }], [{ node: 'vase', what: 'x', why: 2 }], [null]]) {
    const r = await raw('/api/agent/propose', JSON.stringify({ interpretation: 'x', claimed_changes, scene: base }), { agent: true });
    assert.equal(r.status, 400, JSON.stringify(claimed_changes)); assert.match(r.json.error, /claimed_changes/);
  }
  assert.equal((await state()).versions.length, versions);
  const pending = (await state()).adoptionRequests.find((a: Json) => a.status === 'pending');
  assert.ok(pending, 'an earlier check leaves a pending adoption request');
  const plan = await human('/api/adopt/plan', { requestId: pending.id, slug: ['hero'] });
  assert.equal(plan.status, 400); assert.match(plan.json.error, /slug/);
});

await check('#2 inherited keys (toString, constructor, __proto__) are not valid profiles or edit fields', async () => {
  const accepted = (await state()).versions.find((v: Json) => v.status === 'accepted').id;
  for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    assert.equal((await raw(`/api/agent/render?version=${accepted}&profile=${key}`, '', { agent: true, method: 'GET' })).status, 400, `agent render ${key}`);
    assert.equal((await human('/api/render', { versionId: accepted, profile: key })).status, 400, `render ${key}`);
    assert.equal((await human('/api/preview', { versionId: accepted, profile: key })).status, 400, `preview ${key}`);
    const edit = await raw('/api/edit', `{"baseId":"${accepted}","node":"vase","field":"${key}","value":1}`);
    assert.equal(edit.status, 400, `edit ${key}`); assert.match(edit.json.error, /unsupported edit/);
  }
});

await check('#6 static serving cannot reach server.json or state.json outside dist/', async () => {
  const http = await import('node:http');
  const get = (rawPath: string) => new Promise<{ status: number; body: string; type?: string }>((ok, bad) => {
    const u = new URL(BASE);
    http.get({ host: u.hostname, port: u.port, path: rawPath, headers: { host: u.host } }, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => ok({ status: r.statusCode!, body: b, type: r.headers['content-type'] })); }).on('error', bad);
  });
  const rel = path.relative(path.join(ROOT, 'dist'), path.join(PROJECT, '.vork')).split(path.sep);
  for (const file of ['server.json', 'state.json', 'config.json']) {
    for (const sep of ['%2F', '%5C']) {
      const r = await get(`/${[...rel, file].join(sep)}`);
      assert.notEqual(r.status, 200, `${file} via ${sep}`); assert.doesNotMatch(r.body, /agentToken|versions/);
    }
  }
  assert.equal((await get('/%E0%A4%A')).status, 400, 'malformed escape');
  // Every same-origin script and stylesheet the page references is still served (data: URLs such as the icon are not requests).
  const page = await get('/'); assert.equal(page.status, 200, 'index.html');
  const refs = [...page.body.matchAll(/<(?:script\b[^>]*?\bsrc|link\b[^>]*?\bhref)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!)
    .filter((u) => !/^data:/i.test(u) && new URL(u, BASE).origin === new URL(BASE).origin);
  assert.ok(refs.length >= 2, `index.html references its script and stylesheet: ${JSON.stringify(refs)}`);
  for (const u of refs) assert.equal((await get(new URL(u, BASE).pathname)).status, 200, `normal static file ${u} still served`);
  const scripts = refs.filter((u) => /^\/assets\/[^/]+\.js$/.test(new URL(u, BASE).pathname));
  assert.ok(scripts.length >= 1, `index.html references /assets/*.js: ${JSON.stringify(refs)}`);
  for (const u of scripts) assert.match((await get(new URL(u, BASE).pathname)).type ?? '', /^text\/javascript/, `${u} content-type`);
});

await check('#11 /runs/ does not follow a symlink out of .vork; a runs folder inside dist/ is refused', async () => {
  const link = path.join(PROJECT, '.vork', 'v001', 'page-previs.png');
  assert.ok(!fs.existsSync(link), 'test needs an unused render name');
  fs.symlinkSync('../server.json', link);
  try {
    const r = await fetch(`${BASE}/runs/v001/page-previs.png`, { headers: { cookie: uiCookie } });
    const body = await r.text();
    assert.equal(r.status, 404); assert.doesNotMatch(body, /agentToken/);
  } finally { fs.rmSync(link); }
  const { spawnSync } = await import('node:child_process');
  // The upper-case spelling only names dist/ on a case-insensitive file system; there it must be refused too.
  const caseInsensitive = fs.existsSync(path.join(ROOT, 'DIST'));
  for (const dir of ['dist', ...(caseInsensitive ? ['DIST', 'Dist'] : [])]) {
    const inside = path.join(ROOT, dir, `runs-${process.pid}`);
    try {
      const p = spawnSync(process.execPath, [path.join(ROOT, 'server.mts'), '--port', '0'], { env: { ...process.env, RENDER_DIRECTOR_NO_OPEN: '1', RENDER_DIRECTOR_RUNS: inside }, encoding: 'utf8', timeout: 20000 });
      assert.notEqual(p.status, 0, dir); assert.match(p.stderr, /inside/, dir);
      assert.ok(!fs.existsSync(inside), `nothing is created under ${dir}/`);
    } finally { fs.rmSync(inside, { recursive: true, force: true }); }
  }
});

await check('#19 /runs/ does not serve a hard link (to server.json); normal render files still are', async () => {
  const link = path.join(PROJECT, '.vork', 'v001', 'page-previs.png');
  assert.ok(!fs.existsSync(link), 'test needs an unused render name');
  fs.linkSync(path.join(PROJECT, '.vork', 'server.json'), link);
  try {
    const r = await fetch(`${BASE}/runs/v001/page-previs.png`, { headers: { cookie: uiCookie } });
    const body = await r.text();
    assert.equal(r.status, 404); assert.doesNotMatch(body, /agentToken/);
  } finally { fs.rmSync(link); }
  assert.equal((await fetch(`${BASE}/runs/${proposed}/draft.png`, { headers: { cookie: uiCookie } })).status, 200);
});

await check('#19 a FIFO under /runs/ or dist/ gets 404 and does not block the server', async () => {
  const { execFileSync } = await import('node:child_process');
  const fifos = [path.join(PROJECT, '.vork', 'v001', 'page-previs.png'), path.join(ROOT, 'dist', `int-${process.pid}.js`)];
  for (const f of fifos) execFileSync('mkfifo', [f]);
  try {
    for (const url of [`${BASE}/runs/v001/page-previs.png`, `${BASE}/int-${process.pid}.js`]) {
      const r = await fetch(url, { headers: { cookie: uiCookie }, signal: AbortSignal.timeout(5000) });
      assert.equal(r.status, 404, url);
    }
  } finally { for (const f of fifos) fs.rmSync(f, { force: true }); }
});

await check('#10 a static .json file is served as its contents, not as a serialized Buffer', async () => {
  // dist/ holds no .json file of its own (#22), so the check places one for the duration of the test.
  const name = `int-${process.pid}.json`; const file = path.join(ROOT, 'dist', name);
  fs.writeFileSync(file, '{"a":[1,2]}\n');
  try {
    const r = await fetch(`${BASE}/${name}`);
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type')!, /application\/json/);
    assert.equal(await r.text(), '{"a":[1,2]}\n');
  } finally { fs.rmSync(file, { force: true }); }
});

await check('#22 the type-check config is not served', async () => {
  for (const name of ['tsconfig.json', 'tsconfig.public.json']) assert.equal((await fetch(`${BASE}/${name}`)).status, 404, name);
});

// After #19 and #10 have removed their temporary files: what the build put in dist/ is all that is served.
await check('dist/ holds only index.html and assets/*.js, assets/*.css', async () => {
  const DIST = path.join(ROOT, 'dist');
  const files = fs.readdirSync(DIST, { recursive: true, withFileTypes: true }).filter((e) => !e.isDirectory())
    .map((e) => path.relative(DIST, path.join(e.parentPath, e.name)).split(path.sep).join('/'));
  assert.ok(files.includes('index.html'), JSON.stringify(files));
  assert.ok(files.some((f) => /^assets\/[^/]+\.js$/.test(f)) && files.some((f) => /^assets\/[^/]+\.css$/.test(f)), JSON.stringify(files));
  for (const f of files) assert.match(f, /^(index\.html|assets\/[^/]+\.(js|css))$/, f);
});
await check('zustand AC-6: the production bundle carries no Redux devtools hook', async () => {
  const dir = path.join(ROOT, 'dist', 'assets');
  const js = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(js.length, 'dist/assets has JS');
  for (const f of js) assert.equal(fs.readFileSync(path.join(dir, f), 'utf8').split('__REDUX_DEVTOOLS_EXTENSION').length - 1, 0, f);
});

await check('#8 propose refuses unnamed and "#"-named nodes before rendering; edit needs a string node', async () => {
  const versions = (await state()).versions.length;
  const extra = [[{ name: `#${base.nodes.length + 1}`, type: 'light', energy: 5000 }, { type: 'mesh', geometry: { std: 'box' } }], [{ type: 'light', energy: 5 }], [{ name: 7, type: 'light', energy: 5 }]];
  for (const nodes of extra) {
    const r = await raw('/api/agent/propose', JSON.stringify({ interpretation: 'x', claimed_changes: [], scene: { ...base, nodes: [...base.nodes, ...nodes] } }), { agent: true });
    assert.equal(r.status, 422, JSON.stringify(nodes)); assert.ok(r.json.blockers.some((b: string) => /name/.test(b)), JSON.stringify(r.json));
  }
  assert.equal((await state()).versions.length, versions);
  // A version written before names were required may hold an unnamed light; an edit without "node" must not pick it.
  const accepted = (await state()).versions.find((v: Json) => v.status === 'accepted').id;
  const file = path.join(PROJECT, '.vork', accepted, 'scene.json'); const orig = fs.readFileSync(file, 'utf8');
  const withUnnamed = JSON.parse(orig); withUnnamed.nodes.push({ type: 'light', energy: 5 });
  fs.writeFileSync(file, JSON.stringify(withUnnamed));
  try {
    const before = (await state()).versions.length;
    for (const node of [undefined, null, 1, ['vase'], '']) {
      const r = await human('/api/edit', { baseId: accepted, node, field: 'energy', value: 10 });
      assert.equal(r.status, 400, JSON.stringify(node));
    }
    assert.equal((await state()).versions.length, before);
  } finally { fs.writeFileSync(file, orig); }
});

await check('#9 propose and adoption-request reject mistyped optional fields with 400, before rendering', async () => {
  const versions = (await state()).versions.length;
  const ok = { interpretation: 'x', claimed_changes: [], scene: base };
  for (const extra of [{ responds_to: { toString: 1 } }, { responds_to: { a: [1, 2, 3] } }, { responds_to: '3' }, { responds_to: 1.5 }, { assumptions: [{ toString: 1 }] }, { assumptions: 'x' }, { assumptions: ['a', 2] }]) {
    const r = await raw('/api/agent/propose', JSON.stringify({ ...ok, ...extra }), { agent: true });
    assert.equal(r.status, 400, JSON.stringify(extra)); assert.match(r.json.error, /responds_to|assumptions/);
  }
  assert.equal((await state()).versions.length, versions);
  const requests = (await state()).adoptionRequests.length;
  for (const reason of [{ toString: 1 }, 1, ['x']]) {
    const r = await raw('/api/agent/adoption-request', JSON.stringify({ version: 'v001', slug: 'hero', reason }), { agent: true });
    assert.equal(r.status, 400, JSON.stringify(reason)); assert.match(r.json.error, /reason/);
  }
  assert.equal((await state()).adoptionRequests.length, requests);
});

// Standalone Director with a fake `claude` (no API call): it records the prompt, waits while CLAUDE_GATE exists,
// and proposes the current scene unchanged. vork goes through the same gate wrapper as in ADE mode.
const FAKE_BIN = path.join(tmp, 'fake-claude-bin'); fs.mkdirSync(FAKE_BIN);
const PROMPT_FILE = path.join(tmp, 'claude-prompt.txt'), CLAUDE_GATE = path.join(tmp, 'claude-gate');
fs.writeFileSync(path.join(FAKE_BIN, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  fs.writeFileSync(${JSON.stringify(PROMPT_FILE)}, input);
  while (fs.existsSync(${JSON.stringify(CLAUDE_GATE)})) await new Promise((r) => setTimeout(r, 50));
  const scene = JSON.parse(input.match(/CURRENT SCENE \\(v\\d+\\):\\n(.*)\\n\\nDIRECTOR'S REQUEST/s)[1]);
  process.stdout.write(JSON.stringify({ structured_output: { interpretation: 'fake', assumptions: [], clarifying_question: null, claimed_changes: [], scene }, total_cost_usd: 0 }));
});
`, { mode: 0o755 });
const standalone = await (async () => {
  const { spawn } = await import('node:child_process');
  const net = await import('node:net');
  const port = await new Promise<number>((ok) => { const srv = net.createServer().listen(0, '127.0.0.1', () => { const p = (srv.address() as { port: number }).port; srv.close(() => ok(p)); }); });
  const runs = path.join(tmp, 'standalone-runs');
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.mts'), '--port', String(port)], { env: { ...process.env, PATH: `${FAKE_BIN}${path.delimiter}${PATH_WITH_GATE}`, RENDER_DIRECTOR_NO_OPEN: '1', RENDER_DIRECTOR_PAIR_TOKEN: PAIR, RENDER_DIRECTOR_RUNS: runs }, stdio: 'ignore' });
  process.on('exit', () => proc.kill('SIGTERM')); // also when a later step throws at top level
  for (let i = 0; i < 100 && !fs.existsSync(path.join(runs, 'server.json')); i++) await sleep(150);
  const url = `http://127.0.0.1:${port}`;
  const pr = await fetch(`${url}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: PAIR }) });
  const cookie = pr.headers.get('set-cookie')!.split(';')[0];
  const call = async (route: string, body?: unknown): Promise<{ status: number; json: Json }> => {
    const r = await fetch(`${url}${route}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const waitJob = async (id: string) => { for (;;) { const j = (await call(`/api/jobs/${id}`)).json; if (j.status !== 'running') return j; await sleep(200); } };
  return { proc, call, waitJob };
})();

await check('#9 standalone /api/propose rejects a non-string instruction with 400', async () => {
  for (const instruction of [1, { trim: 1 }, ['x'], null, '  ']) {
    assert.equal((await standalone.call('/api/propose', { baseId: 'v001', instruction })).status, 400, JSON.stringify(instruction));
  }
});

await check('#21 standalone /api/propose keeps only string selections and reads context flags as booleans', async () => {
  const cases: [unknown, unknown, RegExp | null][] = [
    ['abc', { selection: true }, null],
    [['vase', 1, { x: 1 }, ['ring']], { selection: true }, /^SELECTED objects \(director clicked these in the image\): vase$/m],
    [['vase'], { selection: 'yes' }, null],
    [['vase'], 'selection', null],
  ];
  for (const [selection, context, want] of cases) {
    fs.rmSync(PROMPT_FILE, { force: true });
    const r = await standalone.call('/api/propose', { baseId: 'v001', instruction: 'same scene', selection, context });
    assert.equal(r.status, 202, JSON.stringify(r.json));
    const job = await standalone.waitJob(r.json.id);
    assert.equal(job.status, 'done', `${JSON.stringify({ selection, context })}: ${JSON.stringify(job)}`);
    const prompt = fs.readFileSync(PROMPT_FILE, 'utf8');
    if (want) assert.match(prompt, want); else assert.doesNotMatch(prompt, /SELECTED objects/, JSON.stringify({ selection, context }));
  }
  fs.rmSync(PROMPT_FILE, { force: true });
  const r = await standalone.call('/api/propose', { baseId: 'v001', instruction: 'same scene', context: { exposure: 1, history: 'yes' } });
  assert.equal((await standalone.waitJob(r.json.id)).status, 'done');
  assert.doesNotMatch(fs.readFileSync(PROMPT_FILE, 'utf8'), /Last render measurements|Earlier accepted requests/);
});

await check('#12 a body over 4 MB gets 413, with or without content-length; the server keeps serving', async () => {
  const big = JSON.stringify({ interpretation: 'x'.repeat(5e6), claimed_changes: [], scene: base });
  const r = await raw('/api/agent/propose', big, { agent: true });
  assert.equal(r.status, 413); assert.match(r.json.error, /larger than/);
  const http = await import('node:http'); const u = new URL(BASE);
  const chunked = await new Promise<{ status: number; body: string }>((ok, bad) => {
    const req = http.request({ host: u.hostname, port: u.port, path: '/api/agent/propose', method: 'POST', headers: { host: u.host, 'content-type': 'application/json', authorization: `Bearer ${agentToken()}`, 'transfer-encoding': 'chunked' } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => ok({ status: res.statusCode!, body: b }));
    });
    req.on('error', bad);
    for (let i = 0; i < 5; i++) req.write('x'.repeat(1e6));
    req.end();
  });
  assert.equal(chunked.status, 413, chunked.body);
  // past the drain limit the server drops the connection rather than reading on
  const endless = await new Promise<string>((ok) => {
    const req = http.request({ host: u.hostname, port: u.port, path: '/api/agent/propose', method: 'POST', headers: { host: u.host, 'content-type': 'application/json', authorization: `Bearer ${agentToken()}`, 'transfer-encoding': 'chunked' } }, () => ok('response'));
    req.on('error', () => ok('dropped'));
    const chunk = 'x'.repeat(1e6); let sent = 0;
    const pump = () => { while (sent < 40 && req.write(chunk)) sent++; if (sent < 40) req.once('drain', () => { sent++; pump(); }); else req.end(); };
    pump();
  });
  assert.equal(endless, 'dropped');
  assert.equal((await raw('/api/agent/status', '', { agent: true, method: 'GET' })).status, 200);
});

await check('#18 a declared content-length past the drain limit gets 413 before the body is read', async () => {
  const http = await import('node:http'); const u = new URL(BASE);
  const size = 20e6; const chunk = 'x'.repeat(1e6);
  const got = await new Promise<string>((ok) => {
    const req = http.request({ host: u.hostname, port: u.port, path: '/api/agent/propose', method: 'POST', headers: { host: u.host, 'content-type': 'application/json', authorization: `Bearer ${agentToken()}`, 'content-length': String(size) } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => ok(`${res.statusCode} ${b}`));
    });
    req.on('error', () => ok('dropped'));
    let sent = 0;
    const pump = () => { while (sent < size / 1e6 && req.write(chunk)) sent++; if (sent < size / 1e6) req.once('drain', () => { sent++; pump(); }); else req.end(); };
    pump();
  });
  assert.match(got, /^413 .*larger than/);
  // A client that keeps sending gets the 413 at once and is cut off after the discard window (5 s), not at requestTimeout.
  const t0 = Date.now();
  const slow = await new Promise<{ status: number | null; closedAfter: number }>((ok) => {
    let status: number | null = null; let timer: NodeJS.Timeout;
    const req = http.request({ host: u.hostname, port: u.port, path: '/api/agent/propose', method: 'POST', headers: { host: u.host, 'content-type': 'application/json', authorization: `Bearer ${agentToken()}`, 'content-length': String(1e12) } }, (res) => { status = res.statusCode!; res.resume(); });
    const done = () => { clearInterval(timer); ok({ status, closedAfter: Date.now() - t0 }); };
    req.on('error', done); req.on('close', done);
    timer = setInterval(() => req.write('x'.repeat(1e4)), 50);
    setTimeout(() => { req.destroy(); }, 15000);
  });
  assert.equal(slow.status, 413);
  assert.ok(slow.closedAfter >= 4000 && slow.closedAfter < 9000, `closed after ${slow.closedAfter} ms`);
  assert.equal((await raw('/api/agent/status', '', { agent: true, method: 'GET' })).status, 200);
});

await check('AC-10 report: fixture gives exact numbers; live project counts match', async () => {
  const fixture = [
    { t: '2026-01-01T10:00:00.000Z', event: 'init' }, { t: '2026-01-01T10:02:00.000Z', event: 'proposed' },
    { t: '2026-01-01T10:05:00.000Z', event: 'feedback' }, { t: '2026-01-01T10:06:00.000Z', event: 'discard' },
    { t: '2026-01-01T10:08:00.000Z', event: 'proposed' }, { t: '2026-01-01T10:09:00.000Z', event: 'adoption_requested' },
    { t: '2026-01-01T10:14:30.000Z', event: 'adopted' },
  ];
  assert.deepEqual(reportFromAudit(fixture), { proposals: 2, feedbackRounds: 1, discards: 1, adoptionRequests: 1, adoptions: 1, adoptionRejections: 0, minutesFirstProposalToAdoption: 12.5 });
  const { execFileSync } = await import('node:child_process');
  const live = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'server.mts'), '--report', PROJECT], { encoding: 'utf8' }));
  assert.equal(live.proposals, 1); assert.equal(live.feedbackRounds, 2); assert.equal(live.adoptions, 2); assert.equal(live.adoptionRequests, 5);
  assert.ok(live.minutesFirstProposalToAdoption >= 0);
});

// The checks below run after AC-10, so they do not change the counts it expects.
const newProposal = async (): Promise<string> => {
  const scene = structuredClone(base); scene.nodes.find((n: SceneNode) => n.name === 'vase').materials[0].inputs.base_color = [Math.random(), 0.2, 0.2];
  const r = await raw('/api/agent/propose', JSON.stringify({ interpretation: 'x', claimed_changes: [], scene, base: 'v001' }), { agent: true });
  assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.version;
};
const versionOf = async (id: string): Promise<Json> => (await state()).versions.find((v: Json) => v.id === id);

await check('#30 page preview waits for a running render of the version and refuses a PNG that is not the recorded one', async () => {
  const cfgFile = path.join(PROJECT, '.vork', 'config.json'); const cfg = fs.readFileSync(cfgFile, 'utf8');
  // The render checks come before Chrome is looked for (#48), so this runs without Chrome too. Nothing listens on port 9:
  // a preview that gets past the checks fails at page.goto with "could not open", or with "Chrome not found".
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(cfg), pageUrl: 'http://127.0.0.1:9/', assetUrlPattern: '**/vork/hero.png' }));
  const draft = path.join(PROJECT, '.vork', proposed, 'draft.png'); let rendered: Buffer | null = null;
  try {
    holdRenders();
    const job = (await human('/api/render', { versionId: proposed, profile: 'draft' })).json;
    await renderWaiting();
    let settled = false;
    const preview = human('/api/preview', { versionId: proposed, profile: 'draft' }).then((r) => { settled = true; return r; });
    await sleep(2500);
    assert.equal(settled, false, 'preview must wait for the render of the same version');
    releaseRenders(); await waitJob(job.id);
    const r = await preview;
    assert.equal(r.json.ok, false); assert.match(r.json.reason, /could not open|Chrome not found/);
    rendered = fs.readFileSync(draft);
    fs.writeFileSync(draft, Buffer.from('not the recorded png'));
    const bad = await human('/api/preview', { versionId: proposed, profile: 'draft' });
    assert.equal(bad.json.ok, false); assert.match(bad.json.reason, /being updated/);
  } finally {
    releaseRenders(); fs.writeFileSync(cfgFile, cfg);
    if (rendered) fs.writeFileSync(draft, rendered);
  }
});

await check('#26 /runs/ serves a render file only while its bytes are the ones Director recorded', async () => {
  for (const name of ['draft.png', 'draft.ids.bin']) {
    const file = path.join(PROJECT, '.vork', proposed, name); const bytes = fs.readFileSync(file);
    const get = async () => (await fetch(`${BASE}/runs/${proposed}/${name}`, { headers: { cookie: uiCookie } })).status;
    assert.equal(await get(), 200, name);
    try { fs.writeFileSync(file, Buffer.concat([bytes, Buffer.from('x')])); assert.equal(await get(), 404, `${name} changed on disk`); }
    finally { fs.writeFileSync(file, bytes); }
    assert.equal(await get(), 200, name);
  }
  // The UI loads the URL Director presents: it carries the recorded hash, so it changes exactly when the file does (#17).
  const r = (await versionOf(proposed)).renders.draft;
  assert.equal(r.image, `/runs/${proposed}/draft.png?${r.sha256.slice(0, 16)}`); assert.equal(r.ids, `/runs/${proposed}/draft.ids.bin?${r.idsSha256.slice(0, 16)}`);
  assert.equal((await fetch(`${BASE}${r.image}`, { headers: { cookie: uiCookie } })).status, 200);
  // A file Director has no record of is not served, even under a valid name.
  assert.equal((await fetch(`${BASE}/runs/${proposed}/page-final.png`, { headers: { cookie: uiCookie } })).status, 404);
});

await check('#31 two concurrent wait_for_feedback calls get one event once in total', async () => {
  await raw('/api/agent/feedback?wait=0', '', { agent: true, method: 'GET' }); // drain anything unread
  const waitOnce = () => raw('/api/agent/feedback?wait=10', '', { agent: true, method: 'GET' });
  const a = waitOnce(), b = waitOnce();
  await sleep(300);
  const comment = `concurrent ${crypto.randomUUID()}`;
  assert.equal((await human('/api/feedback', { versionId: proposed, selection: [], comment })).status, 200);
  const got = [(await a).json, (await b).json];
  const delivered = got.flatMap((g) => g.events).filter((e: Json) => e.comment === comment);
  assert.equal(delivered.length, 1, JSON.stringify(got));
  assert.equal(textOf(await tool('wait_for_feedback', { timeout_sec: 0 })).events.length, 0);
});

await check('#15 a final ticket for a version discarded after planning is refused', async () => {
  const id = await newProposal();
  const plan = await human('/api/final/plan', { versionId: id }); assert.equal(plan.status, 200);
  assert.equal((await human('/api/decide', { versionId: id, decision: 'discard' })).status, 200);
  const r = await human('/api/render', { versionId: id, profile: 'final', ticket: plan.json.ticket });
  assert.equal(r.status, 409, JSON.stringify(r.json)); assert.match(r.json.error, /discarded/);
  assert.equal((await versionOf(id)).renders.final, undefined);
});

await check('#15 a final render of a version discarded while it runs is not kept', async () => {
  const id = await newProposal();
  const plan = await human('/api/final/plan', { versionId: id });
  holdRenders();
  let jobId: string;
  try {
    jobId = (await human('/api/render', { versionId: id, profile: 'final', ticket: plan.json.ticket })).json.id;
    await renderWaiting();
    assert.equal((await human('/api/decide', { versionId: id, decision: 'discard' })).status, 200);
  } finally { releaseRenders(); }
  const job = await waitJob(jobId);
  assert.equal(job.status, 'failed', JSON.stringify(job));
  assert.equal((await versionOf(id)).renders.final, undefined);
});

await check('#15 agent propose: a base discarded during the validation render gives 409 and no version', async () => {
  const baseId = await newProposal(); const count = (await state()).versions.length;
  const scene = structuredClone(base); scene.nodes.find((n: SceneNode) => n.name === 'vase').materials[0].inputs.base_color = [0.9, 0.9, 0.1];
  holdRenders();
  try {
    const pending = raw('/api/agent/propose', JSON.stringify({ interpretation: 'x', claimed_changes: [], scene, base: baseId }), { agent: true });
    await renderWaiting();
    assert.equal((await human('/api/decide', { versionId: baseId, decision: 'discard' })).status, 200);
    releaseRenders();
    const r = await pending;
    assert.equal(r.status, 409, JSON.stringify(r.json)); assert.match(r.json.error, /discarded/);
  } finally { releaseRenders(); }
  assert.equal((await state()).versions.length, count);
});

await check('#15 standalone propose: a discarded base gives 400; a base discarded while the agent works makes no proposal', async () => {
  const first = (await standalone.waitJob((await standalone.call('/api/propose', { baseId: 'v001', instruction: 'same scene' })).json.id));
  assert.equal(first.status, 'done', JSON.stringify(first)); const proposedId = first.result.versionId;
  const count = (await standalone.call('/api/state')).json.versions.length;
  fs.writeFileSync(CLAUDE_GATE, ''); fs.rmSync(PROMPT_FILE, { force: true });
  try {
    const job = (await standalone.call('/api/propose', { baseId: proposedId, instruction: 'again' })).json;
    for (let i = 0; i < 100 && !fs.existsSync(PROMPT_FILE); i++) await sleep(50);
    assert.equal((await standalone.call('/api/decide', { versionId: proposedId, decision: 'discard' })).status, 200);
    fs.rmSync(CLAUDE_GATE);
    const done = await standalone.waitJob(job.id);
    assert.equal(done.status, 'failed'); assert.equal(done.error, 'base_discarded');
  } finally { fs.rmSync(CLAUDE_GATE, { force: true }); }
  assert.equal((await standalone.call('/api/state')).json.versions.length, count);
  const r = await standalone.call('/api/propose', { baseId: proposedId, instruction: 'from discarded' });
  assert.equal(r.status, 400); assert.match(r.json.error, /discarded/);
});

const requestAdoption = async (version: string, slug: string): Promise<string> => {
  const r = await raw('/api/agent/adoption-request', JSON.stringify({ version, slug, reason: 'x' }), { agent: true });
  assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.request;
};
const requestOf = async (id: string): Promise<Json> => (await state()).adoptionRequests.find((a: Json) => a.id === id);
const adoptedEvents = async (requestId: string): Promise<number> => (await state()).events.filter((e: Json) => e.type === 'adopted' && e.request === requestId).length;

await check('#14 while an adopt job renders, reject, plan and discard get 409; after cancel the request can be rejected and nothing is written', async () => {
  const id = await newProposal(); const requestId = await requestAdoption(id, 'race-reject');
  const plan = await human('/api/adopt/plan', { requestId }); assert.equal(plan.json.needsFinalRender, true);
  holdRenders();
  let jobId: string;
  try {
    jobId = (await human('/api/adopt', { ticket: plan.json.ticket })).json.id;
    await renderWaiting();
    assert.equal((await requestOf(requestId)).status, 'adopting');
    const blocked: [string, unknown][] = [['/api/adopt/reject', { requestId }], ['/api/adopt/plan', { requestId }], ['/api/decide', { versionId: id, decision: 'discard' }]];
    for (const [route, body] of blocked) assert.equal((await human(route, body)).status, 409, route);
    assert.equal((await human(`/api/jobs/${jobId}/cancel`, {})).json.status, 'cancelled');
    assert.equal((await human('/api/adopt/reject', { requestId })).status, 200);
  } finally { releaseRenders(); }
  await sleep(1000);
  assert.equal((await human(`/api/jobs/${jobId}`)).json.status, 'cancelled');
  assert.equal((await requestOf(requestId)).status, 'rejected');
  assert.equal(fs.existsSync(path.join(PROJECT, 'public/vork/race-reject.png')), false);
  assert.equal(await adoptedEvents(requestId), 0);
});

await check('#14 a version discarded after the adoption plan is not written, also when its final render is reused', async () => {
  const reused = await newProposal();
  const fp = await human('/api/final/plan', { versionId: reused });
  assert.equal((await waitJob((await human('/api/render', { versionId: reused, profile: 'final', ticket: fp.json.ticket })).json.id)).status, 'done');
  const fresh = await newProposal();
  for (const [id, slug, needsFinalRender] of [[reused, 'race-discard', false], [fresh, 'race-discard-2', true]] as const) {
    const requestId = await requestAdoption(id, slug);
    const plan = await human('/api/adopt/plan', { requestId }); assert.equal(plan.json.needsFinalRender, needsFinalRender, slug);
    assert.equal((await human('/api/decide', { versionId: id, decision: 'discard' })).status, 200);
    const r = await human('/api/adopt', { ticket: plan.json.ticket });
    assert.equal(r.status, 409, `${slug}: ${JSON.stringify(r.json)}`); assert.match(r.json.error, /discarded/);
    assert.equal(fs.existsSync(path.join(PROJECT, `public/vork/${slug}.png`)), false, slug);
    assert.equal((await requestOf(requestId)).status, 'rejected', `${slug}: discarding the version rejects its request (#27)`);
  }
});

await check('#14 a second plan for the same request voids the first ticket; the request is adopted once', async () => {
  const id = await newProposal(); const requestId = await requestAdoption(id, 'twice');
  const first = await human('/api/adopt/plan', { requestId }); const second = await human('/api/adopt/plan', { requestId });
  assert.equal((await human('/api/adopt', { ticket: first.json.ticket })).status, 403);
  const job = await waitJob((await human('/api/adopt', { ticket: second.json.ticket })).json.id);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal((await human('/api/adopt', { ticket: second.json.ticket })).status, 403);
  assert.equal((await requestOf(requestId)).status, 'adopted');
  assert.equal(await adoptedEvents(requestId), 1);
  assert.equal((await state()).audit.filter((a: Json) => a.event === 'adopted' && a.request === requestId).length, 1);
});

await check('#20 reason and assumptions are bounded; one pending request per version and slug; at most 20 pending', async () => {
  const versions = (await state()).versions.length;
  for (const assumptions of [Array(21).fill('a'), ['x'.repeat(1001)]]) {
    const r = await raw('/api/agent/propose', JSON.stringify({ interpretation: 'x', claimed_changes: [], scene: base, assumptions }), { agent: true });
    assert.equal(r.status, 400); assert.match(r.json.error, /assumptions/);
  }
  assert.equal((await state()).versions.length, versions);
  const cc = { node: 'vase', what: 'x', why: 'x' };
  for (const extra of [{ interpretation: 'x'.repeat(4001) }, { claimed_changes: Array(51).fill(cc) }, { claimed_changes: [{ ...cc, node: 'n'.repeat(201) }] }, { claimed_changes: [{ ...cc, why: 'y'.repeat(1001) }] }]) {
    const r = await raw('/api/agent/propose', JSON.stringify({ interpretation: 'x', claimed_changes: [], scene: base, ...extra }), { agent: true });
    assert.equal(r.status, 400, Object.keys(extra)[0]); assert.match(r.json.error, /interpretation|claimed_changes/);
  }
  assert.equal((await state()).versions.length, versions);
  const long = await raw('/api/agent/adoption-request', JSON.stringify({ version: 'v001', slug: 'long', reason: 'x'.repeat(4001) }), { agent: true });
  assert.equal(long.status, 400); assert.match(long.json.error, /reason/);
  const first = await requestAdoption('v001', 'dup');
  const dup = await raw('/api/agent/adoption-request', JSON.stringify({ version: 'v001', slug: 'dup', reason: 'x'.repeat(4000) }), { agent: true });
  assert.equal(dup.status, 409); assert.equal(dup.json.request, first);
  let refused: Json = null; const made: string[] = [];
  for (let i = 0; i < 25 && !refused; i++) {
    const r = await raw('/api/agent/adoption-request', JSON.stringify({ version: 'v001', slug: `fill-${i}`, reason: 'x' }), { agent: true });
    if (r.status === 200) made.push(r.json.request); else refused = r;
  }
  assert.equal(refused?.status, 429, JSON.stringify(refused));
  const s = await state(); const live = (id: string) => s.versions.find((v: Json) => v.id === id)?.status !== 'discarded';
  assert.equal(s.adoptionRequests.filter((a: Json) => a.status === 'pending' && live(a.version)).length, 20);
  for (const requestId of [first, ...made]) assert.equal((await human('/api/adopt/reject', { requestId })).status, 200);
});

await check('#16 wrong Host gets 421, a cross-origin POST 403, a POST that is not application/json 415', async () => {
  const http = await import('node:http'); const u = new URL(BASE);
  const send = (headers: Record<string, string>, method = 'GET', body?: string) => new Promise<number>((ok, bad) => {
    const req = http.request({ host: u.hostname, port: u.port, path: '/api/state', method, headers: { cookie: uiCookie, ...headers } }, (r) => { r.resume(); ok(r.statusCode!); });
    req.on('error', bad); req.end(body);
  });
  assert.equal(await send({ host: `evil.example:${u.port}` }), 421);
  assert.equal(await send({ host: `127.0.0.1:${Number(u.port) + 1}` }), 421);
  assert.equal(await send({ host: u.host }), 200);
  const json = { host: u.host, 'content-type': 'application/json' };
  assert.equal(await send({ ...json, origin: 'http://evil.example' }, 'POST', '{}'), 403);
  assert.equal(await send({ ...json, origin: `http://localhost:${Number(u.port) + 1}` }, 'POST', '{}'), 403);
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) assert.equal(await send({ host: u.host, 'content-type': type }, 'POST', '{}'), 415, type);
  assert.equal(await send({ host: u.host }, 'POST', '{}'), 415, 'no content-type');
});

await check('#16 /runs/ serves only render files by name, also with a session', async () => {
  for (const name of [`${proposed}/scene.json`, `${proposed}/draft.png.meta.json`, `${proposed}/draft.object_index.png`, 'server.json', 'state.json', `${proposed}/../server.json`, 'v1/draft.png']) {
    assert.ok(name.includes('..') || name === 'v1/draft.png' || fs.existsSync(path.join(PROJECT, '.vork', name)), `test needs ${name} on disk`);
    const r = await fetch(`${BASE}/runs/${name}`, { headers: { cookie: uiCookie } });
    assert.equal(r.status, 404, name); assert.doesNotMatch(await r.text(), /agentToken|versions/);
  }
});

await check('#16 open-tab is limited to one call per 30 seconds', async () => {
  const first = await raw('/api/agent/open-tab', '{}', { agent: true });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assertShape(first.json, { opened: 'boolean', note: 'string' }); // #17
  const second = await raw('/api/agent/open-tab', '{}', { agent: true });
  assert.equal(second.status, 429); assert.match(second.json.error, /30 seconds/);
});

await check('#16 cancelling a job kills its render process and the render is not stored', async () => {
  const before = JSON.stringify((await versionOf('v001')).renders);
  holdRenders();
  try {
    const job = (await human('/api/render', { versionId: 'v001', profile: 'previs' })).json;
    const pid = await renderWaiting();
    const c = await human(`/api/jobs/${job.id}/cancel`, {});
    assert.equal(c.json.status, 'cancelled');
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) { try { process.kill(pid, 0); await sleep(50); } catch { gone = true; } }
    assert.ok(gone, `the render process (pid ${pid}, the gate wrapper that execs vork) is still running after cancel`);
    releaseRenders(); await sleep(1000);
    assert.equal((await human(`/api/jobs/${job.id}`)).json.status, 'cancelled');
    assert.equal(JSON.stringify((await versionOf('v001')).renders), before);
  } finally { releaseRenders(); }
});

await check('#27 discarding a version rejects its pending adoption requests and tells the agent', async () => {
  const id = await newProposal();
  const req = await raw('/api/agent/adoption-request', JSON.stringify({ version: id, slug: 'gone', reason: 'x' }), { agent: true });
  assert.equal(req.status, 200, JSON.stringify(req.json));
  await raw('/api/agent/feedback?wait=0', '', { agent: true, method: 'GET' }); // drain
  assert.equal((await human('/api/decide', { versionId: id, decision: 'discard' })).status, 200);
  assert.equal((await state()).adoptionRequests.find((a: Json) => a.id === req.json.request).status, 'rejected');
  const evs = (await raw('/api/agent/feedback?wait=0', '', { agent: true, method: 'GET' })).json.events;
  assert.ok(evs.some((e: Json) => e.type === 'adoption_rejected' && e.request === req.json.request && e.comment === 'version discarded'), JSON.stringify(evs));
});

await check('#28 concurrent agent renders of one version and profile run vork once and share the result', async () => {
  holdRenders();
  try {
    const edit = await human('/api/edit', { baseId: 'v001', node: 'vase', field: 'specular_roughness', value: 0.37 });
    assert.equal(edit.status, 202, JSON.stringify(edit.json)); const id = edit.json.version;
    await renderWaiting(); // the edit's draft render holds the version's lock; previs renders queue behind it
    // Stored renders go to a fresh folder under the version first: .vork/<id>/.render-previs-XXXXXX/previs.png
    const isOut = (l: string) => l.startsWith(path.join(PROJECT, '.vork', id, '.render-previs-')) && l.endsWith('/previs.png');
    const before = fs.existsSync(`${GATE}.calls`) ? fs.readFileSync(`${GATE}.calls`, 'utf8').split('\n').filter(isOut).length : 0;
    const agents = [0, 1, 2].map(() => raw(`/api/agent/render?version=${id}&profile=previs`, '', { agent: true, method: 'GET' }));
    await sleep(300); releaseRenders();
    for (const r of await Promise.all(agents)) assert.equal(r.status, 200, JSON.stringify(r.json));
    await waitJob(edit.json.job.id);
    const calls = fs.readFileSync(`${GATE}.calls`, 'utf8').split('\n').filter(isOut).length - before;
    assert.equal(calls, 1, `vork rendered ${id} previs ${calls} times`);
  } finally { releaseRenders(); }
});

await check('#39 RENDER_DIRECTOR_BROWSER opens the pairing link with the given command', async () => {
  const { spawn } = await import('node:child_process'); const net = await import('node:net');
  const port = await new Promise<number>((ok) => { const srv = net.createServer().listen(0, '127.0.0.1', () => { const p = (srv.address() as { port: number }).port; srv.close(() => ok(p)); }); });
  const got = path.join(tmp, 'browser-args'); const opener = path.join(BIN, 'fake-browser');
  fs.writeFileSync(opener, `#!/bin/sh\nprintf '%s\\n' "$@" > '${got}'\n`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, RENDER_DIRECTOR_RUNS: path.join(tmp, 'browser-runs'), RENDER_DIRECTOR_BROWSER: JSON.stringify([opener, '--profile', 'review']) };
  delete env.RENDER_DIRECTOR_NO_OPEN; delete env.RENDER_DIRECTOR_PAIR_TOKEN;
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.mts'), '--port', String(port)], { env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(got); i++) await sleep(150);
    const args = fs.readFileSync(got, 'utf8').trim().split('\n');
    assert.deepEqual(args.slice(0, 2), ['--profile', 'review']);
    const m = new RegExp(`^http://127\\.0\\.0\\.1:${port}/#pair=([0-9a-f]+)$`).exec(args[2]); assert.ok(m, args[2]);
    const pr = await fetch(`http://127.0.0.1:${port}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: m[1] }) });
    assert.equal(pr.status, 200);
  } finally { proc.kill('SIGTERM'); }
});

await check('#44 RENDER_DIRECTOR_BROWSER_STDIN=1 passes the pairing link on standard input, not as an argument', async () => {
  const { spawn } = await import('node:child_process'); const net = await import('node:net');
  const port = await new Promise<number>((ok) => { const srv = net.createServer().listen(0, '127.0.0.1', () => { const p = (srv.address() as { port: number }).port; srv.close(() => ok(p)); }); });
  const got = path.join(tmp, 'browser-stdin'); const opener = path.join(BIN, 'fake-browser-stdin');
  fs.writeFileSync(opener, `#!/bin/sh\nread link\n{ printf 'args:%s\\n' "$*"; printf 'stdin:%s\\n' "$link"; } > '${got}.tmp' && mv '${got}.tmp' '${got}'\n`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, RENDER_DIRECTOR_RUNS: path.join(tmp, 'browser-stdin-runs'), RENDER_DIRECTOR_BROWSER: JSON.stringify([opener, '--profile', 'review']), RENDER_DIRECTOR_BROWSER_STDIN: '1' };
  delete env.RENDER_DIRECTOR_NO_OPEN; delete env.RENDER_DIRECTOR_PAIR_TOKEN;
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.mts'), '--port', String(port)], { env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(got); i++) await sleep(150);
    const [args, input] = fs.readFileSync(got, 'utf8').trim().split('\n');
    assert.equal(args, 'args:--profile review', 'the link is not an argument');
    const m = new RegExp(`^stdin:http://127\\.0\\.0\\.1:${port}/#pair=([0-9a-f]+)$`).exec(input); assert.ok(m, input);
    const pr = await fetch(`http://127.0.0.1:${port}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: m[1] }) });
    assert.equal(pr.status, 200);
  } finally { proc.kill('SIGTERM'); }
});

await check('#17 /api/state keeps its shape', async () => {
  const s = await state();
  assertShape(s, {
    mode: 'string', project: 'string|null', config: CONFIG, head: 'string|null', vork: 'string', model: 'string', versions: [VERSION],
    audit: [(a: Json, at: string) => { assert.equal(typeof a.t, 'string', at); assert.equal(typeof a.event, 'string', at); }],
    adoptionRequests: [{ id: 'string', version: 'string', slug: 'string', reason: 'string', status: 'string', t: 'string', 'job?': 'string' }],
    events: [EVENT], agentCursor: 'number',
  });
  // The state above must cover what the shapes describe, or the check proves little.
  assert.ok(s.versions.some((v: Json) => v.proposal && v.renders.draft && v.renders.previs) && s.versions.some((v: Json) => v.renders.final));
  for (const type of Object.keys(EVENT_BODIES).filter((t) => t !== 'checkout')) assert.ok(s.events.some((e: Json) => e.type === type), `no ${type} event to check`);
});

await check('#17 /api/agent/* responses keep their shape', async () => {
  const get = (route: string) => raw(route, '', { agent: true, method: 'GET' });
  const st = await get('/api/agent/status'); assert.equal(st.status, 200);
  assertShape(st.json, { mode: 'string', project: 'string|null', head: 'string|null', vork: 'string', versions: [{ id: 'string', parent: 'string|null', status: 'string', origin: 'string', instruction: 'string|null' }], config: CONFIG });
  const sc = await get('/api/agent/scene'); assert.equal(sc.status, 200);
  assertShape(sc.json, { version: 'string', status: 'string', scene: 'object' });
  const scene = structuredClone(base); scene.nodes.find((n: SceneNode) => n.name === 'vase').materials[0].inputs.base_color = [0.4, 0.4, 0.1];
  const pr = await raw('/api/agent/propose', JSON.stringify({ interpretation: 'shape', claimed_changes: [{ node: 'vase', what: 'x', why: 'y' }], scene, base: 'v001', responds_to: 1 }), { agent: true });
  assert.equal(pr.status, 200, JSON.stringify(pr.json));
  assertShape(pr.json, { version: 'string', status: 'string', head: 'string|null', render: orNull(RENDER_SUMMARY), renderError: 'string|null', diff: DIFF, flags: [{ level: 'string', msg: 'string' }] });
  const bad = await raw('/api/agent/propose', JSON.stringify({ interpretation: 'x', claimed_changes: [], scene: { ...base, programs: { p: {} } } }), { agent: true });
  assert.equal(bad.status, 422); assertShape(bad.json, { error: 'string', blockers: ['string'], log: 'string|null', version: 'null' });
  const rn = await get(`/api/agent/render?version=${pr.json.version}&profile=previs`); assert.equal(rn.status, 200);
  assertShape(rn.json, { version: 'string', status: 'string', render: RENDER_SUMMARY });
  await get('/api/agent/feedback?wait=0'); // drain
  assertShape((await get('/api/agent/feedback?wait=0')).json, { timeout: 'boolean', waitedSec: 'number', events: [EVENT] });
  assert.equal((await human('/api/feedback', { versionId: pr.json.version, selection: ['vase'], comment: 'shape' })).status, 200);
  const fb = await get('/api/agent/feedback?wait=0');
  assertShape(fb.json, { timeout: 'boolean', events: [EVENT] }); assert.equal(fb.json.events.length, 1);
  const ar = await raw('/api/agent/adoption-request', JSON.stringify({ version: pr.json.version, slug: 'shape', reason: 'x' }), { agent: true });
  assert.equal(ar.status, 200); assertShape(ar.json, { request: 'string', status: 'string', note: 'string' });
  assert.equal((await human('/api/adopt/reject', { requestId: ar.json.request })).status, 200);
  assertShape((await get('/api/agent/scene?version=v999')).json, { error: 'string' });
});

await check('#51 propose_scene reads a scene from scene_file and shows the same diff as an inline scene', async () => {
  const scene = structuredClone(base); scene.nodes.find((n: SceneNode) => n.name === 'vase').materials[0].inputs.base_color = [0.7, 0.2, 0.1];
  fs.mkdirSync(path.join(PROJECT, 'gen'), { recursive: true }); fs.writeFileSync(path.join(PROJECT, 'gen', 'scene.json'), JSON.stringify(scene));
  const r = await tool('propose_scene', { base: 'v001', scene_file: 'gen/scene.json', interpretation: 'red vase from a file', claimed_changes: [{ node: 'vase', what: 'red', why: 'test' }] });
  assert.ok(!r.isError, r.content[0].text);
  const t = textOf(r); assert.equal(t.status, 'proposed'); assert.deepEqual(t.diff.map((d: Json) => d.path), ['materials[0].inputs.base_color']);
  const agentScene = (await raw(`/api/agent/scene?version=${t.version}`, '', { agent: true, method: 'GET' })).json.scene;
  assert.deepEqual(agentScene, scene);
});

await check('AC-01 nothing new was written under render-director/runs', async () => {
  const after = fs.existsSync(path.join(ROOT, 'runs')) ? JSON.stringify(fs.readdirSync(path.join(ROOT, 'runs'))) : '[]';
  assert.equal(after, runsBefore);
});

await check('T11 mcp.mts writes only JSON-RPC to stdout from initialize to tools/list', async () => {
  const { spawn } = await import('node:child_process');
  const proc = spawn(process.execPath, [path.join(ROOT, 'mcp.mts'), '--project', PROJECT], { env: { ...process.env, PATH: PATH_WITH_GATE, RENDER_DIRECTOR_NO_OPEN: '1' }, stdio: ['pipe', 'pipe', 'ignore'] });
  try {
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    const reply = async (id: number) => {
      for (let i = 0; i < 200; i++) { if (out.split('\n').some((l) => { try { return JSON.parse(l).id === id; } catch { return false; } })) return; await sleep(50); }
      throw new Error(`no reply to request ${id}; stdout: ${out}`);
    };
    const send = (m: unknown) => proc.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't11', version: '1.0.0' } } });
    await reply(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await reply(2);
    const lines = out.split('\n').filter((l) => l !== '');
    assert.ok(lines.length >= 2, out);
    for (const l of lines) assert.equal(JSON.parse(l).jsonrpc, '2.0', l);
  } finally { proc.kill('SIGTERM'); }
});

await check('T10b with a failing browser opener, neither the agent token nor the pairing token is logged', async () => {
  const { spawn } = await import('node:child_process'); const net = await import('node:net');
  const port = await new Promise<number>((ok) => { const srv = net.createServer().listen(0, '127.0.0.1', () => { const p = (srv.address() as { port: number }).port; srv.close(() => ok(p)); }); });
  const runs = path.join(tmp, 'open-failed-runs'); const pair = crypto.randomBytes(16).toString('hex');
  const env: NodeJS.ProcessEnv = { ...process.env, RENDER_DIRECTOR_RUNS: runs, RENDER_DIRECTOR_PAIR_TOKEN: pair, RENDER_DIRECTOR_BROWSER: '["/nonexistent-opener"]' };
  delete env.RENDER_DIRECTOR_NO_OPEN; delete env.RENDER_DIRECTOR_BROWSER_STDIN;
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.mts'), '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; proc.stdout.on('data', (d: Buffer) => { out += d; }); proc.stderr.on('data', (d: Buffer) => { out += d; });
  const file = path.join(runs, 'logs', 'director.jsonl');
  const read = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  try {
    for (let i = 0; i < 100 && !read().includes('"browser.open_failed"'); i++) await sleep(100);
    const failed = read().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)).find((e) => e.event === 'browser.open_failed');
    assert.ok(failed, `no browser.open_failed in 10 s: ${read()}`);
    assert.equal(failed.opener, '/nonexistent-opener'); assert.equal(failed.code, 'ENOENT');
    const token = JSON.parse(fs.readFileSync(path.join(runs, 'server.json'), 'utf8')).agentToken;
    for (const [name, text] of [['director.jsonl', read()], ['stdout and stderr', out]]) {
      assert.ok(!text.includes(token), `agentToken in ${name}`); assert.ok(!text.includes(pair), `PAIR in ${name}`);
    }
  } finally { proc.kill('SIGTERM'); }
});

// teardown
const { pid, agentToken: directorToken } = JSON.parse(fs.readFileSync(path.join(PROJECT, '.vork', 'server.json'), 'utf8'));
await client.close();
const LOGS = path.join(PROJECT, '.vork', 'logs');
const logLines = () => fs.readFileSync(path.join(LOGS, 'director.jsonl'), 'utf8').split('\n').filter((l) => l !== '');
await check('T12 after SIGTERM the last line of director.jsonl is director.stop', async () => {
  // mcp.mts starts Director detached, so closing the client leaves it running.
  process.kill(pid, 'SIGTERM');
  const gone = () => { try { process.kill(pid, 0); return false; } catch (e: Json) { return e.code === 'ESRCH'; } };
  for (let i = 0; i < 100 && !gone(); i++) await sleep(100);
  assert.ok(gone(), `Director (pid ${pid}) still runs 10 s after SIGTERM`);
  const last = JSON.parse(logLines().at(-1)!);
  assert.equal(last.event, 'director.stop'); assert.equal(last.signal, 'SIGTERM');
});
await check('T9a every line of director.jsonl is JSON and director.start is there', async () => {
  const events = logLines().map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.event === 'director.start' && e.mode === 'ade' && typeof e.port === 'number' && e.pid === pid), 'no director.start');
  for (const e of events) {
    for (const k of ['@timestamp', 'level', 'logger', 'message']) assert.equal(typeof e[k], 'string', `${k} missing: ${JSON.stringify(e)}`);
    assert.equal(e.service, 'render-director'); assert.equal(typeof e.component, 'string'); assert.equal(typeof e.event, 'string');
  }
});
await check('T9b server.log has no LogTape banner and no INFO structured line', async () => {
  const log = fs.readFileSync(path.join(PROJECT, '.vork', 'server.log'), 'utf8');
  assert.match(log, /Render Director on http:\/\/127\.0\.0\.1:/); // the file is the one Director writes to, so the checks below mean something
  assert.doesNotMatch(log, /LogTape loggers are configured/);
  for (const l of log.split('\n')) { let e: Json; try { e = JSON.parse(l); } catch { continue; } assert.notEqual(e?.level, 'INFO', l); }
});
await check('T9c every http.request has reqId, method, route, status and ms, and no reqId repeats', async () => {
  const reqs = logLines().map((l) => JSON.parse(l)).filter((e) => e.event === 'http.request');
  assert.ok(reqs.length > 0, 'no http.request');
  for (const e of reqs) {
    for (const k of ['reqId', 'method', 'route', 'status', 'ms']) assert.ok(k in e, `${k} missing: ${JSON.stringify(e)}`);
    assert.match(e.reqId, /^[0-9a-f]{8}$/); assert.doesNotMatch(e.route, /\?|v\d{3}/, e.route);
  }
  assert.equal(new Set(reqs.map((e) => e.reqId)).size, reqs.length, 'a reqId repeats');
});
await check('T10 neither the agent token nor the first pairing token is in director.jsonl or server.log', async () => {
  // This Director runs with RENDER_DIRECTOR_NO_OPEN=1, so it never hands PAIR to an opener. A failing opener, the path
  // where PAIR could reach the log through spawnargs, is covered by T10b.
  for (const f of [path.join(LOGS, 'director.jsonl'), path.join(PROJECT, '.vork', 'server.log')]) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!text.includes(directorToken), `agentToken in ${f}`); assert.ok(!text.includes(PAIR), `PAIR in ${f}`);
  }
});
await check('T4b the interpretation of a proposal is in neither director.jsonl nor server.log', async () => {
  for (const f of [path.join(LOGS, 'director.jsonl'), path.join(PROJECT, '.vork', 'server.log')]) {
    assert.equal(fs.readFileSync(f, 'utf8').split('UNIQUE-INSTR-INTEGRATION').length - 1, 0, f);
  }
});
standalone.proc.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 300));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
