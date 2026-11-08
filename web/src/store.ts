// Page state and the actions that change it (ported from public/app.js). Components read it with useStore (a zustand
// store); everything that talks to Director lives here so components stay declarative.
import { createStore, useStore as useZustandStore, type StateCreator } from 'zustand';
import { devtools } from 'zustand/middleware';
import { api } from './lib/api.ts';
import { signature } from './lib/signature.ts';
import { applyRules, versionOf, viewedVersion } from './lib/state-rules.ts';
import type { AdoptPlan, Data, FinalPlan, Job, PagePreview, Render, Version } from './lib/types.ts';

export type MeasureView = { kind: 'render'; r: Render } | { kind: 'page'; pageUrl?: string; pv: PagePreview } | null;
/** The .errs containers next to what can fail: #err-<scope>. */
export type Scope = 'view' | 'preview' | 'adopt' | 'ask' | 'review' | 'final' | 'edit';
export type Fail = { key: number; msg: string; retry?: () => unknown; retryLabel?: string };
export type DiffBase = 'head' | 'parent';

export type State = {
  data: Data;
  viewId: string;
  profile: string;
  selection: Set<string>;
  compare: boolean;
  onPage: boolean;
  /** Per version, what its diff and wipe compare with, once the human chose (#52). */
  diffBase: Record<string, DiffBase>;
  /** Jobs this tab started, in start order; each is tied to a version (#54). */
  jobs: Map<string, Job>;
  lastResult: Job | null;
  sig: string;
  /** The proposal the fixed notice announces, while it is shown. */
  notice: string | null;
  /** Bumped whenever the viewport must be drawn again (every load, profile and compare change, page toggle). */
  drawSeq: number;
  // viewport read-outs, written by the Viewport's draw routine
  empty: string | null;
  wipe: boolean;
  measure: MeasureView;
  // ask form
  instruction: string;
  ctx: { selection: boolean; exposure: boolean; history: boolean };
  /** Failures shown next to what failed until dismissed or the same action succeeds (#53). */
  fails: Record<Scope, Fail[]>;
  /** Since when polling gets no answer from Director, or null while it answers (#53). */
  connLost: string | null;
  /** A discard waiting out its undo time (#55). */
  pendingDiscard: string | null;
  /** The final render plan shown inline in the inspector (#57). */
  finalPlan: { plan: FinalPlan; proposed: boolean } | null;
  /** Kept after closing so the closing animation still has content. */
  adoptDlg: { plan: AdoptPlan; open: boolean; requestId: string } | null;
  /** Which panel the narrow layout shows below the render (#60). */
  pane: 'inspector' | 'versions';
};

export const NO_RENDER = 'No render at this quality yet.';
const BASE_TITLE = document.title;
const NO_FAILS: Record<Scope, Fail[]> = { view: [], preview: [], adopt: [], ask: [], review: [], final: [], edit: [] };

const initial: State = {
  data: null as unknown as Data, viewId: '', profile: 'draft', selection: new Set(), compare: false, onPage: false, diffBase: {},
  jobs: new Map(), lastResult: null, sig: '', notice: null, drawSeq: 0,
  empty: null, wipe: false, measure: null,
  instruction: '', ctx: { selection: true, exposure: true, history: false },
  fails: NO_FAILS, connLost: null, pendingDiscard: null, finalPlan: null, adoptDlg: null, pane: 'inspector',
};
type Creator = StateCreator<State>;
type DevtoolsFeature = 'pause' | 'lock' | 'persist' | 'export' | 'import' | 'jump' | 'skip' | 'reorder' | 'dispatch' | 'test';
type DevtoolsOpts = { name: string; features: Record<DevtoolsFeature, boolean>; serialize: { options: { map: boolean; set: boolean } } };
/** Devtools only show the state: the buttons that would write it are hidden (the guard below drops such writes anyway). */
const DEVTOOLS_OPTS = {
  name: 'render-director',
  features: { pause: true, lock: false, persist: false, export: true, import: false, jump: false, skip: false, reorder: false, dispatch: false, test: false },
  serialize: { options: { map: true, set: true } },
} satisfies DevtoolsOpts;
/** Redux devtools in development only; the production build drops this branch. */
const withDevtools = (f: Creator): Creator => (import.meta.env.DEV ? (devtools(f, DEVTOOLS_OPTS) as unknown as Creator) : f);
/** True only while set() writes: every other write (devtools time travel, reset, import) is dropped, so all state goes through the rules. */
let writing = false;
const guard = (f: Creator): Creator => (s, g, api) => f(((...a: Parameters<typeof s>) => { if (writing) s(...a); }) as typeof s, g, api);
const store = createStore<State>()(guard(withDevtools(() => initial)));

