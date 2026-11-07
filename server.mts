// Render Director — a review surface for renders made with vork (unofficial).
// Standalone mode: `node server.mts` (built-in proposer via `claude -p`).
// ADE mode:        `node server.mts --project <dir>` (your ADE agent proposes through mcp.mts; you review and adopt here).
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LIMITS, PROFILES, isProfile, DEFAULT_CONFIG, isPlainObject, sha256, policyCheck, diffScenes, resolveInside, reportFromAudit } from './src/policy.mts';
import type { Profile, SceneNode, Scene, PolicyResult, AuditEvent, RenderInfo, Version } from './src/policy.mts';
// Kept importable from here: test/integration.mts and older callers import them from server.mts.
export { policyCheck, diffScenes, resolveInside, reportFromAudit } from './src/policy.mts';
import { createVorkRenderer, vorkInstalled } from './src/vork.mts';
import { createDirector, Refusal } from './src/director.mts';
import { createClaudeProposer } from './src/proposer.mts';
import { pagePreview } from './src/preview.mts';
import type { Job } from './src/director.mts';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

// ---------- pure helpers (no state; used by tests) ----------

/** A client error whose message is safe to return as a 400 response. */
class BadRequest extends Error {}
/** A request body over MAX_BODY bytes; answered with 413. */
class PayloadTooLarge extends Error {
  /** false: the declared length is past the drain limit, so the 413 goes out before the body is read. */
  drain = true;
}
const MAX_BODY = 4e6;
const REFUSAL_STATUS: Record<Refusal['kind'], number> = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, unprocessable: 422, too_many: 429, failed: 500 };

