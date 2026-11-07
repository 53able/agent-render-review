// Director: the use cases of Render Director over its state (versions, renders, adoption requests, agent events),
// with jobs and approval tickets. It renders through the Renderer port and knows nothing of HTTP or processes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  LIMITS, PROFILES, SLUG, DEFAULT_CONFIG, MAX_REASON, MAX_ASSUMPTIONS, MAX_ASSUMPTION, MAX_PENDING_ADOPTIONS, MAX_INTERPRETATION, MAX_CLAIMED, MAX_CLAIMED_NODE, MAX_CLAIMED_TEXT,
  isProfile, isPlainObject, isClaimedChange, sha256, renderFailure, policyCheck, resolveInside, applyDirectEdit, adoptionRels,
  isLive, nextVersionId, nextRequestId, acceptVersion, discardVersion, checkoutVersion, settleRequest, requestsOfDiscarded, normalizeState,
} from './policy.mts';
import type { Profile, Scene, PolicyResult, Config, RenderInfo, AgentOutput, Proposal, VersionStatus, Version, AgentEvent, AgentEventBody, DirectorState, PagePreviewOk } from './policy.mts';
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
/**
 * How a job ended, given to endJob. The caller has already written the job's last step, result and error.
 * err, render and refusal say why it failed (#81 logs them): the thrown value, the failed vork run, or a Refusal of
 * an awaited agent job.
 */
export type JobOutcome =
  | { status: 'done' }
  | { status: 'failed'; err?: unknown; render?: { code?: number | null; timedOut?: boolean; log?: string }; refusal?: boolean }
  | { status: 'cancelled' };

type TicketData =
  | { kind: 'final'; versionId: string; hash: string }
  | { kind: 'adopt'; versionId: string; hash: string; requestId: string; slug: string; sceneText: string; assetRel: string; overwrites: boolean; existingSha256: string | null };
type Ticket = TicketData & { expires: number };

/** The built-in proposer (standalone mode): a structured proposal for a prompt, or null when signal was aborted. */
export type Proposer = (prompt: string, signal: AbortSignal) => Promise<{ out: AgentOutput; cost: number | undefined; ms: number | undefined } | null>;

/**
 * A request a use case refuses. The message is safe to show to the caller; kind says why (http.mts maps it to a
 * status code) and extra is added to the response body.
 */
export class Refusal extends Error {
  kind: 'invalid' | 'forbidden' | 'not_found' | 'conflict' | 'unprocessable' | 'too_many' | 'failed';
  extra: Record<string, unknown>;
  constructor(kind: Refusal['kind'], message: string, extra: Record<string, unknown> = {}) { super(message); this.kind = kind; this.extra = extra; }
}

export interface DirectorOptions {
  /** Folder for state.json, config.json and one folder per version. */
  runs: string;
  /** The project in ADE mode; null in standalone mode. */
  project: string | null;
  renderer: Renderer;
  /** Scene of the first version when the state is new. */
  starter: Scene;
  /** Standalone mode only; without it /api/propose fails its job. */
  proposer?: Proposer;
  /** Milliseconds since the epoch; tests pass their own to expire jobs and tickets. */
  clock?: () => number;
}

export type Director = ReturnType<typeof createDirector>;

