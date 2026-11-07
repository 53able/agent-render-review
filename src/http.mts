// HTTP: the local-only guards (Host, Origin, Content-Type), the agent API (bearer token) and the human API (paired
// browser session), and the presenter that turns Director state into the responses public/app.js and mcp.mts read.
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LIMITS, PROFILES, isProfile, isPlainObject, sha256, diffScenes } from './policy.mts';
import type { Profile, Scene, RenderInfo, Version, PagePreviewOk } from './policy.mts';
import { Refusal } from './director.mts';
import type { Director, Job } from './director.mts';
import { pagePreview } from './preview.mts';
import type {
  RenderSummary, AgentStatusResponse, AgentSceneResponse, AgentProposeResponse, AgentRenderResponse, AgentFeedbackResponse, AdoptionRequestResponse,
  OpenTabResponse, AgentErrorResponse,
} from './contract.mts';

/** A client error whose message is safe to return as a 400 response. */
class BadRequest extends Error {}
/** A request body over MAX_BODY bytes; answered with 413. */
class PayloadTooLarge extends Error {
  /** false: the declared length is past the drain limit, so the 413 goes out before the body is read. */
  drain = true;
}
const MAX_BODY = 4e6;
const REFUSAL_STATUS: Record<Refusal['kind'], number> = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, unprocessable: 422, too_many: 429, failed: 500 };

export interface HttpOptions {
  director: Director;
  /** The folder of the app (paths in a final plan are shown relative to it in standalone mode). */
  root: string;
  /** Served without a session. */
  publicDir: string;
  vorkVersion: string;
  /** The built-in proposer's model, shown in /api/state. */
  model: string;
  /** The port to listen on first; main.mts moves it on while the port is busy. */
  port: number;
}

