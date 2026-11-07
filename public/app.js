import { isWildcard, checkClaims, groupDiff, nameRuns, describeNames, visibleObjects } from './review-model.js';

// ---------- types (JSDoc only; no runtime effect) ----------
/** @typedef {{ pass_index: number, name: string }} RenderObject */
/** @typedef {{ image: string, ids: string | null, width: number, height: number, objects: RenderObject[], profile: string, seconds: number, settings: { integrator: string, samples: number }, exposure: { mean: number, clipped: number, near_black: number }, warnings: string[] }} Render */
/** @typedef {{ ok: boolean, reason?: string, image: string, matched: number, warning?: string }} PagePreview */
/** @typedef {{ name: string, type: string, shape?: string, energy?: number, color?: number[], materials?: { inputs: Record<string, any> }[] }} SceneNode */
/** @typedef {{ nodes: SceneNode[] }} Scene */
/** @typedef {{ node: string, path: string, before?: unknown, after?: unknown }} Diff */
/** @typedef {{ claimed_changes: { node: string, what: string, why: string }[], interpretation: string, assumptions: string[], policy: { flags: { level: string, msg: string }[] }, context: string[], via?: string, cost?: number }} Proposal */
/** @typedef {{ id: string, parent?: string | null, status: string, origin: string, instruction?: string, hash: string, renders: Record<string, Render | undefined>, pagePreviews?: Record<string, PagePreview>, scene: Scene, proposal: Proposal, diff: Diff[], headDiff: Diff[] | null }} Version */
/** @typedef {{ seq: number, type: string, comment: string, selection: string[], decision: string, version: string, asset: string, node: string, field: string, request: string }} AgentEvent */
/** @typedef {{ id: string, status: string, slug: string, version: string, reason: string, job?: string }} AdoptionRequest */
/** @typedef {{ t: string, event: string, version?: string, instruction?: string }} AuditEntry */
/** @typedef {{ head: string, versions: Version[], vork: string, mode?: string, project?: string, model?: string, adoptionRequests: AdoptionRequest[], events: AgentEvent[], agentCursor: number, audit: AuditEntry[], config: { pageUrl?: string } }} Data */
/** @typedef {{ kind: string, versionId: string, asset: string, proposal?: { clarifying_question?: string }, policy: { blockers: string[] }, log?: string }} JobResult */
/** @typedef {{ id: string, kind: string, status: string, versionId: string, steps: { status: string, label: string, t: number, detail?: string }[], elapsed: number, error?: string, result: JobResult }} Job */
/** @typedef {{ versionId: string, versionStatus: string, acceptsProposal?: boolean, hash: string, reason: string, writes: string[], overwrites?: boolean, existing: { bytes: number | null, modified: string | null, image: string | null } | null, needsFinalRender?: boolean, shows: string | null, image: string | null, expiresInSec: number, ticket: string }} AdoptPlan */
/** @typedef {{ versionId: string, hash: string, profile: string, resolution: number[], output: string, overwrites?: boolean, reference: string, timeoutSec: number, expiresInSec: number, flags: { msg: string }[], ticket: string }} FinalPlan */
/** @typedef {{ w: number, h: number, arr: Uint16Array, objects: Record<string, string> }} Ids */
/** @typedef {{ data: Data, viewId: string, profile: string, selection: Set<string>, hover: string | null, compare: boolean, diffBase: Record<string, 'head' | 'parent'>, ids: Ids | null, img: HTMLImageElement, imgB: HTMLImageElement | null, lastResult: Job | null, sig?: string, onPage?: boolean, editing?: boolean, objKey?: string }} State */
/** @typedef {[string, string, string, any, ...number[]]} QuickRow */

/**
 * querySelector that the page's fixed markup guarantees to succeed; T is inferred from the declared type at the call site.
 * @template {HTMLElement} [T=HTMLElement]
 * @param {string} s
 * @returns {T}
 */
const $ = (s) => /** @type {T} */ (document.querySelector(s));
/** @type {State} */
const S = { data: /** @type {Data} */ (/** @type {unknown} */ (null)), viewId: /** @type {string} */ (/** @type {unknown} */ (null)), profile: 'draft', selection: new Set(), hover: null, compare: false, diffBase: {}, ids: null, img: /** @type {HTMLImageElement} */ (/** @type {unknown} */ (null)), imgB: null, lastResult: null };

/**
 * @param {string} url
 * @param {unknown} [body]
 * @returns {Promise<any>}
 */
const api = async (url, body) => {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 202) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};
/** @param {string} msg */
const say = (msg) => { $('#live').textContent = ''; setTimeout(() => ($('#live').textContent = msg), 30); };
/**
 * A failure stays on screen next to what failed until it is dismissed or the same action succeeds (#53). Each one is
 * role=alert, so screen readers announce it too. Dismissing it returns focus to the control that failed.
 * @param {'view' | 'adopt' | 'ask' | 'review' | 'final' | 'edit'} scope the .errs container: #err-<scope>
 * @param {string} msg
 * @param {{ retry?: () => unknown, retryLabel?: string }} [opts]
 */
function fail(scope, msg, opts = {}) {
  const box = $(`#err-${scope}`); const back = /** @type {HTMLElement | null} */ (document.activeElement);
  for (const old of /** @type {NodeListOf<HTMLElement>} */ (box.querySelectorAll('.err'))) if (old.dataset.msg === msg) old.remove();
  const el = document.createElement('div'); el.className = 'err'; el.setAttribute('role', 'alert'); el.dataset.msg = msg;
  el.innerHTML = `<span class="msg">${esc(msg)}</span>`;
  const close = () => { el.remove(); if (back?.isConnected && !back.closest('[hidden]')) back.focus(); };
  if (opts.retry) {
    const again = document.createElement('button'); again.type = 'button'; again.className = 'ghost'; again.textContent = opts.retryLabel || 'Try again';
    again.onclick = () => { close(); opts.retry?.(); }; el.append(again);
  }
  const x = document.createElement('button'); x.type = 'button'; x.className = 'ghost'; x.textContent = '✕'; x.setAttribute('aria-label', 'Dismiss');
  x.onclick = close; el.append(x);
  box.append(el);
}
/** @param {'view' | 'adopt' | 'ask' | 'review' | 'final' | 'edit'} scope */
const clearFails = (scope) => { $(`#err-${scope}`).innerHTML = ''; };
/** @param {unknown} e */
const why = (e) => /** @type {Error} */ (e).message;
/** @param {unknown} s */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, /** @param {string} c */ (c) => (/** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }))[c]);
/**
 * @param {string} id
 * @returns {Version | undefined}
 */
const V = (id) => S.data.versions.find((v) => v.id === id);
const viewV = () => /** @type {Version} */ (V(S.viewId));

// linear <-> sRGB for colour pickers (vork colours are linear Rec.709)
/** @param {number} c */
const toS = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
/** @param {number} c */
const toL = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** @param {number[]} rgb */
const linToHex = (rgb) => '#' + rgb.map((c) => Math.round(Math.min(1, Math.max(0, toS(c))) * 255).toString(16).padStart(2, '0')).join('');
/** @param {string} h */
const hexToLin = (h) => [1, 3, 5].map((i) => +toL(parseInt(h.slice(i, i + 2), 16) / 255).toFixed(4));
/**
 * @param {unknown} v
 * @returns {v is number[]}
 */
const isColor = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && n >= 0 && n <= 1.5);

async function load(keepView = true) {
  S.data = await api('/api/state');
  if (!keepView || !V(S.viewId)) S.viewId = S.data.head;
  S.sig = signature(S.data);
  $('#meta').textContent = ADE()
    ? `${S.data.vork} · ADE mode · project ${S.data.project?.split(/[\\/]/).filter(Boolean).at(-1) ?? ''} · proposals come from your agent via MCP · local only`
    : `${S.data.vork} · agent: claude ${S.data.model} (no tools) · local only`;
  $('#meta').title = ADE() ? S.data.project || '' : ''; // only the directory name is on screen (recordings, one-line header); the full path on hover
  applyMode(); renderVersions(); renderObjects(); renderReview(); renderInspector(); renderAdoptions(); renderEvents(); renderAudit(); await drawViewport();
}
const ADE = () => S.data?.mode === 'ade';
/** @param {Data} d */
const signature = (d) => JSON.stringify([d.head, d.versions.length, d.versions.map((v) => v.status + Object.keys(v.renders).join()), d.adoptionRequests.map((a) => a.status), d.events.length, d.agentCursor]);

