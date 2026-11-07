// Policy and domain rules of Render Director: pure functions and the types they work on. No I/O except resolveInside,
// which checks the file system so a write cannot leave the project.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------- types (erased at runtime) ----------
export type Profile = 'previs' | 'draft' | 'final';
export interface Material { inputs?: Record<string, unknown>; [k: string]: unknown }
export interface SceneNode { type?: string; name?: string; materials?: Material[]; [k: string]: unknown }
// vork scene (API v2). Untrusted input is typed as Scene at the JSON boundary; policyCheck still guards the shape.
export interface Scene {
  version: number; nodes: SceneNode[]; programs?: Record<string, unknown>;
  render?: { resolution?: number[]; background?: number[]; [k: string]: unknown }; [k: string]: unknown;
}
export interface PolicyFlag { level: string; msg: string }
export interface PolicyResult { blockers: string[]; flags: PolicyFlag[] }
export interface DiffEntry { node: string; path: string; before: unknown; after: unknown }
export interface AuditEvent { t: string; event: string; [k: string]: unknown }
export interface AuditReport {
  proposals: number; feedbackRounds: number; discards: number;
  adoptionRequests: number; adoptions: number; adoptionRejections: number;
  minutesFirstProposalToAdoption: number | null;
}
export interface Config { assetDir: string; pageUrl: string | null; assetUrlPattern: string | null }
export interface Exposure { mean: number; clipped: number; near_black: number }
/** An object of the scene as vork numbers it in the object index channel. */
export interface RenderObject { pass_index: number; name: string }
/**
 * A render as state.json keeps it. The file is <version folder>/<profile>.png and the URLs are made by the presenter
 * (http.mts), so the record holds neither a path nor a URL and survives moving the project (#42).
 */
export interface RenderInfo {
  profile: Profile; seconds: number; width: number; height: number;
  sha256: string; idsSha256?: string; sceneHash: string | null; objects: RenderObject[]; exposure: Exposure;
  settings: { integrator: unknown; samples: number; denoiser: unknown }; warnings: string[];
}
export interface ClaimedChange { node: string; what: string; why: string }
// Structured output of the built-in proposer (PROPOSAL_SCHEMA)
export interface AgentOutput { interpretation: string; assumptions: string[]; clarifying_question: string | null; claimed_changes: ClaimedChange[]; scene: Scene }
export interface Proposal {
  interpretation: string; assumptions: string[]; claimed_changes: ClaimedChange[]; policy: PolicyResult; context: string[];
  via: 'built-in' | 'mcp'; cost?: number; clarifying_question?: string | null; scene?: undefined; respondsTo?: unknown;
}
export type VersionStatus = 'proposed' | 'accepted' | 'discarded';
/** A page preview as state.json keeps it: the screenshot is <version folder>/page-<source>.png, source being the render it used. */
export interface PagePreviewOk { ok: true; matched: number; warning: string | null; sha256?: string; source: Profile }
export type PagePreviewResult = { ok: false; reason: string } | PagePreviewOk;
export interface Version {
  id: string; parent: string | null; origin: 'starter' | 'agent' | 'human'; instruction: string | null; proposal: Proposal | null;
  status: VersionStatus; created: string; renders: Partial<Record<Profile, RenderInfo>>; pagePreviews?: Record<string, PagePreviewOk>;
}
export interface AdoptionRequest { id: string; version: string; slug: string; reason: string; status: 'pending' | 'rejected' | 'adopted'; t: string }
// Events the agent reads with wait_for_feedback
export type AgentEventBody =
  | { type: 'feedback'; version: string; versionStatus: VersionStatus; selection: string[]; comment: string }
  | { type: 'decision'; version: string; decision: string; head: string | null; comment: string | null }
  | { type: 'checkout'; head: string }
  | { type: 'adoption_rejected'; request: string; version: string; comment: string | null }
  | { type: 'adopted'; request: string; version: string; slug: string; asset: string; manifest: string; sha256: string }
  | { type: 'direct_edit'; version: string; parent: string; node: string; field: string; value: unknown; head: string | null };
export type AgentEvent = AgentEventBody & { seq: number; t: string };
export interface DirectorState {
  versions: Version[]; head: string | null; audit: AuditEvent[]; events: AgentEvent[]; agentCursor: number; adoptionRequests: AdoptionRequest[];
}

