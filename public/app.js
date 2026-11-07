import { isWildcard, checkClaims, groupDiff, nameRuns, describeNames } from './review-model.js';

// ---------- types (JSDoc only; no runtime effect) ----------
/** @typedef {{ pass_index: number, name: string }} RenderObject */
/** @typedef {{ image: string, ids: string | null, width: number, height: number, objects: RenderObject[], profile: string, seconds: number, settings: { integrator: string, samples: number }, exposure: { mean: number, clipped: number, near_black: number }, warnings: string[] }} Render */
/** @typedef {{ ok: boolean, reason?: string, image: string, matched: number, warning?: string }} PagePreview */
/** @typedef {{ name: string, type: string, shape?: string, energy?: number, color?: number[], materials?: { inputs: Record<string, any> }[] }} SceneNode */
/** @typedef {{ nodes: SceneNode[] }} Scene */
/** @typedef {{ node: string, path: string, before?: unknown, after?: unknown }} Diff */
/** @typedef {{ claimed_changes: { node: string, what: string, why: string }[], interpretation: string, assumptions: string[], policy: { flags: { level: string, msg: string }[] }, context: string[], via?: string, cost?: number }} Proposal */
/** @typedef {{ id: string, parent?: string | null, status: string, origin: string, instruction?: string, hash: string, renders: Record<string, Render | undefined>, pagePreviews?: Record<string, PagePreview>, scene: Scene, proposal: Proposal, diff: Diff[] }} Version */
/** @typedef {{ seq: number, type: string, comment: string, selection: string[], decision: string, version: string, asset: string, node: string, field: string, request: string }} AgentEvent */
/** @typedef {{ id: string, status: string, slug: string, version: string, reason: string, job?: string }} AdoptionRequest */
/** @typedef {{ t: string, event: string, version?: string, instruction?: string }} AuditEntry */
/** @typedef {{ head: string, versions: Version[], vork: string, mode?: string, project?: string, model?: string, adoptionRequests: AdoptionRequest[], events: AgentEvent[], agentCursor: number, audit: AuditEntry[], config: { pageUrl?: string } }} Data */
/** @typedef {{ kind: string, versionId: string, asset: string, proposal?: { clarifying_question?: string }, policy: { blockers: string[] }, log?: string }} JobResult */
/** @typedef {{ id: string, status: string, versionId: string, steps: { status: string, label: string, t: number, detail?: string }[], elapsed: number, error?: string, result: JobResult }} Job */
/** @typedef {{ versionId: string, versionStatus: string, acceptsProposal?: boolean, hash: string, reason: string, writes: string[], overwrites?: boolean, needsFinalRender?: boolean, expiresInSec: number, ticket: string }} AdoptPlan */
/** @typedef {{ versionId: string, hash: string, profile: string, resolution: number[], output: string, overwrites?: boolean, reference: string, timeoutSec: number, expiresInSec: number, flags: { msg: string }[], ticket: string }} FinalPlan */
/** @typedef {{ w: number, h: number, arr: Uint16Array, objects: Record<string, string> }} Ids */
/** @typedef {{ data: Data, viewId: string, profile: string, selection: Set<string>, hover: string | null, compare: boolean, job: Job | null, ids: Ids | null, img: HTMLImageElement, imgB: HTMLImageElement | null, lastResult: Job | null, sig?: string, onPage?: boolean, editing?: boolean, objKey?: string }} State */
/** @typedef {[string, string, string, any, ...number[]]} QuickRow */

/**
 * querySelector that the page's fixed markup guarantees to succeed; T is inferred from the declared type at the call site.
 * @template {HTMLElement} [T=HTMLElement]
 * @param {string} s
 * @returns {T}
 */