// ---------- ADE mode ----------
function applyMode() {
  if (!ADE()) return;
  $('#h-ask').textContent = 'Feedback to your agent';
  $('#adeHint').hidden = false;
  $('#adeHint').textContent = 'Your ADE agent writes the scenes. What you send here, with the selected objects and the version you are viewing, reaches it through wait_for_feedback.';
  $('#starters').hidden = true; /** @type {HTMLElement} */ (document.querySelector('.ctx')).hidden = true;
  $('#askBtn').textContent = 'Send to agent';
  /** @type {HTMLTextAreaElement} */ ($('#instruction')).placeholder = '例: 選択した物体をもっと小さく。見出しの右側に余白を残したい';
  $('#pageBtn').hidden = false;
}
function renderEvents() {
  const list = $('#eventList'); if (!ADE()) return;
  const evs = S.data.events.filter((e) => ['feedback', 'decision', 'direct_edit', 'adopted', 'adoption_rejected'].includes(e.type)).slice(-6).reverse();
  list.hidden = !evs.length;
  list.innerHTML = evs.map((e) => {
    const what = e.type === 'feedback' ? `${esc(e.comment)}${e.selection.length ? ` <span class="hint">[${e.selection.map(esc).join(', ')}]</span>` : ''}`
      : e.type === 'decision' ? `${esc(e.decision)} ${esc(e.version)}` : e.type === 'adopted' ? `adopted → ${esc(e.asset)}`
      : e.type === 'direct_edit' ? `edited ${esc(e.node)}.${esc(e.field)}` : `rejected adoption ${esc(e.request)}`;
    const read = e.seq <= S.data.agentCursor;
    return `<li>#${e.seq} ${esc(e.type)} · ${what} <span class="${read ? 'read' : 'unread'}">${read ? '· read by agent' : '· not read yet'}</span></li>`;
  }).join('');
}
function renderAdoptions() {
  // 'adopting': its adopt job is running; the server refuses plan and reject until the job ends or is cancelled.
  const pending = (S.data.adoptionRequests || []).filter((a) => a.status === 'pending' || a.status === 'adopting');
  $('#adoptBox').hidden = !pending.length;
  $('#adoptList').innerHTML = pending.map((a) => `<li><span><b>${esc(a.slug)}</b> from ${esc(a.version)}</span>${a.status === 'adopting' ? `<span class="hint">adopting…</span><button class="ghost" data-cancel="${esc(a.job)}">Cancel</button>` : `<button class="ghost" data-req="${esc(a.id)}">Review…</button>`}<span class="why">${esc(a.reason)}</span></li>`).join('');
  $('#adoptList').querySelectorAll('button[data-req]').forEach((b) => (/** @type {HTMLButtonElement} */ (b).onclick = () => reviewAdoption(/** @type {HTMLButtonElement} */ (b).dataset.req)));
  // Cancelling the adopt job makes the request pending again (also after a reload, when the job is no longer tracked here).
  $('#adoptList').querySelectorAll('button[data-cancel]').forEach((b) => (/** @type {HTMLButtonElement} */ (b).onclick = async () => {
    try { await api(`/api/jobs/${/** @type {HTMLButtonElement} */ (b).dataset.cancel}/cancel`, {}); say('Adoption cancelled; the request is pending again'); }
    catch (e) { fail('adopt', `Cannot cancel: ${why(e)}`); }
    await load();
  }));
}
/** @param {string | undefined} requestId */
async function reviewAdoption(requestId) {
  /** @type {AdoptPlan} */
  let plan;
  try { plan = await api('/api/adopt/plan', { requestId }); } catch (e) { return fail('adopt', `Cannot adopt ${requestId}: ${why(e)}`); }
  clearFails('adopt');
  await openVersion(plan.versionId);
  const rows = [
    ['version', `${plan.versionId} (${plan.versionStatus})${plan.acceptsProposal ? ' — approving also accepts this proposal as HEAD' : ''}`],
    ['scene hash', plan.hash], ['agent says', plan.reason],
    ['writes', plan.writes.join('\n') + (plan.overwrites ? '\n(replaces the existing image)' : '')],
    ['final render', plan.needsFinalRender ? 'will run std/final first' : 'reuses the existing final render'],
    ['approval valid', `${plan.expiresInSec / 60} min, this scene only`],
  ];
  $('#adoptPlan').innerHTML = rows.map(([k, x]) => `<dt>${k}</dt><dd style="white-space:pre-wrap">${esc(x)}</dd>`).join('');
  // The images being decided on, inside the dialog (#58): what will be written, and what it replaces.
  const ex = plan.existing; const kb = /** @param {number | null} n */ (n) => (n == null ? '' : ` · ${(n / 1024).toFixed(0)} KB`);
  $('#adoptImages').innerHTML = `<figure><figcaption>Writes${plan.needsFinalRender ? ` <span class="flag">(${esc(plan.shows)} shown; rendered again at final quality before writing)</span>` : ' (the final render)'}</figcaption>
      ${plan.image ? `<img class="write" src="${esc(plan.image)}" alt="The image that will be written to ${esc(plan.writes[0])}">` : '<p class="hint">No render of this version yet.</p>'}</figure>
    ${ex ? `<figure><figcaption>Replaces ${esc(plan.writes[0])}${ex.modified ? ` · modified ${esc(new Date(ex.modified).toLocaleString())}` : ''}${kb(ex.bytes)}</figcaption>
      ${ex.image ? `<img class="existing" src="${esc(ex.image)}" alt="The image in the project now, which will be replaced">` : '<p class="flag">The existing file cannot be shown (not a plain file with a single link).</p>'}</figure>` : '<figure><figcaption>Replaces nothing (a new file)</figcaption></figure>'}`;
  /** @type {HTMLDialogElement} */ const dlg = $('#adoptDlg'); dlg.returnValue = ''; dlg.showModal();
  dlg.onclose = async () => {
    // Focus goes back to this request's Review… button (the list may have been redrawn while the dialog was open).
    if (dlg.returnValue !== 'approve') /** @type {HTMLElement | null} */ (document.querySelector(`#adoptList button[data-req="${requestId}"]`))?.focus();
    if (dlg.returnValue === 'reject') {
      try { await api('/api/adopt/reject', { requestId }); say(`Rejected ${requestId}`); }
      catch (e) { fail('adopt', `Cannot reject ${requestId}: ${why(e)}`); }
      return load();
    }
    if (dlg.returnValue !== 'approve') return say('Nothing written');
    try {
      const job = await api('/api/adopt', { ticket: plan.ticket });
      trackJob(job, async (j) => {
        await load();
        if (j.status === 'done') say(`Wrote ${j.result.asset}`); else if (j.status === 'cancelled') say('Adoption cancelled; the request is pending again');
        else if (j.status === 'failed') fail('adopt', `Adoption of ${requestId} failed: ${j.error}. Nothing was written; the request is pending again.`, { retry: () => reviewAdoption(requestId), retryLabel: 'Review again…' });
      });
    } catch (e) { fail('adopt', `Adoption refused: ${why(e)}`, { retry: () => reviewAdoption(requestId), retryLabel: 'Review again…' }); }
  };
}
const BASE_TITLE = document.title;
/** The proposal the notice announces, while it is shown. @type {string | null} */
let noticeFor = null;
const closeNotice = () => { noticeFor = null; $('#notice').hidden = true; document.title = BASE_TITLE; };
/** @param {string} id */
function notify(id) {
  // fixed on screen so it is seen while scrolled down; the tab title is marked until the proposal is opened, decided or dismissed
  const n = $('#notice'); n.hidden = false; document.title = `(1) ${BASE_TITLE}`; noticeFor = id;
  n.innerHTML = `New proposal <b>${esc(id)}</b> from your agent <button type="button" class="ghost">View</button><button type="button" class="ghost" aria-label="Dismiss">✕</button>`;
  const close = closeNotice;
  const [view, dismiss] = /** @type {NodeListOf<HTMLButtonElement>} */ (n.querySelectorAll('button'));
  view.onclick = async () => { close(); await openVersion(id); };
  dismiss.onclick = close;
  say(`New proposal ${id} from your agent. Press View to open it.`);
}
/** Shows, while polling fails, that Director does not answer: nothing on screen is current then (#53). @param {boolean} ok */
function connection(ok) {
  const bar = $('#conn');
  if (ok) { bar.hidden = true; delete bar.dataset.since; return; }
  bar.dataset.since ||= new Date().toLocaleTimeString();
  bar.hidden = false; bar.textContent = `Director is not responding (since ${bar.dataset.since}). What you see may be out of date; retrying every few seconds. If it stopped, start it again or ask your agent to call director_status.`;
}
// Agents act from outside the page: poll for new proposals, requests and reads.
setInterval(async () => {
  // Also while the tab is hidden: the "(1)" title mark is how a hidden tab shows a new proposal (browsers slow this timer down there).
  // Also while a job runs or a dialog is open (#54): the agent keeps working meanwhile, and load() keeps the version you view.
  if (!S.data) return;
  /** @type {Data | null} */
  const d = await api('/api/state').catch(() => null);
  connection(!!d);
  if (d && signature(d) !== S.sig) {
    const fresh = d.versions.filter((v) => !V(v.id) && v.origin === 'agent');
    await load(); // keeps the version you are viewing; never switches under your cursor
    if (fresh.length) notify(/** @type {Version} */ (fresh.at(-1)).id);
  }
}, 2500);

