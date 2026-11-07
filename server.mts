// vork Director — a review surface for renders made with vork.
// Standalone mode: `node server.mts` (built-in proposer via `claude -p`).
// ADE mode:        `node server.mts --project <dir>` (your ADE agent proposes through mcp.mts; you review and adopt here).
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';

// ---------- types (erased at runtime) ----------
type Profile = 'previs' | 'draft' | 'final';
interface Material { inputs?: Record<string, unknown>; [k: string]: unknown }
interface SceneNode { type?: string; name?: string; materials?: Material[]; [k: string]: unknown }
// vork scene (API v2). Untrusted input is typed as Scene at the JSON boundary; policyCheck still guards the shape.
interface Scene {
  version: number; nodes: SceneNode[]; programs?: Record<string, unknown>;
  render?: { resolution?: number[]; background?: number[]; [k: string]: unknown }; [k: string]: unknown;
}
interface PolicyFlag { level: string; msg: string }
interface PolicyResult { blockers: string[]; flags: PolicyFlag[] }
interface DiffEntry { node: string; path: string; before: unknown; after: unknown }
interface AuditEvent { t: string; event: string; [k: string]: unknown }
interface AuditReport {
  proposals: number; feedbackRounds: number; discards: number;
  adoptionRequests: number; adoptions: number; adoptionRejections: number;
  minutesFirstProposalToAdoption: number | null;
}
interface Config { assetDir: string; pageUrl: string | null; assetUrlPattern: string | null }
interface Exposure { mean: number; clipped: number; near_black: number }
// `<out>.meta.json` written by vork render
interface VorkMeta { object_ids: unknown; exposure: Exposure; denoiser: unknown; settings: { integrator: unknown; samples: number } }
interface RenderInfo {
  profile: Profile; seconds: number; width: number; height: number; image: string; ids: string;
  file: string; sha256: string; sceneHash: string | null; objects: unknown; exposure: Exposure;
  settings: { integrator: unknown; samples: number; denoiser: unknown }; warnings: string[];
}
type RenderResult =
  | { ok: true; info: RenderInfo; cancelled?: undefined; code?: undefined; timedOut?: undefined; log?: undefined }
  | { ok: false; cancelled: true; info?: undefined; code?: undefined; timedOut?: undefined; log?: undefined }
  | { ok: false; cancelled?: undefined; info?: undefined; code?: number | null; timedOut?: boolean; log: string; seconds?: number };
type ValidateResult =
  | { ok: true; kind?: undefined; policy: PolicyResult; log?: undefined }
  | { ok: false; kind: 'blocked'; policy: PolicyResult; log?: undefined }
  | { ok: false; kind: 'invalid'; policy: PolicyResult; log: string }
  | { ok: false; kind: 'cancelled'; policy?: undefined; log?: undefined };
interface ClaimedChange { node: string; what: string; why: string }
// Structured output of the built-in proposer (PROPOSAL_SCHEMA)
interface AgentOutput { interpretation: string; assumptions: string[]; clarifying_question: string | null; claimed_changes: ClaimedChange[]; scene: Scene }
interface Proposal {
  interpretation: string; assumptions: string[]; claimed_changes: ClaimedChange[]; policy: PolicyResult; context: string[];
  via: 'built-in' | 'mcp'; cost?: number; clarifying_question?: string | null; scene?: undefined; respondsTo?: unknown;
}
type VersionStatus = 'proposed' | 'accepted' | 'discarded';
interface PagePreviewOk { ok: true; matched: number; image: string; warning: string | null }
type PagePreviewResult = { ok: false; reason: string } | PagePreviewOk;
interface Version {
  id: string; parent: string | null; origin: 'starter' | 'agent' | 'human'; instruction: string | null; proposal: Proposal | null;
  status: VersionStatus; created: string; renders: Partial<Record<Profile, RenderInfo>>; pagePreviews?: Record<string, PagePreviewOk>;
}
interface AdoptionRequest { id: string; version: string; slug: string; reason: string; status: 'pending' | 'rejected' | 'adopted'; t: string }
// Events the agent reads with wait_for_feedback
type AgentEventBody =
  | { type: 'feedback'; version: string; versionStatus: VersionStatus; selection: string[]; comment: string }
  | { type: 'decision'; version: string; decision: string; head: string | null; comment: string | null }
  | { type: 'checkout'; head: string }
  | { type: 'adoption_rejected'; request: string; version: string; comment: string | null }
  | { type: 'adopted'; request: string; version: string; slug: string; asset: string; manifest: string; sha256: string }
  | { type: 'direct_edit'; version: string; parent: string; node: string; field: string; value: unknown; head: string | null };