export const get = (): State => store.getState();
export const V = (id: string | null | undefined, s: State = get()): Version | undefined => versionOf(id, s);
/** The version on screen. A view id that the loaded state does not know yet (a version just created) shows HEAD meanwhile. */
export const viewV = (s: State = get()): Version => viewedVersion(s);
export const isADE = (s: State = get()): boolean => s.data?.mode === 'ade';
export const discarding = (id: string, s: State = get()): boolean => s.pendingDiscard === id;
export const runningJob = (versionId: string, kind?: string, s: State = get()): Job | undefined =>
  [...s.jobs.values()].find((j) => j.status === 'running' && j.versionId === versionId && (!kind || j.kind === kind));

export function set(patch: Partial<State>): void {
  const prev = get();
  const was = writing;
  writing = true;
  try { store.setState(applyRules(prev, { ...prev, ...patch }, patch), true); } finally { writing = was; }
}
// The tab title is marked while a proposal is announced.
store.subscribe((s, prev) => { if (s.notice !== prev.notice) document.title = s.notice ? `(1) ${BASE_TITLE}` : BASE_TITLE; });
/** Select one field (or a value derived without allocating) from the state. */
export const useStore = <T,>(sel: (s: State) => T): T => useZustandStore(store, sel);

// ---------- announcements and failures ----------
/** Polite announcement. Cleared first and written 30 ms later so the same sentence is read again. */
export const say = (msg: string): void => {
  const el = document.getElementById('live'); if (!el) return;
  el.textContent = ''; setTimeout(() => { el.textContent = msg; }, 30);
};
const why = (e: unknown): string => (e as Error).message;
let failKey = 0;
/** Per failure key, the control that was focused when it failed (kept out of the state: it is a DOM element). */
const backs = new Map<number, HTMLElement>();
// However a failure leaves the state (dismissed, cleared, replaced, or filtered by a component), its control goes too.
store.subscribe((s, prev) => {
  if (s.fails === prev.fails) return;
  const live = new Set(Object.values(s.fails).flatMap((list) => list.map((f) => f.key)));
  for (const key of backs.keys()) if (!live.has(key)) backs.delete(key);
});
/**
 * A failure stays on screen next to what failed until it is dismissed or the same action succeeds (#53). Each one is
 * role=alert, so screen readers announce it too. Dismissing it returns focus to the control that was focused when it failed.
 */
export function fail(scope: Scope, msg: string, opts: { retry?: () => unknown; retryLabel?: string } = {}): void {
  const back = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  const list = get().fails[scope].filter((f) => f.msg !== msg);
  const key = ++failKey;
  if (back) backs.set(key, back);
  set({ fails: { ...get().fails, [scope]: [...list, { key, msg, ...opts }] } });
}
export function clearFails(scope: Scope): void { if (get().fails[scope].length) set({ fails: { ...get().fails, [scope]: [] } }); }
/** Removes one failure; focus goes back to the control that failed when it is still on screen. */
export function dismissFail(scope: Scope, key: number): void {
  if (!get().fails[scope].some((x) => x.key === key)) return;
  const back = backs.get(key);
  set({ fails: { ...get().fails, [scope]: get().fails[scope].filter((x) => x.key !== key) } });
  if (back?.isConnected && !back.closest('[hidden]')) back.focus();
}
export const focusInstruction = (): void => document.getElementById('instruction')?.focus();
/** Focuses an element once React has drawn it (after a state change that adds it). */
const focusSoon = (id: string): void => { requestAnimationFrame(() => document.getElementById(id)?.focus()); };

// ---------- loading and polling ----------
let loadSeq = 0;
/** The newest load(); an older one that lost the race waits for it before returning. */
let latestLoad: Promise<void> | null = null;
/**
 * Several callers load (the poll, finished jobs, decisions); only the newest answer is applied, and every caller
 * returns after it is applied.
 */