// ---------- versions ----------
/** Shows a version: the list, the inspector and the viewport follow. @param {string} id */
function openVersion(id) { S.viewId = id; renderVersions(); renderObjects(); renderReview(); renderInspector(); return drawViewport(); }
/** @param {Version} v */
function depth(v) { let /** @type {number} */ d = 0, /** @type {Version | undefined} */ p = v; while (p?.parent && d < 3) { const parent = V(p.parent); if (parent && S.data.versions.filter((x) => x.parent === parent.id && x.status !== 'discarded').length > 1) d++; p = parent; } return d; }
function renderVersions() {
  const list = $('#versionList'); list.innerHTML = '';
  for (const v of [...S.data.versions].reverse()) {
    const li = document.createElement('li'); li.className = `st-${discarding(v.id) ? 'discarded' : v.status} indent-${depth(v)}`;
    const title = v.origin === 'starter' ? 'Starter scene' : v.instruction;
    li.innerHTML = `<button aria-current="${v.id === S.viewId}" data-id="${v.id}">
      <span class="vid">${v.id}${v.parent ? ` ← ${v.parent}` : ''} ${v.id === S.data.head ? '<span class="headmark">● HEAD</span>' : ''}</span>
      <span class="badge ${v.origin}">${v.origin}</span>
      <span class="vtitle">${esc(title)}</span></button>`;
    /** @type {HTMLButtonElement} */ (li.querySelector('button')).onclick = () => { openVersion(v.id); say(`Viewing ${v.id}, ${v.status}`); };
    list.append(li);
  }
  renderJobs();
}

// ---------- viewport ----------
const /** @type {HTMLCanvasElement} */ cv = $('#canvas'), /** @type {HTMLCanvasElement} */ ov = $('#overlay'), ctx = /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d')), octx = /** @type {CanvasRenderingContext2D} */ (ov.getContext('2d'));
/**
 * @param {string} src
 * @returns {Promise<HTMLImageElement>}
 */
const loadImg = (src) => new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = src; });

/**
 * What a version is compared with, in the diff and in the wipe (#52). When its parent is not HEAD, the human chooses
 * between HEAD (what accepting it changes; the default for a proposal) and the parent (what this step changed).
 * @param {Version} v
 * @returns {{ id: string | null, kind: 'head' | 'parent', choice: boolean }}
 */
function baseOf(v) {
  const choice = !!v.headDiff;
  const kind = choice ? (S.diffBase[v.id] || (v.status === 'proposed' ? 'head' : 'parent')) : 'parent';
  return { id: kind === 'head' ? S.data.head : v.parent || null, kind, choice };
}
let drawSeq = 0;
/**
 * One line that says what the viewport shows: version, state, quality, what it is compared with, on page (#59).
 * Compare is disabled, with the reason beside it, when it cannot apply.
 * @param {Version} v
 * @param {Version | undefined} parent
 */
function renderViewState(v, parent) {
  const base = baseOf(v); const pr = parent?.renders[S.profile];
  $('#compareBase').textContent = base.kind === 'head' ? `HEAD (${base.id})` : 'parent';
  const noCompare = S.onPage ? 'not on page: the page shows one candidate' : !base.id ? `${v.id} has no parent` : !pr ? `${base.id} has no ${S.profile} render` : '';
  const box = /** @type {HTMLInputElement} */ ($('#compareToggle')); box.disabled = !!noCompare;
  $('#compareWhy').textContent = noCompare ? `(${noCompare})` : '';
  const shown = S.onPage ? `${v.renders[S.profile] ? S.profile : 'draft'} on page ${S.data.config.pageUrl || '(no pageUrl)'}` : `${S.profile}${S.compare && !noCompare ? ` · wipe: ◀ ${base.id} | ${v.id} ▶` : ''}`;
  $('#viewing').textContent = `Showing ${v.id} · ${v.status}${v.id === S.data.head ? ' · HEAD' : v.status === 'accepted' ? ' (not HEAD)' : ''} · ${shown} · scene ${v.hash}`;
}
/** @returns {Promise<void>} */
async function drawViewport() {
  if (S.onPage) return drawPage();
  // The poll, a finished job and the human can each redraw; only the latest draw may write to the canvas (#54).
  const seq = ++drawSeq; const stale = () => seq !== drawSeq;
  const v = viewV(); const r = v.renders[S.profile];
  delete cv.dataset.ready; // clicks are ignored until this view's object ids are loaded
  const p = /** @type {Version | undefined} */ (V(/** @type {string} */ (baseOf(v).id)));
  renderViewState(v, p);
  $('#empty').hidden = !!r;
  renderMeasure(r);
  if (!r) { ctx.clearRect(0, 0, cv.width, cv.height); octx.clearRect(0, 0, ov.width, ov.height); S.ids = null; return; }
  const img = await loadImg(r.image);
  const pr = p?.renders[S.profile];
  const imgB = S.compare && pr ? await loadImg(pr.image) : null;
  // ids is null for a render recorded before object ids were hashed: Director does not serve that file (#43).
  const buf = r.ids ? await (await fetch(r.ids)).arrayBuffer() : null;
  if (stale()) return;
  S.img = img; S.imgB = imgB; $('#wipe').hidden = !S.imgB;
  S.ids = buf && { w: r.width, h: r.height, arr: new Uint16Array(buf), objects: Object.fromEntries(r.objects.map((o) => [o.pass_index, o.name])) };
  for (const c of [cv, ov]) { c.width = r.width; c.height = r.height; }
  $('#viewport').style.aspectRatio = `${r.width} / ${r.height}`;
  paint();
  cv.dataset.ready = `${v.id}:${S.profile}`;
}
// The real page with the candidate substituted (server-side headless Chrome; project files untouched).
/** @returns {Promise<void>} */
async function drawPage() {
  const seq = ++drawSeq;
  delete cv.dataset.ready;
  const v = viewV(); const prof = v.renders[S.profile] ? S.profile : 'draft';
  renderViewState(v, undefined);
  octx.clearRect(0, 0, ov.width, ov.height); S.ids = null; $('#wipe').hidden = true;
  /** @type {PagePreview | undefined} */
  let pv = v.pagePreviews?.[prof];
  if (!pv) {
    $('#empty').hidden = false; $('#empty').textContent = 'Opening the page with this candidate…';
    pv = /** @type {PagePreview} */ (await api('/api/preview', { versionId: v.id, profile: prof }).catch((e) => ({ ok: false, reason: e.message })));
    if (pv.ok) (v.pagePreviews ||= {})[prof] = pv;
  }
  $('#empty').textContent = 'No render at this quality yet.';
  if (!pv.ok) {
    // The render is shown instead; the reason stays above the viewport with a retry (#53).
    S.onPage = false; $('#pageBtn').setAttribute('aria-pressed', 'false');
    fail('view', `Page preview of ${v.id} unavailable: ${pv.reason}. Showing the render instead.`, { retry: () => { S.onPage = true; $('#pageBtn').setAttribute('aria-pressed', 'true'); return drawViewport(); } });
    return drawViewport();
  }
  clearFails('view');
  $('#empty').hidden = true;
  const img = await loadImg(pv.image);
  if (seq !== drawSeq) return;
  for (const c of [cv, ov]) { c.width = img.width; c.height = img.height; }
  $('#viewport').style.aspectRatio = `${img.width} / ${img.height}`;
  ctx.clearRect(0, 0, cv.width, cv.height); ctx.drawImage(img, 0, 0);
  $('#measure').innerHTML = `<div><dt>page</dt><dd>${esc(S.data.config.pageUrl)}</dd></div><div><dt>substituted requests</dt><dd class="${pv.matched ? '' : 'warn'}">${pv.matched}</dd></div>` + (pv.warning ? `<div><dd class="warn">${esc(pv.warning)}</dd></div>` : '');
  if (pv.warning) say(pv.warning);
}
$('#pageBtn').addEventListener('click', () => {
  S.onPage = !S.onPage; $('#pageBtn').setAttribute('aria-pressed', String(S.onPage)); drawViewport();
});

