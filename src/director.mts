// Director: the use cases of Render Director over its state (versions, renders, adoption requests, agent events),
// with jobs and approval tickets. It renders through the Renderer port and knows nothing of HTTP or processes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_CONFIG, policyCheck, sha256 } from './policy.mts';
import type { Profile, Scene, PolicyResult, Config, RenderInfo, Proposal, VersionStatus, Version, AgentEventBody, DirectorState } from './policy.mts';
import type { Renderer } from './vork.mts';

export type RenderResult =
  | { ok: true; info: RenderInfo; cancelled?: undefined; code?: undefined; timedOut?: undefined; log?: undefined }
  | { ok: false; cancelled: true; info?: undefined; code?: undefined; timedOut?: undefined; log?: undefined }
  | { ok: false; cancelled?: undefined; info?: undefined; code?: number | null; timedOut?: boolean; log: string; seconds?: number };
export type ValidateResult =
  | { ok: true; kind?: undefined; policy: PolicyResult; log?: undefined }
  | { ok: false; kind: 'blocked'; policy: PolicyResult; log?: undefined }
  | { ok: false; kind: 'invalid'; policy: PolicyResult; log: string }
  | { ok: false; kind: 'cancelled'; policy?: undefined; log?: undefined };
export interface JobStep { label: string; status: 'running' | 'done' | 'failed'; detail: string | null | undefined; t: number }
export interface Job {
  id: string; kind: string; versionId: string; status: 'running' | 'done' | 'failed' | 'cancelled'; steps: JobStep[];
  started: number; result: unknown; error: string | null; ac: AbortController;
}

export interface DirectorOptions {
  /** Folder for state.json, config.json and one folder per version. */
  runs: string;
  /** The project in ADE mode; null in standalone mode. */
  project: string | null;
  renderer: Renderer;
  /** Scene of the first version when the state is new. */
  starter: Scene;
}

export type Director = ReturnType<typeof createDirector>;