type AgentEvent = AgentEventBody & { seq: number; t: string };
interface DirectorState {
  versions: Version[]; head: string | null; audit: AuditEvent[]; events: AgentEvent[]; agentCursor: number; adoptionRequests: AdoptionRequest[];
}
interface JobStep { label: string; status: 'running' | 'done' | 'failed'; detail: string | null | undefined; t: number }
interface Job {
  id: string; kind: string; versionId: string; status: 'running' | 'done' | 'failed' | 'cancelled'; steps: JobStep[];
  started: number; result: unknown; error: string | null; child: ChildProcess | null;
}
interface RunResult { code: number | null; signal?: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }
type TicketData =
  | { kind: 'final'; versionId: string; hash: string }
  | { kind: 'adopt'; versionId: string; hash: string; requestId: string; slug: string; sceneText: string; assetRel: string; overwrites: boolean };
type Ticket = TicketData & { expires: number };

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const LIMITS = { previs: 60_000, draft: 120_000, final: 900_000, agent: 180_000, page: 45_000 };
const PROFILES: Record<Profile, string> = { previs: 'std/previs', draft: 'std/draft', final: 'std/final' };
const MAX_W = 1920, MAX_H = 1080;
const SAFE_FILE_EXT = /\.(glb|png|jpe?g|hdr|exr|tiff?)$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEFAULT_CONFIG: Config = { assetDir: 'public/vork', pageUrl: null, assetUrlPattern: null };

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

// ---------- pure helpers (no state; used by tests) ----------

/** A client error whose message is safe to return as a 400 response. */
class BadRequest extends Error {}
const isPlainObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isClaimedChange = (x: unknown): x is ClaimedChange => isPlainObject(x) && typeof x.node === 'string' && typeof x.what === 'string' && typeof x.why === 'string';

const sha256 = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

// Policy enforced outside the model. Everything an agent proposes passes through here before vork sees it.
export function policyCheck(scene: Scene | null | undefined): PolicyResult {
  const blockers: string[] = []; const flags: PolicyFlag[] = [];
  if (!scene || typeof scene !== 'object' || scene.version !== 2 || !Array.isArray(scene.nodes)) {
    blockers.push('scene must be an object with version 2 and a nodes array');
    return { blockers, flags };
  }
  const walk = (val: unknown, p: string): void => {
    if (Array.isArray(val)) return val.forEach((x, i) => walk(x, `${p}[${i}]`));
    if (val && typeof val === 'object') {
      for (const [k, x] of Object.entries(val)) {
        if (k === 'file') {
          if (typeof x !== 'string' || path.isAbsolute(x) || x.split(/[\\/]/).includes('..') || /^[a-z]+:/i.test(x))
            blockers.push(`${p}.file ${JSON.stringify(x)}: only relative files inside the project folder are allowed`);
          else if (!SAFE_FILE_EXT.test(x))
            blockers.push(`${p}.file "${x}": only ${SAFE_FILE_EXT.source} files (no .gltf: external buffer URIs are not checked)`);
          else flags.push({ level: 'R2', msg: `${p}.file references "${x}" (must exist locally; no downloads)` });
        }
        if (k === 'source' || k === 'code' || k === 'slang') blockers.push(`${p}.${k}: custom shader code is not allowed in this prototype`);
        if (k === 'resolution') {
          const ok = Array.isArray(x) && x.length === 2 && x.every(Number.isInteger) && x[0] >= 1 && x[1] >= 1 && x[0] <= MAX_W && x[1] <= MAX_H;
          if (!ok) blockers.push(`${p}.resolution ${JSON.stringify(x)}: must be [w,h] integers within ${MAX_W}x${MAX_H}`);
        }
        walk(x, `${p}.${k}`);
      }
    }
  };
  walk(scene, 'scene');
  if (scene.programs && Object.keys(scene.programs).length) blockers.push('custom programs are not allowed in this prototype');
  const names = scene.nodes.map((n) => n.name).filter(Boolean);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) blockers.push(`duplicate node names: ${[...new Set(dup)].join(', ')}`);
  return { blockers, flags };
}

// Diff computed from data, not from the model's description.
export function diffScenes(a: Scene, b: Scene): DiffEntry[] {
  const out: DiffEntry[] = [];
  const byName = (s: Scene) => Object.fromEntries((s.nodes || []).map((n, i) => [n.name || `#${i}`, n]));
  const A = byName(a), B = byName(b);
  const rec = (x: unknown, y: unknown, p: string, node: string): void => {
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    const isObj = (v: any): v is Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v);
    const numArr = (v: unknown) => Array.isArray(v) && v.every((n) => typeof n === 'number');
    if (isObj(x) && isObj(y)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) rec(x[k], y[k], p ? `${p}.${k}` : k, node);
    } else if (Array.isArray(x) && Array.isArray(y) && !numArr(x) && x.length === y.length) {
      x.forEach((_, i) => rec(x[i], y[i], `${p}[${i}]`, node));
    } else out.push({ node, path: p, before: x, after: y });
  };
  for (const n of new Set([...Object.keys(A), ...Object.keys(B)])) {
    if (!A[n]) out.push({ node: n, path: '(node)', before: undefined, after: 'added' });
    else if (!B[n]) out.push({ node: n, path: '(node)', before: 'present', after: 'removed' });
    else rec(A[n], B[n], '', n);
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === 'nodes') continue;
    rec(a[k], b[k], k, '(scene)');
  }
  return out;
}