function paint() {
  ctx.clearRect(0, 0, cv.width, cv.height); ctx.drawImage(S.img, 0, 0);
  if (S.imgB) {
    const x = Math.round(cv.width * /** @type {any} */ ($('#wipe')).value / 100);
    ctx.drawImage(S.imgB, 0, 0, x, cv.height, 0, 0, x, cv.height);
    ctx.fillStyle = '#3ee6f0'; ctx.fillRect(x - 1, 0, 2, cv.height);
    ctx.font = '600 14px system-ui'; ctx.fillStyle = '#fff';
    ctx.fillText(`◀ ${baseOf(viewV()).id}`, 10, 22); ctx.fillText(`${viewV().id} ▶`, cv.width - 70, 22);
  }
  paintOverlay();
}
function paintOverlay() {
  octx.clearRect(0, 0, ov.width, ov.height); if (!S.ids) return;
  const { w, h, arr, objects } = S.ids; const img = octx.createImageData(w, h); const d = img.data;
  for (let i = 0; i < arr.length; i++) {
    const name = objects[arr[i]]; if (!name) continue;
    const sel = S.selection.has(name), hov = name === S.hover;
    if (!sel && !hov) continue;
    // edge test: draw a solid outline plus a light fill
    const x = i % w, y = (i / w) | 0;
    const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 || arr[i - 1] !== arr[i] || arr[i + 1] !== arr[i] || arr[i - w] !== arr[i] || arr[i + w] !== arr[i];
    const o = i * 4;
    if (sel) { d[o] = 62; d[o + 1] = 230; d[o + 2] = 240; d[o + 3] = edge ? 255 : 46; }
    else { d[o] = 255; d[o + 1] = 255; d[o + 2] = 255; d[o + 3] = edge ? 200 : 22; }
  }
  octx.putImageData(img, 0, 0);
}
/**
 * @param {MouseEvent} ev
 * @returns {string | null}
 */
function pick(ev) {
  if (!S.ids) return null;
  const rect = cv.getBoundingClientRect();
  const x = Math.floor((ev.clientX - rect.left) / rect.width * S.ids.w), y = Math.floor((ev.clientY - rect.top) / rect.height * S.ids.h);
  return S.ids.objects[S.ids.arr[y * S.ids.w + x]] || null;
}
cv.addEventListener('mousemove', (ev) => {
  const n = pick(ev); const tip = $('#tip');
  if (n !== S.hover) { S.hover = n; paintOverlay(); }
  tip.hidden = !n; if (n) { const r = $('#viewport').getBoundingClientRect(); tip.style.left = `${ev.clientX - r.left}px`; tip.style.top = `${ev.clientY - r.top}px`; tip.textContent = n + (S.selection.has(n) ? ' · selected' : ' · click to select'); }
});
cv.addEventListener('mouseleave', () => { S.hover = null; $('#tip').hidden = true; paintOverlay(); });
cv.addEventListener('click', (ev) => { if (!cv.dataset.ready) return; const n = pick(ev); if (!n) { S.selection.clear(); renderObjects(); paintOverlay(); say('Selection cleared'); } else toggleSel(n, ev.shiftKey || ev.metaKey); });
$('#wipe').addEventListener('input', paint);
$('#objectFilter').addEventListener('input', () => renderObjects());
$('#compareToggle').addEventListener('change', (e) => { S.compare = /** @type {HTMLInputElement} */ (e.target).checked; drawViewport(); });
/** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('.seg button')).forEach((b) => b.addEventListener('click', () => {
  S.profile = /** @type {string} */ (b.dataset.profile); document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-checked', /** @type {string} */ (/** @type {unknown} */ (x === b)))); drawViewport();
}));

/**
 * @param {string} name
 * @param {boolean} additive
 */
function toggleSel(name, additive) {
  if (additive) S.selection.has(name) ? S.selection.delete(name) : S.selection.add(name);
  else { const only = S.selection.size === 1 && S.selection.has(name); S.selection.clear(); if (!only) S.selection.add(name); }
  renderObjects(); paintOverlay(); say(S.selection.size ? `Selected: ${[...S.selection].join(', ')}` : 'Selection cleared');
}

/** @param {Render | undefined} r */
function renderMeasure(r) {
  const m = $('#measure');
  if (!r) { m.innerHTML = ''; return; }
  const e = r.exposure; const pct = /** @param {number} x */ (x) => `${(x * 100).toFixed(1)}%`;
  m.innerHTML = [
    ['render', `${r.profile} · ${r.seconds.toFixed(2)}s`], ['integrator', `${r.settings.integrator} · ${r.settings.samples} spp`],
    ['mean', e.mean.toFixed(3)], ['clipped', pct(e.clipped), e.clipped > 0.01], ['near-black', pct(e.near_black), e.near_black > 0.05],
    ['warnings', r.warnings.length, r.warnings.length > 0],
  ].map(([k, v, w]) => `<div><dt>${k}</dt><dd class="${w ? 'warn' : ''}">${esc(v)}</dd></div>`).join('')
    + (r.ids ? '' : `<div><dd class="warn">Object ids of this render predate recorded hashes, so clicking cannot select. ${r.profile === 'final' ? 'Plan the final render again to fix it.' : `<button type="button" class="ghost" id="rerender">Render ${esc(r.profile)} again</button>`}</dd></div>`);
  const again = /** @type {HTMLButtonElement | null} */ (m.querySelector('#rerender'));
  if (again) again.onclick = async () => {
    try { trackJob(await api('/api/render', { versionId: S.viewId, profile: r.profile }), () => load()); }
    catch (e) { fail('view', `Could not start the render: ${why(e)}`); }
  };
}