export function createDirector({ runs: RUNS, project: PROJECT, renderer, starter }: DirectorOptions) {
  const MODE = PROJECT ? 'ade' : 'standalone';

  // project config
  const CONFIG_FILE = path.join(RUNS, 'config.json');
  // Re-read on every use so edits to .vork/config.json apply without a restart.
  const readConfig = (): Config => {
    if (!PROJECT || !fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
    try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
    catch (e: any) { console.error(`ignoring invalid ${CONFIG_FILE}: ${e.message}`); return { ...DEFAULT_CONFIG }; }
  };

  // ---------- state ----------
  const STATE_FILE = path.join(RUNS, 'state.json');
  const state: DirectorState = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {} as DirectorState;
  state.versions ||= []; state.head ??= null; state.audit ||= []; state.events ||= []; state.agentCursor ||= 0; state.adoptionRequests ||= [];
  const save = () => { fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2)); fs.renameSync(STATE_FILE + '.tmp', STATE_FILE); };
  const audit = (event: string, data: Record<string, unknown> = {}) => { state.audit.push({ t: new Date().toISOString(), event, ...data }); save(); };
  const getV = (id: string | null | undefined): Version | undefined => state.versions.find((v) => v.id === id);
  // A discarded version cannot be rendered at final quality, be the base of a proposal, or be adopted.
  // Check it when a request arrives, when a ticket is used, and again after every await before state changes.
  const liveV = (id: string | null | undefined): Version | undefined => { const v = getV(id); return v && v.status !== 'discarded' ? v : undefined; };
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
    addVersion({ parent: null, scene: starter, origin: 'starter', status: 'accepted' });
    audit('init', { head: state.head, mode: MODE });
  }

  // ---------- jobs (cancellable, observable steps) ----------
  // Jobs the UI polls by id. A finished job is kept JOB_TTL after its last step so the UI can read the result,
  // then dropped (#32); /api/jobs/:id then answers 404. Agent API jobs are not listed: nobody can poll them.
  const jobs = new Map<string, Job>();
  const JOB_TTL = 10 * 60_000;
  const newJob = (kind: string, versionId: string, { listed = true } = {}) => {
    const now = Date.now();
    for (const [id, j] of jobs) if (j.status !== 'running' && j.started + (j.steps.at(-1)?.t ?? 0) < now - JOB_TTL) jobs.delete(id);
    const job: Job = { id: crypto.randomUUID(), kind, versionId, status: 'running', steps: [], started: now, result: null, error: null, ac: new AbortController() };
    if (listed) jobs.set(job.id, job);
    return job;
  };
  const step = (job: Job, label: string, status: JobStep['status'] = 'running', detail: string | null | undefined = null) => {
    const prev = job.steps.at(-1); if (prev && prev.status === 'running') prev.status = 'done';
    job.steps.push({ label, status, detail, t: Date.now() - job.started });
  };
  const failJob = (job: Job, e: Partial<Error> | null | undefined) => { if (job.status === 'cancelled') return; job.status = 'failed'; job.error = String(e?.message || e); step(job, 'Failed', 'failed', job.error); };

  // Renders of the same version are serialized: vork writes fixed output names per profile.
  // renderLocks holds the last queued render of a version and is dropped when that render ends (#32).
  const renderLocks = new Map<string, Promise<RenderResult>>();
  // A stored render of a version and profile that is queued or running. A version's scene.json never changes, so a
  // second request for the same render waits for that one instead of queueing another (#28). Renders of a pinned
  // scene text (adoption) are never shared.
  const sharedRenders = new Map<string, Promise<RenderResult>>();
  function renderVersion(job: Job, v: Version, profile: Profile, opts: { scene?: Scene; pinnedText?: string } = {}): Promise<RenderResult> {
    const key = `${v.id}:${profile}`; const shareable = !opts.scene && opts.pinnedText === undefined;
    const running = shareable ? sharedRenders.get(key) : undefined;
    // If the shared render was cancelled with its own job, a caller that was not cancelled renders it itself.
    if (running) return running.then((r) => (r.cancelled && job.status !== 'cancelled' ? renderVersion(job, v, profile) : r));
    const prev = renderLocks.get(v.id) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => renderVersionNow(job, v, profile, opts));
    renderLocks.set(v.id, next);
    if (shareable) sharedRenders.set(key, next);
    next.catch(() => {}).finally(() => {
      if (renderLocks.get(v.id) === next) renderLocks.delete(v.id);
      if (sharedRenders.get(key) === next) sharedRenders.delete(key);
    });
    return next;
  }
  // scene: throwaway validation render (not stored). pinnedText: render exactly this scene text and store it.
  async function renderVersionNow(job: Job, v: Pick<Version, 'id' | 'renders'>, profile: Profile, { scene, pinnedText }: { scene?: Scene; pinnedText?: string } = {}): Promise<RenderResult> {
    const dir = vdir(v.id);
    const sceneText = scene ? null : pinnedText ?? fs.readFileSync(path.join(dir, 'scene.json'), 'utf8');
    const r = await renderer.render({ scene: scene || JSON.parse(sceneText!), dir, profile, signal: job.ac.signal });
    if (job.status === 'cancelled') return { ok: false, cancelled: true };
    if (!r.ok) return { ok: false, code: r.code, timedOut: r.timedOut, log: r.log, seconds: r.seconds };
    fs.writeFileSync(path.join(dir, `${profile}.ids.bin`), r.ids);
    const stamp = Date.now();
    const info: RenderInfo = {
      profile, seconds: r.seconds, width: r.width, height: r.height, image: `/runs/${v.id}/${profile}.png?${stamp}`, ids: `/runs/${v.id}/${profile}.ids.bin?${stamp}`,
      file: r.file, sha256: sha256(fs.readFileSync(r.file)), idsSha256: sha256(r.ids),
      sceneHash: sceneText ? sha256(sceneText).slice(0, 16) : null,
      objects: r.objects, exposure: r.exposure, settings: r.settings, warnings: r.warnings,
    };
    // A final render of a version discarded while it ran is not kept (#15).
    if (profile === 'final' && !liveV(v.id)) return { ok: false, log: `${v.id} was discarded during the render; the final render was not kept` };
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

  return {
    mode: MODE, project: PROJECT, runs: RUNS, renderer, state, readConfig, save, audit, getV, liveV, vdir, sceneOf, hashScene, waiters, pushEvent, addVersion,
    jobs, newJob, step, failJob, renderLocks, renderVersion, validateScene, createProposal,
  };
}