// ---------- CLI: selftest and report (no server, no state) ----------
if (argv[0] === '--selftest') {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'scenes', 'starter.json'), 'utf8')) as Scene;
  const cases: [string, Scene, (r: PolicyResult) => boolean][] = [
    ['starter passes', base, (r) => !r.blockers.length && !r.flags.length],
    ['absolute asset path blocked', { ...base, nodes: [...base.nodes, { type: 'asset', name: 'x', file: '/etc/passwd' }] }, (r) => r.blockers.length === 1],
    ['parent traversal blocked', { ...base, nodes: [...base.nodes, { type: 'asset', name: 'x', file: 'a/../../b.glb' }] }, (r) => r.blockers.length === 1],
    ['url blocked', { ...base, nodes: [...base.nodes, { type: 'asset', name: 'x', file: 'https://e.com/m.glb' }] }, (r) => r.blockers.length === 1],
    ['local asset flagged R2', { ...base, nodes: [...base.nodes, { type: 'asset', name: 'x', file: 'm.glb' }] }, (r) => !r.blockers.length && r.flags[0]?.level === 'R2'],
    ['custom program blocked', { ...base, programs: { p: { source: 'x' } } }, (r) => r.blockers.some((b) => b.includes('custom'))],
    ['huge resolution blocked', { ...base, render: { resolution: [7680, 4320] } }, (r) => r.blockers.some((b) => b.includes('resolution'))],
    ['skewed resolution blocked', { ...base, render: { resolution: [100000, 10] } }, (r) => r.blockers.some((b) => b.includes('resolution'))],
    ['compositor resolution blocked', { ...base, render: { ...base.render, compositor: [{ material: 'm', resolution: [8000, 8000] }] } }, (r) => r.blockers.some((b) => b.includes('compositor'))],
    ['gltf blocked', { ...base, nodes: [...base.nodes, { type: 'asset', name: 'x', file: 'm.gltf' }] }, (r) => r.blockers.length === 1],
    ['image file object in inputs blocked', { ...base, nodes: [...base.nodes, { type: 'mesh', name: 'q', geometry: { std: 'box' }, materials: [{ inputs: { base_color: { image: { file: '/etc/passwd' } } } }] }] }, (r) => r.blockers.length === 1],
    ['unnamed node blocked', { ...base, nodes: [...base.nodes, { type: 'mesh', geometry: { std: 'box' } }] }, (r) => r.blockers.some((b) => b.includes('name'))],
    ['non-string name blocked', { ...base, nodes: [...base.nodes, { type: 'mesh', name: 1, geometry: { std: 'box' } } as unknown as SceneNode] }, (r) => r.blockers.some((b) => b.includes('name'))],
    ['reserved # name blocked', { ...base, nodes: [...base.nodes, { type: 'light', name: '#10', energy: 5 }] }, (r) => r.blockers.some((b) => b.includes('reserved'))],
    ['null node blocked without throwing', { ...base, nodes: [...base.nodes, null as unknown as SceneNode] }, (r) => r.blockers.some((b) => b.includes('name'))],
    ['duplicate names blocked', { ...base, nodes: [...base.nodes, { type: 'mesh', name: 'vase', geometry: { std: 'box' } }] }, (r) => r.blockers.some((b) => b.includes('duplicate'))],
    ['wrong version blocked', { ...base, version: 1 }, (r) => r.blockers.length === 1],
  ];
  let fail = 0;
  for (const [name, scene, ok] of cases) { const r = policyCheck(scene); const pass = ok(r); fail += !pass as unknown as number; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`, pass ? '' : JSON.stringify(r)); }
  const mod = structuredClone(base); mod.nodes[1].materials![0].inputs!.base_color = [0.1, 0.1, 0.1]; mod.render!.background = [0, 0, 0];
  const d = diffScenes(base, mod);
  const dpass = d.length === 2 && d.some((x) => x.node === 'vase' && x.path === 'materials[0].inputs.base_color') && d.some((x) => x.node === '(scene)' && x.path === 'render.background');
  fail += !dpass as unknown as number; console.log(`${dpass ? 'PASS' : 'FAIL'} diff finds exactly the two edits`, dpass ? '' : JSON.stringify(d));
  // #8: a '#<index>' name must not hide an unnamed node; inherited keys are added, not changed
  const added = (extra: SceneNode[]) => diffScenes(base, { ...base, nodes: [...base.nodes, ...extra] });
  const collide = added([{ type: 'light', name: `#${base.nodes.length + 1}`, energy: 5000 }, { type: 'mesh', geometry: { std: 'box' } }]);
  const inherited = ['constructor', 'toString', '__proto__', 'hasOwnProperty'].map((name) => added([{ type: 'light', name, energy: 5 }]));
  const extraCases: [string, boolean, unknown][] = [
    ['diff: a "#<index>" name does not hide an unnamed node', collide.length === 2 && collide.every((x) => x.path === '(node)' && x.after === 'added'), collide],
    ['diff: inherited key names show as added nodes', inherited.every((x) => x.length === 1 && x[0].path === '(node)' && x[0].after === 'added'), inherited],
  ];
  for (const [name, pass, got] of extraCases) { fail += !pass as unknown as number; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`, pass ? '' : JSON.stringify(got)); }
  // write-back containment
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'vd-self-'));
  fs.mkdirSync(path.join(tmp, 'proj', 'public'), { recursive: true }); fs.mkdirSync(path.join(tmp, 'outside'));
  fs.symlinkSync(path.join(tmp, 'outside'), path.join(tmp, 'proj', 'public', 'escape'));
  fs.writeFileSync(path.join(tmp, 'outside', 'x.png'), ''); fs.symlinkSync(path.join(tmp, 'outside', 'x.png'), path.join(tmp, 'proj', 'public', 'link.png'));
  const proj = path.join(tmp, 'proj');
  const throws = (rel: string) => { try { resolveInside(proj, rel); return false; } catch { return true; } };
  const wcases: [string, boolean][] = [
    ['write: normal path allowed', !throws('public/vork/hero.png')],
    ['write: .. rejected', throws('public/../../outside/x.png')],
    ['write: absolute rejected', throws(path.join(tmp, 'outside', 'x.png'))],
    ['write: symlinked dir escaping rejected', throws('public/escape/x.png')],
    ['write: symlink file rejected', throws('public/link.png')],
  ];
  for (const [name, pass] of wcases) { fail += !pass as unknown as number; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`); }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

if (argv[0] === '--report') {
  const dir = path.resolve(argv[1] || '.');
  const f = path.join(dir, '.vork', 'state.json');
  if (!fs.existsSync(f)) { console.error(`no Director state at ${f}`); process.exit(2); }
  const r = reportFromAudit(JSON.parse(fs.readFileSync(f, 'utf8')).audit as AuditEvent[] || []);
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}