export const LIMITS = { previs: 60_000, draft: 120_000, final: 900_000, agent: 180_000, page: 45_000 };
export const PROFILES: Record<Profile, string> = { previs: 'std/previs', draft: 'std/draft', final: 'std/final' };
export const MAX_W = 1920, MAX_H = 1080;
export const SAFE_FILE_EXT = /\.(glb|png|jpe?g|hdr|exr|tiff?)$/i;
export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Own keys only: a plain PROFILES[x] lookup would also accept inherited keys such as toString or constructor.
export const isProfile = (x: unknown): x is Profile => typeof x === 'string' && Object.hasOwn(PROFILES, x);
export const DEFAULT_CONFIG: Config = { assetDir: 'public/vork', pageUrl: null, assetUrlPattern: null };

// Agent text is kept in state.json (rewritten on every save) and shown to the human, so it is bounded.
export const MAX_REASON = 4000, MAX_ASSUMPTIONS = 20, MAX_ASSUMPTION = 1000, MAX_PENDING_ADOPTIONS = 20;
export const MAX_INTERPRETATION = 4000, MAX_CLAIMED = 50, MAX_CLAIMED_NODE = 200, MAX_CLAIMED_TEXT = 1000;
export const isPlainObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
export const isClaimedChange = (x: unknown): x is ClaimedChange => isPlainObject(x) && typeof x.node === 'string' && typeof x.what === 'string' && typeof x.why === 'string';

export const sha256 = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

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
  // The diff a human reviews pairs nodes by name, so every node needs its own name. '#' is reserved for diff keys.
  const names: string[] = [];
  scene.nodes.forEach((n, i) => {
    const name = isPlainObject(n) ? n.name : undefined;
    if (typeof name !== 'string' || !name) blockers.push(`scene.nodes[${i}]: every node needs a non-empty string "name"`);
    else if (name.startsWith('#')) blockers.push(`scene.nodes[${i}].name ${JSON.stringify(name)}: names starting with "#" are reserved`);
    else names.push(name);
  });
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) blockers.push(`duplicate node names: ${[...new Set(dup)].join(', ')}`);
  return { blockers, flags };
}

// Diff computed from data, not from the model's description.
export function diffScenes(a: Scene, b: Scene): DiffEntry[] {
  const out: DiffEntry[] = [];
  // A Map keyed by name: no inherited keys, and a key that is already taken never hides a node.
  const byName = (s: Scene) => {
    const m = new Map<string, unknown>();
    (Array.isArray(s.nodes) ? s.nodes : []).forEach((n, i) => {
      const name = isPlainObject(n) ? n.name : undefined;
      let key = typeof name === 'string' && name ? name : `#${i}`;
      while (m.has(key)) key += `#${i}`;
      m.set(key, n);
    });
    return m;
  };
  const A = byName(a), B = byName(b);
  const own = (o: Record<string, unknown>, k: string) => (Object.hasOwn(o, k) ? o[k] : undefined);
  const rec = (x: unknown, y: unknown, p: string, node: string): void => {
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    const numArr = (v: unknown) => Array.isArray(v) && v.every((n) => typeof n === 'number');
    if (isPlainObject(x) && isPlainObject(y)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) rec(own(x, k), own(y, k), p ? `${p}.${k}` : k, node);
    } else if (Array.isArray(x) && Array.isArray(y) && !numArr(x) && x.length === y.length) {
      x.forEach((_, i) => rec(x[i], y[i], `${p}[${i}]`, node));
    } else out.push({ node, path: p, before: x, after: y });
  };
  for (const n of new Set([...A.keys(), ...B.keys()])) {
    if (!A.has(n)) out.push({ node: n, path: '(node)', before: undefined, after: 'added' });
    else if (!B.has(n)) out.push({ node: n, path: '(node)', before: 'present', after: 'removed' });
    else rec(A.get(n), B.get(n), '', n);
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === 'nodes') continue;
    rec(own(a, k), own(b, k), k, '(scene)');
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