export function load(keepView = true): Promise<void> {
  const seq = ++loadSeq;
  const run = loadNow(seq, keepView);
  latestLoad = run;
  return run.then(() => (seq === loadSeq ? undefined : latestLoad ?? undefined));
}
async function loadNow(seq: number, keepView: boolean): Promise<void> {
  const d = await api<Data>('/api/state'); if (seq !== loadSeq) return;
  // A new agent version is announced by whichever load sees it first, not only by the poll. Only an ADE agent proposes
  // from outside the page; in standalone mode a new version is the human's own request.
  const known = get().data && new Set(get().data.versions.map((v) => v.id));
  const fresh = known && d.mode === 'ade' ? d.versions.filter((v) => !known.has(v.id) && v.origin === 'agent') : [];
  const keep = keepView && d.versions.some((v) => v.id === get().viewId);
  set({ data: d, viewId: keep ? get().viewId : d.head, sig: signature(d), drawSeq: get().drawSeq + 1 });
  if (fresh.length) notify(fresh.at(-1)!.id);
}

function notify(id: string): void {
  // fixed on screen so it is seen while scrolled down; the tab title is marked until the proposal is opened, decided or dismissed
  set({ notice: id });
  say(`New proposal ${id} from your agent. Press View to open it.`);
}
export const closeNotice = (): void => set({ notice: null });
export const viewNotice = (): void => { const id = get().notice; if (!id) return; set({ notice: null }); openVersion(id); };

/** Shows, while polling fails, that Director does not answer: nothing on screen is current then (#53). */
function connection(ok: boolean): void {
  if (ok) { if (get().connLost) set({ connLost: null }); return; }
  if (!get().connLost) set({ connLost: new Date().toLocaleTimeString() });
}
/**
 * Agents act from outside the page: poll for new proposals, requests and reads. Also while the tab is hidden (the "(1)"
 * title mark is how a hidden tab shows a new proposal), and while a job runs or a dialog is open (#54): the agent keeps
 * working meanwhile, and load() keeps the version you view. Returns a function that stops polling.
 */
export function startPolling(): () => void {
  const timer = setInterval(async () => {
    if (!get().data) return;
    const d = await api<Data>('/api/state').catch(() => null);
    connection(!!d);
    // keeps the version you are viewing; never switches under your cursor
    if (d && signature(d) !== get().sig) await load().catch(() => connection(false));
  }, 2500);
  return () => clearInterval(timer);
}

/** On startup, a HEAD without a draft render gets one, then a previs render. */
export async function renderMissingDraft(): Promise<void> {
  if (viewV().renders.draft) return;
  const id = get().viewId;
  try {
    const job = await api<Job>('/api/render', { versionId: id, profile: 'draft' });
    trackJob(job, async () => {
      try { const j2 = await api<Job>('/api/render', { versionId: id, profile: 'previs' }); trackJob(j2, () => load()); }
      catch (e) { fail('view', `Could not start the render: ${why(e)}`); }
    });
  } catch (e) { fail('view', `Could not start the render: ${why(e)}`); }
}

// ---------- viewing ----------
/** Shows a version: the list, the inspector and the viewport follow. */
export function openVersion(id: string): void { set({ viewId: id, drawSeq: get().drawSeq + 1 }); }
export function selectVersion(id: string): void {
  const v = V(id); if (!v) return;
  openVersion(id);
  say(`Viewing ${id}, ${v.status}`);
}
export const setProfile = (profile: string): void => set({ profile, drawSeq: get().drawSeq + 1 });
export const setCompare = (compare: boolean): void => set({ compare, drawSeq: get().drawSeq + 1 });
export const setOnPage = (onPage: boolean): void => set({ onPage, drawSeq: get().drawSeq + 1 });
export const setPane = (pane: State['pane']): void => set({ pane });
/** Caches a successful page preview on its version without mutating the polled data. */
export function cachePagePreview(versionId: string, profile: string, pv: PagePreview): void {
  const versions = get().data.versions.map((v) => (v.id === versionId ? { ...v, pagePreviews: { ...v.pagePreviews, [profile]: pv } } : v));
  set({ data: { ...get().data, versions } });
}

/**
 * What a version is compared with, in the diff and in the wipe (#52). When its parent is not HEAD, the human chooses
 * between HEAD (what accepting it changes; the default for a proposal) and the parent (what this step changed).
 */
