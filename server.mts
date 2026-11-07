// Render Director — a review surface for renders made with vork (unofficial).
// Standalone mode: `node server.mts` (built-in proposer via `claude -p`).
// ADE mode:        `node server.mts --project <dir>` (your ADE agent proposes through mcp.mts; you review and adopt here).
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LIMITS, PROFILES, SLUG, isProfile, DEFAULT_CONFIG, MAX_REASON, MAX_ASSUMPTIONS, MAX_ASSUMPTION, MAX_PENDING_ADOPTIONS, MAX_INTERPRETATION, MAX_CLAIMED, MAX_CLAIMED_NODE, MAX_CLAIMED_TEXT,
  isPlainObject, isClaimedChange, sha256, policyCheck, diffScenes, resolveInside, reportFromAudit, applyDirectEdit, adoptionRels } from './src/policy.mts';
import type { Profile, SceneNode, Scene, PolicyResult, AuditEvent, Config, Exposure, RenderInfo, AgentOutput, Proposal, VersionStatus, PagePreviewResult,
  Version, AgentEventBody, DirectorState } from './src/policy.mts';
// Kept importable from here: test/integration.mts and older callers import them from server.mts.
export { policyCheck, diffScenes, resolveInside, reportFromAudit } from './src/policy.mts';
import { createVorkRenderer, vorkInstalled, run } from './src/vork.mts';
import { createDirector } from './src/director.mts';
import type { Job } from './src/director.mts';

// ---------- types (erased at runtime) ----------
type TicketData =
  | { kind: 'final'; versionId: string; hash: string }
  | { kind: 'adopt'; versionId: string; hash: string; requestId: string; slug: string; sceneText: string; assetRel: string; overwrites: boolean };