// Resolve a project-relative path for writing. Rejects absolute paths, '..', and anything whose
// nearest existing ancestor (after resolving symlinks) or the target itself escapes the project.
export function resolveInside(projectDir: string, rel: unknown): string {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || /^[a-z]+:/i.test(rel))
    throw new Error(`path ${JSON.stringify(rel)} must be relative and stay inside the project`);
  const root = fs.realpathSync(projectDir);
  const target = path.resolve(root, rel);
  let probe = target;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`path ${JSON.stringify(rel)} resolves outside the project`);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error(`path ${JSON.stringify(rel)} is a symlink`);
  return target;
}

// Measurements for the experiment: read an audit log, no vork needed.
export function reportFromAudit(auditLog: AuditEvent[]): AuditReport {
  const at = (e: string) => auditLog.find((a) => a.event === e)?.t;
  const count = (e: string) => auditLog.filter((a) => a.event === e).length;
  const firstProposal = at('proposed'), firstAdoption = at('adopted');
  return {
    proposals: count('proposed'), feedbackRounds: count('feedback'), discards: count('discard'),
    adoptionRequests: count('adoption_requested'), adoptions: count('adopted'), adoptionRejections: count('adoption_rejected'),
    minutesFirstProposalToAdoption: firstProposal && firstAdoption ? +((Date.parse(firstAdoption) - Date.parse(firstProposal)) / 60000).toFixed(1) : null,
  };
}