export function baseOf(v: Version, s: State = get()): { id: string | null; kind: DiffBase; choice: boolean } {
  const choice = !!v.headDiff;
  const kind: DiffBase = choice ? (s.diffBase[v.id] || (v.status === 'proposed' ? 'head' : 'parent')) : 'parent';
  return { id: kind === 'head' ? s.data.head : v.parent || null, kind, choice };
}
export function setBase(id: string, kind: DiffBase): void {
  set({ diffBase: { ...get().diffBase, [id]: kind }, drawSeq: get().drawSeq + 1 });
  say(`Changes against ${kind === 'head' ? 'HEAD' : 'the parent'}`);
}

export function toggleSel(name: string, additive: boolean): void {
  const sel = new Set(get().selection);
  if (additive) { if (sel.has(name)) sel.delete(name); else sel.add(name); }
  else { const only = sel.size === 1 && sel.has(name); sel.clear(); if (!only) sel.add(name); }
  set({ selection: sel });
  say(sel.size ? `Selected: ${[...sel].join(', ')}` : 'Selection cleared');
}
export function clearSelection(): void { set({ selection: new Set() }); say('Selection cleared'); }

/** Where the text in the box goes: the version on screen, shown above the box and following every switch (#59). */
export function askTarget(s: State = get()): string {
  const v = viewV(s);
  return !isADE(s) && (v.status === 'discarded' || discarding(v.id, s)) ? s.data.head : v.id;
}

// ---------- jobs ----------
// Jobs run in the background, each tied to a version (#54): the page keeps polling, other versions can be viewed and
// compared, and only a second job of the same kind on the same version is refused. Finished jobs that failed or were
// cancelled stay listed until dismissed.
const putJob = (j: Job): void => set({ jobs: new Map(get().jobs).set(j.id, j) });
export function dropJob(id: string): void { const jobs = new Map(get().jobs); if (jobs.delete(id)) set({ jobs }); }

export function trackJob(job: Job, onEnd?: (j: Job) => unknown): void {
  putJob(job);
  let lastCount = 0, misses = 0;
  const tick = async () => {
    if (!get().jobs.has(job.id)) return; // dismissed
    let j: Job;
    try { j = await api<Job>(`/api/jobs/${job.id}`); misses = 0; }
    catch (e) {
      // 'no job': Director drops finished jobs after a while (#32); treat it as ended instead of polling forever.
      // Any other failure (Director not answering): keep asking, less often each time (2 s up to 30 s); the connection
      // banner says what is going on.
      if (why(e) !== 'no job') { misses++; setTimeout(tick, Math.min(2000 * 2 ** (misses - 1), 30000)); return; }
      j = { ...job, status: 'gone' };
    }
    if (j.steps.length !== lastCount) { lastCount = j.steps.length; say(j.steps.at(-1)?.label || ''); }
    if (j.status === 'gone') {
      // The result is unknown here (the tab did not poll for over 10 minutes); the reloaded state shows what happened.
      dropJob(job.id);
      await load().catch(() => {}); say('The job ended while this tab was not watching it; the versions and requests show the result');
      return;
    }
    putJob(j);
    if (j.status === 'running') { setTimeout(tick, 500); return; }
    say(j.status === 'done' ? 'Finished' : `Stopped: ${j.error || j.status}`);
    try { await onEnd?.(j); } catch (e) { fail('view', `Could not update after the job: ${why(e)}`); }
    if (j.status === 'done') setTimeout(() => dropJob(job.id), 1500);
  };
  void tick();
}
export function cancelJob(id: string): void {
  api(`/api/jobs/${id}/cancel`, {}).catch((e) => fail('view', `Cannot cancel: ${why(e)}`));
}

// ---------- direct edit ----------
/** Set synchronously while a direct edit is in flight, so a second change event cannot fork a duplicate version. */
let editing = false;
/** Returns false when the edit failed (the caller puts the control back to the version's value). */
export async function directEdit(node: string, field: string, value: unknown): Promise<boolean> {
  if (editing) return true; // the edit in flight creates the version
  editing = true;
  const base = get().viewId;
  let r: { version: string; job: Job };
  try { r = await api<{ version: string; job: Job }>('/api/edit', { baseId: base, node, field, value }); }
  catch (e) { editing = false; fail('edit', `Edit of ${node}.${field} failed: ${why(e)}`); return false; }
  clearFails('edit');
  // The new version is viewed only once it is loaded, so HEAD is not shown in its place, and only while the human is
  // still on the version edited: one opened meanwhile stays on screen. The edit succeeded either way: a failed load is a
  // view failure, the view stays, and the next poll brings the version in.
  let loaded = false;
  try { await load(); loaded = true; } catch (e) { fail('view', `Created ${r.version}, but could not load it: ${why(e)}`); }
  finally { editing = false; }
  if (loaded && get().viewId === base && V(r.version)) openVersion(r.version);
  say(`Created ${r.version}`);
  trackJob(r.job, () => load());
  return true;
}