// ---------- objects & direct manipulation ----------
const OBJECT_CAP = 200;
let objPins = { base: '', names: /** @type {Set<string>} */ (new Set()) };
// Rebuilds the list only when the version or the filter changes; a selection change only updates the rows already shown.
function renderObjects() {
  const scene = viewV().scene; const list = $('#objectList');
  const filter = /** @type {HTMLInputElement} */ ($('#objectFilter')).value.trim().toLowerCase();
  for (const s of [...S.selection]) if (!scene.nodes.some((n) => n.name === s)) S.selection.delete(s);
  // An object selected past the cap is listed first (#46) and stays listed, also once deselected, until the version or
  // the filter changes: a row does not vanish under the pointer.
  const base = `${S.viewId}\n${filter}`;
  if (base !== objPins.base) objPins = { base, names: new Set() };
  for (const s of S.selection) objPins.names.add(s);
  const { shown, pinned, rest, matches } = visibleObjects(scene.nodes, filter, objPins.names, OBJECT_CAP);
  const key = `${base}\n${pinned.join()}`;
  if (key !== S.objKey) {
    S.objKey = key; list.innerHTML = '';
    for (const n of shown) {
      const li = document.createElement('li'); li.dataset.name = n.name;
      li.innerHTML = `<label><input type="checkbox"> ${esc(n.name)} <span class="kind">${esc(n.type)}${n.type === 'light' ? ' ' + esc(n.shape) : ''}</span></label>`;
      /** @type {HTMLInputElement} */ (li.querySelector('input')).onchange = () => toggleSel(n.name, true);
      list.append(li);
    }
    const more = $('#objectMore');
    more.hidden = matches ? rest <= 0 : !filter; more.textContent = matches ? `${rest} more — type to filter` : 'No objects match';
  }
  for (const li of /** @type {HTMLCollectionOf<HTMLElement>} */ (list.children)) {
    const sel = S.selection.has(/** @type {string} */ (li.dataset.name));
    /** @type {HTMLElement} */ (li.querySelector('label')).classList.toggle('sel', sel); /** @type {HTMLInputElement} */ (li.querySelector('input')).checked = sel;
  }
  $('#selCount').textContent = S.selection.size ? `(${[...S.selection].join(', ')})` : '(none)';
  if (S.data) renderTarget();
  renderQuick(scene);
}
/** @param {Scene} scene */
function renderQuick(scene) {
  const q = $('#quick'); q.innerHTML = '';
  const v = viewV();
  if (v.status !== 'accepted') {
    // Say why, next to what lifts it (#59).
    q.innerHTML = `<p class="hint">Direct edits start from an accepted version; ${esc(v.id)} is ${esc(v.status)}.</p><div class="btnrow">${v.status === 'proposed' && !discarding(v.id) ? '<button type="button" class="ghost" id="qAccept">Accept this proposal</button>' : ''}<button type="button" class="ghost" id="qHead">Open HEAD (${esc(S.data.head)})</button></div>`;
    $('#qHead').onclick = () => openVersion(S.data.head);
    const acc = /** @type {HTMLButtonElement | null} */ (q.querySelector('#qAccept')); if (acc) acc.onclick = () => decide('accept', v.id);
    return;
  }
  if (S.selection.size !== 1) { q.innerHTML = S.selection.size ? '' : '<p class="hint">Select one object to edit it directly, without the agent.</p>'; return; }
  const n = scene.nodes.find((x) => x.name === [...S.selection][0]); if (!n) return;
  /** @type {QuickRow[]} */
  const rows = [];
  if (n.type === 'mesh') {
    const inp = n.materials?.[0]?.inputs || {};
    if (isColor(inp.base_color) || inp.base_color === undefined) rows.push(['base_color', 'Base colour', 'color', inp.base_color || [0.8, 0.8, 0.8]]);
    rows.push(['specular_roughness', 'Roughness', 'range', inp.specular_roughness ?? 0.5, 0, 1, 0.01]);
    rows.push(['emission_luminance', 'Emission (nits)', 'range', inp.emission_luminance ?? 0, 0, 100, 1]);
  } else if (n.type === 'light') {
    rows.push(['energy', n.shape === 'sun' ? 'Energy (W/m²)' : 'Energy (W)', 'range', n.energy ?? 100, 0, 3000, 10]);
    if (isColor(n.color)) rows.push(['color', 'Colour', 'color', n.color]);
  }
  if (!rows.length) { q.innerHTML = '<p class="hint">No direct controls for this object type. Ask the agent instead.</p>'; return; }
  q.insertAdjacentHTML('beforeend', `<p class="hint">Direct edit of <b>${esc(n.name)}</b> creates a new human version from ${viewV().id}. Changes apply on release.</p>`);
  for (const [field, label, kind, val, min, max, stepv] of rows) {
    const row = document.createElement('label'); row.className = 'row';
    row.innerHTML = kind === 'color'
      ? `<span>${label}</span><input type="color" value="${linToHex(val)}"><output>${val.map(/** @param {number} c */ (c) => c.toFixed(2)).join(',')}</output>`
      : `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${stepv}" value="${esc(Number(val))}"><output>${esc(Number(val))}</output>`;
    const input = /** @type {HTMLInputElement} */ (row.querySelector('input')), out = /** @type {HTMLOutputElement} */ (row.querySelector('output'));
    input.addEventListener('input', () => (out.textContent = kind === 'color' ? hexToLin(input.value).map((c) => c.toFixed(2)).join(',') : input.value));
    input.addEventListener('change', () => directEdit(n.name, field, kind === 'color' ? hexToLin(input.value) : Number(input.value)));
    q.append(row);
  }
}
/**
 * @param {string} node
 * @param {string} field
 * @param {unknown} value
 */
async function directEdit(node, field, value) {
  if (S.editing) return;
  S.editing = true; // set synchronously so a second change event cannot fork a duplicate version
  try {
    const r = await api('/api/edit', { baseId: S.viewId, node, field, value });
    clearFails('edit'); S.viewId = r.version; await load(); say(`Created ${r.version}`);
    trackJob(r.job, () => load());
  } catch (e) { fail('edit', `Edit of ${node}.${field} failed: ${why(e)}`); }
  finally { S.editing = false; }
}

// ---------- ask the agent ----------
const STARTERS = [
  '夜のシーンにして、seedの光だけで部屋を照らす',
  '選択した物体をマットな陶器に変える',
  'カメラを低くして見上げる構図にする',
  'rimライトを強めて輪郭を際立たせる',
];
$('#starters').innerHTML = STARTERS.map((s) => `<button type="button">${esc(s)}</button>`).join('');
$('#starters').querySelectorAll('button').forEach((b) => (b.onclick = () => { /** @type {HTMLTextAreaElement} */ ($('#instruction')).value = /** @type {string} */ (b.textContent); $('#instruction').focus(); }));

$('#askForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const instruction = /** @type {HTMLTextAreaElement} */ ($('#instruction')).value.trim(); if (!instruction) return $('#instruction').focus();
  if (ADE()) {
    try { await api('/api/feedback', { versionId: askTarget(), selection: [...S.selection], comment: instruction }); /** @type {HTMLTextAreaElement} */ ($('#instruction')).value = ''; clearFails('ask'); say('Sent to your agent'); await load(); }
    catch (err) { fail('ask', `Could not send: ${why(err)}. Your text is kept.`); }
    return;
  }
  const baseId = askTarget();
  if (runningJob(baseId, 'propose')) return fail('ask', `A proposal from ${baseId} is already being made. Wait for it or cancel it, then propose again.`);
  try {
    const job = await api('/api/propose', {
      baseId, instruction, selection: [...S.selection],
      context: { selection: /** @type {HTMLInputElement} */ ($('#ctxSelection')).checked, exposure: /** @type {HTMLInputElement} */ ($('#ctxExposure')).checked, history: /** @type {HTMLInputElement} */ ($('#ctxHistory')).checked },
    });
    clearFails('ask'); say(`Proposal requested from ${baseId}`);
    trackJob(job, async (j) => {
      S.lastResult = j;
      await load();
      if (j.status === 'done' && j.result?.kind === 'proposal') await openVersion(j.result.versionId); else renderReview();
    });
  } catch (err) { fail('ask', `Could not start: ${why(err)}. Your request is kept.`); }
});