export function createHttp({ director, root: ROOT, publicDir: PUBLIC, vorkVersion: VORK_VERSION, model: MODEL, port }: HttpOptions) {
  const { state, readConfig, audit, getV, sceneOf, hashScene, jobs, adoptionJobs, mode: MODE, project: PROJECT, runs: RUNS } = director;
  let PORT = port;
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
      const shots = Object.values(v.pagePreviews || {}).filter((p) => p.source === profile);
      if (!shots.length) return null;
      return shots.some((p) => !p.sha256) ? [] : shots.map((p) => p.sha256!);
    }
    const r = v.renders[profile]; if (!r) return null;
    const h = ext === 'png' ? r.sha256 : r.idsSha256;
    return h ? [h] : [];
  };
  // Presenter: the URLs the browser loads are made here from the version, the profile and the recorded hash, so a
  // URL changes exactly when the file does (#17). state.json keeps no URL (#42).
  const stamp = (h: string | undefined) => (h ? `?${h.slice(0, 16)}` : '');
  const presentRender = (id: string, r: RenderInfo) => ({
    ...r, image: `/runs/${id}/${r.profile}.png${stamp(r.sha256)}`, ids: `/runs/${id}/${r.profile}.ids.bin${stamp(r.idsSha256)}`,
  });
  const presentPreview = (id: string, p: PagePreviewOk) => ({ ...p, image: `/runs/${id}/page-${p.source}.png${stamp(p.sha256)}` });
  const versionView = (v: Version) => {
    const base = v.parent ? sceneOf(v.parent) : null; const scene = sceneOf(v.id);
    const renders = Object.fromEntries(Object.entries(v.renders).map(([k, r]) => [k, r && presentRender(v.id, r)]));
    const pagePreviews = v.pagePreviews && Object.fromEntries(Object.entries(v.pagePreviews).map(([k, p]) => [k, presentPreview(v.id, p)]));
    return { ...v, renders, pagePreviews, scene, diff: base ? diffScenes(base, scene) : [], hash: hashScene(v.id) };
  };
  // file: the absolute path is made here for mcp.mts, which reads the image from it; state.json keeps no path (#42).
  const renderSummary = (id: string, r: RenderInfo | undefined): RenderSummary | undefined => r && { profile: r.profile, seconds: r.seconds, width: r.width, height: r.height, file: director.renderFile(id, r.profile), exposure: r.exposure, objects: r.objects, warnings: r.warnings };

  async function handleAgent(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (url.pathname === '/api/agent/status' && req.method === 'GET') {
      return send(res, 200, { mode: MODE, project: PROJECT, head: state.head, vork: VORK_VERSION, versions: state.versions.map((v) => ({ id: v.id, parent: v.parent, status: v.status, origin: v.origin, instruction: v.instruction })), config: readConfig() } satisfies AgentStatusResponse);
    }
    if (url.pathname === '/api/agent/open-tab' && req.method === 'POST') {
      // rate-limited: each call invalidates the previous link, so an agent must not keep rotating it
      if (Date.now() - lastOpenTab < 30_000) return send(res, 429, { error: 'a review tab was opened less than 30 seconds ago; ask the human to use it' });
      lastOpenTab = Date.now(); rotatePair(); const opened = openPairing();
      return send(res, 200, { opened, note: opened ? 'A browser tab was opened for the human with a one-time pairing link.' : 'Could not open a browser here; ask the human to run Director in a terminal to get a link.' } satisfies OpenTabResponse);
    }
    if (url.pathname === '/api/agent/scene' && req.method === 'GET') {
      const id = url.searchParams.get('version') || state.head; if (!getV(id)) return send(res, 404, { error: 'no such version' });
      return send(res, 200, { version: id!, status: getV(id)!.status, scene: sceneOf(id!) } satisfies AgentSceneResponse);
    }
    if (url.pathname === '/api/agent/propose' && req.method === 'POST') {
      const b = await readBody<{ base?: string; interpretation?: unknown; assumptions?: unknown; claimed_changes?: unknown; scene: Scene; responds_to?: unknown }>(req);
      const { v, draft, baseId, flags } = await director.agentPropose(b);
      return send(res, 200, { version: v.id, status: v.status, head: state.head, render: draft.ok ? renderSummary(v.id, draft.info) : null, renderError: draft.ok ? null : draft.log, diff: diffScenes(sceneOf(baseId), b.scene), flags } satisfies AgentProposeResponse);
    }
    if (url.pathname === '/api/agent/render' && req.method === 'GET') {
      const { v, render } = await director.agentRender(url.searchParams.get('version'), url.searchParams.get('profile') || 'draft');
      return send(res, 200, { version: v.id, status: v.status, render: renderSummary(v.id, render) } satisfies AgentRenderResponse);
    }
    if (url.pathname === '/api/agent/feedback' && req.method === 'GET') {
      const wait = Math.min(Math.max(Number(url.searchParams.get('wait') || 60), 0), 120); const t0 = Date.now();
      const gone = new AbortController(); res.on('close', () => gone.abort());
      await director.waitForEvents(wait * 1000, gone.signal);
      if (res.destroyed || res.writableEnded) return; // client gone: leave events unread
      const evs = director.takeEvents(); // reads the pending events and moves agentCursor with no await in between (#31)
      if (!evs.length) return send(res, 200, { timeout: true, waitedSec: Math.round((Date.now() - t0) / 100) / 10, events: [] } satisfies AgentFeedbackResponse);
      return send(res, 200, { timeout: false, events: evs } satisfies AgentFeedbackResponse);
    }
    if (url.pathname === '/api/agent/adoption-request' && req.method === 'POST') {
      const request = director.requestAdoption(await readBody<{ version: string; slug: unknown; reason?: unknown }>(req));
      return send(res, 200, { request, status: 'pending_human_approval', note: 'A human must approve this in Director. Call wait_for_feedback to learn the outcome.' } satisfies AdoptionRequestResponse);
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
        return send(res, 200, r.ok ? presentPreview(v.id, r) : r);
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
      if (e instanceof Refusal) return send(res, REFUSAL_STATUS[e.kind], { error: e.message, ...e.extra } satisfies AgentErrorResponse);
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

  return {
    server, agentToken: AGENT_TOKEN, openPairing, rotatePair,
    get port() { return PORT; },
    set port(p: number) { PORT = p; },
  };
}