// ---------- ask the agent ----------
export async function submitAsk(): Promise<void> {
  const instruction = get().instruction.trim(); if (!instruction) return focusInstruction();
  const target = askTarget();
  if (isADE()) {
    if (discarding(target)) return fail('ask', `${target} is about to be discarded; undo the discard or open another version. Your text is kept.`);
    try { await api('/api/feedback', { versionId: target, selection: [...get().selection], comment: instruction }); }
    catch (e) { return fail('ask', `Could not send: ${why(e)}. Your text is kept.`); }
    set({ instruction: '' }); clearFails('ask'); say('Sent to your agent');
    await load().catch((e) => fail('view', `Sent, but could not reload: ${why(e)}`));
    return;
  }
  if (runningJob(target, 'propose')) return fail('ask', `A proposal from ${target} is already being made. Wait for it or cancel it, then propose again.`);
  try {
    const job = await api<Job>('/api/propose', { baseId: target, instruction, selection: [...get().selection], context: get().ctx });
    clearFails('ask'); say(`Proposal requested from ${target}`);
    trackJob(job, async (j) => {
      set({ lastResult: j });
      await load();
      if (j.status === 'done' && j.result?.kind === 'proposal') openVersion(j.result.versionId);
    });
  } catch (e) { fail('ask', `Could not start: ${why(e)}. Your request is kept.`); }
}

// ---------- decisions ----------
export async function decide(decision: 'accept' | 'discard', id: string = get().viewId): Promise<void> {
  if (decision === 'discard') return discardLater(id);
  try { await api('/api/decide', { versionId: id, decision }); }
  catch (e) { return fail('review', `Cannot ${decision} ${id}: ${why(e)}`); }
  clearFails('review');
  set({ instruction: '' });
  try { await load(); } catch (e) { return fail('view', `${id} is now HEAD, but could not reload: ${why(e)}`); }
  say(`${id} is now HEAD`);
}
/** The box already says it goes to this version (#59). */
export const refine = (): void => focusInstruction();
export const dismissResult = (): void => set({ lastResult: null });

/** Makes an accepted version HEAD again: this is how an Accept is taken back (#55). */
export async function checkout(id: string): Promise<void> {
  try { await api('/api/checkout', { versionId: id }); }
  catch (e) { return fail('review', `Cannot make ${id} HEAD: ${why(e)}`); }
  clearFails('review');
  try { await load(); } catch (e) { return fail('view', `${id} is now HEAD, but could not reload: ${why(e)}`); }
  say(`${id} is now HEAD`);
}

// Discard can be undone for a few seconds (#55): the decision reaches Director, and through it the agent (with the
// rejection of pending adoption requests), only when the time is up. Closing the tab before then discards nothing.
export const UNDO_MS = 6000;
let discardTimer = 0;
function discardLater(id: string): void {
  if (get().pendingDiscard) void commitDiscard(); // one at a time: the earlier one is decided now
  discardTimer = window.setTimeout(() => void commitDiscard(), UNDO_MS);
  set({ pendingDiscard: id });
  say(`${id} will be discarded in ${UNDO_MS / 1000} seconds. Press Undo to keep it.`);
}
export function undoDiscard(): void {
  const id = get().pendingDiscard; if (!id) return;
  clearTimeout(discardTimer); set({ pendingDiscard: null }); say(`${id} kept`);
  if (get().viewId === id) focusSoon('acceptBtn');
}
async function commitDiscard(): Promise<void> {
  const id = get().pendingDiscard; if (!id) return;
  clearTimeout(discardTimer); set({ pendingDiscard: null });
  try { await api('/api/decide', { versionId: id, decision: 'discard' }); }
  catch (e) { return fail('review', `Cannot discard ${id}: ${why(e)}`); }
  clearFails('review');
  if (get().viewId === id) set({ viewId: V(id)?.parent ?? get().data.head });
  try { await load(); } catch (e) { return fail('view', `${id} discarded, but could not reload: ${why(e)}`); }
  say(`${id} discarded`);
}