const $ = (s) => /** @type {T} */ (document.querySelector(s));
/** @type {State} */
const S = { data: /** @type {Data} */ (/** @type {unknown} */ (null)), viewId: /** @type {string} */ (/** @type {unknown} */ (null)), profile: 'draft', selection: new Set(), hover: null, compare: false, job: null, ids: null, img: /** @type {HTMLImageElement} */ (/** @type {unknown} */ (null)), imgB: null, lastResult: null };

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
/** @param {string} msg */
const alertMsg = (msg) => { $('#alert').textContent = msg; };
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
  applyMode(); renderVersions(); renderObjects(); renderReview(); renderAdoptions(); renderEvents(); renderAudit(); await drawViewport();
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
    catch (e) { alertMsg(`Cannot cancel: ${/** @type {Error} */ (e).message}`); }
    await load();
  }));
}
/** @param {string | undefined} requestId */
async function reviewAdoption(requestId) {
  /** @type {AdoptPlan} */
  let plan;
  try { plan = await api('/api/adopt/plan', { requestId }); } catch (e) { return alertMsg(`Cannot adopt: ${/** @type {Error} */ (e).message}`); }
  S.viewId = plan.versionId; renderVersions(); renderObjects(); renderReview(); await drawViewport();
  const rows = [
    ['version', `${plan.versionId} (${plan.versionStatus})${plan.acceptsProposal ? ' — approving also accepts this proposal as HEAD' : ''}`],
    ['scene hash', plan.hash], ['agent says', plan.reason],
    ['writes', plan.writes.join('\n') + (plan.overwrites ? '\n(replaces the existing image)' : '')],
    ['final render', plan.needsFinalRender ? 'will run std/final first' : 'reuses the existing final render'],
    ['approval valid', `${plan.expiresInSec / 60} min, this scene only`],
  ];
  $('#adoptPlan').innerHTML = rows.map(([k, x]) => `<dt>${k}</dt><dd style="white-space:pre-wrap">${esc(x)}</dd>`).join('');
  /** @type {HTMLDialogElement} */ const dlg = $('#adoptDlg'); dlg.returnValue = ''; dlg.showModal();
  dlg.onclose = async () => {
    if (dlg.returnValue === 'reject') {
      try { await api('/api/adopt/reject', { requestId }); say(`Rejected ${requestId}`); }
      catch (e) { alertMsg(`Cannot reject: ${/** @type {Error} */ (e).message}`); }
      return load();
    }
    if (dlg.returnValue !== 'approve') return say('Nothing written');
    try { const job = await api('/api/adopt', { ticket: plan.ticket }); trackJob(job, async (j) => { await load(); say(j.status === 'done' ? `Wrote ${j.result.asset}` : j.status === 'cancelled' ? 'Adoption cancelled; the request is pending again' : `Adoption failed: ${j.error}`); }); }
    catch (e) { alertMsg(`Adoption refused: ${/** @type {Error} */ (e).message}`); }
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
  view.onclick = async () => { close(); S.viewId = id; renderVersions(); renderObjects(); renderReview(); await drawViewport(); };
  dismiss.onclick = close;
  say(`New proposal ${id} from your agent. Press View to open it.`);
}
// Agents act from outside the page: poll for new proposals, requests and reads.
setInterval(async () => {
  // Also while the tab is hidden: the "(1)" title mark is how a hidden tab shows a new proposal (browsers slow this timer down there).
  if (!S.data || S.job || document.querySelector('dialog[open]')) return;
  /** @type {Data | null} */
  const d = await api('/api/state').catch(() => null);
  if (d && signature(d) !== S.sig) {
    const fresh = d.versions.filter((v) => !V(v.id) && v.origin === 'agent');
    await load(); // keeps the version you are viewing; never switches under your cursor
    if (fresh.length) notify(/** @type {Version} */ (fresh.at(-1)).id);
  }
}, 2500);

// ---------- versions ----------
/** @param {Version} v */
function depth(v) { let /** @type {number} */ d = 0, /** @type {Version | undefined} */ p = v; while (p?.parent && d < 3) { const parent = V(p.parent); if (parent && S.data.versions.filter((x) => x.parent === parent.id && x.status !== 'discarded').length > 1) d++; p = parent; } return d; }
function renderVersions() {
  const list = $('#versionList'); list.innerHTML = '';
  for (const v of [...S.data.versions].reverse()) {
    const li = document.createElement('li'); li.className = `st-${v.status} indent-${depth(v)}`;
    const title = v.origin === 'starter' ? 'Starter scene' : v.instruction;
    li.innerHTML = `<button aria-current="${v.id === S.viewId}" data-id="${v.id}">
      <span class="vid">${v.id}${v.parent ? ` ← ${v.parent}` : ''} ${v.id === S.data.head ? '<span class="headmark">● HEAD</span>' : ''}</span>
      <span class="badge ${v.origin}">${v.origin}</span>
      <span class="vtitle">${esc(title)}</span></button>`;
    /** @type {HTMLButtonElement} */ (li.querySelector('button')).onclick = () => { S.viewId = v.id; renderVersions(); renderObjects(); renderReview(); drawViewport(); say(`Viewing ${v.id}, ${v.status}`); };
    list.append(li);
  }
}

// ---------- viewport ----------
const /** @type {HTMLCanvasElement} */ cv = $('#canvas'), /** @type {HTMLCanvasElement} */ ov = $('#overlay'), ctx = /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d')), octx = /** @type {CanvasRenderingContext2D} */ (ov.getContext('2d'));
/**
 * @param {string} src
 * @returns {Promise<HTMLImageElement>}
 */
const loadImg = (src) => new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = src; });

