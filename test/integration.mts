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

const PAIR = crypto.randomBytes(16).toString('hex'); // test-only: lets the simulated human pair without a real browser opener
const client = new Client({ name: 'integration-test', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp.mts'), '--project', PROJECT], stderr: 'pipe', env: { ...process.env, VORK_DIRECTOR_NO_OPEN: '1', VORK_DIRECTOR_PAIR_TOKEN: PAIR } }));
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

await check('#8 propose refuses unnamed and "#"-named nodes before rendering; edit needs a string node', async () => {
  const versions = (await state()).versions.length;
  const extra = [[{ name: `#${base.nodes.length + 1}`, type: 'light', energy: 5000 }, { type: 'mesh', geometry: { std: 'box' } }], [{ type: 'light', energy: 5 }], [{ name: 7, type: 'light', energy: 5 }]];
  for (const nodes of extra) {
    const r = await raw('/api/agent/propose', JSON.stringify({ interpretation: 'x', claimed_changes: [], scene: { ...base, nodes: [...base.nodes, ...nodes] } }), { agent: true });
    assert.equal(r.status, 422, JSON.stringify(nodes)); assert.ok(r.json.blockers.some((b: string) => /name/.test(b)), JSON.stringify(r.json));
  }
  assert.equal((await state()).versions.length, versions);
  const accepted = (await state()).versions.find((v: Json) => v.status === 'accepted').id;
  for (const node of [undefined, null, 1, ['vase'], '']) {
    const r = await human('/api/edit', { baseId: accepted, node, field: 'energy', value: 10 });
    assert.equal(r.status, 400, JSON.stringify(node));
  }
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

await check('#9 standalone /api/propose rejects a non-string instruction with 400', async () => {
  const { spawn } = await import('node:child_process');
  const runs = path.join(tmp, 'standalone-runs'); const port = 47900 + Math.floor(Math.random() * 90);
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mts'), '--port', String(port)], { env: { ...process.env, VORK_DIRECTOR_NO_OPEN: '1', VORK_DIRECTOR_PAIR_TOKEN: PAIR, VORK_DIRECTOR_RUNS: runs }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(path.join(runs, 'server.json')); i++) await new Promise((r) => setTimeout(r, 150));
    const url = `http://127.0.0.1:${port}`;
    const pr = await fetch(`${url}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: PAIR }) });
    const cookie = pr.headers.get('set-cookie')!.split(';')[0];
    for (const instruction of [1, { trim: 1 }, ['x'], null, '  ']) {
      const r = await fetch(`${url}/api/propose`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ baseId: 'v001', instruction }) });
      assert.equal(r.status, 400, JSON.stringify(instruction));
    }
  } finally { p.kill('SIGTERM'); }
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

await check('AC-01 nothing new was written under vork-director/runs', async () => {
  const after = fs.existsSync(path.join(ROOT, 'runs')) ? JSON.stringify(fs.readdirSync(path.join(ROOT, 'runs'))) : '[]';
  assert.equal(after, runsBefore);
});

// teardown
const pid = JSON.parse(fs.readFileSync(path.join(PROJECT, '.vork', 'server.json'), 'utf8')).pid;
await client.close();
try { process.kill(pid, 'SIGTERM'); } catch {}
await new Promise((r) => setTimeout(r, 300));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
