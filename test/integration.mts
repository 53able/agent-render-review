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

process.env.VORK_DIRECTOR_IMPORT = '1';
const { reportFromAudit } = await import('../server.mts');
delete process.env.VORK_DIRECTOR_IMPORT; // must not leak into the Director that mcp.mts starts

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
fs.writeFileSync(path.join(BIN, 'vork'), `#!/bin/sh\nif [ "$1" = render ] && [ -e '${GATE}' ]; then\n  echo $$ >> '${GATE}.waiting'\n  while [ -e '${GATE}' ]; do sleep 0.05; done\nfi\nexec '${realVork}' "$@"\n`, { mode: 0o755 });
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
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp.mts'), '--project', PROJECT], stderr: 'pipe', env: { ...process.env, PATH: PATH_WITH_GATE, VORK_DIRECTOR_NO_OPEN: '1', VORK_DIRECTOR_PAIR_TOKEN: PAIR } }));
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

let proposed: string;
await check('propose_scene creates a proposed agent version, HEAD unchanged, draft image returned', async () => {
  const scene = structuredClone(base); scene.nodes.find((n: SceneNode) => n.name === 'vase').materials[0].inputs.base_color = [0.1, 0.3, 0.6];
  const headBefore = (await state()).head;
  const r = await tool('propose_scene', { scene, interpretation: 'blue vase', claimed_changes: [{ node: 'vase', what: 'blue', why: 'test' }] });
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
  const r = spawnSync(process.execPath, [path.join(ROOT, 'server.mts'), '--project', PROJECT], { env: { ...process.env, VORK_DIRECTOR_NO_OPEN: '1' }, encoding: 'utf8', timeout: 20000 });
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

await check('#6 static serving cannot reach server.json or state.json outside public/', async () => {
  const http = await import('node:http');
  const get = (rawPath: string) => new Promise<{ status: number; body: string }>((ok, bad) => {
    const u = new URL(BASE);
    http.get({ host: u.hostname, port: u.port, path: rawPath, headers: { host: u.host } }, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => ok({ status: r.statusCode!, body: b })); }).on('error', bad);
  });
  const rel = path.relative(path.join(ROOT, 'public'), path.join(PROJECT, '.vork')).split(path.sep);
  for (const file of ['server.json', 'state.json', 'config.json']) {
    for (const sep of ['%2F', '%5C']) {
      const r = await get(`/${[...rel, file].join(sep)}`);
      assert.notEqual(r.status, 200, `${file} via ${sep}`); assert.doesNotMatch(r.body, /agentToken|versions/);
    }
  }
  assert.equal((await get('/%E0%A4%A')).status, 400, 'malformed escape');
  assert.equal((await get('/app.js')).status, 200, 'normal static files still served');
});

await check('#11 /runs/ does not follow a symlink out of .vork; a runs folder inside public/ is refused', async () => {
  const link = path.join(PROJECT, '.vork', 'v001', 'page-previs.png');
  assert.ok(!fs.existsSync(link), 'test needs an unused render name');
  fs.symlinkSync('../server.json', link);
  try {
    const r = await fetch(`${BASE}/runs/v001/page-previs.png`, { headers: { cookie: uiCookie } });
    const body = await r.text();
    assert.equal(r.status, 404); assert.doesNotMatch(body, /agentToken/);
  } finally { fs.rmSync(link); }
  const { spawnSync } = await import('node:child_process');
  // The upper-case spelling only names public/ on a case-insensitive file system; there it must be refused too.
  const caseInsensitive = fs.existsSync(path.join(ROOT, 'PUBLIC'));
  for (const dir of ['public', ...(caseInsensitive ? ['PUBLIC', 'Public'] : [])]) {
    const inside = path.join(ROOT, dir, `runs-${process.pid}`);
    try {
      const p = spawnSync(process.execPath, [path.join(ROOT, 'server.mts'), '--port', '0'], { env: { ...process.env, VORK_DIRECTOR_NO_OPEN: '1', VORK_DIRECTOR_RUNS: inside }, encoding: 'utf8', timeout: 20000 });
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

await check('#10 a static .json file is served as its contents, not as a serialized Buffer', async () => {
  const r = await fetch(`${BASE}/tsconfig.json`);
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type')!, /application\/json/);
  assert.equal(await r.text(), fs.readFileSync(path.join(ROOT, 'public', 'tsconfig.json'), 'utf8'));
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
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.mts'), '--port', String(port)], { env: { ...process.env, PATH: `${FAKE_BIN}${path.delimiter}${PATH_WITH_GATE}`, VORK_DIRECTOR_NO_OPEN: '1', VORK_DIRECTOR_PAIR_TOKEN: PAIR, VORK_DIRECTOR_RUNS: runs }, stdio: 'ignore' });
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

await check('#15 a final ticket for a version discarded after planning is refused', async () => {
  const id = await newProposal();
  const plan = await human('/api/final/plan', { versionId: id }); assert.equal(plan.status, 200);
  assert.equal((await human('/api/decide', { versionId: id, decision: 'discard' })).status, 200);
  const r = await human('/api/render', { versionId: id, profile: 'final', ticket: plan.json.ticket });
  assert.equal(r.status, 409, JSON.stringify(r.json)); assert.match(r.json.error, /discarded/);
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
  fs.writeFileSync(CLAUDE_GATE, ''); fs.rmSync(PROMPT_FILE, { force: true });
  try {
    const job = (await standalone.call('/api/propose', { baseId: proposedId, instruction: 'again' })).json;
    for (let i = 0; i < 100 && !fs.existsSync(PROMPT_FILE); i++) await sleep(50);
    assert.equal((await standalone.call('/api/decide', { versionId: proposedId, decision: 'discard' })).status, 200);
    fs.rmSync(CLAUDE_GATE);
    const done = await standalone.waitJob(job.id);
    assert.equal(done.status, 'failed'); assert.equal(done.error, 'base_discarded');
  } finally { fs.rmSync(CLAUDE_GATE, { force: true }); }
  const versions = (await standalone.call('/api/state')).json.versions;
  assert.deepEqual(versions.map((v: Json) => v.id), ['v001', proposedId]);
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
    assert.equal((await requestOf(requestId)).status, 'pending', slug);
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

await check('AC-01 nothing new was written under vork-director/runs', async () => {
  const after = fs.existsSync(path.join(ROOT, 'runs')) ? JSON.stringify(fs.readdirSync(path.join(ROOT, 'runs'))) : '[]';
  assert.equal(after, runsBefore);
});

// teardown
const pid = JSON.parse(fs.readFileSync(path.join(PROJECT, '.vork', 'server.json'), 'utf8')).pid;
await client.close();
try { process.kill(pid, 'SIGTERM'); } catch {}
standalone.proc.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 300));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