async function drawViewport() {
  if (S.onPage) return drawPage();
  const v = viewV(); const r = v.renders[S.profile];
  delete cv.dataset.ready; // clicks are ignored until this view's object ids are loaded
  $('#viewing').textContent = `${v.id} · ${v.status}${v.status === 'accepted' && v.id !== S.data.head ? ' (not head)' : ''} · scene ${v.hash}`;
  $('#empty').hidden = !!r;
  renderMeasure(r);
  if (!r) { ctx.clearRect(0, 0, cv.width, cv.height); octx.clearRect(0, 0, ov.width, ov.height); S.ids = null; return; }
  S.img = await loadImg(r.image);
  const p = /** @type {Version | undefined} */ (v.parent && V(v.parent)); const pr = p?.renders[S.profile];
  S.imgB = S.compare && pr ? await loadImg(pr.image) : null;
  $('#wipe').hidden = !S.imgB;
  // ids is null for a render recorded before object ids were hashed: Director does not serve that file (#43).
  const buf = r.ids ? await (await fetch(r.ids)).arrayBuffer() : null;
  S.ids = buf && { w: r.width, h: r.height, arr: new Uint16Array(buf), objects: Object.fromEntries(r.objects.map((o) => [o.pass_index, o.name])) };
  for (const c of [cv, ov]) { c.width = r.width; c.height = r.height; }
  $('#viewport').style.aspectRatio = `${r.width} / ${r.height}`;
  paint();
  cv.dataset.ready = `${v.id}:${S.profile}`;
}
// The real page with the candidate substituted (server-side headless Chrome; project files untouched).
async function drawPage() {
  delete cv.dataset.ready;
  const v = viewV(); const prof = v.renders[S.profile] ? S.profile : 'draft';
  $('#viewing').textContent = `${v.id} · on page · ${S.data.config.pageUrl || 'no pageUrl'}`;
  octx.clearRect(0, 0, ov.width, ov.height); S.ids = null; $('#wipe').hidden = true;
  /** @type {PagePreview | undefined} */
  let pv = v.pagePreviews?.[prof];
  if (!pv) {
    $('#empty').hidden = false; $('#empty').textContent = 'Opening the page with this candidate…';
    pv = /** @type {PagePreview} */ (await api('/api/preview', { versionId: v.id, profile: prof }).catch((e) => ({ ok: false, reason: e.message })));
    if (pv.ok) (v.pagePreviews ||= {})[prof] = pv;
  }
  if (!pv.ok) { $('#empty').textContent = `Page preview unavailable: ${pv.reason}. Showing render only.`; S.onPage = false; $('#pageBtn').setAttribute('aria-pressed', 'false'); alertMsg(`Page preview unavailable: ${pv.reason}`); setTimeout(() => { $('#empty').textContent = 'No render at this quality yet.'; drawViewport(); }, 2500); return; }
  $('#empty').hidden = true; $('#empty').textContent = 'No render at this quality yet.';
  const img = await loadImg(pv.image);
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
    ctx.fillText(`◀ ${viewV().parent}`, 10, 22); ctx.fillText(`${viewV().id} ▶`, cv.width - 70, 22);
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
    catch (e) { alertMsg(`Could not start: ${/** @type {Error} */ (e).message}`); }
  };
}