export function createDirector({ runs: RUNS, project: PROJECT, renderer, starter, proposer, clock = Date.now }: DirectorOptions) {
  const MODE: 'ade' | 'standalone' = PROJECT ? 'ade' : 'standalone';

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
  const state: DirectorState = normalizeState(fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {});
  const save = () => { fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2)); fs.renameSync(STATE_FILE + '.tmp', STATE_FILE); };
  const audit = (event: string, data: Record<string, unknown> = {}) => { state.audit.push({ t: new Date().toISOString(), event, ...data }); save(); };
  const getV = (id: string | null | undefined): Version | undefined => state.versions.find((v) => v.id === id);
  // A discarded version cannot be rendered at final quality, be the base of a proposal, or be adopted.
  // Check it when a request arrives, when a ticket is used, and again after every await before state changes.
  const liveV = (id: string | null | undefined): Version | undefined => { const v = getV(id); return isLive(v) ? v : undefined; };
  const vdir = (id: string) => path.join(RUNS, id);
  /** Where a stored render of a version is; state.json does not keep the path (#42). */
  const renderFile = (id: string, profile: Profile) => path.join(vdir(id), `${profile}.png`);
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
    const id = nextVersionId(state);
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
    const now = clock();
    for (const [id, j] of jobs) if (j.status !== 'running' && j.started + (j.steps.at(-1)?.t ?? 0) < now - JOB_TTL) jobs.delete(id);
    const job: Job = { id: crypto.randomUUID(), kind, versionId, status: 'running', steps: [], started: now, result: null, error: null, ac: new AbortController() };
    if (listed) jobs.set(job.id, job);
    return job;
  };
  const step = (job: Job, label: string, status: JobStep['status'] = 'running', detail: string | null | undefined = null) => {
    const prev = job.steps.at(-1); if (prev && prev.status === 'running') prev.status = 'done';
    job.steps.push({ label, status, detail, t: clock() - job.started });
  };
  // The one place a job ends (#70). cancelled is what the cancel request does; it is not called for a finished job.
  const endJob = (job: Job, outcome: JobOutcome) => {
    if (outcome.status === 'cancelled') {
      job.status = 'cancelled'; job.ac.abort(); step(job, 'Cancelled by director', 'failed'); audit('cancelled', { job: job.kind, version: job.versionId });
      for (const [rid, aj] of adoptionJobs) if (aj === job) adoptionJobs.delete(rid); // the request is pending again
      return;
    }
    job.status = outcome.status;
  };
  const failedBy = (job: Job, e: Partial<Error> | null | undefined): JobOutcome => { job.error = String(e?.message || e); step(job, 'Failed', 'failed', job.error); return { status: 'failed', err: e }; };
  const failJob = (job: Job, e: Partial<Error> | null | undefined) => { if (job.status === 'cancelled') return; endJob(job, failedBy(job, e)); };
  /**
   * Runs a job's body in the background. Once it settles, end writes the last step, result and error and says how the
   * job ended; a throw from either goes to fail (by default a 'Failed' step with the message). Neither runs for a job
   * cancelled meanwhile: cancelJob has already ended it.
   */
  function runJob<T>(job: Job, body: () => Promise<T>, end: (r: T) => JobOutcome, fail: (e: any) => JobOutcome = (e) => failedBy(job, e)) {
    body()
      .then((r) => { if (job.status === 'cancelled') return; endJob(job, end(r)); })
      .catch((e) => { if (job.status === 'cancelled') return; endJob(job, fail(e)); });
  }

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
  // A stored render is written into a fresh folder next to the version and moved in only when it is recorded, so the
  // files under the version are always the recorded ones: a failed, cancelled or discarded render leaves them as they
  // were, and /runs/ (which serves only recorded bytes, #26) never sees a half-written file.
  async function renderVersionNow(job: Job, v: Pick<Version, 'id' | 'renders'>, profile: Profile, { scene, pinnedText }: { scene?: Scene; pinnedText?: string } = {}): Promise<RenderResult> {
    const dir = vdir(v.id);
    const sceneText = scene ? null : pinnedText ?? fs.readFileSync(path.join(dir, 'scene.json'), 'utf8');
    const out = scene ? dir : fs.mkdtempSync(path.join(dir, `.render-${profile}-`));
    try {
      const r = await renderer.render({ scene: scene || JSON.parse(sceneText!), dir: out, profile, signal: job.ac.signal });
      if (job.status === 'cancelled') return { ok: false, cancelled: true };
      if (!r.ok) return { ok: false, code: r.code, timedOut: r.timedOut, log: r.log, seconds: r.seconds };
      const file = renderFile(v.id, profile);
      const info: RenderInfo = {
        profile, seconds: r.seconds, width: r.width, height: r.height, sha256: sha256(fs.readFileSync(r.file)), idsSha256: sha256(r.ids),
        sceneHash: sceneText ? sha256(sceneText).slice(0, 16) : null,
        objects: r.objects, exposure: r.exposure, settings: r.settings, warnings: r.warnings,
      };
      // A final render of a version discarded while it ran is not kept (#15).
      if (profile === 'final' && !liveV(v.id)) return { ok: false, log: `${v.id} was discarded during the render; the final render was not kept` };
      if (!scene) {
        fs.writeFileSync(path.join(out, `${profile}.ids.bin`), r.ids);
        // vork's side outputs move along with the image; renames replace the old files in place.
        for (const name of [`${profile}.png.meta.json`, `${profile}.object_index.png`, `${profile}.ids.bin`])
          if (fs.existsSync(path.join(out, name))) fs.renameSync(path.join(out, name), path.join(dir, name));
        fs.renameSync(r.file, file);
        v.renders[profile] = info; save();
      }
      return { ok: true, info };
    } finally { if (out !== dir) fs.rmSync(out, { recursive: true, force: true }); }
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
    if (!draft.ok) step(job, `Draft render failed: ${renderFailure(draft, LIMITS.draft / 1000)} (previs is still available)`, 'failed', draft.log);
    else await renderVersion(job, v, 'previs');
    audit('proposed', { version: v.id, parent: baseId, instruction, cost: proposal.cost ?? null, flags: proposal.policy.flags.length, via: proposal.via });
    return { v, draft };
  }

  // ---------- approval tickets (final render, adoption) bound to an exact scene hash ----------
  const tickets = new Map<string, Ticket>();
  const issueTicket = (data: TicketData) => {
    // A new adoption plan replaces the older ones for the same request, so two tickets cannot both adopt it.
    if (data.kind === 'adopt') for (const [id, t] of tickets) if (t.kind === 'adopt' && t.requestId === data.requestId) tickets.delete(id);
    for (const [id, t] of tickets) if (t.expires < clock()) tickets.delete(id); // unused tickets are not kept past expiry (#32)
    const id = crypto.randomUUID(); tickets.set(id, { ...data, expires: clock() + 10 * 60_000 }); return id;
  };
  // Adoption requests whose adopt job is running. Kept in memory only: a job does not survive a restart,
  // so after one the request is simply pending again. While a job runs, plan, reject and discard answer 409.
  const adoptionJobs = new Map<string, Job>();
  const adoptingVersion = (versionId: string) => [...adoptionJobs.keys()].some((rid) => state.adoptionRequests.find((a) => a.id === rid)?.version === versionId);
  const ADOPTION_RUNNING = 'an adoption of this request is running; cancel its job first';
  // A pending request for a discarded version can never be adopted: reject it so the agent learns the outcome (#27).
  // A version with a running adopt job cannot be discarded, so no job is affected.
  const rejectRequestsOfDiscarded = () => {
    for (const ar of requestsOfDiscarded(state, (id) => adoptionJobs.has(id))) {
      settleRequest(ar, 'rejected'); audit('adoption_rejected', { request: ar.id, version: ar.version, reason: 'version discarded' });
      pushEvent({ type: 'adoption_rejected', request: ar.id, version: ar.version, comment: 'version discarded' });
    }
  };
  rejectRequestsOfDiscarded(); // requests left pending by a Director from before #27
  const finalMatches = (v: Version, hash: string) => {
    const f = v.renders.final; const file = renderFile(v.id, 'final'); if (!f || f.sceneHash !== hash || !fs.existsSync(file)) return false;
    return sha256(fs.readFileSync(file)) === f.sha256;
  };
  const takeTicket = <K extends Ticket['kind']>(id: string, kind: K): Extract<Ticket, { kind: K }> | null => {
    const t = tickets.get(id);
    if (!t || t.kind !== kind || t.expires < clock() || t.hash !== hashScene(t.versionId)) return null;
    tickets.delete(id); return t as Extract<Ticket, { kind: K }>;
  };

  function adoptionTargets(slug: unknown) {
    if (!PROJECT) throw new Error('adoption needs --project');
    if (typeof slug !== 'string' || !SLUG.test(slug)) throw new Error('slug must match [a-z0-9][a-z0-9-]{0,63}');
    const { assetRel, manifestRel } = adoptionRels(slug, String(readConfig().assetDir || DEFAULT_CONFIG.assetDir));
    return { slug, assetRel, manifestRel, asset: resolveInside(PROJECT, assetRel), manifest: resolveInside(PROJECT, manifestRel) };
  }

  /**
   * Reads a file only if it is a plain file with one link, opened without following a symlink, and still the file at
   * that path after opening (the checks /runs/ uses, #19 #26). null otherwise.
   */
  function readPlainFile(file: string): { data: Buffer; mtime: string } | null {
    let fd: number;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { return null; }
    try {
      const st = fs.fstatSync(fd); const at = fs.lstatSync(file);
      if (!st.isFile() || st.nlink !== 1 || at.dev !== st.dev || at.ino !== st.ino) return null;
      return { data: fs.readFileSync(fd), mtime: st.mtime.toISOString() };
    } catch { return null; } finally { fs.closeSync(fd); }
  }

  /**
   * Writes each new file next to its target, then renames them into place: an existing file's inode, and anything
   * hard-linked to it, is never written. Temporary files left by a failure are removed.
   */
  function replaceFiles(files: [target: string, data: string | Buffer][]) {
    const tmps = files.map(([target]) => `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      files.forEach(([, data], i) => fs.writeFileSync(tmps[i], data, { flag: 'wx' }));
      files.forEach(([target], i) => fs.renameSync(tmps[i], target));
    } finally { for (const t of tmps) fs.rmSync(t, { force: true }); }
  }

  // ---------- adoption: the agent asks, the human plans and approves, a job writes into the project ----------
  function requestAdoption(b: { version: string; slug: unknown; reason?: unknown }) {
    const v = liveV(b.version);
    if (!PROJECT) throw new Refusal('conflict', 'adoption needs Director started with --project');
    if (!v) throw new Refusal('invalid', 'version must exist and not be discarded');
    if (b.reason != null && typeof b.reason !== 'string') throw new Refusal('invalid', 'reason must be a string');
    if (typeof b.reason === 'string' && b.reason.length > MAX_REASON) throw new Refusal('invalid', `reason must be at most ${MAX_REASON} characters`);
    let slug: string;
    try { ({ slug } = adoptionTargets(b.slug)); } catch (e: any) { throw new Refusal('invalid', e.message); }
    const same = state.adoptionRequests.find((a) => a.status === 'pending' && a.version === v.id && a.slug === slug);
    if (same) throw new Refusal('conflict', `request ${same.id} for ${v.id} as ${slug} is already pending; call wait_for_feedback`, { request: same.id });
    // Requests for a discarded version can no longer be adopted, so they do not count.
    if (state.adoptionRequests.filter((a) => a.status === 'pending' && liveV(a.version)).length >= MAX_PENDING_ADOPTIONS)
      throw new Refusal('too_many', `${MAX_PENDING_ADOPTIONS} adoption requests are already pending; wait for the human to decide`);
    const reqId = nextRequestId(state);
    state.adoptionRequests.push({ id: reqId, version: v.id, slug, reason: b.reason ?? '', status: 'pending', t: new Date().toISOString() });
    audit('adoption_requested', { request: reqId, version: v.id, slug });
    return reqId;
  }

  function planAdoption({ requestId, slug: slugOverride }: { requestId: string; slug?: unknown }) {
    if (adoptionJobs.has(requestId)) throw new Refusal('conflict', ADOPTION_RUNNING);
    const ar = state.adoptionRequests.find((a) => a.id === requestId && a.status === 'pending');
    if (!ar) throw new Refusal('invalid', 'no pending adoption request with that id');
    const v = liveV(ar.version); if (!v) throw new Refusal('conflict', 'version is gone or discarded');
    let t;
    try { t = adoptionTargets(slugOverride || ar.slug); } catch (e: any) { throw new Refusal('invalid', e.message); }
    const pol = policyCheck(sceneOf(v.id)); if (pol.blockers.length) throw new Refusal('conflict', pol.blockers.join('; '));
    const sceneText = fs.readFileSync(path.join(vdir(v.id), 'scene.json'), 'utf8');
    const hash = sha256(sceneText).slice(0, 16);
    const overwrites = fs.existsSync(t.asset);
    // What would be replaced, so the human can see it next to the new image (#58). Read through the same checks as
    // a /runs/ file; null when it cannot be shown (not a plain file with one link).
    const old = overwrites ? readPlainFile(t.asset) : null;
    // A file that cannot be read this way (a hard link, a FIFO, …) is neither shown nor replaced: the approval would
    // not be bound to its contents, and writing through a hard link changes the file it links to.
    if (overwrites && !old) throw new Refusal('conflict', `${t.assetRel} exists but is not a plain file with a single link; Director does not replace it`);
    // The manifest is replaced too: the same rule applies to it.
    if (fs.existsSync(t.manifest) && !readPlainFile(t.manifest)) throw new Refusal('conflict', `${t.manifestRel} exists but is not a plain file with a single link; Director does not replace it`);
    const existing = old ? { bytes: old.data.length, modified: old.mtime, viewable: true } : null;
    const reusable = finalMatches(v, hash); const { slug } = t;
    const ticket = issueTicket({ kind: 'adopt', versionId: v.id, hash, requestId, slug, sceneText, assetRel: t.assetRel, overwrites, existingSha256: old ? sha256(old.data) : null });
    return {
      ticket, requestId, versionId: v.id, versionStatus: v.status, hash, slug, reason: ar.reason,
      writes: [t.assetRel, t.manifestRel], overwrites, existing, needsFinalRender: !reusable,
      // the image the human approves: the final render that will be written, or the draft until final is rendered
      shows: (reusable ? 'final' : v.renders.draft ? 'draft' : v.renders.previs ? 'previs' : null) as Profile | null,
      acceptsProposal: v.status === 'proposed', expiresInSec: 600,
    };
  }

  /**
   * The project file an adoption plan would overwrite, as it was when the plan was made: null if the ticket is not a
   * live adoption plan, or the file is no longer a plain file with those bytes (#58). The ticket is not used up.
   */
  function existingOfPlan(ticketId: string): Buffer | null {
    const t = tickets.get(ticketId);
    if (!t || t.kind !== 'adopt' || t.expires < clock() || !t.existingSha256) return null;
    let asset: string;
    try { asset = resolveInside(PROJECT!, t.assetRel); } catch { return null; } // the path the plan was made for
    const now = readPlainFile(asset);
    return now && sha256(now.data) === t.existingSha256 ? now.data : null;
  }

  function rejectAdoption({ requestId, comment }: { requestId: string; comment?: unknown }) {
    if (adoptionJobs.has(requestId)) throw new Refusal('conflict', ADOPTION_RUNNING);
    const ar = state.adoptionRequests.find((a) => a.id === requestId && a.status === 'pending');
    if (!ar) throw new Refusal('invalid', 'no pending adoption request with that id');
    settleRequest(ar, 'rejected'); audit('adoption_rejected', { request: ar.id, version: ar.version });
    pushEvent({ type: 'adoption_rejected', request: ar.id, version: ar.version, comment: typeof comment === 'string' ? comment.slice(0, 4000) : null });
  }

  function startAdoption(ticket: string): Job {
    const t = takeTicket(ticket, 'adopt');
    if (!t) throw new Refusal('forbidden', 'adoption needs a fresh approval for this exact scene');
    // Version first: discarding it also rejects the request (#27), and this reason says why.
    const v = liveV(t.versionId);
    if (!v) throw new Refusal('conflict', 'the version was discarded after approval; nothing was written');
    const ar = state.adoptionRequests.find((a) => a.id === t.requestId);
    if (!ar || ar.status !== 'pending' || adoptionJobs.has(ar.id)) throw new Refusal('conflict', 'request is no longer pending');
    const job = newJob('adopt', v.id);
    adoptionJobs.set(ar.id, job);
    runJob(job, async () => {
      try {
        // Render exactly the approved scene text unless an untouched final of that scene already exists.
        if (!finalMatches(v, t.hash)) {
          step(job, 'vork render std/final (approved scene)');
          const r = await renderVersion(job, v, 'final', { pinnedText: t.sceneText }); if (job.status === 'cancelled') return;
          if (!r.ok) throw new Error(`final render failed: ${r.log && /device lost/i.test(r.log) ? renderFailure(r, LIMITS.final / 1000) : r.log?.slice(-400)}`);
          audit('final_rendered', { version: v.id, seconds: r.info.seconds });
        }
        step(job, 'Writing into the project');
        // Check again right before writing: the request is still ours and pending, the version not discarded.
        if (job.status !== 'running' || adoptionJobs.get(ar.id) !== job || ar.status !== 'pending' || !liveV(v.id)) throw new Error('the request or the version changed since approval; nothing was written');
        const targets = adoptionTargets(t.slug); // re-resolve right before writing
        if (targets.assetRel !== t.assetRel) throw new Error(`asset path changed since approval (${t.assetRel} → ${targets.assetRel}); plan again`);
        if (fs.existsSync(targets.asset) !== t.overwrites) throw new Error('the target file appeared or disappeared since approval; plan again');
        // The human approved replacing the file they were shown (#58); a different file there needs a new look.
        if (t.existingSha256) {
          const now = readPlainFile(targets.asset);
          if (!now || sha256(now.data) !== t.existingSha256) throw new Error('the existing file changed since approval; plan again');
        }
        const png = fs.readFileSync(renderFile(v.id, 'final'));
        if (sha256(png) !== v.renders.final!.sha256) throw new Error('final.png changed after rendering; plan again');
        fs.mkdirSync(path.dirname(targets.asset), { recursive: true }); fs.mkdirSync(path.dirname(targets.manifest), { recursive: true });
        const overwrote = fs.existsSync(targets.asset);
        if (fs.existsSync(targets.manifest) && !readPlainFile(targets.manifest)) throw new Error(`${targets.manifestRel} is no longer a plain file with a single link; nothing was written`);

        const pngSha = sha256(png);
        const manifest = {
          slug: t.slug, asset: targets.assetRel, sha256: pngSha, version: v.id, sceneHash: t.hash, vork: renderer.version, profile: PROFILES.final,
          resolution: [v.renders.final!.width, v.renders.final!.height], reason: ar.reason, interpretation: v.proposal?.interpretation ?? v.instruction,
          adoptedAt: new Date().toISOString(), approvedVia: 'Render Director UI', scene: JSON.parse(t.sceneText),
        };
        // Both new files are written before either replaces anything, so a failed write leaves the project as it was.
        replaceFiles([[targets.asset, png], [targets.manifest, JSON.stringify(manifest, null, 2)]]);
        if (v.status === 'proposed') { acceptVersion(state, v); audit('accept', { version: v.id, via: 'adoption' }); }
        settleRequest(ar, 'adopted'); save();
        audit('adopted', { request: ar.id, version: v.id, hash: t.hash, asset: targets.assetRel, sha256: pngSha, overwrote });
        pushEvent({ type: 'adopted', request: ar.id, version: v.id, slug: t.slug, asset: targets.assetRel, manifest: targets.manifestRel, sha256: pngSha });
        step(job, 'Adopted', 'done'); job.result = { asset: targets.assetRel, manifest: targets.manifestRel, sha256: pngSha, overwrote };
      } finally { if (adoptionJobs.get(ar.id) === job) adoptionJobs.delete(ar.id); }
    }, () => ({ status: 'done' }));
    return job;
  }

  // ---------- proposals: from the ADE agent (MCP), or from the built-in proposer in standalone mode ----------
  async function agentPropose(b: { base?: string; interpretation?: unknown; assumptions?: unknown; claimed_changes?: unknown; scene: Scene; responds_to?: unknown }) {
    const baseId = b.base || state.head;
    if (!liveV(baseId)) throw new Refusal('invalid', 'base must be an existing, not discarded version');
    if (typeof b.interpretation !== 'string' || !b.interpretation.trim() || !Array.isArray(b.claimed_changes)) throw new Refusal('invalid', 'interpretation and claimed_changes are required');
    if (!b.claimed_changes.every(isClaimedChange)) throw new Refusal('invalid', 'each claimed_changes item must be { node, what, why } with string values');
    // interpretation is stored three times (instruction, proposal, audit), so it is bounded like reason.
    if (b.interpretation.length > MAX_INTERPRETATION) throw new Refusal('invalid', `interpretation must be at most ${MAX_INTERPRETATION} characters`);
    if (b.claimed_changes.length > MAX_CLAIMED || b.claimed_changes.some((c) => c.node.length > MAX_CLAIMED_NODE || c.what.length > MAX_CLAIMED_TEXT || c.why.length > MAX_CLAIMED_TEXT))
      throw new Refusal('invalid', `claimed_changes: at most ${MAX_CLAIMED} items; node at most ${MAX_CLAIMED_NODE}, what and why at most ${MAX_CLAIMED_TEXT} characters`);
    // Checked before validateScene so a bad field does not cost a vork render.
    if (b.assumptions != null && !(Array.isArray(b.assumptions) && b.assumptions.every((a) => typeof a === 'string'))) throw new Refusal('invalid', 'assumptions must be an array of strings');
    if (Array.isArray(b.assumptions) && (b.assumptions.length > MAX_ASSUMPTIONS || b.assumptions.some((a: string) => a.length > MAX_ASSUMPTION))) throw new Refusal('invalid', `assumptions: at most ${MAX_ASSUMPTIONS} items of at most ${MAX_ASSUMPTION} characters`);
    if (b.responds_to != null && !Number.isInteger(b.responds_to)) throw new Refusal('invalid', 'responds_to must be an integer');
    const assumptions: string[] = (b.assumptions as string[] | null | undefined) ?? [];
    const respondsTo = (b.responds_to as number | null | undefined) ?? null;
    const job = newJob('agent-propose', baseId!, { listed: false });
    const check = await validateScene(job, b.scene);
    if (!check.ok) { audit('agent_proposal_rejected', { kind: check.kind, base: baseId }); throw new Refusal('unprocessable', check.kind === 'blocked' ? 'policy' : 'vork rejected the scene', { blockers: check.policy?.blockers || [], log: check.log || null, version: null }); }
    // The human may have discarded the base during the validation render.
    if (!liveV(baseId)) throw new Refusal('conflict', `base ${baseId} was discarded while the scene was being validated; no version was created`, { version: null });
    const proposal: Proposal = { interpretation: b.interpretation, assumptions, claimed_changes: b.claimed_changes.map(({ node, what, why }) => ({ node, what, why })), policy: check.policy, context: respondsTo != null ? [`responds to feedback #${respondsTo}`] : [], via: 'mcp', respondsTo };
    const { v, draft } = await createProposal(job, { baseId, scene: b.scene, instruction: b.interpretation, proposal });
    return { v, draft, baseId: baseId!, flags: check.policy.flags };
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
      if (!proposer) throw new Error('no built-in proposer');
      const res = await proposer(prompt, job.ac.signal); if (job.status === 'cancelled' || !res) return;
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

  function checkCanPropose() {
    if (MODE === 'ade') throw new Refusal('conflict', 'ADE mode: proposals come from your ADE agent via MCP. Send feedback instead.');
  }
  function startPropose(body: { baseId: string; instruction?: unknown; selection?: unknown; context?: unknown }): Job {
    checkCanPropose();
    if (!getV(body.baseId) || typeof body.instruction !== 'string' || !body.instruction.trim()) throw new Refusal('invalid', 'need baseId and instruction');
    if (!liveV(body.baseId)) throw new Refusal('invalid', 'discarded versions cannot be the base of a proposal');
    // Same rule as /api/feedback: keep only string selections. Context flags are read as booleans.
    const selection = (Array.isArray(body.selection) ? body.selection : []).filter((x): x is string => typeof x === 'string').slice(0, 50);
    const ctx = isPlainObject(body.context) ? body.context : {};
    const context = { selection: ctx.selection === true, exposure: ctx.exposure === true, history: ctx.history === true };
    const job = newJob('propose', body.baseId);
    const instruction = body.instruction.trim();
    runJob(job, () => propose(job, { baseId: body.baseId, instruction, selection, context }),
      (r) => { job.result = r; if (r && ['proposal', 'question'].includes(r.kind)) return { status: 'done' }; job.error = r?.kind || 'failed'; return { status: 'failed' }; },
      (e) => { job.error = String(e.message || e); step(job, 'Agent call failed', 'failed', job.error); audit('agent_error', { error: job.error }); return { status: 'failed', err: e }; });
    return job;
  }

  // ---------- review: renders, decisions and feedback from the human; renders and events for the agent ----------
  function cancelJob(id: string): Job | undefined {
    const j = jobs.get(id); if (!j) return;
    if (j.status === 'running') endJob(j, { status: 'cancelled' });
    return j;
  }

  /** Renders previs or draft for the agent if missing. final needs a human approval. */
  async function agentRender(versionId: string | null, profile: string): Promise<{ v: Version; render: RenderInfo }> {
    const v = getV(versionId || state.head);
    if (!v) throw new Refusal('not_found', 'no such version');
    if (!isProfile(profile)) throw new Refusal('invalid', 'profile must be previs, draft or final');
    if (!v.renders[profile]) {
      if (profile === 'final') throw new Refusal('forbidden', 'final renders need human approval in Director');
      const r = await renderVersion(newJob('agent-render', v.id, { listed: false }), v, profile);
      if (!r.ok) throw new Refusal('failed', `render failed: ${renderFailure(r, LIMITS[profile] / 1000)}`, { log: r.log });
    }
    return { v, render: v.renders[profile]! };
  }

  function startRender({ versionId, profile, ticket }: { versionId: string; profile: unknown; ticket: string }): Job {
    const v = getV(versionId);
    if (!v || !isProfile(profile)) throw new Refusal('invalid', 'bad version or profile');
    if (profile === 'final') {
      const t = takeTicket(ticket, 'final');
      if (!t || t.versionId !== versionId) throw new Refusal('forbidden', 'final render needs a fresh approval for this exact scene');
      if (!liveV(versionId)) throw new Refusal('conflict', 'discarded versions cannot be rendered at final quality');
      audit('final_approved', { version: versionId, hash: t.hash });
    }
    const job = newJob('render', versionId); step(job, `vork render ${PROFILES[profile]}`);
    runJob(job, () => renderVersion(job, v, profile), (r) => {
      if (r.ok) { step(job, 'Done', 'done'); job.result = r.info; if (profile === 'final') audit('final_rendered', { version: versionId, seconds: r.info.seconds }); return { status: 'done' }; }
      job.error = renderFailure(r, LIMITS[profile] / 1000); step(job, job.error, 'failed', r.log);
      return { status: 'failed', render: { code: r.code, timedOut: r.timedOut, log: r.log } };
    });
    return job;
  }

  /** Issues a ticket for a final render of the version's current scene. */
  function planFinal(versionId: string) {
    const v = getV(versionId); if (!v) throw new Refusal('invalid', 'bad version');
    const scene = sceneOf(versionId); const pol = policyCheck(scene);
    if (pol.blockers.length) throw new Refusal('conflict', `scene violates policy: ${pol.blockers.join('; ')}`);
    if (!liveV(versionId)) throw new Refusal('conflict', 'discarded versions cannot be rendered at final quality');
    const hash = hashScene(versionId); const ticket = issueTicket({ kind: 'final', versionId, hash });
    return { ticket, hash, v, scene, flags: pol.flags };
  }

  function feedback({ versionId, selection, comment }: { versionId: string; selection?: unknown; comment?: unknown }) {
    const v = getV(versionId);
    if (!v || typeof comment !== 'string' || !comment.trim()) throw new Refusal('invalid', 'need versionId and a comment');
    const sel = (Array.isArray(selection) ? selection : []).filter((s) => typeof s === 'string').slice(0, 50);
    pushEvent({ type: 'feedback', version: v.id, versionStatus: v.status, selection: sel, comment: comment.trim().slice(0, 4000) });
    audit('feedback', { version: v.id, selection: sel.length });
  }

  /** Accepts or discards a proposed version. Returns HEAD afterwards. */
  function decide({ versionId, decision, comment }: { versionId: string; decision: string; comment?: unknown }) {
    const v = getV(versionId);
    if (!v || v.status !== 'proposed' || !['accept', 'discard'].includes(decision)) throw new Refusal('invalid', 'only proposed versions can be decided');
    if (decision === 'discard' && adoptingVersion(v.id)) throw new Refusal('conflict', 'this version is being adopted; cancel the adoption job first');
    if (decision === 'accept') acceptVersion(state, v); else discardVersion(v);
    audit(decision, { version: v.id });
    pushEvent({ type: 'decision', version: v.id, decision, head: state.head, comment: typeof comment === 'string' ? comment.slice(0, 4000) : null });
    if (decision === 'discard') rejectRequestsOfDiscarded();
    return state.head;
  }

  function checkout({ versionId }: { versionId: string }) {
    const v = getV(versionId);
    if (!v || v.status !== 'accepted') throw new Refusal('invalid', 'only accepted versions can become head');
    checkoutVersion(state, v); audit('checkout', { version: v.id }); pushEvent({ type: 'checkout', head: v.id });
  }

  // Direct manipulation: human edits produce a version without the model.
  function directEdit({ baseId, node, field, value }: { baseId: string; node: string; field: string; value: unknown }): { v: Version; job: Job } {
    const baseV = getV(baseId);
    if (!baseV || baseV.status !== 'accepted') throw new Refusal('invalid', 'direct edits start from an accepted version');
    const scene = sceneOf(baseId); const refused = applyDirectEdit(scene, node, field, value);
    if (refused) throw new Refusal('invalid', refused);
    const pol = policyCheck(scene); if (pol.blockers.length) throw new Refusal('conflict', pol.blockers.join('; '));
    const v = addVersion({ parent: baseId, scene, origin: 'human', instruction: `${node}.${field} = ${JSON.stringify(value)}`, status: 'accepted' });
    audit('direct_edit', { version: v.id, node, field });
    pushEvent({ type: 'direct_edit', version: v.id, parent: baseId, node, field, value, head: state.head });
    const job = newJob('render', v.id); step(job, 'vork render std/draft');
    runJob(job, () => renderVersion(job, v, 'draft').then(async (r) => {
      if (r.ok && job.status !== 'cancelled') await renderVersion(job, v, 'previs'); // its result is not looked at
      return r;
    }), (r) => {
      job.result = r.info; if (!r.ok) job.error = renderFailure(r, LIMITS.draft / 1000);
      step(job, r.ok ? 'Done' : `Render failed: ${job.error}`, r.ok ? 'done' : 'failed', r.log);
      return r.ok ? { status: 'done' } : { status: 'failed', render: { code: r.code, timedOut: r.timedOut, log: r.log } };
    });
    return { v, job };
  }

  /** Waits for the renders of a version queued so far. */
  const rendersQueued = (id: string): Promise<unknown> => renderLocks.get(id)?.catch(() => {}) ?? Promise.resolve();
  function recordPagePreview(v: Version, profile: Profile, r: PagePreviewOk) { v.pagePreviews = { ...(v.pagePreviews || {}), [profile]: r }; save(); }

  // Agent events. Waits until an event is pending, ms pass, or signal aborts (the client went away).
  const pendingEvents = () => state.events.filter((e) => e.seq > state.agentCursor);
  function waitForEvents(ms: number, signal: AbortSignal): Promise<void> {
    if (pendingEvents().length || !(ms > 0)) return Promise.resolve();
    return new Promise<void>((resolve) => { const done = () => { waiters.delete(done); clearTimeout(t); resolve(); }; const t = setTimeout(done, ms); waiters.add(done); signal.addEventListener('abort', done); });
  }
  // Concurrent waiters are all woken by one event. Each event is delivered once only because nothing here awaits
  // between reading the pending events and moving agentCursor: keep this synchronous, no await (e.g. an async save) (#31).
  function takeEvents(): AgentEvent[] {
    const evs = pendingEvents();
    if (evs.length) { state.agentCursor = evs.at(-1)!.seq; save(); }
    return evs;
  }

  return {
    mode: MODE, project: PROJECT, runs: RUNS, renderer, state, readConfig, save, audit, getV, liveV, vdir, renderFile, sceneOf, hashScene, waiters, pushEvent, addVersion,
    jobs, tickets, newJob, step, endJob, failJob, renderLocks, renderVersion, validateScene, createProposal,
    adoptionJobs, requestAdoption, planAdoption, existingOfPlan, rejectAdoption, startAdoption, agentPropose, checkCanPropose, startPropose,
    cancelJob, agentRender, startRender, planFinal, feedback, decide, checkout, directEdit, rendersQueued, recordPagePreview, waitForEvents, takeEvents,
  };
}