// ---------- final render ----------
// The plan opens inline in the inspector, not in a modal (#57): the render and the wipe stay usable while deciding.
// A final render writes only into the version's folder (it replaces that version's previous final) and can be made
// again, so nothing needs to lock the page. The approval stays explicit and bound to the scene hash by the server.
export async function planFinal(): Promise<void> {
  const v = viewV();
  if (v.status === 'discarded') return fail('final', `${v.id} is discarded; discarded versions cannot be rendered at final quality.`);
  let plan: FinalPlan;
  try { plan = await api<FinalPlan>('/api/final/plan', { versionId: v.id }); }
  catch (e) { return fail('final', `Cannot plan a final render of ${v.id}: ${why(e)}`); }
  if (viewV().id !== v.id) return; // the human moved on while the plan was requested
  clearFails('final');
  set({ finalPlan: { plan, proposed: v.status === 'proposed' } });
  say(`Final render plan for ${plan.versionId}. Approve and render, or cancel.`);
}
export function closeFinalPlan(refocus = false): void {
  if (get().finalPlan) set({ finalPlan: null });
  if (refocus) document.getElementById('finalBtn')?.focus();
}
export async function approveFinal(): Promise<void> {
  const fp = get().finalPlan;
  // The plan is for the version on screen only; the inspector closes it when the view changes.
  closeFinalPlan(true);
  if (!fp || fp.plan.versionId !== viewV().id) return;
  const { versionId, ticket } = fp.plan;
  try {
    const job = await api<Job>('/api/render', { versionId, profile: 'final', ticket });
    trackJob(job, async (j) => { await load(); if (j.status === 'done' && viewV().id === versionId) setProfile('final'); });
  } catch (e) {
    fail('final', `Final render of ${versionId} refused: ${why(e)}. Plan it again.`, { retry: () => planFinal(), retryLabel: 'Plan again…' });
  }
}

// ---------- adoption ----------
export async function reviewAdoption(requestId: string): Promise<void> {
  const req = get().data.adoptionRequests.find((a) => a.id === requestId);
  if (req && discarding(req.version)) return fail('adopt', `${req.version} is about to be discarded; undo the discard to review ${requestId}.`);
  let plan: AdoptPlan;
  try { plan = await api<AdoptPlan>('/api/adopt/plan', { requestId }); }
  catch (e) { return fail('adopt', `Cannot adopt ${requestId}: ${why(e)}`); }
  clearFails('adopt');
  openVersion(plan.versionId);
  set({ adoptDlg: { plan, open: true, requestId } });
}
export async function closeAdoption(decision: 'approve' | 'reject' | 'cancel'): Promise<void> {
  const d = get().adoptDlg; if (!d?.open) return;
  const { requestId } = d;
  set({ adoptDlg: { ...d, open: false } });
  if (decision === 'reject') {
    try { await api('/api/adopt/reject', { requestId }); say(`Rejected ${requestId}`); }
    catch (e) { fail('adopt', `Cannot reject ${requestId}: ${why(e)}`); }
    return load();
  }
  if (decision !== 'approve') return say('Nothing written');
  const again = { retry: () => reviewAdoption(requestId), retryLabel: 'Review again…' };
  try {
    const job = await api<Job>('/api/adopt', { ticket: d.plan.ticket });
    trackJob(job, async (j) => {
      await load();
      if (j.status === 'done') say(`Wrote ${j.result.asset}`); else if (j.status === 'cancelled') say('Adoption cancelled; the request is pending again');
      else if (j.status === 'failed') fail('adopt', `Adoption of ${requestId} failed: ${j.error}. Nothing was written; the request is pending again.`, again);
    });
  } catch (e) { fail('adopt', `Adoption refused: ${why(e)}`, again); }
}
/** Cancelling the adopt job makes the request pending again (also after a reload, when the job is no longer tracked here). */
export async function cancelAdoption(jobId: string): Promise<void> {
  try { await api(`/api/jobs/${jobId}/cancel`, {}); say('Adoption cancelled; the request is pending again'); }
  catch (e) { fail('adopt', `Cannot cancel: ${why(e)}`); }
  await load().catch(() => {});
}

/** Starts a render of the version on screen again (a render whose object ids predate recorded hashes). */
export async function rerender(profile: string): Promise<void> {
  try { trackJob(await api<Job>('/api/render', { versionId: viewV().id, profile }), () => load()); }
  catch (e) { fail('view', `Could not start the render: ${why(e)}`); }
}