// ---------- jobs ----------
// Jobs run in the background, each tied to a version (#54): the page keeps polling, other versions can be viewed and
// compared, and only a second job of the same kind on the same version is refused. Finished jobs that failed or were
// cancelled stay listed until dismissed.
/** @type {Map<string, Job>} */
const JOBS = new Map();
/** @param {string} versionId @param {string} [kind] */
const runningJob = (versionId, kind) => [...JOBS.values()].find((j) => j.status === 'running' && j.versionId === versionId && (!kind || j.kind === kind));
const JOB_TITLE = /** @type {Record<string, string>} */ ({ render: 'Render', propose: 'Proposal from', adopt: 'Adoption of' });
function renderJobs() {
  const jobs = [...JOBS.values()];
  $('#jobBox').hidden = !jobs.length;
  $('#jobList').innerHTML = jobs.map((j) => `<li class="jobrow" data-job="${esc(j.id)}" data-status="${esc(j.status)}" data-version="${esc(j.versionId)}">
    <div class="jobhead"><b>${esc(JOB_TITLE[j.kind] || j.kind)} ${esc(j.versionId)}</b><span class="hint">${esc(j.status === 'running' ? `elapsed ${(j.elapsed / 1000).toFixed(0)}s (no ETA: agent and GPU time vary)` : j.status)}</span>
      ${j.status === 'running' ? `<button type="button" class="ghost" data-cancel-job="${esc(j.id)}">Cancel</button>` : `<button type="button" class="ghost" data-dismiss-job="${esc(j.id)}" aria-label="Dismiss">✕</button>`}</div>
    <ol class="steps">${j.steps.map((st) => `<li class="${st.status}"><span class="ic" aria-hidden="true"></span><span>${esc(st.label)}</span><span class="t">${(st.t / 1000).toFixed(1)}s</span>${st.detail ? `<pre>${esc(st.detail)}</pre>` : ''}</li>`).join('')}</ol></li>`).join('');
  $('#jobList').querySelectorAll('button[data-cancel-job]').forEach((b) => (/** @type {HTMLButtonElement} */ (b).onclick = () => api(`/api/jobs/${/** @type {HTMLButtonElement} */ (b).dataset.cancelJob}/cancel`, {}).catch((e) => fail('view', `Cannot cancel: ${why(e)}`))));
  $('#jobList').querySelectorAll('button[data-dismiss-job]').forEach((b) => (/** @type {HTMLButtonElement} */ (b).onclick = () => { JOBS.delete(/** @type {string} */ (/** @type {HTMLButtonElement} */ (b).dataset.dismissJob)); renderJobs(); }));
  // The version list marks versions with a running job; the final render waits for the viewed version's jobs.
  for (const li of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('#versionList button[data-id]'))) li.classList.toggle('busy', !!runningJob(/** @type {string} */ (li.dataset.id)));
  renderBusy(); renderTarget();
}
/** Where the text in the box goes: the version on screen, shown above the box and following every switch (#59). */
function askTarget() { const v = viewV(); return !ADE() && v.status === 'discarded' ? S.data.head : v.id; }
function renderTarget() {
  const v = viewV(); const to = askTarget(); const t = V(to);
  $('#askTarget').innerHTML = ADE()
    ? `Feedback on <b>${esc(to)}</b> <span class="hint">(${esc(t?.status)}${S.selection.size ? `, with ${S.selection.size} selected object${S.selection.size > 1 ? 's' : ''}` : ''})</span>`
    : `New proposal based on <b>${esc(to)}</b>${to !== v.id ? ` <span class="hint">(${esc(v.id)} is discarded, so HEAD)</span>` : ''}`;
}
/** Says next to a button why it cannot be used while a job of the viewed version runs. */
function renderBusy() {
  if (!S.data) return;
  const busy = runningJob(S.viewId);
  /** @type {HTMLButtonElement} */ ($('#finalBtn')).disabled = !!busy;
  $('#finalBusy').hidden = !busy; $('#finalBusy').textContent = busy ? `${S.viewId} has a running job (${busy.kind}); plan the final render when it ends.` : '';
}
/**
 * @param {Job} job
 * @param {(j: Job) => unknown} [onEnd]
 */
function trackJob(job, onEnd) {
  JOBS.set(job.id, job); renderJobs();
  let lastCount = 0;
  const tick = async () => {
    // 'no job': Director drops finished jobs after a while (#32); treat it as ended instead of polling forever.
    // Any other failure (Director not answering): keep asking; the connection banner says what is going on.
    /** @type {Job | null} */
    const j = await api(`/api/jobs/${job.id}`).catch((e) => (why(e) === 'no job' ? { ...job, status: 'gone' } : null));
    if (!j) return setTimeout(tick, 2000);
    if (j.steps.length !== lastCount) { lastCount = j.steps.length; say(j.steps.at(-1)?.label || ''); }
    if (j.status === 'gone') {
      // The result is unknown here (the tab did not poll for over 10 minutes); the reloaded state shows what happened.
      JOBS.delete(job.id); renderJobs();
      await load(); say('The job ended while this tab was not watching it; the versions and requests show the result');
      return;
    }
    JOBS.set(job.id, j); renderJobs();
    if (j.status === 'running') return setTimeout(tick, 500);
    say(j.status === 'done' ? 'Finished' : `Stopped: ${j.error || j.status}`);
    await onEnd?.(j);
    if (j.status === 'done') setTimeout(() => { JOBS.delete(job.id); renderJobs(); }, 1500);
  };
  tick();
}

// ---------- review ----------
/** @param {string} id @param {'head' | 'parent'} kind */
function setBase(id, kind) { S.diffBase[id] = kind; renderReview(); drawViewport(); say(`Changes against ${kind === 'head' ? 'HEAD' : 'the parent'}`); }
/** @param {unknown} v */
function fmt(v) {
  if (v === undefined) return '<span class="hint">—</span>';
  const s = esc(JSON.stringify(v));
  return isColor(v) ? `<span class="swatch" style="background:${linToHex(v)}"></span>${s}` : s;
}
/**
 * What a "prefix*" claim covers, by name stem: "→ 401 nodes: b0 … b399 (400), backdrop". Names of more than one stem
 * are flagged, because a short prefix can hide an unrelated change among the claimed ones (#47).
 * @param {string[]} names
 */