// Direct manipulation: the fields a human may edit without the model, and their ranges.
const isRGB = (x: unknown) => Array.isArray(x) && x.length === 3 && x.every((c) => typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1);
const num = (lo: number, hi: number) => (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
const DIRECT_EDITS: Record<string, ['mat' | 'light', (x: unknown) => boolean] | undefined> = { base_color: ['mat', isRGB], emission_luminance: ['mat', num(0, 1000)], specular_roughness: ['mat', num(0, 1)], energy: ['light', num(0, 100000)], color: ['light', isRGB] };
/** Applies one direct edit to scene in place. Returns why it is refused, or null. */
export function applyDirectEdit(scene: Scene, node: unknown, field: unknown, value: unknown): string | null {
  const spec = typeof field === 'string' && Object.hasOwn(DIRECT_EDITS, field) ? DIRECT_EDITS[field] : undefined;
  if (!spec || !spec[1](value)) return 'unsupported edit or value out of range';
  if (typeof node !== 'string' || !node) return 'node must be a node name';
  const n = scene.nodes.find((x) => x.name === node);
  if (!n) return 'no such node';
  const f = field as string;
  if (spec[0] === 'light') { if (n.type !== 'light') return 'not a light'; n[f] = value; }
  else { if (n.type !== 'mesh') return 'not a mesh'; n.materials ||= [{}]; n.materials[0] ||= {}; n.materials[0].inputs ||= {}; n.materials[0].inputs[f] = value; }
  return null;
}

// Where an adoption writes, relative to the project: the asset under assetDir and its manifest under .vork/adopted.
export const adoptionRels = (slug: string, assetDir: string) => ({
  assetRel: path.posix.join(assetDir.replace(/\\/g, '/'), `${slug}.png`), manifestRel: path.posix.join('.vork', 'adopted', `${slug}.json`),
});

// ---------- state transitions (no I/O; the caller saves) ----------
// Every change of a version's status, of HEAD and of an adoption request's status goes through these, so the rules
// hold in one place: a discarded version never becomes accepted or HEAD, HEAD is always an accepted version, and a
// request is settled once.
export const isLive = (v: Version | undefined): v is Version => v !== undefined && v.status !== 'discarded';
export const nextVersionId = (state: DirectorState) => `v${String(state.versions.length + 1).padStart(3, '0')}`;
export const nextRequestId = (state: DirectorState) => `a${String(state.adoptionRequests.length + 1).padStart(3, '0')}`;
/** Accepting a version also makes it HEAD. */
export function acceptVersion(state: DirectorState, v: Version): void {
  if (v.status === 'discarded') throw new Error(`${v.id} is discarded and cannot be accepted`);
  v.status = 'accepted'; state.head = v.id;
}
export function discardVersion(v: Version): void {
  if (v.status !== 'proposed') throw new Error(`only a proposed version can be discarded, not ${v.id} (${v.status})`);
  v.status = 'discarded';
}
export function checkoutVersion(state: DirectorState, v: Version): void {
  if (v.status !== 'accepted') throw new Error(`only an accepted version can become HEAD, not ${v.id} (${v.status})`);
  state.head = v.id;
}
export function settleRequest(ar: AdoptionRequest, status: 'rejected' | 'adopted'): void {
  if (ar.status !== 'pending') throw new Error(`adoption request ${ar.id} is already ${ar.status}`);
  ar.status = status;
}
/** Pending requests whose version is discarded (or gone), except those busy() says are being adopted. */
export const requestsOfDiscarded = (state: DirectorState, busy: (requestId: string) => boolean): AdoptionRequest[] =>
  state.adoptionRequests.filter((ar) => ar.status === 'pending' && !isLive(state.versions.find((v) => v.id === ar.version)) && !busy(ar.id));
/**
 * Fills in what a state.json from an older Director lacks, and drops what it kept that Director no longer stores:
 * the URLs and the absolute path of a render, and the URL of a page preview (its source render is read from it) (#42).
 */
export function normalizeState(raw: Partial<DirectorState>): DirectorState {
  const state = raw as DirectorState;
  state.versions ||= []; state.head ??= null; state.audit ||= []; state.events ||= []; state.agentCursor ||= 0; state.adoptionRequests ||= [];
  for (const v of state.versions) {
    for (const r of Object.values(v.renders || {})) if (r) for (const k of ['image', 'ids', 'file']) delete (r as unknown as Record<string, unknown>)[k];
    if (!v.pagePreviews) continue;
    for (const [k, p] of Object.entries(v.pagePreviews)) {
      const old = p as PagePreviewOk & { image?: unknown };
      const from = typeof old.image === 'string' ? /\/page-(previs|draft|final)\.png(\?|$)/.exec(old.image)?.[1] : undefined;
      old.source ||= from as Profile;
      delete old.image;
      if (!isProfile(old.source)) delete v.pagePreviews[k];
    }
  }
  return state;
}
