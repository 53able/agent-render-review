// Page state and the actions that change it (ported from public/app.js). Components read it with useStore
// (useSyncExternalStore); everything that talks to Director lives here so components stay declarative.
import { useSyncExternalStore } from 'react';
import { api } from './lib/api.ts';
import { signature } from './lib/signature.ts';
import type { AdoptPlan, Data, FinalPlan, Job, PagePreview, Render, Version } from './lib/types.ts';

export type MeasureView = { kind: 'render'; r: Render } | { kind: 'page'; pageUrl?: string; pv: PagePreview } | null;
export type Dlg<P> = { plan: P; open: boolean };

export type State = {
  data: Data;
  viewId: string;
  profile: string;
  selection: Set<string>;
  compare: boolean;
  onPage: boolean;
  job: Job | null;
  lastResult: Job | null;
  sig: string;
  /** A dialog is open: polling pauses so the page under it does not change (app.js:165). */
  dialogOpen: boolean;
  /** The proposal the fixed notice announces, while it is shown. */
  notice: string | null;
  /** Set synchronously while a direct edit is in flight, so a second change event cannot fork a duplicate version (app.js:381-383). */
  editing: boolean;
  /** Bumped whenever the viewport must be drawn again (every load, profile and compare change, page toggle). */
  drawSeq: number;
  // viewport read-outs, written by the Viewport's draw routine
  viewing: string;
  empty: string | null;
  wipe: boolean;
  measure: MeasureView;
  // job box
  jobView: { steps: Job['steps']; elapsed: number } | null;
  jobBoxHidden: boolean;
  // ask form
  instruction: string;
  placeholder: string | null;
  ctx: { selection: boolean; exposure: boolean; history: boolean };
  // dialogs (kept after closing so the closing animation still has content)
  finalDlg: Dlg<FinalPlan> & { versionId: string; proposed: boolean } | null;
  adoptDlg: Dlg<AdoptPlan> & { requestId: string } | null;
};

export const NO_RENDER = 'No render at this quality yet.';
const BASE_TITLE = document.title;

let state: State = {
  data: null as unknown as Data, viewId: '', profile: 'draft', selection: new Set(), compare: false, onPage: false,
  job: null, lastResult: null, sig: '', dialogOpen: false, notice: null, editing: false, drawSeq: 0,
  viewing: '', empty: null, wipe: false, measure: null,
  jobView: null, jobBoxHidden: true,
  instruction: '', placeholder: null, ctx: { selection: true, exposure: true, history: false },
  finalDlg: null, adoptDlg: null,
};
const listeners = new Set<() => void>();

export const get = (): State => state;
export const V = (id: string | null | undefined, s: State = state): Version | undefined => (id ? s.data.versions.find((v) => v.id === id) : undefined);
export const viewV = (s: State = state): Version => V(s.viewId, s) as Version;
export const isADE = (s: State = state): boolean => s.data?.mode === 'ade';