// ---------- objects & direct manipulation ----------
const OBJECT_CAP = 200;
// Rebuilds the list only when the version or the filter changes; a selection change only updates the rows already shown.
function renderObjects() {
  const scene = viewV().scene; const list = $('#objectList');
  const filter = /** @type {HTMLInputElement} */ ($('#objectFilter')).value.trim().toLowerCase();
  for (const s of [...S.selection]) if (!scene.nodes.some((n) => n.name === s)) S.selection.delete(s);
  const key = `${S.viewId}\n${filter}`;
  if (key !== S.objKey) {
    S.objKey = key; list.innerHTML = '';
    const matches = scene.nodes.filter((n) => n.name && n.name.toLowerCase().includes(filter));
    for (const n of matches.slice(0, OBJECT_CAP)) {
      const li = document.createElement('li'); li.dataset.name = n.name;
      li.innerHTML = `<label><input type="checkbox"> ${esc(n.name)} <span class="kind">${esc(n.type)}${n.type === 'light' ? ' ' + esc(n.shape) : ''}</span></label>`;
      /** @type {HTMLInputElement} */ (li.querySelector('input')).onchange = () => toggleSel(n.name, true);
      list.append(li);
    }
    const more = $('#objectMore'); const rest = matches.length - OBJECT_CAP;
    more.hidden = matches.length ? rest <= 0 : !filter; more.textContent = matches.length ? `${rest} more — type to filter` : 'No objects match';
  }
  for (const li of /** @type {HTMLCollectionOf<HTMLElement>} */ (list.children)) {
    const sel = S.selection.has(/** @type {string} */ (li.dataset.name));
    /** @type {HTMLElement} */ (li.querySelector('label')).classList.toggle('sel', sel); /** @type {HTMLInputElement} */ (li.querySelector('input')).checked = sel;
  }
  $('#selCount').textContent = S.selection.size ? `(${[...S.selection].join(', ')})` : '(none)';
  renderQuick(scene);
}
/** @param {Scene} scene */
function renderQuick(scene) {
  const q = $('#quick'); q.innerHTML = '';
  if (viewV().status !== 'accepted') { q.innerHTML = '<p class="hint">Direct edits start from an accepted version. Accept this proposal or open HEAD.</p>'; return; }
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
  if (S.job || S.editing) return alertMsg('Wait for the current job to finish or cancel it.');
  S.editing = true; // set synchronously so a second change event cannot fork a duplicate version
  try {
    const r = await api('/api/edit', { baseId: S.viewId, node, field, value });
    S.viewId = r.version; await load(); say(`Created ${r.version}`);
    trackJob(r.job, () => load());
  } catch (e) { alertMsg(`Edit failed: ${/** @type {Error} */ (e).message}`); }
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
    try { await api('/api/feedback', { versionId: S.viewId, selection: [...S.selection], comment: instruction }); /** @type {HTMLTextAreaElement} */ ($('#instruction')).value = ''; say('Sent to your agent'); await load(); }
    catch (err) { alertMsg(`Could not send: ${/** @type {Error} */ (err).message}`); }
    return;
  }
  if (S.job) return alertMsg('A job is already running.');
  const v = viewV(); const baseId = v.status === 'discarded' ? S.data.head : v.id;
  try {
    const job = await api('/api/propose', {
      baseId, instruction, selection: [...S.selection],
      context: { selection: /** @type {HTMLInputElement} */ ($('#ctxSelection')).checked, exposure: /** @type {HTMLInputElement} */ ($('#ctxExposure')).checked, history: /** @type {HTMLInputElement} */ ($('#ctxHistory')).checked },
    });
    say(`Proposal requested from ${baseId}`);
    trackJob(job, async (j) => {
      S.lastResult = j;
      await load();
      if (j.status === 'done' && j.result?.kind === 'proposal') { S.viewId = j.result.versionId; renderVersions(); renderObjects(); await drawViewport(); }
      renderReview();
    });
  } catch (err) { alertMsg(`Could not start: ${/** @type {Error} */ (err).message}`); }
});

// ---------- jobs ----------
/**
 * @param {Job} job
 * @param {(j: Job) => unknown} [onEnd]
 */