function wildNote(names) {
  const mixed = nameRuns(names).length > 1;
  return ` <span class="${mixed ? 'flag' : 'hint'}">→ ${names.length} node${names.length === 1 ? '' : 's'}${names.length ? `: ${esc(describeNames(names))}` : ''}${mixed ? ' · check each name' : ''}</span>`;
}
function renderReview() {
  const box = $('#review'); const v = viewV(); const r = S.lastResult;
  // The notice is done once its proposal is on screen or no longer a proposal.
  if (noticeFor === v.id || (noticeFor && V(noticeFor)?.status !== 'proposed')) closeNotice();
  // failure / question states from the last agent job (not tied to a version)
  if (r && r.result && ['question', 'blocked', 'invalid'].includes(r.result.kind) && r.versionId === S.viewId) {
    const p = r.result.proposal || {};
    box.hidden = false;
    box.innerHTML = r.result.kind === 'question'
      ? `<h3>Agent asks before changing anything</h3><p class="interp">${esc(p.clarifying_question)}</p><p class="hint">Your request is kept in the box below. Add the missing detail and propose again.</p>`
      : `<h3 class="flag bad">No version was created</h3><p>${r.result.kind === 'blocked' ? 'The proposal broke a project rule enforced outside the model:' : 'vork rejected the scene twice. Last error:'}</p>
         <pre class="hint" style="white-space:pre-wrap">${esc(r.result.kind === 'blocked' ? r.result.policy.blockers.join('\n') : r.result.log?.slice(-800))}</pre>
         <p class="hint">Your request is kept. Try rephrasing, narrowing the selection, or edit directly.</p>`;
    box.insertAdjacentHTML('beforeend', `<div class="btnrow"><button class="ghost" id="dismiss">Dismiss</button></div>`);
    $('#dismiss').onclick = () => { S.lastResult = null; renderReview(); };
    return;
  }
  if (v.origin !== 'agent') { box.hidden = true; return; }
  const p = v.proposal; const base = baseOf(v); const diff = base.kind === 'head' ? /** @type {Diff[]} */ (v.headDiff) : v.diff;
  // Against HEAD, the claims of the unaccepted versions in between count too: they describe changes this one carries.
  const between = []; for (let a = V(/** @type {string} */ (v.parent)); base.kind === 'head' && a && a.id !== S.data.head && a.status !== 'accepted'; a = V(/** @type {string} */ (a.parent))) between.push(a);
  const claims = [...p.claimed_changes, ...between.flatMap((a) => a.proposal?.claimed_changes || [])];
  const { isClaimed, wildMatches, ghost } = checkClaims(claims, diff);
  const typeOf = new Map([...(V(/** @type {string} */ (base.id))?.scene.nodes || []), ...v.scene.nodes].map((n) => [n.name, n.type]));
  const { groups: groupList, rest } = groupDiff(diff, typeOf);
  /** @param {Diff} d */
  const row = (d) => `<tr class="${isClaimed(d) ? '' : 'unclaimed'}"><td>${esc(d.node)}${d.path ? '.' + esc(d.path) : ''}</td><td>${fmt(d.before)}</td><td>${fmt(d.after)}</td></tr>`;
  /** @param {Diff[]} ds */
  const unclaimedNote = (ds) => { const u = ds.filter((d) => !isClaimed(d)).length; return u ? ` <span class="flag">· ⚠ ${u} not mentioned</span>` : ''; };
  const CAP = 200; const hidden = rest.slice(CAP);
  const diffRows = groupList.map(({ type, kind, ds }, i) => `<tr class="group"><td colspan="3"><details data-group="${i}"><summary>${ds.length} ${esc(type)} node${ds.length > 1 ? 's' : ''} ${esc(kind)}: ${esc(describeNames(ds.map((d) => d.node)))}${unclaimedNote(ds)}</summary><table class="difftable"><tbody></tbody></table></details></td></tr>`).join('')
    + rest.slice(0, CAP).map(row).join('')
    + (hidden.length ? `<tr class="group"><td colspan="3"><button type="button" class="ghost" id="moreDiff">Show remaining ${hidden.length} rows</button>${unclaimedNote(hidden)}</td></tr>` : '');
  // The poll re-renders this panel; keep what the human opened in the diff while it shows the same version.
  const same = box.dataset.view === `${v.id}:${base.kind}`;
  const openGroups = same ? [...box.querySelectorAll('details[data-group]')].filter((el) => /** @type {HTMLDetailsElement} */ (el).open).map((el) => /** @type {HTMLElement} */ (el).dataset.group) : [];
  const shownMore = same && box.dataset.more === '1';
  box.dataset.view = `${v.id}:${base.kind}`; box.dataset.more = shownMore ? '1' : '';
  box.hidden = false;
  box.innerHTML = `
    ${base.choice ? `<div class="basepick" role="radiogroup" aria-label="Changes against">
      <span>Changes against</span>
      <label class="chk"><input type="radio" name="diffBase" value="head" ${base.kind === 'head' ? 'checked' : ''}> HEAD ${esc(S.data.head)} <span class="hint">(what accepting changes)</span></label>
      <label class="chk"><input type="radio" name="diffBase" value="parent" ${base.kind === 'parent' ? 'checked' : ''}> parent ${esc(v.parent)} <span class="hint">(this step only)</span></label></div>
      ${base.kind === 'head'
        ? (between.length ? `<p class="hint">Includes the changes of ${between.map((a) => esc(a.id)).join(', ')} (${esc(V(/** @type {string} */ (v.parent))?.status)}), which accepting this also accepts; their claims count below.</p>` : '')
        : `<p class="flag">⚠ Built on ${esc(v.parent)}, which is ${esc(V(/** @type {string} */ (v.parent))?.status)}. Accepting this also accepts that version's changes, not shown here. <button type="button" class="ghost" id="showHeadDiff">Show changes against HEAD</button></p>`}` : ''}
    <div><h3>Request</h3>${esc(v.instruction)}</div>
    <div><h3>Agent's reading</h3><p class="interp">${esc(p.interpretation)}</p>
      ${p.assumptions.length ? `<ul>${p.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}</div>
    <div><h3>What the agent says it changed</h3><ul>${p.claimed_changes.map((c) => `<li><b>${esc(c.node)}</b>${isWildcard(c.node) ? wildNote(wildMatches.get(c.node) || []) : ''}: ${esc(c.what)} <span class="hint">— ${esc(c.why)}</span></li>`).join('')}</ul></div>
    <div><h3>What actually changed (computed from the scene)</h3>
      <table class="difftable"><thead><tr><th>node.field</th><th>before</th><th>after</th></tr></thead><tbody>
      ${diffRows || '<tr><td colspan="3">No changes</td></tr>'}
      </tbody></table>
      ${ghost.length ? `<p class="flag">⚠ Claimed but not changed: ${ghost.map(esc).join(', ')}</p>` : ''}</div>
    ${p.policy.flags.length ? `<div><h3>Needs attention</h3><ul>${p.policy.flags.map((f) => `<li class="flag">${f.level}: ${esc(f.msg)}</li>`).join('')}</ul></div>` : ''}
    <details><summary class="hint">Context that was sent</summary><pre class="hint" style="white-space:pre-wrap">${esc(p.context.join('\n\n') || 'scene only')}</pre></details>
    <p class="hint">${p.via === 'mcp' ? 'Proposed by your ADE agent via MCP' : `Agent cost ${p.cost ? '$' + p.cost.toFixed(3) : 'n/a'}`}. Judge the image, not the explanation.</p>`;
  box.querySelectorAll('input[name=diffBase]').forEach((el) => el.addEventListener('change', () => setBase(v.id, /** @type {'head' | 'parent'} */ (/** @type {HTMLInputElement} */ (el).value))));
  const toHead = box.querySelector('#showHeadDiff'); if (toHead) /** @type {HTMLButtonElement} */ (toHead).onclick = () => setBase(v.id, 'head');
  // rows inside a group or past the cap are built only when the human opens them
  box.querySelectorAll('details[data-group]').forEach((el) => el.addEventListener('toggle', () => {
    const tb = /** @type {HTMLElement} */ (el.querySelector('tbody'));
    if (/** @type {HTMLDetailsElement} */ (el).open && !tb.children.length) tb.innerHTML = groupList[Number(/** @type {HTMLElement} */ (el).dataset.group)].ds.map(row).join('');
  }));
  const more = box.querySelector('#moreDiff'); if (more) /** @type {HTMLButtonElement} */ (more).onclick = () => { box.dataset.more = '1'; /** @type {HTMLElement} */ (more.closest('tr')).outerHTML = hidden.map(row).join(''); };
  for (const g of openGroups) /** @type {HTMLDetailsElement | null} */ (box.querySelector(`details[data-group="${g}"]`))?.setAttribute('open', '');
  if (shownMore && more) /** @type {HTMLButtonElement} */ (more).click();
}

// ---------- inspector head: the version on screen and what can be done with it (#56) ----------
const STATUS_TEXT = /** @type {Record<string, string>} */ ({ proposed: 'Proposal — not applied yet', accepted: 'Accepted', discarded: 'Discarded' });
function renderInspector() {
  const v = viewV();
  if (finalPlan && finalPlan.versionId !== v.id) closeFinalPlan();
  $('#h-insp').textContent = `${v.id} · ${v.origin === 'starter' ? 'Starter scene' : STATUS_TEXT[v.status] || v.status}`;
  $('#vstate').innerHTML = [
    v.id === S.data.head ? '<b>HEAD</b>' : v.status === 'accepted' ? 'accepted, not HEAD' : '',
    v.parent ? `from ${esc(v.parent)}` : '', `by ${esc(v.origin)}`,
  ].filter(Boolean).join(' · ');
  const box = $('#decide');
  if (discarding(v.id)) {
    box.innerHTML = `<span class="flag">Will be discarded in a few seconds</span><button class="ghost" id="undoHere">Undo discard</button>`;
    /** @type {HTMLButtonElement} */ ($('#undoHere')).onclick = undoDiscard;
  } else if (v.status === 'accepted' && v.id !== S.data.head) {
    box.innerHTML = `<button class="ghost" id="headBtn">Make HEAD</button>`;
    /** @type {HTMLButtonElement} */ ($('#headBtn')).onclick = () => checkout(v.id);
  } else box.innerHTML = v.status === 'proposed' ? `<button class="primary" id="acceptBtn">Accept as new HEAD</button>
    <button class="ghost" id="refineBtn">Refine from this</button>
    <button class="ghost danger" id="discardBtn">Discard</button>` : '';
  if (v.status === 'proposed' && !discarding(v.id)) {
    $('#acceptBtn').onclick = () => decide('accept');
    $('#discardBtn').onclick = () => decide('discard');
    $('#refineBtn').onclick = () => $('#instruction').focus(); // the box already says it goes to this version (#59)
  }
  $('#finalBtn').hidden = v.status === 'discarded';
  // adoption requests of this version, next to its actions
  const reqs = (S.data.adoptionRequests || []).filter((a) => a.version === v.id && (a.status === 'pending' || a.status === 'adopting'));
  $('#vrequests').hidden = !reqs.length;
  $('#vrequests').innerHTML = reqs.map((a) => `<li><span>Adoption request <b>${esc(a.slug)}</b></span>${a.status === 'adopting' ? '<span class="hint">adopting…</span>' : `<button class="ghost" data-req="${esc(a.id)}">Review…</button>`}</li>`).join('');
  $('#vrequests').querySelectorAll('button[data-req]').forEach((b) => (/** @type {HTMLButtonElement} */ (b).onclick = () => reviewAdoption(/** @type {HTMLButtonElement} */ (b).dataset.req)));
  renderBusy();
}
/** @param {string} decision @param {string} [id] */
async function decide(decision, id = S.viewId) {
  if (decision === 'discard') return discardLater(id);
  try { await api('/api/decide', { versionId: id, decision }); }
  catch (e) { return fail('review', `Cannot ${decision} ${id}: ${why(e)}`); }
  clearFails('review');
  /** @type {HTMLTextAreaElement} */ ($('#instruction')).value = '';
  await load(); say(`${id} is now HEAD`);
}

/** Makes an accepted version HEAD again: this is how an Accept is taken back (#55). @param {string} id */
async function checkout(id) {
  try { await api('/api/checkout', { versionId: id }); }
  catch (e) { return fail('review', `Cannot make ${id} HEAD: ${why(e)}`); }
  clearFails('review'); await load(); say(`${id} is now HEAD`);
}

// Discard can be undone for a few seconds (#55): the decision reaches Director, and through it the agent (with the
// rejection of pending adoption requests), only when the time is up. Closing the tab before then discards nothing.
const UNDO_MS = 6000;
/** @type {{ id: string, timer: number, ends: number } | null} */
let pendingDiscard = null;
/** @param {string} id */
function discardLater(id) {
  if (pendingDiscard) commitDiscard(); // one at a time: the earlier one is decided now
  pendingDiscard = { id, timer: window.setTimeout(commitDiscard, UNDO_MS), ends: Date.now() + UNDO_MS };
  renderVersions(); renderInspector(); renderUndo();
  say(`${id} will be discarded in ${UNDO_MS / 1000} seconds. Press Undo to keep it.`);
}
function undoDiscard() {
  if (!pendingDiscard) return;
  const { id } = pendingDiscard; clearTimeout(pendingDiscard.timer); pendingDiscard = null;
  renderVersions(); renderInspector(); renderUndo(); say(`${id} kept`);
  if (S.viewId === id) $('#acceptBtn')?.focus();
}
async function commitDiscard() {
  if (!pendingDiscard) return;
  const { id } = pendingDiscard; clearTimeout(pendingDiscard.timer); pendingDiscard = null; renderUndo();
  try { await api('/api/decide', { versionId: id, decision: 'discard' }); }
  catch (e) { renderVersions(); renderInspector(); return fail('review', `Cannot discard ${id}: ${why(e)}`); }
  clearFails('review');
  if (S.viewId === id) S.viewId = /** @type {string} */ (/** @type {Version} */ (V(id)).parent);
  await load(); say(`${id} discarded`);
}
function renderUndo() {
  const bar = $('#undoBar');
  if (!pendingDiscard) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.innerHTML = `<span><b>${esc(pendingDiscard.id)}</b> will be discarded</span><button type="button" class="ghost" id="undoBtn">Undo</button>`;
  /** @type {HTMLButtonElement} */ ($('#undoBtn')).onclick = undoDiscard;
}
/** @param {string} id */
const discarding = (id) => pendingDiscard?.id === id;

// ---------- final render ----------
// The plan opens inline in the inspector, not in a modal (#57): the render and the wipe stay usable while deciding.
// A final render writes only into the version's folder (it replaces that version's previous final) and can be made
// again, so nothing needs to lock the page. The approval stays explicit and bound to the scene hash by the server.
/** @type {{ versionId: string, ticket: string } | null} */
let finalPlan = null;
/** @param {boolean} [refocus] */
function closeFinalPlan(refocus = false) {
  if (!finalPlan && $('#finalPlanBox').hidden) return;
  finalPlan = null; $('#finalPlanBox').hidden = true; $('#finalPlan').innerHTML = '';
  if (refocus) $('#finalBtn').focus();
}
$('#finalBtn').addEventListener('click', async () => {
  const v = viewV();
  if (v.status === 'discarded') return fail('final', `${v.id} is discarded; discarded versions cannot be rendered at final quality.`);
  /** @type {FinalPlan} */
  let plan;
  try { plan = await api('/api/final/plan', { versionId: v.id }); } catch (e) { return fail('final', `Cannot plan a final render of ${v.id}: ${why(e)}`); }
  if (S.viewId !== v.id) return; // the human moved on while the plan was requested
  clearFails('final');
  const rows = [
    ['version', `${plan.versionId}${v.status === 'proposed' ? ' (unaccepted proposal)' : ''}`], ['scene hash', plan.hash], ['profile', plan.profile],
    ['resolution', plan.resolution.join(' × ')], ['writes', plan.output + (plan.overwrites ? ' (replaces previous final)' : '')],
    ['time', `not predicted · ${plan.reference} · hard stop at ${plan.timeoutSec}s`], ['approval valid', `${plan.expiresInSec / 60} min, this scene only`],
  ];
  $('#finalPlan').innerHTML = rows.map(([k, x]) => `<dt>${k}</dt><dd>${esc(x)}</dd>`).join('') +
    (plan.flags.length ? `<dt class="flag">attention</dt><dd>${plan.flags.map((f) => esc(f.msg)).join('<br>')}</dd>` : '');
  $('#h-fplan').textContent = `Final render of ${plan.versionId}`;
  finalPlan = { versionId: plan.versionId, ticket: plan.ticket };
  $('#finalPlanBox').hidden = false; $('#h-fplan').focus();
  say(`Final render plan for ${plan.versionId}. Approve and render, or cancel.`);
});
$('#finalCancel').addEventListener('click', () => { closeFinalPlan(true); say('Final render not started'); });
$('#finalPlanBox').addEventListener('keydown', (e) => { if (/** @type {KeyboardEvent} */ (e).key === 'Escape') { closeFinalPlan(true); say('Final render not started'); } });
$('#finalApprove').addEventListener('click', async () => {
  const plan = finalPlan;
  // The plan is for the version on screen only; the inspector closes it when the view changes.
  if (!plan || plan.versionId !== S.viewId) return closeFinalPlan(true);
  closeFinalPlan(true);
  try {
    const job = await api('/api/render', { versionId: plan.versionId, profile: 'final', ticket: plan.ticket });
    trackJob(job, async (j) => { await load(); if (j.status === 'done' && S.viewId === plan.versionId) { /** @type {HTMLElement} */ (document.querySelector('[data-profile="final"]')).click(); } });
  } catch (e) { fail('final', `Final render of ${plan.versionId} refused: ${why(e)}. Plan it again.`, { retry: () => $('#finalBtn').click(), retryLabel: 'Plan again…' }); }
});

function renderAudit() {
  $('#audit').innerHTML = [...S.data.audit].reverse().map((a) => `<li>${a.t.slice(11, 19)} ${esc(a.event)} ${esc(a.version || '')} ${a.instruction ? '· ' + esc(a.instruction).slice(0, 40) : ''}</li>`).join('');
}

// ---------- boot ----------
// Pair this tab with Director using the one-time link Director opened, then drop the token from the URL.
const pairMatch = location.hash.match(/^#pair=([0-9a-f]+)$/);
if (pairMatch) {
  await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: pairMatch[1] }) });
  history.replaceState(null, '', location.pathname);
}
try { await load(false); }
catch (e) {
  /** @type {HTMLElement} */ (document.querySelector('main')).innerHTML = `<section class="unpaired" role="alert"><h2>This tab is not paired with Director</h2>
    <p>Director opens a paired tab by itself when it starts. Ask your agent to call <code>open_review_tab</code>, or run <code>node server.mts</code> in a terminal and open the one-time link it prints.</p>
    <p class="hint">${esc(/** @type {Error} */ (e).message)}</p></section>`;
  throw e;
}
if (!viewV().renders.draft) {
  const job = await api('/api/render', { versionId: S.viewId, profile: 'draft' });
  trackJob(job, async () => { const j2 = await api('/api/render', { versionId: S.viewId, profile: 'previs' }); trackJob(j2, () => load()); });
}