if (argv[0] && argv[0].startsWith('--') && !['--project', '--port'].includes(argv[0])) {
  console.error('usage: node server.mts [--project DIR] [--port N] | --selftest | --report DIR'); process.exit(2);
}
if (process.env.RENDER_DIRECTOR_IMPORT) { /* imported by tests for the pure helpers only */ } else { await main(); }

// ---------- server ----------
async function main() {
  const PROJECT = arg('--project') ? fs.realpathSync(path.resolve(arg('--project')!)) : null;
  const MODE = PROJECT ? 'ade' : 'standalone';
  const RUNS = PROJECT ? path.join(PROJECT, '.vork') : path.resolve(process.env.RENDER_DIRECTOR_RUNS || path.join(ROOT, 'runs'));
  const MODEL = process.env.DIRECTOR_MODEL || 'sonnet';
  // Files under PUBLIC are served without a session, so RUNS (server.json, state.json) must not live there.
  // Checked before mkdir, on the real path of the nearest existing ancestor.
  // realpathSync.native returns the on-disk letter case, so PUBLIC/x is caught on case-insensitive file systems.
  const realish = (p: string): string => { let probe = p; while (!fs.existsSync(probe)) probe = path.dirname(probe); return path.join(fs.realpathSync.native(probe), path.relative(probe, p)); };
  const runsReal = realish(RUNS), publicReal = fs.realpathSync.native(PUBLIC);
  if (runsReal === publicReal || runsReal.startsWith(publicReal + path.sep)) { console.error(`refusing to start: the runs folder ${RUNS} is inside ${PUBLIC}, which is served without a session`); process.exit(2); }
  fs.mkdirSync(RUNS, { recursive: true });
  const LOCK = path.join(RUNS, 'lock');
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; } };
  for (;;) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); break; }
    catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      const other = Number(fs.readFileSync(LOCK, 'utf8'));
      if (other && other !== process.pid && alive(other)) { console.error(`Director is already running for ${RUNS} (pid ${other})`); process.exit(3); }
      // Stale lock. Only one starter can rename it away; if what we grabbed is a fresh lock, put it back.
      const grab = `${LOCK}.${process.pid}.stale`;
      try { fs.renameSync(LOCK, grab); } catch { continue; }
      if (Number(fs.readFileSync(grab, 'utf8')) !== other) { try { fs.linkSync(grab, LOCK); } catch {} }
      fs.rmSync(grab, { force: true });
    }
  }
  process.on('exit', () => { try { if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.rmSync(LOCK); } catch {} });

  const vork = vorkInstalled();
  if (!vork) { console.error('vork not found on PATH. Install it first: https://github.com/voyager-so/vork'); process.exit(1); }
  const { help: VORK_HELP, version: VORK_VERSION } = vork;

  if (PROJECT) {
    if (!fs.existsSync(path.join(RUNS, 'config.json'))) fs.writeFileSync(path.join(RUNS, 'config.json'), JSON.stringify(DEFAULT_CONFIG, null, 2));
    if (!fs.existsSync(path.join(RUNS, '.gitignore'))) fs.writeFileSync(path.join(RUNS, '.gitignore'), '*\n!.gitignore\n!config.json\n!adopted/\n!adopted/**\n');
  }

  // Scene file references are relative to the project, or to scenes/ in standalone mode.
  const renderer = createVorkRenderer({ assetBase: PROJECT || path.join(ROOT, 'scenes'), version: VORK_VERSION });
  const starter = JSON.parse(fs.readFileSync(path.join(ROOT, 'scenes', 'starter.json'), 'utf8')) as Scene;
  const proposer = PROJECT ? undefined : createClaudeProposer({ model: MODEL, vorkHelp: VORK_HELP, vorkVersion: VORK_VERSION, cwd: RUNS });
  const director = createDirector({ runs: RUNS, project: PROJECT, renderer, starter, proposer });
  const { state, readConfig, audit, getV, sceneOf, hashScene, jobs, adoptionJobs } = director;
  const publicJob = (j: Job) => ({ id: j.id, kind: j.kind, versionId: j.versionId, status: j.status, steps: j.steps, elapsed: Date.now() - j.started, result: j.result, error: j.error });

  // ---------- http ----------
  // Human sessions: a one-time pairing token travels only server → OS browser opener → page fragment.
  // It is never written to disk or to logs, so the agent cannot read it from files. (A same-user process can
  // still find ways around this; see README "安全境界".)
  const AGENT_TOKEN = crypto.randomBytes(24).toString('hex');
  const sessions = new Set();
  let PAIR = process.env.RENDER_DIRECTOR_PAIR_TOKEN || crypto.randomBytes(24).toString('hex'); // env: tests only
  let lastOpenTab = 0;
  const rotatePair = () => { PAIR = crypto.randomBytes(24).toString('hex'); };
  let PORT = Number(arg('--port') || process.env.PORT || 4747);

  const send = (res: http.ServerResponse, code: number, body: unknown, type = 'application/json', headers: Record<string, string> = {}) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...headers });
    // File contents (a Buffer) are sent as they are, also for .json files.
    res.end(type === 'application/json' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body);
  };
  // The type argument is not checked at run time; each endpoint still validates the fields it reads.
  // Over MAX_BODY: settle with PayloadTooLarge (413) and keep draining the rest, so the client can read the response.
  // Draining stops at MAX_DRAIN: past that the connection is dropped instead of reading on until requestTimeout.
  // A content-length declared past MAX_DRAIN is answered before reading; the rest is then discarded for at most DRAIN_MS.
  const MAX_DRAIN = 4 * MAX_BODY, DRAIN_MS = 5000;
  const readBody = <T,>(req: http.IncomingMessage): Promise<T> => new Promise((ok, bad) => {
    if (Number(req.headers['content-length']) > MAX_DRAIN) { const e = new PayloadTooLarge(); e.drain = false; return bad(e); }
    const chunks: Buffer[] = []; let size = 0; let settled = false;
    const fail = (e: Error) => { if (!settled) { settled = true; chunks.length = 0; bad(e); } };
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > MAX_DRAIN) return void req.destroy();
      if (settled) return;
      if (size > MAX_BODY) fail(new PayloadTooLarge()); else chunks.push(d);
    });
    if (Number(req.headers['content-length']) > MAX_BODY) fail(new PayloadTooLarge());
    req.on('error', fail);
    req.on('close', () => fail(new Error('request closed before the body was read')));
    req.on('end', () => {
      if (settled) return; settled = true;
      const b = Buffer.concat(chunks).toString('utf8');
      let parsed: unknown;
      try { parsed = b ? JSON.parse(b) : {}; } catch { return bad(new BadRequest('request body is not valid JSON')); }
      if (!isPlainObject(parsed)) return bad(new BadRequest('request body must be a JSON object'));
      ok(parsed as T);
    });
  });
  const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.bin': 'application/octet-stream', '.json': 'application/json' };
  const SESSION_COOKIE = () => `vd_${PORT}`;
  const hasSession = (req: http.IncomingMessage) => { const c = cookie(req, SESSION_COOKIE()); return typeof c === 'string' && sessions.has(c); };
  function openPairing() {
    const link = `http://127.0.0.1:${PORT}/#pair=${PAIR}`;
    if (process.stdout.isTTY) console.log(`Open Director (one-time link): ${link}`);
    if (process.env.RENDER_DIRECTOR_NO_OPEN === '1') return false;
    // RENDER_DIRECTOR_BROWSER: the command that receives the link as its last argument, either one executable or a JSON
    // array of strings (e.g. ["open","-a","Firefox"]). Only an environment variable: .vork/config.json is writable by
    // the agent, and a command set there could hand the link to it (#39).
    let opener = [process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'];
    const custom = process.env.RENDER_DIRECTOR_BROWSER;
    if (custom) {
      try {
        const cmd: unknown = custom.trimStart().startsWith('[') ? JSON.parse(custom) : [custom];
        if (!Array.isArray(cmd) || !cmd.length || !cmd.every((x) => typeof x === 'string' && x)) throw new Error('must be a non-empty array of strings');
        opener = cmd;
      } catch (e: any) { console.error(`ignoring RENDER_DIRECTOR_BROWSER: ${e.message}`); }
    }
    try { spawn(opener[0], [...opener.slice(1), link], { detached: true, stdio: 'ignore' }).on('error', (e) => console.error(`could not open the review tab with ${opener[0]}: ${e.message}`)).unref(); return true; } catch { return false; }
  }
  const cookie = (req: http.IncomingMessage, name: string): string | undefined => (req.headers.cookie || '').split(';').map((s) => s.trim().split('=')).find(([k]) => k === name)?.[1];
  const tokenEq = (a: unknown, b: string): boolean => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

  // Hashes a /runs/ file may have: null if Director has no record of it, [] if the record predates hashes.
  const recordedHashes = (pathname: string): string[] | null => {
    const m = /^\/runs\/(v\d{3})\/(page-)?(previs|draft|final)\.(png|ids\.bin)$/.exec(pathname); const v = m && getV(m[1]);
    if (!m || !v) return null;
    const [, , page, profile, ext] = m as unknown as [string, string, string | undefined, Profile, string];
    if (page) {
      if (ext !== 'png') return null;
      const shots = Object.values(v.pagePreviews || {}).filter((p) => p.image.split('?')[0] === `/runs/${v.id}/page-${profile}.png`);
      if (!shots.length) return null;
      return shots.some((p) => !p.sha256) ? [] : shots.map((p) => p.sha256!);
    }
    const r = v.renders[profile]; if (!r) return null;
    const h = ext === 'png' ? r.sha256 : r.idsSha256;
    return h ? [h] : [];
  };
  const versionView = (v: Version) => {
    const base = v.parent ? sceneOf(v.parent) : null; const scene = sceneOf(v.id);
    return { ...v, scene, diff: base ? diffScenes(base, scene) : [], hash: hashScene(v.id) };
  };
  const renderSummary = (r: RenderInfo | undefined) => r && { profile: r.profile, seconds: r.seconds, width: r.width, height: r.height, file: r.file, exposure: r.exposure, objects: r.objects, warnings: r.warnings };

  async function handleAgent(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (url.pathname === '/api/agent/status' && req.method === 'GET') {
      return send(res, 200, { mode: MODE, project: PROJECT, head: state.head, vork: VORK_VERSION, versions: state.versions.map((v) => ({ id: v.id, parent: v.parent, status: v.status, origin: v.origin, instruction: v.instruction })), config: readConfig() });
    }
    if (url.pathname === '/api/agent/open-tab' && req.method === 'POST') {
      // rate-limited: each call invalidates the previous link, so an agent must not keep rotating it
      if (Date.now() - lastOpenTab < 30_000) return send(res, 429, { error: 'a review tab was opened less than 30 seconds ago; ask the human to use it' });
      lastOpenTab = Date.now(); rotatePair(); const opened = openPairing();
      return send(res, 200, { opened, note: opened ? 'A browser tab was opened for the human with a one-time pairing link.' : 'Could not open a browser here; ask the human to run Director in a terminal to get a link.' });
    }
    if (url.pathname === '/api/agent/scene' && req.method === 'GET') {
      const id = url.searchParams.get('version') || state.head; if (!getV(id)) return send(res, 404, { error: 'no such version' });
      return send(res, 200, { version: id, status: getV(id)!.status, scene: sceneOf(id!) });
    }
    if (url.pathname === '/api/agent/propose' && req.method === 'POST') {
      const b = await readBody<{ base?: string; interpretation?: unknown; assumptions?: unknown; claimed_changes?: unknown; scene: Scene; responds_to?: unknown }>(req);
      const { v, draft, baseId, flags } = await director.agentPropose(b);
      return send(res, 200, { version: v.id, status: v.status, head: state.head, render: draft.ok ? renderSummary(draft.info) : null, renderError: draft.ok ? null : draft.log, diff: diffScenes(sceneOf(baseId), b.scene), flags });
    }
    if (url.pathname === '/api/agent/render' && req.method === 'GET') {
      const { v, render } = await director.agentRender(url.searchParams.get('version'), url.searchParams.get('profile') || 'draft');
      return send(res, 200, { version: v.id, status: v.status, render: renderSummary(render) });
    }
    if (url.pathname === '/api/agent/feedback' && req.method === 'GET') {
      const wait = Math.min(Math.max(Number(url.searchParams.get('wait') || 60), 0), 120); const t0 = Date.now();
      const gone = new AbortController(); res.on('close', () => gone.abort());
      await director.waitForEvents(wait * 1000, gone.signal);
      if (res.destroyed || res.writableEnded) return; // client gone: leave events unread
      const evs = director.takeEvents(); // reads the pending events and moves agentCursor with no await in between (#31)
      if (!evs.length) return send(res, 200, { timeout: true, waitedSec: Math.round((Date.now() - t0) / 100) / 10, events: [] });
      return send(res, 200, { timeout: false, events: evs });
    }
    if (url.pathname === '/api/agent/adoption-request' && req.method === 'POST') {
      const request = director.requestAdoption(await readBody<{ version: string; slug: unknown; reason?: unknown }>(req));
      return send(res, 200, { request, status: 'pending_human_approval', note: 'A human must approve this in Director. Call wait_for_feedback to learn the outcome.' });
    }
    return send(res, 404, { error: 'unknown agent endpoint' });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    // Local-only guard: reject other Host names (DNS rebinding) and cross-site or simple-request POSTs (CSRF).
    const okHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
    if (!okHosts.includes(req.headers.host as string)) return send(res, 421, { error: 'unexpected Host' });
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && !okHosts.some((h) => origin === `http://${h}`)) return send(res, 403, { error: 'cross-origin request refused' });
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'application/json required' });
    }
    try {
      // Agent API: bearer token from .vork/server.json (read by mcp.mts). Cannot accept, discard, approve or adopt.
      if (url.pathname.startsWith('/api/agent/')) {
        if (!tokenEq(String(req.headers.authorization || '').replace(/^Bearer /, ''), AGENT_TOKEN)) return send(res, 401, { error: 'agent token required' });
        return await handleAgent(req, res, url);
      }
      if (url.pathname === '/api/pair' && req.method === 'POST') {
        const { token } = await readBody<{ token?: unknown }>(req);
        if (!tokenEq(token, PAIR)) return send(res, 403, { error: 'pairing link expired or invalid' });
        rotatePair(); const sid = crypto.randomBytes(24).toString('hex'); sessions.add(sid); audit('paired');
        return send(res, 200, { ok: true }, 'application/json', { 'set-cookie': `${SESSION_COOKIE()}=${sid}; HttpOnly; SameSite=Strict; Path=/` });
      }
      // Human API and render files: only a paired browser session.
      if ((url.pathname.startsWith('/api/') || url.pathname.startsWith('/runs/')) && !hasSession(req))
        return send(res, 403, { error: 'this browser is not paired with Director; open the link Director opened, or ask your agent to call open_review_tab' });

      if (req.method === 'GET' && url.pathname === '/api/state')
        return send(res, 200, {
          mode: MODE, project: PROJECT, config: readConfig(), head: state.head, vork: VORK_VERSION, model: MODEL,
          versions: state.versions.map(versionView), audit: state.audit.slice(-60),
          adoptionRequests: state.adoptionRequests.map((a) => (adoptionJobs.has(a.id) ? { ...a, status: 'adopting', job: adoptionJobs.get(a.id)!.id } : a)), events: state.events.slice(-30), agentCursor: state.agentCursor,
        });

      if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
        const j = jobs.get(url.pathname.split('/').pop()!); return j ? send(res, 200, publicJob(j)) : send(res, 404, { error: 'no job' });
      }
      if (req.method === 'POST' && url.pathname.match(/^\/api\/jobs\/[^/]+\/cancel$/)) {
        const j = director.cancelJob(url.pathname.split('/')[3]); if (!j) return send(res, 404, { error: 'no job' });
        return send(res, 200, publicJob(j));
      }

      if (req.method === 'POST' && url.pathname === '/api/render')
        return send(res, 202, publicJob(director.startRender(await readBody<{ versionId: string; profile: unknown; ticket: string }>(req))));

      if (req.method === 'POST' && url.pathname === '/api/final/plan') {
        const { versionId } = await readBody<{ versionId: string }>(req);
        const { ticket, hash, v, scene, flags } = director.planFinal(versionId); const d = v.renders.draft;
        return send(res, 200, {
          ticket, hash, versionId, profile: PROFILES.final, resolution: scene.render?.resolution || [1920, 1080],
          output: path.relative(PROJECT || ROOT, path.join(director.vdir(versionId), 'final.png')), overwrites: Boolean(v.renders.final), timeoutSec: LIMITS.final / 1000,
          reference: d ? `draft took ${d.seconds.toFixed(1)}s at ${d.settings.samples} samples` : 'no draft measured yet',
          flags, expiresInSec: 600,
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/propose') {
        director.checkCanPropose(); // before the body is read: ADE mode refuses any body
        return send(res, 202, publicJob(director.startPropose(await readBody<{ baseId: string; instruction?: unknown; selection?: unknown; context?: unknown }>(req))));
      }

      if (req.method === 'POST' && url.pathname === '/api/feedback') {
        director.feedback(await readBody<{ versionId: string; selection?: unknown; comment?: unknown }>(req));
        return send(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/api/decide') {
        const head = director.decide(await readBody<{ versionId: string; decision: string; comment?: unknown }>(req));
        return send(res, 200, { ok: true, head });
      }

      if (req.method === 'POST' && url.pathname === '/api/checkout') {
        director.checkout(await readBody<{ versionId: string }>(req));
        return send(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/api/adopt/plan')
        return send(res, 200, director.planAdoption(await readBody<{ requestId: string; slug?: unknown }>(req)));

      if (req.method === 'POST' && url.pathname === '/api/adopt/reject') {
        director.rejectAdoption(await readBody<{ requestId: string; comment?: unknown }>(req));
        return send(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/api/adopt') {
        const { ticket } = await readBody<{ ticket: string }>(req);
        return send(res, 202, publicJob(director.startAdoption(ticket)));
      }

      if (req.method === 'POST' && url.pathname === '/api/preview') {
        const { versionId, profile = 'draft' } = await readBody<{ versionId: string; profile?: unknown }>(req); const v = getV(versionId);
        if (!v) return send(res, 400, { error: 'bad version' });
        if (!isProfile(profile)) return send(res, 400, { error: 'profile must be previs, draft or final' });
        const r = await pagePreview(director, v, profile);
        if (r.ok) director.recordPagePreview(v, profile, r);
        return send(res, 200, r);
      }

      if (req.method === 'POST' && url.pathname === '/api/edit') {
        const { v, job } = director.directEdit(await readBody<{ baseId: string; node: string; field: string; value: unknown }>(req));
        return send(res, 202, { version: v.id, job: publicJob(job) });
      }

      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'unknown endpoint' });

      // static
      if (url.pathname === '/' || url.pathname === '/index.html')
        return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html')), MIME['.html']);
      // Each route serves only its own root: render files from RUNS (session checked above), the app from PUBLIC.
      let root, rel;
      if (url.pathname.startsWith('/runs/')) {
        if (!/^\/runs\/v\d{3}\/(previs|draft|final|page-previs|page-draft|page-final)\.(png|ids\.bin)$/.test(url.pathname)) return send(res, 404, 'not found', 'text/plain');
        root = RUNS; rel = url.pathname.slice(6);
      } else {
        try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'bad path', 'text/plain'); }
        root = PUBLIC;
      }
      if (rel.includes('\0') || rel.split(/[\\/]/).includes('..')) return send(res, 404, 'not found', 'text/plain');
      // No symlinks below the root: the real path must be the literal one. A link that stays inside RUNS
      // (v001/final.png -> ../server.json) would otherwise still pass a "real path is inside the root" check.
      // .native also makes a URL whose letter case differs from the file on disk a 404.
      const rootReal = fs.realpathSync.native(root); const want = path.resolve(rootReal, '.' + path.sep + rel);
      let real: string;
      try { real = fs.realpathSync.native(want); } catch { return send(res, 404, 'not found', 'text/plain'); }
      if (real !== want || !real.startsWith(rootReal + path.sep)) return send(res, 404, 'not found', 'text/plain');
      // Read from the descriptor that was checked, not the path again: O_NOFOLLOW refuses a symlink swapped in
      // after the check. A render file must have one link only: a hard link to server.json passes every path check.
      let fd: number;
      // O_NONBLOCK: opening a FIFO would otherwise block the whole server until a writer appears; fstat below refuses it.
      try { fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { return send(res, 404, 'not found', 'text/plain'); }
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || (root === RUNS && st.nlink !== 1)) return send(res, 404, 'not found', 'text/plain');
        // O_NOFOLLOW covers the last component only: the opened file must still be the one at the checked path.
        const at = fs.lstatSync(real);
        if (at.dev !== st.dev || at.ino !== st.ino || fs.realpathSync.native(real) !== want) return send(res, 404, 'not found', 'text/plain');
        const data = fs.readFileSync(fd);
        // The checks above narrow a race but cannot close it: Node has no openat, so a directory on the path can be
        // swapped for a symlink between the check and the open (#26). A render file is served only if its bytes are
        // the ones Director recorded. State written before #26 has no hash for ids.bin and page-*.png; those keep
        // the path checks only.
        if (root === RUNS) {
          const hashes = recordedHashes(url.pathname);
          if (!hashes || (hashes.length && !hashes.includes(sha256(data)))) return send(res, 404, 'not found', 'text/plain');
        }
        return send(res, 200, data, MIME[path.extname(real)] || 'application/octet-stream');
      } finally { fs.closeSync(fd); }
    } catch (e: any) {
      if (e instanceof Refusal) return send(res, REFUSAL_STATUS[e.kind], { error: e.message, ...e.extra });
      if (e instanceof BadRequest) return send(res, 400, { error: e.message });
      if (e instanceof PayloadTooLarge) {
        const reply = () => { if (!res.headersSent && !res.destroyed) send(res, 413, { error: `request body is larger than ${MAX_BODY / 1e6} MB` }); };
        if (!e.drain) {
          // Declared past the drain limit: reply now, then discard what still arrives for at most DRAIN_MS.
          // Closing at once would reset the connection while the client still sends, and the client could lose the reply.
          const cut = setTimeout(() => req.destroy(), DRAIN_MS);
          req.once('close', () => clearTimeout(cut)); req.resume();
          return reply();
        }
        // Otherwise reply once the rest of the body is drained: closing while the client still sends resets the connection.
        return req.readableEnded ? reply() : void req.once('end', reply);
      }
      if (res.destroyed) return; // client went away mid-body
      console.error(e); return send(res, 500, { error: 'internal error' });
    }
  });

  // Listen; in ADE mode try the next ports if busy, then publish the address for mcp.mts.
  const listen = (port: number) => new Promise<void>((ok, bad) => { server.once('error', bad); server.listen(port, '127.0.0.1', () => { server.off('error', bad); ok(); }); });
  for (let attempt = 0; ; attempt++) {
    try { await listen(PORT); break; }
    catch (e: any) { if (e.code !== 'EADDRINUSE' || !PROJECT || attempt >= 20) throw e; PORT++; }
  }
  const SERVER_FILE = path.join(RUNS, 'server.json');
  fs.writeFileSync(SERVER_FILE, JSON.stringify({ url: `http://127.0.0.1:${PORT}`, pid: process.pid, agentToken: AGENT_TOKEN, project: PROJECT, mode: MODE, started: new Date().toISOString() }, null, 2), { mode: 0o600 });
  const cleanup = () => { try { const s = JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8')) as { pid?: number }; if (s.pid === process.pid) fs.rmSync(SERVER_FILE); } catch {} process.exit(0); };
  process.on('SIGINT', cleanup); process.on('SIGTERM', cleanup);
  process.on('SIGUSR1', () => { rotatePair(); openPairing(); });
  openPairing();
  console.log(`Render Director on http://127.0.0.1:${PORT}  mode=${MODE}${PROJECT ? `  project=${PROJECT}` : ''}  (${VORK_VERSION}${MODE === 'standalone' ? `, built-in agent: claude ${MODEL}` : ''})`);
}