function trackJob(job, onEnd) {
  S.job = job; $('#jobBox').hidden = false; /** @type {HTMLButtonElement} */ ($('#askBtn')).disabled = true; /** @type {HTMLButtonElement} */ ($('#finalBtn')).disabled = true;
  let lastCount = 0;
  const tick = async () => {
    /** @type {Job | null} */
    // 'no job': Director drops finished jobs after a while (#32); treat it as ended instead of polling forever.
    /** @type {Job | null} */
    const j = await api(`/api/jobs/${job.id}`).catch((e) => (/** @type {Error} */ (e).message === 'no job' ? { ...job, status: 'gone' } : null)); if (!j) return;
    $('#jobSteps').innerHTML = j.steps.map((s) => `<li class="${s.status}"><span class="ic" aria-hidden="true"></span><span>${esc(s.label)}</span><span class="t">${(s.t / 1000).toFixed(1)}s</span>${s.detail ? `<pre>${esc(s.detail)}</pre>` : ''}</li>`).join('');
    $('#jobElapsed').textContent = `elapsed ${(j.elapsed / 1000).toFixed(0)}s (no ETA: agent and GPU time vary)`;
    if (j.steps.length !== lastCount) { lastCount = j.steps.length; say(j.steps.at(-1)?.label || ''); }
    if (j.status === 'running') return setTimeout(tick, 500);
    if (j.status === 'gone') {
      // The result is unknown here (the tab did not poll for over 10 minutes); the reloaded state shows what happened.
      S.job = null; /** @type {HTMLButtonElement} */ ($('#askBtn')).disabled = false; /** @type {HTMLButtonElement} */ ($('#finalBtn')).disabled = false; $('#cancelBtn').hidden = true; $('#jobBox').hidden = true;
      await load(); say('The job ended while this tab was not watching it; the versions and requests show the result');
      return;
    }
    S.job = null; /** @type {HTMLButtonElement} */ ($('#askBtn')).disabled = false; /** @type {HTMLButtonElement} */ ($('#finalBtn')).disabled = false; $('#cancelBtn').hidden = true;
    say(j.status === 'done' ? 'Finished' : `Stopped: ${j.error || j.status}`);
    await onEnd?.(j);
    setTimeout(() => { if (!S.job) $('#jobBox').hidden = j.status !== 'done' ? false : true; }, j.status === 'done' ? 1500 : 0);
  };
  $('#cancelBtn').hidden = false; $('#cancelBtn').onclick = () => api(`/api/jobs/${job.id}/cancel`, {});
  tick();
}