// 16-bit grayscale PNG decode (object_index channel)
function decodeGray16(buf: Buffer): { w: number; h: number; data: Buffer } {
  let off = 8, w = 0, h = 0, depth = 0, ctype = 0; const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  if (depth !== 16 || ctype !== 0) throw new Error(`unexpected object_index PNG format depth=${depth} type=${ctype}`);
  const raw = zlib.inflateSync(Buffer.concat(idat)); const bpp = 2, stride = w * bpp;
  const out = Buffer.alloc(w * h * 2); let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)]; const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = v & 255;
    }
    for (let x = 0; x < w; x++) out.writeUInt16LE(line.readUInt16BE(x * 2), (y * w + x) * 2);
    prev = line;
  }
  return { w, h, data: out };
}

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
    ['duplicate names blocked', { ...base, nodes: [...base.nodes, { type: 'mesh', name: 'vase', geometry: { std: 'box' } }] }, (r) => r.blockers.some((b) => b.includes('duplicate'))],
    ['wrong version blocked', { ...base, version: 1 }, (r) => r.blockers.length === 1],
  ];
  let fail = 0;
  for (const [name, scene, ok] of cases) { const r = policyCheck(scene); const pass = ok(r); fail += !pass as unknown as number; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`, pass ? '' : JSON.stringify(r)); }
  const mod = structuredClone(base); mod.nodes[1].materials![0].inputs!.base_color = [0.1, 0.1, 0.1]; mod.render!.background = [0, 0, 0];
  const d = diffScenes(base, mod);
  const dpass = d.length === 2 && d.some((x) => x.node === 'vase' && x.path === 'materials[0].inputs.base_color') && d.some((x) => x.node === '(scene)' && x.path === 'render.background');
  fail += !dpass as unknown as number; console.log(`${dpass ? 'PASS' : 'FAIL'} diff finds exactly the two edits`, dpass ? '' : JSON.stringify(d));
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
if (process.env.VORK_DIRECTOR_IMPORT) { /* imported by tests for the pure helpers only */ } else { await main(); }

// ---------- server ----------
async function main() {
  const PROJECT = arg('--project') ? fs.realpathSync(path.resolve(arg('--project')!)) : null;
  const MODE = PROJECT ? 'ade' : 'standalone';
  const RUNS = PROJECT ? path.join(PROJECT, '.vork') : path.resolve(process.env.VORK_DIRECTOR_RUNS || path.join(ROOT, 'runs'));
  const MODEL = process.env.DIRECTOR_MODEL || 'sonnet';
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

  let VORK_HELP = '';
  try { VORK_HELP = execFileSync('vork', ['help'], { encoding: 'utf8' }); }
  catch { console.error('vork not found on PATH. Install it first: https://github.com/voyager-so/vork'); process.exit(1); }
  const VORK_VERSION = execFileSync('vork', ['--version'], { encoding: 'utf8' }).trim();

  // project config
  const CONFIG_FILE = path.join(RUNS, 'config.json');
  // Re-read on every use so edits to .vork/config.json apply without a restart.
  const readConfig = (): Config => {
    if (!PROJECT || !fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
    try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
    catch (e: any) { console.error(`ignoring invalid ${CONFIG_FILE}: ${e.message}`); return { ...DEFAULT_CONFIG }; }
  };
  if (PROJECT) {
    if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
    if (!fs.existsSync(path.join(RUNS, '.gitignore'))) fs.writeFileSync(path.join(RUNS, '.gitignore'), '*\n!.gitignore\n!config.json\n!adopted/\n!adopted/**\n');
  }

  // ---------- state ----------
  const STATE_FILE = path.join(RUNS, 'state.json');
  const state: DirectorState = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {} as DirectorState;
  state.versions ||= []; state.head ??= null; state.audit ||= []; state.events ||= []; state.agentCursor ||= 0; state.adoptionRequests ||= [];
  const save = () => { fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2)); fs.renameSync(STATE_FILE + '.tmp', STATE_FILE); };
  const audit = (event: string, data: Record<string, unknown> = {}) => { state.audit.push({ t: new Date().toISOString(), event, ...data }); save(); };
  const getV = (id: string | null | undefined): Version | undefined => state.versions.find((v) => v.id === id);
  const vdir = (id: string) => path.join(RUNS, id);
  const sceneOf = (id: string): Scene => JSON.parse(fs.readFileSync(path.join(vdir(id), 'scene.json'), 'utf8'));
  const hashScene = (id: string) => sha256(fs.readFileSync(path.join(vdir(id), 'scene.json'))).slice(0, 16);

  // Events the agent can read with wait_for_feedback. Waiters are resolved when a new event arrives.
  const waiters = new Set<() => void>();
  const pushEvent = (ev: AgentEventBody) => {
    state.events.push({ seq: state.events.length + 1, t: new Date().toISOString(), ...ev }); save();
    for (const w of waiters) w();
  };

  function addVersion({ parent, scene, origin, instruction = null, proposal = null, status }: {
    parent: string | null; scene: unknown; origin: Version['origin']; instruction?: string | null; proposal?: Proposal | null; status: VersionStatus;
  }): Version {
    const id = `v${String(state.versions.length + 1).padStart(3, '0')}`;
    fs.mkdirSync(vdir(id), { recursive: true });
    fs.writeFileSync(path.join(vdir(id), 'scene.json'), JSON.stringify(scene, null, 2));
    const v: Version = { id, parent, origin, instruction, proposal, status, created: new Date().toISOString(), renders: {} };
    state.versions.push(v);
    if (status === 'accepted') state.head = id;
    save();
    return v;
  }

  if (!state.versions.length) {
    const scene = JSON.parse(fs.readFileSync(path.join(ROOT, 'scenes', 'starter.json'), 'utf8'));
    addVersion({ parent: null, scene, origin: 'starter', status: 'accepted' });
    audit('init', { head: state.head, mode: MODE });
  }

  // ---------- jobs (cancellable, observable steps) ----------
  const jobs = new Map<string, Job>();
  const newJob = (kind: string, versionId: string) => {
    const job: Job = { id: crypto.randomUUID(), kind, versionId, status: 'running', steps: [], started: Date.now(), result: null, error: null, child: null };
    jobs.set(job.id, job); return job;
  };
  const step = (job: Job, label: string, status: JobStep['status'] = 'running', detail: string | null | undefined = null) => {
    const prev = job.steps.at(-1); if (prev && prev.status === 'running') prev.status = 'done';
    job.steps.push({ label, status, detail, t: Date.now() - job.started });
  };
  const failJob = (job: Job, e: Partial<Error> | null | undefined) => { if (job.status === 'cancelled') return; job.status = 'failed'; job.error = String(e?.message || e); step(job, 'Failed', 'failed', job.error); };
  const publicJob = (j: Job) => ({ id: j.id, kind: j.kind, versionId: j.versionId, status: j.status, steps: j.steps, elapsed: Date.now() - j.started, result: j.result, error: j.error });

  function run(job: Job, cmd: string, args: string[], { timeout, input, cwd }: { timeout?: number; input?: string; cwd?: string } = {}): Promise<RunResult> {
    if (job.status === 'cancelled') return Promise.resolve({ code: -1, signal: null, stdout: '', stderr: 'cancelled', timedOut: false });
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      job.child = child; let stdout = '', stderr = '', timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
      child.stdout.on('data', (d) => (stdout += d)); child.stderr.on('data', (d) => (stderr += d));
      if (input) child.stdin.end(input); else child.stdin.end();
      child.on('close', (code, signal) => { clearTimeout(timer); job.child = null; resolve({ code, signal, stdout, stderr, timedOut }); });
      child.on('error', (e) => { clearTimeout(timer); job.child = null; resolve({ code: -1, stdout, stderr: String(e), timedOut }); });
    });
  }

  // Scene file references are project-relative (policy-checked). vork resolves them relative to the scene
  // file, so the rendered copy rewrites them to point from the version directory into the project.
  const ASSET_BASE = PROJECT || path.join(ROOT, 'scenes');
  function sceneForRender(scene: Scene, dir: string) {
    const walk = (x: unknown): unknown => {
      if (Array.isArray(x)) return x.map(walk);
      if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, k === 'file' && typeof val === 'string' ? path.relative(dir, path.join(ASSET_BASE, val)) : walk(val)]));
      return x;
    };
    return walk(scene);
  }

  // Renders of the same version are serialized: vork writes fixed output names per profile.
  const renderLocks = new Map<string, Promise<RenderResult>>();
  function renderVersion(job: Job, v: Version, profile: Profile, opts: { scene?: Scene; pinnedText?: string } = {}): Promise<RenderResult> {
    const prev = renderLocks.get(v.id) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => renderVersionNow(job, v, profile, opts));
    renderLocks.set(v.id, next);
    return next;
  }
  // scene: throwaway validation render (not stored). pinnedText: render exactly this scene text and store it.
  async function renderVersionNow(job: Job, v: Pick<Version, 'id' | 'renders'>, profile: Profile, { scene, pinnedText }: { scene?: Scene; pinnedText?: string } = {}): Promise<RenderResult> {
    const dir = vdir(v.id); const sceneFile = path.join(dir, scene ? 'scene.check.json' : 'scene.render.json');
    const sceneText = scene ? null : pinnedText ?? fs.readFileSync(path.join(dir, 'scene.json'), 'utf8');
    fs.writeFileSync(sceneFile, JSON.stringify(sceneForRender(scene || JSON.parse(sceneText!), dir)));
    const out = path.join(dir, `${profile}.png`);
    const args = ['render', sceneFile, '--out', out, '--profile', PROFILES[profile], '--channels', 'color,object_index'];
    const t0 = Date.now();
    const r = await run(job, 'vork', args, { timeout: LIMITS[profile], cwd: dir });
    const seconds = (Date.now() - t0) / 1000;
    if (job.status === 'cancelled') return { ok: false, cancelled: true };
    if (r.code !== 0) return { ok: false, code: r.code, timedOut: r.timedOut, log: (r.stderr + r.stdout).slice(-4000), seconds };
    const meta = JSON.parse(fs.readFileSync(`${out}.meta.json`, 'utf8')) as VorkMeta;
    const ids = decodeGray16(fs.readFileSync(path.join(dir, `${profile}.object_index.png`)));
    fs.writeFileSync(path.join(dir, `${profile}.ids.bin`), ids.data);
    const warnings = (r.stderr + r.stdout).split('\n').filter((l) => /warn/i.test(l)).slice(0, 20);
    const stamp = Date.now();
    const info: RenderInfo = {
      profile, seconds, width: ids.w, height: ids.h, image: `/runs/${v.id}/${profile}.png?${stamp}`, ids: `/runs/${v.id}/${profile}.ids.bin?${stamp}`,
      file: out, sha256: sha256(fs.readFileSync(out)),
      sceneHash: sceneText ? sha256(sceneText).slice(0, 16) : null,
      objects: meta.object_ids, exposure: meta.exposure,
      settings: { integrator: meta.settings.integrator, samples: meta.settings.samples, denoiser: meta.denoiser }, warnings,
    };
    if (!scene) { v.renders[profile] = info; save(); }
    return { ok: true, info };
  }

  // Validate a proposed scene: policy, then a previs render in a throwaway directory.
  async function validateScene(job: Job, scene: Scene | undefined): Promise<ValidateResult> {
    const pol = policyCheck(scene);
    if (pol.blockers.length) return { ok: false, kind: 'blocked', policy: pol };
    const tmp = { id: `tmp-${job.id.slice(0, 8)}`, renders: {} };
    fs.mkdirSync(vdir(tmp.id), { recursive: true });
    let check: RenderResult;
    try { check = await renderVersionNow(job, tmp, 'previs', { scene }); }
    catch (e: any) { check = { ok: false, log: String(e.message || e) }; }
    finally { fs.rmSync(vdir(tmp.id), { recursive: true, force: true }); }
    if (check.cancelled) return { ok: false, kind: 'cancelled' };
    if (!check.ok) return { ok: false, kind: 'invalid', log: check.log, policy: pol };
    return { ok: true, policy: pol };
  }

  async function createProposal(job: Job, { baseId, scene, instruction, proposal }: { baseId: string | null; scene: Scene; instruction: string; proposal: Proposal }): Promise<{ v: Version; draft: RenderResult }> {
    const v = addVersion({ parent: baseId, scene, origin: 'agent', instruction, proposal, status: 'proposed' });
    step(job, 'Rendering draft preview of the proposal');
    const draft = await renderVersion(job, v, 'draft');
    if (draft.cancelled) return { v, draft };
    if (!draft.ok) step(job, 'Draft render failed (previs is still available)', 'failed', draft.log);
    else await renderVersion(job, v, 'previs');
    audit('proposed', { version: v.id, parent: baseId, instruction, cost: proposal.cost ?? null, flags: proposal.policy.flags.length, via: proposal.via });
    return { v, draft };
  }

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
  const SYSTEM = `You are the scene assistant inside "vork Director". A human director looks at renders and asks for changes.
You edit vork scene JSON (API v2). You do NOT render; the app renders and the director judges the image.
Rules:
- Return the COMPLETE revised scene in "scene". Keep every node "name" stable; give new nodes unique names.
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
    const r = await run(job, 'claude', args, { timeout: LIMITS.agent, input: prompt, cwd: RUNS });
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
      const { v, draft } = await createProposal(job, { baseId, scene: last.scene, instruction, proposal: { ...last, scene: undefined, policy: check.policy, cost: totalCost, context: ctx, via: 'built-in' } });
      if (draft.cancelled) return;
      step(job, 'Proposal ready for review', 'done');
      return { kind: 'proposal', versionId: v.id };
    }
  }

  // ---------- approval tickets (final render, adoption) bound to an exact scene hash ----------
  const tickets = new Map<string, Ticket>();
  const issueTicket = (data: TicketData) => { const id = crypto.randomUUID(); tickets.set(id, { ...data, expires: Date.now() + 10 * 60_000 }); return id; };
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
    const assetDir = String(readConfig().assetDir || DEFAULT_CONFIG.assetDir);
    const assetRel = path.posix.join(assetDir.replace(/\\/g, '/'), `${slug}.png`);
    const manifestRel = path.posix.join('.vork', 'adopted', `${slug}.json`);
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
    const render = v.renders[profile] || v.renders.draft;
    if (!render) return { ok: false, reason: 'render the version first' };
    const browser = await chromium.launch({ executablePath: exe, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      let matched = 0; const png = fs.readFileSync(render.file);
      await page.route(config.assetUrlPattern, (route) => { matched++; route.fulfill({ status: 200, contentType: 'image/png', body: png }); });
      try { await page.goto(config.pageUrl, { waitUntil: 'networkidle', timeout: LIMITS.page }); }
      catch (e: any) { return { ok: false, reason: `could not open ${config.pageUrl}: ${String(e.message).split('\n')[0]}` }; }
      const file = path.join(vdir(v.id), `page-${render.profile}.png`);
      await page.screenshot({ path: file, fullPage: false });
      return { ok: true, matched, image: `/runs/${v.id}/page-${render.profile}.png?${Date.now()}`, warning: matched ? null : `no request matched ${config.assetUrlPattern}; the screenshot shows the page without the candidate` };
    } finally { await browser.close(); }
  }

  // ---------- http ----------
  // Human sessions: a one-time pairing token travels only server → OS browser opener → page fragment.
  // It is never written to disk or to logs, so the agent cannot read it from files. (A same-user process can
  // still find ways around this; see README "安全境界".)
  const AGENT_TOKEN = crypto.randomBytes(24).toString('hex');
  const sessions = new Set();
  let PAIR = process.env.VORK_DIRECTOR_PAIR_TOKEN || crypto.randomBytes(24).toString('hex'); // env: tests only
  let lastOpenTab = 0;
  const rotatePair = () => { PAIR = crypto.randomBytes(24).toString('hex'); };
  let PORT = Number(arg('--port') || process.env.PORT || 4747);

  const send = (res: http.ServerResponse, code: number, body: unknown, type = 'application/json', headers: Record<string, string> = {}) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...headers });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  // The type argument is not checked at run time; each endpoint still validates the fields it reads.
  const readBody = <T,>(req: http.IncomingMessage): Promise<T> => new Promise((ok, bad) => {
    let b = ''; req.on('data', (d) => { b += d; if (b.length > 4e6) req.destroy(); });
    req.on('end', () => {
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
    if (process.env.VORK_DIRECTOR_NO_OPEN === '1') return false;
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    try { spawn(opener, [link], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); return true; } catch { return false; }
  }
  const cookie = (req: http.IncomingMessage, name: string): string | undefined => (req.headers.cookie || '').split(';').map((s) => s.trim().split('=')).find(([k]) => k === name)?.[1];
  const tokenEq = (a: unknown, b: string): boolean => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

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
      const baseId = b.base || state.head; const base = getV(baseId);
      if (!base || base.status === 'discarded') return send(res, 400, { error: 'base must be an existing, not discarded version' });
      if (typeof b.interpretation !== 'string' || !b.interpretation.trim() || !Array.isArray(b.claimed_changes)) return send(res, 400, { error: 'interpretation and claimed_changes are required' });
      if (!b.claimed_changes.every(isClaimedChange)) return send(res, 400, { error: 'each claimed_changes item must be { node, what, why } with string values' });
      const job = newJob('agent-propose', baseId!);
      const check = await validateScene(job, b.scene);
      if (!check.ok) { audit('agent_proposal_rejected', { kind: check.kind, base: baseId }); return send(res, 422, { error: check.kind === 'blocked' ? 'policy' : 'vork rejected the scene', blockers: check.policy?.blockers || [], log: check.log || null, version: null }); }
      const proposal: Proposal = { interpretation: b.interpretation, assumptions: Array.isArray(b.assumptions) ? b.assumptions.map(String) : [], claimed_changes: b.claimed_changes, policy: check.policy, context: b.responds_to ? [`responds to feedback #${b.responds_to}`] : [], via: 'mcp', respondsTo: b.responds_to ?? null };
      const { v, draft } = await createProposal(job, { baseId, scene: b.scene, instruction: b.interpretation, proposal });
      return send(res, 200, { version: v.id, status: v.status, head: state.head, render: draft.ok ? renderSummary(draft.info) : null, renderError: draft.ok ? null : draft.log, diff: diffScenes(sceneOf(baseId!), b.scene), flags: check.policy.flags });
    }
    if (url.pathname === '/api/agent/render' && req.method === 'GET') {
      const v = getV(url.searchParams.get('version') || state.head); const profile = url.searchParams.get('profile') as Profile | null || 'draft';
      if (!v) return send(res, 404, { error: 'no such version' });
      if (!PROFILES[profile]) return send(res, 400, { error: 'profile must be previs, draft or final' });
      if (!v.renders[profile]) {
        if (profile === 'final') return send(res, 403, { error: 'final renders need human approval in Director' });
        const r = await renderVersion(newJob('agent-render', v.id), v, profile);
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
      const evs = pending();
      if (!evs.length) return send(res, 200, { timeout: true, waitedSec: Math.round((Date.now() - t0) / 100) / 10, events: [] });
      state.agentCursor = evs.at(-1)!.seq; save();
      return send(res, 200, { timeout: false, events: evs });
    }
    if (url.pathname === '/api/agent/adoption-request' && req.method === 'POST') {
      const b = await readBody<{ version: string; slug: unknown; reason?: unknown }>(req); const v = getV(b.version);
      if (!PROJECT) return send(res, 409, { error: 'adoption needs Director started with --project' });
      if (!v || v.status === 'discarded') return send(res, 400, { error: 'version must exist and not be discarded' });
      let slug: string;
      try { ({ slug } = adoptionTargets(b.slug)); } catch (e: any) { return send(res, 400, { error: e.message }); }
      const reqId = `a${String(state.adoptionRequests.length + 1).padStart(3, '0')}`;
      state.adoptionRequests.push({ id: reqId, version: v.id, slug, reason: String(b.reason || ''), status: 'pending', t: new Date().toISOString() });
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
          adoptionRequests: state.adoptionRequests, events: state.events.slice(-30), agentCursor: state.agentCursor,
        });

      if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
        const j = jobs.get(url.pathname.split('/').pop()!); return j ? send(res, 200, publicJob(j)) : send(res, 404, { error: 'no job' });
      }
      if (req.method === 'POST' && url.pathname.match(/^\/api\/jobs\/[^/]+\/cancel$/)) {
        const j = jobs.get(url.pathname.split('/')[3]); if (!j) return send(res, 404, { error: 'no job' });
        if (j.status === 'running') { j.status = 'cancelled'; j.child?.kill('SIGTERM'); step(j, 'Cancelled by director', 'failed'); audit('cancelled', { job: j.kind, version: j.versionId }); }
        return send(res, 200, publicJob(j));
      }

      if (req.method === 'POST' && url.pathname === '/api/render') {
        const { versionId, profile, ticket } = await readBody<{ versionId: string; profile: Profile; ticket: string }>(req); const v = getV(versionId);
        if (!v || !PROFILES[profile]) return send(res, 400, { error: 'bad version or profile' });
        if (profile === 'final') {
          const t = takeTicket(ticket, 'final');
          if (!t || t.versionId !== versionId) return send(res, 403, { error: 'final render needs a fresh approval for this exact scene' });
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
        if (v.status === 'discarded') return send(res, 409, { error: 'discarded versions cannot be rendered at final quality' });
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
        const body = await readBody<{ baseId: string; instruction?: string; selection?: string[]; context?: { selection?: boolean; exposure?: boolean; history?: boolean } }>(req);
        if (!getV(body.baseId) || !body.instruction?.trim()) return send(res, 400, { error: 'need baseId and instruction' });
        const job = newJob('propose', body.baseId);
        propose(job, { baseId: body.baseId, instruction: body.instruction.trim(), selection: body.selection || [], context: body.context || {} })
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
        v.status = decision === 'accept' ? 'accepted' : 'discarded'; if (decision === 'accept') state.head = v.id;
        audit(decision, { version: v.id });
        pushEvent({ type: 'decision', version: v.id, decision, head: state.head, comment: typeof comment === 'string' ? comment.slice(0, 4000) : null });
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
        const ar = state.adoptionRequests.find((a) => a.id === requestId && a.status === 'pending');
        if (!ar) return send(res, 400, { error: 'no pending adoption request with that id' });
        const v = getV(ar.version); if (!v || v.status === 'discarded') return send(res, 409, { error: 'version is gone or discarded' });
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
        const ar = state.adoptionRequests.find((a) => a.id === t.requestId);
        if (!ar || ar.status !== 'pending') return send(res, 409, { error: 'request is no longer pending' });
        const v = getV(t.versionId)!;
        const job = newJob('adopt', v.id);
        (async () => {
          // Render exactly the approved scene text unless an untouched final of that scene already exists.
          if (!finalMatches(v, t.hash)) {
            step(job, 'vork render std/final (approved scene)');
            const r = await renderVersion(job, v, 'final', { pinnedText: t.sceneText }); if (job.status === 'cancelled') return;
            if (!r.ok) throw new Error(`final render failed: ${r.log?.slice(-400)}`);
            audit('final_rendered', { version: v.id, seconds: r.info.seconds });
          }
          step(job, 'Writing into the project');
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
            adoptedAt: new Date().toISOString(), approvedVia: 'vork Director UI', scene: JSON.parse(t.sceneText),
          };
          fs.writeFileSync(targets.manifest, JSON.stringify(manifest, null, 2));
          if (v.status === 'proposed') { v.status = 'accepted'; state.head = v.id; audit('accept', { version: v.id, via: 'adoption' }); }
          ar.status = 'adopted'; save();
          audit('adopted', { request: ar.id, version: v.id, hash: t.hash, asset: targets.assetRel, sha256: pngSha, overwrote });
          pushEvent({ type: 'adopted', request: ar.id, version: v.id, slug: t.slug, asset: targets.assetRel, manifest: targets.manifestRel, sha256: pngSha });
          step(job, 'Adopted', 'done'); job.status = 'done'; job.result = { asset: targets.assetRel, manifest: targets.manifestRel, sha256: pngSha, overwrote };
        })().catch((e) => failJob(job, e));
        return send(res, 202, publicJob(job));
      }

      if (req.method === 'POST' && url.pathname === '/api/preview') {
        const { versionId, profile } = await readBody<{ versionId: string; profile?: Profile }>(req); const v = getV(versionId);
        if (!v) return send(res, 400, { error: 'bad version' });
        const r = await pagePreview(v, profile || 'draft');
        if (r.ok) { v.pagePreviews = { ...(v.pagePreviews || {}), [profile || 'draft']: r }; save(); }
        return send(res, 200, r);
      }

      // Direct manipulation: human edits produce a version without the model.
      if (req.method === 'POST' && url.pathname === '/api/edit') {
        const { baseId, node, field, value } = await readBody<{ baseId: string; node: string; field: string; value: unknown }>(req);
        const isRGB = (x: unknown) => Array.isArray(x) && x.length === 3 && x.every((c) => typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1);
        const num = (lo: number, hi: number) => (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
        const allowed: Record<string, ['mat' | 'light', (x: unknown) => boolean] | undefined> = { base_color: ['mat', isRGB], emission_luminance: ['mat', num(0, 1000)], specular_roughness: ['mat', num(0, 1)], energy: ['light', num(0, 100000)], color: ['light', isRGB] };
        const baseV = getV(baseId);
        if (!baseV || baseV.status !== 'accepted') return send(res, 400, { error: 'direct edits start from an accepted version' });
        if (!allowed[field] || !allowed[field][1](value)) return send(res, 400, { error: 'unsupported edit or value out of range' });
        const scene = sceneOf(baseId); const n = scene.nodes.find((x) => x.name === node);
        if (!n) return send(res, 400, { error: 'no such node' });
        if (allowed[field][0] === 'light') { if (n.type !== 'light') return send(res, 400, { error: 'not a light' }); n[field] = value; }
        else { if (n.type !== 'mesh') return send(res, 400, { error: 'not a mesh' }); n.materials ||= [{}]; n.materials[0] ||= {}; n.materials[0].inputs ||= {}; n.materials[0].inputs[field] = value; }
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
      let file;
      if (url.pathname.startsWith('/runs/')) {
        if (!/^\/runs\/v\d{3}\/(previs|draft|final|page-previs|page-draft|page-final)\.(png|ids\.bin)$/.test(url.pathname)) return send(res, 404, 'not found', 'text/plain');
        file = path.join(RUNS, url.pathname.slice(6));
      } else file = path.join(PUBLIC, decodeURIComponent(url.pathname));
      const real = path.resolve(file);
      if (!(real.startsWith(PUBLIC + path.sep) || real.startsWith(RUNS + path.sep)) || !fs.existsSync(real) || !fs.statSync(real).isFile())
        return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(real), MIME[path.extname(real)] || 'application/octet-stream');
    } catch (e: any) {
      if (e instanceof BadRequest) return send(res, 400, { error: e.message });
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
  console.log(`vork Director on http://127.0.0.1:${PORT}  mode=${MODE}${PROJECT ? `  project=${PROJECT}` : ''}  (${VORK_VERSION}${MODE === 'standalone' ? `, built-in agent: claude ${MODEL}` : ''})`);
}