export function set(patch: Partial<State>): void {
  const prev = state;
  let next: State = { ...prev, ...patch };
  if (next.data && (next.data !== prev.data || next.viewId !== prev.viewId)) {
    // Objects that are not in the viewed scene cannot stay selected (app.js:324).
    const names = new Set(viewV(next)?.scene.nodes.map((n) => n.name) ?? []);
    if ([...next.selection].some((s) => !names.has(s))) next = { ...next, selection: new Set([...next.selection].filter((s) => names.has(s))) };
  }
  // The notice is done once its proposal is on screen or no longer a proposal (app.js:470).
  if (!('notice' in patch) && next.notice && (next.notice === next.viewId || V(next.notice, next)?.status !== 'proposed')) next = { ...next, notice: null };
  if (next.notice !== prev.notice) document.title = next.notice ? `(1) ${BASE_TITLE}` : BASE_TITLE;
  state = next;
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
/** Select one field (or a value derived without allocating) from the state. */
export const useStore = <T,>(sel: (s: State) => T): T => useSyncExternalStore(subscribe, () => sel(state));

// ---------- announcements ----------
/** Polite announcement. Cleared first and written 30 ms later so the same sentence is read again (app.js:44). */
export const say = (msg: string): void => {
  const el = document.getElementById('live'); if (!el) return;
  el.textContent = ''; setTimeout(() => { el.textContent = msg; }, 30);
};
export const alertMsg = (msg: string): void => { const el = document.getElementById('alert'); if (el) el.textContent = msg; };
const errMsg = (e: unknown): string => (e as Error).message;
export const focusInstruction = (): void => document.getElementById('instruction')?.focus();

// ---------- loading and polling ----------
export async function load(opts: { keepView?: boolean; view?: string } = {}): Promise<void> {
  const data = await api<Data>('/api/state');
  const want = opts.view ?? state.viewId;
  const keep = opts.keepView !== false && data.versions.some((v) => v.id === want);
  set({ data, viewId: keep ? want : data.head, sig: signature(data), drawSeq: state.drawSeq + 1 });
}

function notify(id: string): void {
  // fixed on screen so it is seen while scrolled down; the tab title is marked until the proposal is opened, decided or dismissed
  set({ notice: id });
  say(`New proposal ${id} from your agent. Press View to open it.`);
}
export const closeNotice = (): void => set({ notice: null });
export const viewNotice = (): void => { const id = state.notice; if (id) set({ notice: null, viewId: id }); };

/** Agents act from outside the page: poll for new proposals, requests and reads. */
export function startPolling(): void {
  setInterval(async () => {
    // Also while the tab is hidden: the "(1)" title mark is how a hidden tab shows a new proposal.
    if (!state.data || state.job || state.dialogOpen) return;
    const d = await api<Data>('/api/state').catch(() => null);
    if (d && signature(d) !== state.sig) {
      const fresh = d.versions.filter((v) => !V(v.id) && v.origin === 'agent');
      await load(); // keeps the version you are viewing; never switches under your cursor
      if (fresh.length) notify(fresh.at(-1)!.id);
    }
  }, 2500);
}

/** On startup, a HEAD without a draft render gets one, then a previs render (app.js:606-609). */
export async function renderMissingDraft(): Promise<void> {
  if (viewV().renders.draft) return;
  try {
    const job = await api<Job>('/api/render', { versionId: state.viewId, profile: 'draft' });
    trackJob(job, async () => {
      try { const j2 = await api<Job>('/api/render', { versionId: state.viewId, profile: 'previs' }); trackJob(j2, () => load()); }
      catch (e) { alertMsg(`Render refused: ${errMsg(e)}`); }
    });
  } catch (e) { alertMsg(`Render refused: ${errMsg(e)}`); }
}

// ---------- viewing ----------
export function selectVersion(id: string): void {
  const v = V(id); if (!v) return;
  set({ viewId: id });
  say(`Viewing ${id}, ${v.status}`);
}
export const setProfile = (profile: string): void => set({ profile, drawSeq: state.drawSeq + 1 });
export const setCompare = (compare: boolean): void => set({ compare, drawSeq: state.drawSeq + 1 });
export const setOnPage = (onPage: boolean): void => set({ onPage, drawSeq: state.drawSeq + 1 });
/** Caches a successful page preview on its version without mutating the polled data. */
export function cachePagePreview(versionId: string, profile: string, pv: PagePreview): void {
  const versions = state.data.versions.map((v) => (v.id === versionId ? { ...v, pagePreviews: { ...v.pagePreviews, [profile]: pv } } : v));
  set({ data: { ...state.data, versions } });
}

export function toggleSel(name: string, additive: boolean): void {
  const sel = new Set(state.selection);
  if (additive) { if (sel.has(name)) sel.delete(name); else sel.add(name); }
  else { const only = sel.size === 1 && sel.has(name); sel.clear(); if (!only) sel.add(name); }
  set({ selection: sel });
  say(sel.size ? `Selected: ${[...sel].join(', ')}` : 'Selection cleared');
}
export function clearSelection(): void { set({ selection: new Set() }); say('Selection cleared'); }

// ---------- jobs ----------
export function trackJob(job: Job, onEnd?: (j: Job) => unknown): void {
  set({ job, jobBoxHidden: false });
  let lastCount = 0;
  const tick = async () => {
    // 'no job': Director drops finished jobs after a while (#32); treat it as ended instead of polling forever.
    const j = await api<Job>(`/api/jobs/${job.id}`).catch((e) => (errMsg(e) === 'no job' ? { ...job, status: 'gone' } : null));
    if (!j) return;
    set({ jobView: { steps: j.steps, elapsed: j.elapsed } });
    if (j.steps.length !== lastCount) { lastCount = j.steps.length; say(j.steps.at(-1)?.label || ''); }
    if (j.status === 'running') { setTimeout(tick, 500); return; }
    if (j.status === 'gone') {
      // The result is unknown here (the tab did not poll for over 10 minutes); the reloaded state shows what happened.
      set({ job: null, jobBoxHidden: true });
      await load(); say('The job ended while this tab was not watching it; the versions and requests show the result');
      return;
    }
    set({ job: null });
    say(j.status === 'done' ? 'Finished' : `Stopped: ${j.error || j.status}`);
    await onEnd?.(j);
    // a failed job stays on screen with its steps; a finished one goes away shortly after
    setTimeout(() => { if (!state.job) set({ jobBoxHidden: j.status === 'done' }); }, j.status === 'done' ? 1500 : 0);
  };
  void tick();
}
export const cancelJob = (): void => { const j = state.job; if (j) api(`/api/jobs/${j.id}/cancel`, {}).catch((e) => alertMsg(`Cannot cancel: ${errMsg(e)}`)); };

// ---------- direct edit ----------
export async function directEdit(node: string, field: string, value: unknown): Promise<void> {
  if (state.job || state.editing) return alertMsg('Wait for the current job to finish or cancel it.');
  set({ editing: true }); // synchronous, so a second change event cannot fork a duplicate version
  try {
    const r = await api<{ version: string; job: Job }>('/api/edit', { baseId: state.viewId, node, field, value });
    await load({ view: r.version }); say(`Created ${r.version}`);
    trackJob(r.job, () => load());
  } catch (e) { alertMsg(`Edit failed: ${errMsg(e)}`); }
  finally { set({ editing: false }); }
}

// ---------- ask the agent ----------
export async function submitAsk(): Promise<void> {
  const instruction = state.instruction.trim(); if (!instruction) return focusInstruction();
  if (isADE()) {
    try { await api('/api/feedback', { versionId: state.viewId, selection: [...state.selection], comment: instruction }); set({ instruction: '' }); say('Sent to your agent'); await load(); }
    catch (e) { alertMsg(`Could not send: ${errMsg(e)}`); }
    return;
  }
  if (state.job) return alertMsg('A job is already running.');
  const v = viewV(); const baseId = v.status === 'discarded' ? state.data.head : v.id;
  try {
    const job = await api<Job>('/api/propose', { baseId, instruction, selection: [...state.selection], context: state.ctx });
    say(`Proposal requested from ${baseId}`);
    trackJob(job, async (j) => {
      set({ lastResult: j });
      await load(j.status === 'done' && j.result?.kind === 'proposal' ? { view: j.result.versionId } : {});
    });
  } catch (e) { alertMsg(`Could not start: ${errMsg(e)}`); }
}

// ---------- review ----------
export async function decide(decision: 'accept' | 'discard'): Promise<void> {
  const id = state.viewId;
  try { await api('/api/decide', { versionId: id, decision }); }
  catch (e) { return alertMsg(`Cannot ${decision}: ${errMsg(e)}`); }
  set({ instruction: '' });
  await load(decision === 'discard' ? { view: V(id)?.parent ?? undefined } : {});
  say(decision === 'accept' ? `${id} is now HEAD` : `${id} discarded`);
}
export function refine(): void {
  set({ instruction: '', placeholder: `Refine ${state.viewId}: what should differ?` });
  focusInstruction();
}
export const dismissResult = (): void => set({ lastResult: null });

// ---------- final render ----------
export async function planFinal(): Promise<void> {
  const v = viewV();
  if (v.status === 'discarded') return alertMsg('Discarded versions cannot be rendered at final quality.');
  let plan: FinalPlan;
  try { plan = await api<FinalPlan>('/api/final/plan', { versionId: v.id }); }
  catch (e) { return alertMsg(`Final render refused: ${errMsg(e)}`); }
  set({ finalDlg: { plan, open: true, versionId: v.id, proposed: v.status === 'proposed' }, dialogOpen: true });
}
export async function closeFinal(approved: boolean): Promise<void> {
  const d = state.finalDlg; if (!d) return;
  set({ finalDlg: { ...d, open: false }, dialogOpen: false });
  if (!approved) return say('Final render not started');
  try {
    const job = await api<Job>('/api/render', { versionId: d.versionId, profile: 'final', ticket: d.plan.ticket });
    trackJob(job, async (j) => { await load(); if (j.status === 'done') setProfile('final'); });
  } catch (e) { alertMsg(`Final render refused: ${errMsg(e)}`); }
}

// ---------- adoption ----------
export async function reviewAdoption(requestId: string): Promise<void> {
  let plan: AdoptPlan;
  try { plan = await api<AdoptPlan>('/api/adopt/plan', { requestId }); }
  catch (e) { return alertMsg(`Cannot adopt: ${errMsg(e)}`); }
  set({ viewId: plan.versionId, adoptDlg: { plan, open: true, requestId }, dialogOpen: true });
}
export async function closeAdoption(decision: 'approve' | 'reject' | 'cancel'): Promise<void> {
  const d = state.adoptDlg; if (!d) return;
  set({ adoptDlg: { ...d, open: false }, dialogOpen: false });
  if (decision === 'reject') {
    try { await api('/api/adopt/reject', { requestId: d.requestId }); say(`Rejected ${d.requestId}`); }
    catch (e) { alertMsg(`Cannot reject: ${errMsg(e)}`); }
    return load();
  }
  if (decision !== 'approve') return say('Nothing written');
  try {
    const job = await api<Job>('/api/adopt', { ticket: d.plan.ticket });
    trackJob(job, async (j) => { await load(); say(j.status === 'done' ? `Wrote ${j.result.asset}` : j.status === 'cancelled' ? 'Adoption cancelled; the request is pending again' : `Adoption failed: ${j.error}`); });
  } catch (e) { alertMsg(`Adoption refused: ${errMsg(e)}`); }
}
/** Cancelling the adopt job makes the request pending again (also after a reload, when the job is no longer tracked here). */
export async function cancelAdoption(jobId: string): Promise<void> {
  try { await api(`/api/jobs/${jobId}/cancel`, {}); say('Adoption cancelled; the request is pending again'); }
  catch (e) { alertMsg(`Cannot cancel: ${errMsg(e)}`); }
  await load();
}