// ---------- review ----------
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
  const p = v.proposal;
  const { isClaimed, wildMatches, ghost } = checkClaims(p.claimed_changes, v.diff);
  const typeOf = new Map([...(V(/** @type {string} */ (v.parent))?.scene.nodes || []), ...v.scene.nodes].map((n) => [n.name, n.type]));
  const { groups: groupList, rest } = groupDiff(v.diff, typeOf);
  /** @param {Diff} d */
  const row = (d) => `<tr class="${isClaimed(d) ? '' : 'unclaimed'}"><td>${esc(d.node)}${d.path ? '.' + esc(d.path) : ''}</td><td>${fmt(d.before)}</td><td>${fmt(d.after)}</td></tr>`;
  /** @param {Diff[]} ds */
  const unclaimedNote = (ds) => { const u = ds.filter((d) => !isClaimed(d)).length; return u ? ` <span class="flag">· ⚠ ${u} not mentioned</span>` : ''; };
  const CAP = 200; const hidden = rest.slice(CAP);
  const diffRows = groupList.map(({ type, kind, ds }, i) => `<tr class="group"><td colspan="3"><details data-group="${i}"><summary>${ds.length} ${esc(type)} node${ds.length > 1 ? 's' : ''} ${esc(kind)} (${esc(ds[0].node)}${ds.length > 1 ? ` … ${esc(ds.at(-1)?.node)}` : ''})${unclaimedNote(ds)}</summary><table class="difftable"><tbody></tbody></table></details></td></tr>`).join('')
    + rest.slice(0, CAP).map(row).join('')
    + (hidden.length ? `<tr class="group"><td colspan="3"><button type="button" class="ghost" id="moreDiff">Show remaining ${hidden.length} rows</button>${unclaimedNote(hidden)}</td></tr>` : '');
  // The poll re-renders this panel; keep what the human opened in the diff while it shows the same version.
  const same = box.dataset.view === v.id;
  const openGroups = same ? [...box.querySelectorAll('details[data-group]')].filter((el) => /** @type {HTMLDetailsElement} */ (el).open).map((el) => /** @type {HTMLElement} */ (el).dataset.group) : [];
  const shownMore = same && box.dataset.more === '1';
  box.dataset.view = v.id; box.dataset.more = shownMore ? '1' : '';
  box.hidden = false;
  box.style.borderColor = v.status === 'proposed' ? 'var(--warn)' : 'var(--line)';
  box.innerHTML = `
    <h3>${v.status === 'proposed' ? 'Proposal — not applied yet' : v.status === 'accepted' ? 'Accepted proposal' : 'Discarded proposal'} · ${v.id} from ${v.parent}</h3>
    ${V(/** @type {string} */ (v.parent))?.status !== 'accepted' ? `<p class="flag">⚠ Built on ${esc(v.parent)}, which is ${esc(V(/** @type {string} */ (v.parent))?.status)}. Accepting this also accepts that version's changes (not shown in this diff).</p>` : ''}
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
    <p class="hint">${p.via === 'mcp' ? 'Proposed by your ADE agent via MCP' : `Agent cost ${p.cost ? '$' + p.cost.toFixed(3) : 'n/a'}`}. Judge the image, not the explanation.</p>
    ${v.status === 'proposed' ? `<div class="btnrow">
      <button class="primary" id="acceptBtn">Accept as new HEAD</button>
      <button class="ghost" id="refineBtn">Refine from this</button>
      <button class="ghost danger" id="discardBtn">Discard</button></div>` : ''}`;
  // rows inside a group or past the cap are built only when the human opens them
  box.querySelectorAll('details[data-group]').forEach((el) => el.addEventListener('toggle', () => {
    const tb = /** @type {HTMLElement} */ (el.querySelector('tbody'));
    if (/** @type {HTMLDetailsElement} */ (el).open && !tb.children.length) tb.innerHTML = groupList[Number(/** @type {HTMLElement} */ (el).dataset.group)].ds.map(row).join('');
  }));
  const more = box.querySelector('#moreDiff'); if (more) /** @type {HTMLButtonElement} */ (more).onclick = () => { box.dataset.more = '1'; /** @type {HTMLElement} */ (more.closest('tr')).outerHTML = hidden.map(row).join(''); };
  for (const g of openGroups) /** @type {HTMLDetailsElement | null} */ (box.querySelector(`details[data-group="${g}"]`))?.setAttribute('open', '');
  if (shownMore && more) /** @type {HTMLButtonElement} */ (more).click();
  if (v.status !== 'proposed') return;
  $('#acceptBtn').onclick = () => decide('accept');
  $('#discardBtn').onclick = () => decide('discard');
  $('#refineBtn').onclick = () => { /** @type {HTMLTextAreaElement} */ ($('#instruction')).value = ''; /** @type {HTMLTextAreaElement} */ ($('#instruction')).placeholder = `Refine ${v.id}: what should differ?`; $('#instruction').focus(); };
}
/** @param {string} decision */
async function decide(decision) {
  const id = S.viewId;
  try { await api('/api/decide', { versionId: id, decision }); }
  catch (e) { return alertMsg(`Cannot ${decision}: ${/** @type {Error} */ (e).message}`); }
  if (decision === 'discard') S.viewId = /** @type {string} */ (/** @type {Version} */ (V(id)).parent);
  /** @type {HTMLTextAreaElement} */ ($('#instruction')).value = '';
  await load(); say(decision === 'accept' ? `${id} is now HEAD` : `${id} discarded`);
}

// ---------- final render ----------
$('#finalBtn').addEventListener('click', async () => {
  const v = viewV();
  if (v.status === 'discarded') return alertMsg('Discarded versions cannot be rendered at final quality.');
  /** @type {FinalPlan} */
  const plan = await api('/api/final/plan', { versionId: v.id });
  const rows = [
    ['version', `${plan.versionId}${v.status === 'proposed' ? ' (unaccepted proposal)' : ''}`], ['scene hash', plan.hash], ['profile', plan.profile],
    ['resolution', plan.resolution.join(' × ')], ['writes', plan.output + (plan.overwrites ? ' (replaces previous final)' : '')],
    ['time', `not predicted · ${plan.reference} · hard stop at ${plan.timeoutSec}s`], ['approval valid', `${plan.expiresInSec / 60} min, this scene only`],
  ];
  $('#finalPlan').innerHTML = rows.map(([k, x]) => `<dt>${k}</dt><dd>${esc(x)}</dd>`).join('') +
    (plan.flags.length ? `<dt class="flag">attention</dt><dd>${plan.flags.map((f) => esc(f.msg)).join('<br>')}</dd>` : '');
  /** @type {HTMLDialogElement} */ const dlg = $('#finalDlg'); dlg.returnValue = ''; dlg.showModal();
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'approve') { say('Final render not started'); return; }
    try {
      const job = await api('/api/render', { versionId: v.id, profile: 'final', ticket: plan.ticket });
      trackJob(job, async (j) => { await load(); if (j.status === 'done') { /** @type {HTMLElement} */ (document.querySelector('[data-profile="final"]')).click(); } });
    } catch (e) { alertMsg(`Final render refused: ${/** @type {Error} */ (e).message}`); }
  };
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