type Ticket = TicketData & { expires: number };

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
  const director = createDirector({ runs: RUNS, project: PROJECT, renderer, starter });
  const { state, readConfig, save, audit, getV, liveV, vdir, sceneOf, hashScene, waiters, pushEvent, addVersion, jobs, newJob, step, failJob, renderLocks, renderVersion, validateScene, createProposal } = director;
  const publicJob = (j: Job) => ({ id: j.id, kind: j.kind, versionId: j.versionId, status: j.status, steps: j.steps, elapsed: Date.now() - j.started, result: j.result, error: j.error });

  // ---------- built-in proposer (standalone mode only) ----------
  const PROPOSAL_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['interpretation', 'assumptions', 'clarifying_question', 'claimed_changes', 'scene'],
    properties: {
      interpretation: { type: 'string', description: 'One sentence: what you understood the director wants.' },
      assumptions: { type: 'array', items: { type: 'string' } },
      clarifying_question: { type: ['string', 'null'], description: 'Non-null only if the request is too ambiguous to act on safely.' },
      claimed_changes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['node', 'what', 'why'], properties: { node: { type: 'string' }, what: { type: 'string' }, why: { type: 'string' } } } },
      scene: { type: 'object', description: 'The complete revised vork scene (version 2).' },
    },
  };
  const SYSTEM = `You are the scene assistant inside "Render Director". A human director looks at renders and asks for changes.
You edit vork scene JSON (API v2). You do NOT render; the app renders and the director judges the image.
Rules:
- Return the COMPLETE revised scene in "scene". Keep every node "name" stable; give every new node a unique, non-empty name that does not start with "#".
- Change only what the request needs. If objects are SELECTED, scope changes to them unless the request clearly says otherwise.
- Never reference files, URLs or downloads. Do not add custom programs/shader code unless explicitly asked.
- Unknown fields are errors in vork; use only fields documented below. Keep resolution unchanged unless asked.
- If the request is ambiguous in a way that changes the result a lot, set clarifying_question and return the scene unchanged.
- claimed_changes must describe every edit you made. The app compares them with the real diff and shows mismatches.
vork reference (from \`vork help\`, ${VORK_VERSION}):
${VORK_HELP}`;

  async function callAgent(job: Job, prompt: string): Promise<{ cancelled: true; out?: undefined; cost?: undefined } | { cancelled?: undefined; out: AgentOutput; cost: number | undefined; ms: number | undefined }> {
    const args = ['-p', '--model', MODEL, '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
      '--output-format', 'json', '--json-schema', JSON.stringify(PROPOSAL_SCHEMA), '--system-prompt', SYSTEM];
    const r = await run('claude', args, { timeout: LIMITS.agent, input: prompt, cwd: RUNS, signal: job.ac.signal });
    if (job.status === 'cancelled') return { cancelled: true };
    if (r.code !== 0) throw new Error(r.timedOut ? 'agent timed out' : `claude exited ${r.code}: ${(r.stderr || r.stdout).slice(-600)}`);
    const env = JSON.parse(r.stdout) as { structured_output?: AgentOutput; result?: unknown; total_cost_usd?: number; duration_ms?: number };
    const out = env.structured_output ?? (typeof env.result === 'string' ? JSON.parse(env.result) : null);
    if (!out) throw new Error('agent returned no structured output');
    return { out, cost: env.total_cost_usd, ms: env.duration_ms };
  }

  async function propose(job: Job, { baseId, instruction, selection, context }: {
    baseId: string; instruction: string; selection: string[]; context: { selection?: boolean; exposure?: boolean; history?: boolean };
  }) {
    const base = getV(baseId)!; const baseScene = sceneOf(baseId);
    const r = base.renders.draft || base.renders.previs;
    const ctx: string[] = [];
    if (context.selection && selection.length) ctx.push(`SELECTED objects (director clicked these in the image): ${selection.join(', ')}`);
    if (context.exposure && r) ctx.push(`Last render measurements (from vork, ${r.profile}): mean ${r.exposure.mean.toFixed(3)}, clipped ${(r.exposure.clipped * 100).toFixed(2)}%, near-black ${(r.exposure.near_black * 100).toFixed(2)}%`);
    if (context.history) {
      const hist: string[] = []; let p: Version | undefined = base;
      while (p && hist.length < 5) { if (p.instruction) hist.unshift(`- ${p.instruction}`); p = getV(p.parent); }
      if (hist.length) ctx.push(`Earlier accepted requests in this branch:\n${hist.join('\n')}`);
    }
    let prompt = `${ctx.join('\n\n')}\n\nCURRENT SCENE (${baseId}):\n${JSON.stringify(baseScene)}\n\nDIRECTOR'S REQUEST:\n${instruction}`;
    let totalCost = 0;
    for (let attempt = 1; attempt <= 2; attempt++) {
      step(job, attempt === 1 ? 'Agent is drafting a scene change' : 'Agent is repairing its proposal (1 retry)');
      const res = await callAgent(job, prompt); if (res.cancelled) return;
      totalCost += res.cost || 0; const last = res.out;
      if (last.clarifying_question) { step(job, 'Agent needs clarification', 'done'); return { kind: 'question', proposal: last, cost: totalCost }; }
      step(job, 'Checking policy and validating with vork');
      const check = await validateScene(job, last.scene);
      if (check.kind === 'cancelled') return;
      if (!check.ok) {
        const why = check.kind === 'blocked' ? check.policy.blockers.join('; ') : check.log;
        if (attempt >= 2) { step(job, check.kind === 'blocked' ? 'Blocked by policy' : 'vork rejected the scene', 'failed', why); return { kind: check.kind, proposal: last, policy: check.policy, log: check.log, cost: totalCost }; }
        job.steps.at(-1)!.detail = String(why).split('\n').slice(-6).join('\n'); job.steps.at(-1)!.status = 'failed';
        prompt += `\n\nYOUR PREVIOUS PROPOSAL WAS REJECTED:\n${String(why).slice(-1500)}\nFix it and return the full scene again.`; continue;
      }
      if (!liveV(baseId)) { step(job, `${baseId} was discarded while the agent worked; no proposal was made`, 'failed'); return { kind: 'base_discarded', cost: totalCost }; }
      const { v, draft } = await createProposal(job, { baseId, scene: last.scene, instruction, proposal: { ...last, scene: undefined, policy: check.policy, cost: totalCost, context: ctx, via: 'built-in' } });
      if (draft.cancelled) return;
      step(job, 'Proposal ready for review', 'done');
      return { kind: 'proposal', versionId: v.id };
    }
  }

  // ---------- approval tickets (final render, adoption) bound to an exact scene hash ----------
  const tickets = new Map<string, Ticket>();
  const issueTicket = (data: TicketData) => {
    // A new adoption plan replaces the older ones for the same request, so two tickets cannot both adopt it.
    if (data.kind === 'adopt') for (const [id, t] of tickets) if (t.kind === 'adopt' && t.requestId === data.requestId) tickets.delete(id);
    for (const [id, t] of tickets) if (t.expires < Date.now()) tickets.delete(id); // unused tickets are not kept past expiry (#32)
    const id = crypto.randomUUID(); tickets.set(id, { ...data, expires: Date.now() + 10 * 60_000 }); return id;
  };
  // Adoption requests whose adopt job is running. Kept in memory only: a job does not survive a restart,
  // so after one the request is simply pending again. While a job runs, plan, reject and discard answer 409.
  const adoptionJobs = new Map<string, Job>();
  const adoptingVersion = (versionId: string) => [...adoptionJobs.keys()].some((rid) => state.adoptionRequests.find((a) => a.id === rid)?.version === versionId);
  const ADOPTION_RUNNING = 'an adoption of this request is running; cancel its job first';
  // A pending request for a discarded version can never be adopted: reject it so the agent learns the outcome (#27).
  // A version with a running adopt job cannot be discarded, so no job is affected.
  const rejectRequestsOfDiscarded = () => {
    for (const ar of state.adoptionRequests) {
      if (ar.status !== 'pending' || liveV(ar.version) || adoptionJobs.has(ar.id)) continue;
      ar.status = 'rejected'; audit('adoption_rejected', { request: ar.id, version: ar.version, reason: 'version discarded' });
      pushEvent({ type: 'adoption_rejected', request: ar.id, version: ar.version, comment: 'version discarded' });
    }
  };
  rejectRequestsOfDiscarded(); // requests left pending by a Director from before #27
  const finalMatches = (v: Version, hash: string) => {
    const f = v.renders.final; if (!f || f.sceneHash !== hash || !fs.existsSync(f.file)) return false;
    return sha256(fs.readFileSync(f.file)) === f.sha256;
  };
  const takeTicket = <K extends Ticket['kind']>(id: string, kind: K): Extract<Ticket, { kind: K }> | null => {
    const t = tickets.get(id);
    if (!t || t.kind !== kind || t.expires < Date.now() || t.hash !== hashScene(t.versionId)) return null;
    tickets.delete(id); return t as Extract<Ticket, { kind: K }>;
  };

  function adoptionTargets(slug: unknown) {
    if (!PROJECT) throw new Error('adoption needs --project');
    if (typeof slug !== 'string' || !SLUG.test(slug)) throw new Error('slug must match [a-z0-9][a-z0-9-]{0,63}');
    const { assetRel, manifestRel } = adoptionRels(slug, String(readConfig().assetDir || DEFAULT_CONFIG.assetDir));
    return { slug, assetRel, manifestRel, asset: resolveInside(PROJECT, assetRel), manifest: resolveInside(PROJECT, manifestRel) };
  }

  // ---------- page preview: real page, candidate substituted by request interception ----------
  async function pagePreview(v: Version, profile: Profile): Promise<PagePreviewResult> {
    const config = readConfig();
    if (!config.pageUrl || !config.assetUrlPattern) return { ok: false, reason: 'set pageUrl and assetUrlPattern in .vork/config.json' };
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(String(config.pageUrl))) return { ok: false, reason: 'pageUrl must be an http(s) URL on 127.0.0.1, localhost or [::1]' };
    let chromium;
    try { ({ chromium } = await import('playwright-core')); } catch { return { ok: false, reason: 'playwright-core is not installed (npm install)' }; }
    const exe = process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
    if (!exe) return { ok: false, reason: 'Chrome not found (set CHROME_PATH)' };
    // Wait for renders of this version queued so far: vork writes the PNG in place (#30).
    await renderLocks.get(v.id)?.catch(() => {});
    const render = v.renders[profile] || v.renders.draft;
    if (!render) return { ok: false, reason: 'render the version first' };
    // The bytes must be the ones recorded when the render finished; otherwise a render started after the wait is writing it.
    let png: Buffer;
    try { png = fs.readFileSync(render.file); } catch { return { ok: false, reason: 'the render file is missing; render the version again' }; }
    if (sha256(png) !== render.sha256) return { ok: false, reason: 'the render is being updated; try again when it finishes' };
    const browser = await chromium.launch({ executablePath: exe, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      let matched = 0;
      await page.route(config.assetUrlPattern, (route) => { matched++; route.fulfill({ status: 200, contentType: 'image/png', body: png }); });
      try { await page.goto(config.pageUrl, { waitUntil: 'networkidle', timeout: LIMITS.page }); }
      catch (e: any) { return { ok: false, reason: `could not open ${config.pageUrl}: ${String(e.message).split('\n')[0]}` }; }
      const file = path.join(vdir(v.id), `page-${render.profile}.png`);
      const shot = await page.screenshot({ path: file, fullPage: false });
      return { ok: true, matched, sha256: sha256(shot), image: `/runs/${v.id}/page-${render.profile}.png?${Date.now()}`, warning: matched ? null : `no request matched ${config.assetUrlPattern}; the screenshot shows the page without the candidate` };
    } finally { await browser.close(); }
  }

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
      const baseId = b.base || state.head;
      if (!liveV(baseId)) return send(res, 400, { error: 'base must be an existing, not discarded version' });
      if (typeof b.interpretation !== 'string' || !b.interpretation.trim() || !Array.isArray(b.claimed_changes)) return send(res, 400, { error: 'interpretation and claimed_changes are required' });
      if (!b.claimed_changes.every(isClaimedChange)) return send(res, 400, { error: 'each claimed_changes item must be { node, what, why } with string values' });
      // interpretation is stored three times (instruction, proposal, audit), so it is bounded like reason.
      if (b.interpretation.length > MAX_INTERPRETATION) return send(res, 400, { error: `interpretation must be at most ${MAX_INTERPRETATION} characters` });
      if (b.claimed_changes.length > MAX_CLAIMED || b.claimed_changes.some((c) => c.node.length > MAX_CLAIMED_NODE || c.what.length > MAX_CLAIMED_TEXT || c.why.length > MAX_CLAIMED_TEXT))
        return send(res, 400, { error: `claimed_changes: at most ${MAX_CLAIMED} items; node at most ${MAX_CLAIMED_NODE}, what and why at most ${MAX_CLAIMED_TEXT} characters` });
      // Checked before validateScene so a bad field does not cost a vork render.
      if (b.assumptions != null && !(Array.isArray(b.assumptions) && b.assumptions.every((a) => typeof a === 'string'))) return send(res, 400, { error: 'assumptions must be an array of strings' });
      if (Array.isArray(b.assumptions) && (b.assumptions.length > MAX_ASSUMPTIONS || b.assumptions.some((a: string) => a.length > MAX_ASSUMPTION))) return send(res, 400, { error: `assumptions: at most ${MAX_ASSUMPTIONS} items of at most ${MAX_ASSUMPTION} characters` });
      if (b.responds_to != null && !Number.isInteger(b.responds_to)) return send(res, 400, { error: 'responds_to must be an integer' });
      const assumptions: string[] = (b.assumptions as string[] | null | undefined) ?? [];
      const respondsTo = (b.responds_to as number | null | undefined) ?? null;
      const job = newJob('agent-propose', baseId!, { listed: false });
      const check = await validateScene(job, b.scene);
      if (!check.ok) { audit('agent_proposal_rejected', { kind: check.kind, base: baseId }); return send(res, 422, { error: check.kind === 'blocked' ? 'policy' : 'vork rejected the scene', blockers: check.policy?.blockers || [], log: check.log || null, version: null }); }
      // The human may have discarded the base during the validation render.
      if (!liveV(baseId)) return send(res, 409, { error: `base ${baseId} was discarded while the scene was being validated; no version was created`, version: null });
      const proposal: Proposal = { interpretation: b.interpretation, assumptions, claimed_changes: b.claimed_changes.map(({ node, what, why }) => ({ node, what, why })), policy: check.policy, context: respondsTo != null ? [`responds to feedback #${respondsTo}`] : [], via: 'mcp', respondsTo };
      const { v, draft } = await createProposal(job, { baseId, scene: b.scene, instruction: b.interpretation, proposal });
      return send(res, 200, { version: v.id, status: v.status, head: state.head, render: draft.ok ? renderSummary(draft.info) : null, renderError: draft.ok ? null : draft.log, diff: diffScenes(sceneOf(baseId!), b.scene), flags: check.policy.flags });
    }
    if (url.pathname === '/api/agent/render' && req.method === 'GET') {
      const v = getV(url.searchParams.get('version') || state.head); const profile = url.searchParams.get('profile') || 'draft';
      if (!v) return send(res, 404, { error: 'no such version' });
      if (!isProfile(profile)) return send(res, 400, { error: 'profile must be previs, draft or final' });
      if (!v.renders[profile]) {
        if (profile === 'final') return send(res, 403, { error: 'final renders need human approval in Director' });
        const r = await renderVersion(newJob('agent-render', v.id, { listed: false }), v, profile);
        if (!r.ok) return send(res, 500, { error: 'render failed', log: r.log });
      }
      return send(res, 200, { version: v.id, status: v.status, render: renderSummary(v.renders[profile]) });
    }
    if (url.pathname === '/api/agent/feedback' && req.method === 'GET') {
      const wait = Math.min(Math.max(Number(url.searchParams.get('wait') || 60), 0), 120);
      const pending = () => state.events.filter((e) => e.seq > state.agentCursor); const t0 = Date.now();
      if (!pending().length && wait > 0) {
        await new Promise<void>((resolve) => { const done = () => { waiters.delete(done); clearTimeout(t); resolve(); }; const t = setTimeout(done, wait * 1000); waiters.add(done); res.on('close', done); });
      }
      if (res.destroyed || res.writableEnded) return; // client gone: leave events unread
      // Concurrent waiters are all woken by one event. Each event is delivered once only because nothing below
      // awaits between reading pending() and moving agentCursor: do not put an await (e.g. an async save) in between (#31).
      const evs = pending();
      if (!evs.length) return send(res, 200, { timeout: true, waitedSec: Math.round((Date.now() - t0) / 100) / 10, events: [] });
      state.agentCursor = evs.at(-1)!.seq; save();
      return send(res, 200, { timeout: false, events: evs });
    }
    if (url.pathname === '/api/agent/adoption-request' && req.method === 'POST') {
      const b = await readBody<{ version: string; slug: unknown; reason?: unknown }>(req); const v = liveV(b.version);
      if (!PROJECT) return send(res, 409, { error: 'adoption needs Director started with --project' });
      if (!v) return send(res, 400, { error: 'version must exist and not be discarded' });
      if (b.reason != null && typeof b.reason !== 'string') return send(res, 400, { error: 'reason must be a string' });
      if (typeof b.reason === 'string' && b.reason.length > MAX_REASON) return send(res, 400, { error: `reason must be at most ${MAX_REASON} characters` });
      let slug: string;
      try { ({ slug } = adoptionTargets(b.slug)); } catch (e: any) { return send(res, 400, { error: e.message }); }
      const same = state.adoptionRequests.find((a) => a.status === 'pending' && a.version === v.id && a.slug === slug);
      if (same) return send(res, 409, { error: `request ${same.id} for ${v.id} as ${slug} is already pending; call wait_for_feedback`, request: same.id });
      // Requests for a discarded version can no longer be adopted, so they do not count.
      if (state.adoptionRequests.filter((a) => a.status === 'pending' && liveV(a.version)).length >= MAX_PENDING_ADOPTIONS)
        return send(res, 429, { error: `${MAX_PENDING_ADOPTIONS} adoption requests are already pending; wait for the human to decide` });
      const reqId = `a${String(state.adoptionRequests.length + 1).padStart(3, '0')}`;
      state.adoptionRequests.push({ id: reqId, version: v.id, slug, reason: b.reason ?? '', status: 'pending', t: new Date().toISOString() });
      audit('adoption_requested', { request: reqId, version: v.id, slug });
      return send(res, 200, { request: reqId, status: 'pending_human_approval', note: 'A human must approve this in Director. Call wait_for_feedback to learn the outcome.' });
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
        const j = jobs.get(url.pathname.split('/')[3]); if (!j) return send(res, 404, { error: 'no job' });
        if (j.status === 'running') {
          j.status = 'cancelled'; j.ac.abort(); step(j, 'Cancelled by director', 'failed'); audit('cancelled', { job: j.kind, version: j.versionId });
          for (const [rid, aj] of adoptionJobs) if (aj === j) adoptionJobs.delete(rid); // the request is pending again
        }
        return send(res, 200, publicJob(j));
      }

      if (req.method === 'POST' && url.pathname === '/api/render') {
        const { versionId, profile, ticket } = await readBody<{ versionId: string; profile: unknown; ticket: string }>(req); const v = getV(versionId);
        if (!v || !isProfile(profile)) return send(res, 400, { error: 'bad version or profile' });
        if (profile === 'final') {
          const t = takeTicket(ticket, 'final');
          if (!t || t.versionId !== versionId) return send(res, 403, { error: 'final render needs a fresh approval for this exact scene' });
          if (!liveV(versionId)) return send(res, 409, { error: 'discarded versions cannot be rendered at final quality' });
          audit('final_approved', { version: versionId, hash: t.hash });
        }
        const job = newJob('render', versionId); step(job, `vork render ${PROFILES[profile]}`);
        renderVersion(job, v, profile).then((r) => {
          if (job.status === 'cancelled') return;
          if (r.ok) { step(job, 'Done', 'done'); job.status = 'done'; job.result = r.info; if (profile === 'final') audit('final_rendered', { version: versionId, seconds: r.info.seconds }); }
          else { job.status = 'failed'; job.error = r.timedOut ? `timed out after ${LIMITS[profile] / 1000}s` : `vork exited ${r.code}`; step(job, job.error, 'failed', r.log); }
        }).catch((e) => failJob(job, e));
        return send(res, 202, publicJob(job));
      }

      if (req.method === 'POST' && url.pathname === '/api/final/plan') {
        const { versionId } = await readBody<{ versionId: string }>(req); const v = getV(versionId); if (!v) return send(res, 400, { error: 'bad version' });
        const scene = sceneOf(versionId); const pol = policyCheck(scene);
        if (pol.blockers.length) return send(res, 409, { error: `scene violates policy: ${pol.blockers.join('; ')}` });
        if (!liveV(versionId)) return send(res, 409, { error: 'discarded versions cannot be rendered at final quality' });
        const hash = hashScene(versionId); const ticket = issueTicket({ kind: 'final', versionId, hash });
        const d = v.renders.draft;
        return send(res, 200, {
          ticket, hash, versionId, profile: PROFILES.final, resolution: scene.render?.resolution || [1920, 1080],
          output: path.relative(PROJECT || ROOT, path.join(vdir(versionId), 'final.png')), overwrites: Boolean(v.renders.final), timeoutSec: LIMITS.final / 1000,
          reference: d ? `draft took ${d.seconds.toFixed(1)}s at ${d.settings.samples} samples` : 'no draft measured yet',
          flags: pol.flags, expiresInSec: 600,
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/propose') {
        if (MODE === 'ade') return send(res, 409, { error: 'ADE mode: proposals come from your ADE agent via MCP. Send feedback instead.' });
        const body = await readBody<{ baseId: string; instruction?: unknown; selection?: unknown; context?: unknown }>(req);
        if (!getV(body.baseId) || typeof body.instruction !== 'string' || !body.instruction.trim()) return send(res, 400, { error: 'need baseId and instruction' });
        if (!liveV(body.baseId)) return send(res, 400, { error: 'discarded versions cannot be the base of a proposal' });
        // Same rule as /api/feedback: keep only string selections. Context flags are read as booleans.
        const selection = (Array.isArray(body.selection) ? body.selection : []).filter((x): x is string => typeof x === 'string').slice(0, 50);
        const ctx = isPlainObject(body.context) ? body.context : {};
        const context = { selection: ctx.selection === true, exposure: ctx.exposure === true, history: ctx.history === true };
        const job = newJob('propose', body.baseId);
        propose(job, { baseId: body.baseId, instruction: body.instruction.trim(), selection, context })
          .then((r) => { if (job.status === 'cancelled') return; job.status = r && ['proposal', 'question'].includes(r.kind) ? 'done' : 'failed'; job.result = r; if (job.status === 'failed') job.error = r?.kind || 'failed'; })
          .catch((e) => { if (job.status === 'cancelled') return; job.status = 'failed'; job.error = String(e.message || e); step(job, 'Agent call failed', 'failed', job.error); audit('agent_error', { error: job.error }); });
        return send(res, 202, publicJob(job));
      }

      if (req.method === 'POST' && url.pathname === '/api/feedback') {
        const { versionId, selection, comment } = await readBody<{ versionId: string; selection?: unknown; comment?: unknown }>(req); const v = getV(versionId);
        if (!v || typeof comment !== 'string' || !comment.trim()) return send(res, 400, { error: 'need versionId and a comment' });
        const sel = (Array.isArray(selection) ? selection : []).filter((s) => typeof s === 'string').slice(0, 50);
        pushEvent({ type: 'feedback', version: v.id, versionStatus: v.status, selection: sel, comment: comment.trim().slice(0, 4000) });
        audit('feedback', { version: v.id, selection: sel.length });
        return send(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/api/decide') {
        const { versionId, decision, comment } = await readBody<{ versionId: string; decision: string; comment?: unknown }>(req); const v = getV(versionId);
        if (!v || v.status !== 'proposed' || !['accept', 'discard'].includes(decision)) return send(res, 400, { error: 'only proposed versions can be decided' });
        if (decision === 'discard' && adoptingVersion(v.id)) return send(res, 409, { error: 'this version is being adopted; cancel the adoption job first' });
        v.status = decision === 'accept' ? 'accepted' : 'discarded'; if (decision === 'accept') state.head = v.id;
        audit(decision, { version: v.id });
        pushEvent({ type: 'decision', version: v.id, decision, head: state.head, comment: typeof comment === 'string' ? comment.slice(0, 4000) : null });
        if (decision === 'discard') rejectRequestsOfDiscarded();
        return send(res, 200, { ok: true, head: state.head });
      }

      if (req.method === 'POST' && url.pathname === '/api/checkout') {
        const { versionId } = await readBody<{ versionId: string }>(req); const v = getV(versionId);
        if (!v || v.status !== 'accepted') return send(res, 400, { error: 'only accepted versions can become head' });
        state.head = v.id; audit('checkout', { version: v.id }); pushEvent({ type: 'checkout', head: v.id });
        return send(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/api/adopt/plan') {
        const { requestId, slug: slugOverride } = await readBody<{ requestId: string; slug?: unknown }>(req);
        if (adoptionJobs.has(requestId)) return send(res, 409, { error: ADOPTION_RUNNING });
        const ar = state.adoptionRequests.find((a) => a.id === requestId && a.status === 'pending');
        if (!ar) return send(res, 400, { error: 'no pending adoption request with that id' });
        const v = liveV(ar.version); if (!v) return send(res, 409, { error: 'version is gone or discarded' });
        let t;
        try { t = adoptionTargets(slugOverride || ar.slug); } catch (e: any) { return send(res, 400, { error: e.message }); }
        const pol = policyCheck(sceneOf(v.id)); if (pol.blockers.length) return send(res, 409, { error: pol.blockers.join('; ') });
        const sceneText = fs.readFileSync(path.join(vdir(v.id), 'scene.json'), 'utf8');
        const hash = sha256(sceneText).slice(0, 16);
        const overwrites = fs.existsSync(t.asset);
        const reusable = finalMatches(v, hash); const { slug } = t;
        const ticket = issueTicket({ kind: 'adopt', versionId: v.id, hash, requestId, slug, sceneText, assetRel: t.assetRel, overwrites });
        return send(res, 200, {
          ticket, requestId, versionId: v.id, versionStatus: v.status, hash, slug, reason: ar.reason,
          writes: [t.assetRel, t.manifestRel], overwrites, needsFinalRender: !reusable,
          acceptsProposal: v.status === 'proposed', expiresInSec: 600,
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/adopt/reject') {
        const { requestId, comment } = await readBody<{ requestId: string; comment?: unknown }>(req);
        if (adoptionJobs.has(requestId)) return send(res, 409, { error: ADOPTION_RUNNING });
        const ar = state.adoptionRequests.find((a) => a.id === requestId && a.status === 'pending');
        if (!ar) return send(res, 400, { error: 'no pending adoption request with that id' });
        ar.status = 'rejected'; audit('adoption_rejected', { request: ar.id, version: ar.version });
        pushEvent({ type: 'adoption_rejected', request: ar.id, version: ar.version, comment: typeof comment === 'string' ? comment.slice(0, 4000) : null });
        return send(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/api/adopt') {
        const { ticket } = await readBody<{ ticket: string }>(req);
        const t = takeTicket(ticket, 'adopt');
        if (!t) return send(res, 403, { error: 'adoption needs a fresh approval for this exact scene' });
        // Version first: discarding it also rejects the request (#27), and this reason says why.
        const v = liveV(t.versionId);
        if (!v) return send(res, 409, { error: 'the version was discarded after approval; nothing was written' });
        const ar = state.adoptionRequests.find((a) => a.id === t.requestId);
        if (!ar || ar.status !== 'pending' || adoptionJobs.has(ar.id)) return send(res, 409, { error: 'request is no longer pending' });
        const job = newJob('adopt', v.id);
        adoptionJobs.set(ar.id, job);
        (async () => {
          try {
            // Render exactly the approved scene text unless an untouched final of that scene already exists.
            if (!finalMatches(v, t.hash)) {
              step(job, 'vork render std/final (approved scene)');
              const r = await renderVersion(job, v, 'final', { pinnedText: t.sceneText }); if (job.status === 'cancelled') return;
              if (!r.ok) throw new Error(`final render failed: ${r.log?.slice(-400)}`);
              audit('final_rendered', { version: v.id, seconds: r.info.seconds });
            }
            step(job, 'Writing into the project');
            // Check again right before writing: the request is still ours and pending, the version not discarded.
            if (job.status !== 'running' || adoptionJobs.get(ar.id) !== job || ar.status !== 'pending' || !liveV(v.id)) throw new Error('the request or the version changed since approval; nothing was written');
            const targets = adoptionTargets(t.slug); // re-resolve right before writing
            if (targets.assetRel !== t.assetRel) throw new Error(`asset path changed since approval (${t.assetRel} → ${targets.assetRel}); plan again`);
            if (fs.existsSync(targets.asset) !== t.overwrites) throw new Error('the target file appeared or disappeared since approval; plan again');
            const png = fs.readFileSync(v.renders.final!.file);
            if (sha256(png) !== v.renders.final!.sha256) throw new Error('final.png changed after rendering; plan again');
            fs.mkdirSync(path.dirname(targets.asset), { recursive: true }); fs.mkdirSync(path.dirname(targets.manifest), { recursive: true });
            const overwrote = fs.existsSync(targets.asset);
            fs.writeFileSync(targets.asset, png);
            const pngSha = sha256(png);
            const manifest = {
              slug: t.slug, asset: targets.assetRel, sha256: pngSha, version: v.id, sceneHash: t.hash, vork: VORK_VERSION, profile: PROFILES.final,
              resolution: [v.renders.final!.width, v.renders.final!.height], reason: ar.reason, interpretation: v.proposal?.interpretation ?? v.instruction,
              adoptedAt: new Date().toISOString(), approvedVia: 'Render Director UI', scene: JSON.parse(t.sceneText),
            };
            fs.writeFileSync(targets.manifest, JSON.stringify(manifest, null, 2));
            if (v.status === 'proposed') { v.status = 'accepted'; state.head = v.id; audit('accept', { version: v.id, via: 'adoption' }); }
            ar.status = 'adopted'; save();
            audit('adopted', { request: ar.id, version: v.id, hash: t.hash, asset: targets.assetRel, sha256: pngSha, overwrote });
            pushEvent({ type: 'adopted', request: ar.id, version: v.id, slug: t.slug, asset: targets.assetRel, manifest: targets.manifestRel, sha256: pngSha });
            step(job, 'Adopted', 'done'); job.status = 'done'; job.result = { asset: targets.assetRel, manifest: targets.manifestRel, sha256: pngSha, overwrote };
          } finally { if (adoptionJobs.get(ar.id) === job) adoptionJobs.delete(ar.id); }
        })().catch((e) => failJob(job, e));
        return send(res, 202, publicJob(job));
      }

      if (req.method === 'POST' && url.pathname === '/api/preview') {
        const { versionId, profile = 'draft' } = await readBody<{ versionId: string; profile?: unknown }>(req); const v = getV(versionId);
        if (!v) return send(res, 400, { error: 'bad version' });
        if (!isProfile(profile)) return send(res, 400, { error: 'profile must be previs, draft or final' });
        const r = await pagePreview(v, profile);
        if (r.ok) { v.pagePreviews = { ...(v.pagePreviews || {}), [profile]: r }; save(); }
        return send(res, 200, r);
      }

      // Direct manipulation: human edits produce a version without the model.
      if (req.method === 'POST' && url.pathname === '/api/edit') {
        const { baseId, node, field, value } = await readBody<{ baseId: string; node: string; field: string; value: unknown }>(req);
        const baseV = getV(baseId);
        if (!baseV || baseV.status !== 'accepted') return send(res, 400, { error: 'direct edits start from an accepted version' });
        const scene = sceneOf(baseId); const refused = applyDirectEdit(scene, node, field, value);
        if (refused) return send(res, 400, { error: refused });
        const pol = policyCheck(scene); if (pol.blockers.length) return send(res, 409, { error: pol.blockers.join('; ') });
        const v = addVersion({ parent: baseId, scene, origin: 'human', instruction: `${node}.${field} = ${JSON.stringify(value)}`, status: 'accepted' });
        audit('direct_edit', { version: v.id, node, field });
        pushEvent({ type: 'direct_edit', version: v.id, parent: baseId, node, field, value, head: state.head });
        const job = newJob('render', v.id); step(job, 'vork render std/draft');
        renderVersion(job, v, 'draft').then(async (r) => {
          if (r.ok && job.status !== 'cancelled') await renderVersion(job, v, 'previs');
          if (job.status === 'cancelled') return;
          job.status = r.ok ? 'done' : 'failed'; job.result = r.info; step(job, r.ok ? 'Done' : 'Render failed', r.ok ? 'done' : 'failed', r.log);
        }).catch((e) => failJob(job, e));
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
