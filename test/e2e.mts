// Browser E2E (headless Chrome via playwright-core). Requires vork and Google Chrome.
// Part A: standalone flow (AC-11). Part B: ADE flow — agent proposal appears, feedback, page preview (AC-09), adoption.
// Set E2E_AGENT=1 to also exercise the built-in `claude -p` proposer in standalone mode (costs an API call).
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireGpuLock } from './gpu-lock.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// E2E_REQUIRED=1 (CI, refactoring sign-off): a missing Chrome is a failure, not a skip.
if (!fs.existsSync(CHROME)) {
  if (process.env.E2E_REQUIRED === '1') { console.log('FAIL e2e: Chrome not found (set CHROME_PATH); E2E_REQUIRED=1'); process.exit(1); }
  console.log('SKIP e2e: Chrome not found (set CHROME_PATH)'); process.exit(0);
}
await acquireGpuLock('e2e');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vd-e2e-')));
// The README images in docs/ are rewritten only with E2E_UPDATE_SCREENSHOTS=1; otherwise screenshots go to the temp folder.
const SHOTS = process.env.E2E_UPDATE_SCREENSHOTS === '1' ? path.join(ROOT, 'docs') : process.env.E2E_SHOTS_DIR || tmp; // E2E_SHOTS_DIR: keep them to look at
interface SceneNode { name: string; energy?: number; materials?: { inputs: Record<string, number> }[] }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, failures = 0; const procs: ChildProcess[] = [];
async function check(name: string, fn: () => unknown) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e: any) { failures++; console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ')}`); }
}
const PAIR = 'e2e' + Date.now().toString(16); // test-only pairing token (normally sent only to the OS browser opener)
async function startDirector(args: string[], env: Record<string, string> = {}) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mts'), ...args], { env: { ...process.env, RENDER_DIRECTOR_NO_OPEN: '1', RENDER_DIRECTOR_PAIR_TOKEN: PAIR, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p); let out = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 80 && !/Render Director on (http:\/\/\S+)/.test(out); i++) await sleep(150);
  const m = out.match(/Render Director on (http:\/\/\S+)/); if (!m) throw new Error(`Director did not start:\n${out}`);
  return m[1];
}
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
type ErrPage = Page & { errors: string[] };
const newPage = async () => {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } }) as ErrPage;
  page.errors = []; page.on('pageerror', (e) => page.errors.push(String(e)));
  return page;
};
const idle = (page: Page, t = 120000) => page.waitForFunction(() => !document.querySelector('#jobList [data-status="running"]'), null, { timeout: t });
const clickObject = async (page: Page, fx: number, fy: number) => { await page.waitForSelector('#canvas[data-ready]'); const b = await page.locator('#canvas').boundingBox(); await page.mouse.click(b!.x + b!.width * fx, b!.y + b!.height * fy); };

// ---------------- Part A: standalone ----------------
{
  const url = await startDirector(['--port', '4791'], { RENDER_DIRECTOR_RUNS: path.join(tmp, 'runs') });
  const page = await newPage();
  await page.goto(`${url}/#pair=${PAIR}`);
  await page.waitForFunction(() => document.querySelector('#measure')!.textContent!.includes('draft'), null, { timeout: 60000 });
  await idle(page);

  await check('AC-11 standalone: click selects the vase via object ids', async () => {
    await clickObject(page, 350 / 960, 220 / 540);
    assert.match(await page.textContent('#selCount') as string, /vase/);
  });
  await check('AC-11 standalone: one direct edit creates exactly one human version', async () => {
    const before = await page.locator('#versionList li').count();
    const slider = page.locator('#quick input[type=range]').first();
    await slider.fill('0.8'); await slider.dispatchEvent('change');
    await sleep(400); await idle(page);
    assert.equal(await page.locator('#versionList li').count(), before + 1);
    assert.match(await page.textContent('#versionList') as string, /vase\.specular_roughness = 0\.8/);
  });
  await check('AC-11 standalone: compare wipe appears against the parent', async () => {
    await page.check('#compareToggle'); await sleep(600);
    assert.equal(await page.locator('#wipe').isVisible(), true);
    await page.uncheck('#compareToggle');
  });
  await check('#57 the final render plan opens inline: the wipe works meanwhile, and switching versions closes it', async () => {
    const head = await page.evaluate(() => document.querySelector('.headmark')!.closest('button')!.getAttribute('data-id'));
    await page.click('#finalBtn'); await page.waitForSelector('#finalPlanBox:not([hidden])');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'h-fplan', 'focus moves to the plan');
    assert.equal(await page.locator('dialog[open]').count(), 0, 'no modal');
    await page.check('#compareToggle'); await page.waitForSelector('#wipe:not([hidden])');
    await page.locator('#wipe').fill('20'); await page.uncheck('#compareToggle');
    assert.equal(await page.locator('#finalPlanBox').isVisible(), true, 'the plan stays open while comparing');
    await page.keyboard.press('Escape'); // focus is not in the plan: Escape there only
    await page.focus('#finalApprove'); await page.keyboard.press('Escape');
    assert.equal(await page.locator('#finalPlanBox').isHidden(), true);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'finalBtn', 'focus returns to Plan final render');
    await page.click('#finalBtn'); await page.waitForSelector('#finalPlanBox:not([hidden])');
    await page.click('button[data-id="v001"]'); await sleep(200);
    assert.equal(await page.locator('#finalPlanBox').isHidden(), true, 'a plan for another version closes');
    await page.click(`button[data-id="${head}"]`); await page.waitForSelector(`#canvas[data-ready="${head}:draft"]`);
  });
  await check('AC-11 standalone: final render needs approval, then shows final', async () => {
    await page.click('#finalBtn'); await page.waitForSelector('#finalPlanBox:not([hidden])'); await page.click('#finalApprove');
    await page.waitForFunction(() => document.querySelector('[data-profile="final"]')!.getAttribute('aria-checked') === 'true', null, { timeout: 120000 });
    assert.match(await page.textContent('#measure') as string, /final/);
  });
  if (process.env.E2E_AGENT === '1') {
    await check('AC-11 standalone: built-in agent proposal can be discarded', async () => {
      await page.fill('#instruction', 'rimライトを強めて輪郭を際立たせる'); await page.click('#askBtn'); await sleep(800);
      await idle(page, 240000); await sleep(800);
      assert.match(await page.textContent('#viewing') as string, /proposed/);
      await page.click('#discardBtn'); await sleep(7500); // committed after the undo time (#55)
      assert.doesNotMatch(await page.textContent('#viewing') as string, /proposed/);
    });
  }
  await check('#55 standalone: an accepted version that is not HEAD can be made HEAD again', async () => {
    const headOf = () => page.evaluate(() => document.querySelector('.headmark')!.closest('button')!.getAttribute('data-id'));
    const head = await headOf(); assert.notEqual(head, 'v001');
    await page.click('button[data-id="v001"]'); await page.click('#headBtn');
    await page.waitForFunction(() => document.querySelector('.headmark')?.closest('button')?.getAttribute('data-id') === 'v001', null, { timeout: 5000 });
    assert.equal(await page.locator('#headBtn').count(), 0, 'HEAD needs no Make HEAD');
    await page.click(`button[data-id="${head}"]`); await page.click('#headBtn');
    await page.waitForFunction((h) => document.querySelector('.headmark')?.closest('button')?.getAttribute('data-id') === h, head, { timeout: 5000 });
    await page.click('#auditbox summary, .auditbox summary');
    assert.match(await page.textContent('#audit') as string, /checkout v001/);
  });
  await check('#53 standalone: when Director stops, the page says so instead of showing stale data silently', async () => {
    procs[0].kill('SIGTERM');
    await page.waitForSelector('#conn:not([hidden])', { timeout: 10000 });
    assert.match(await page.textContent('#conn') as string, /Director is not responding/);
  });
  await check('AC-11 standalone: no page errors', async () => assert.deepEqual(page.errors, []));
  await page.close();
}

// ---------------- Part B: ADE mode ----------------
{
  const PROJECT = path.join(tmp, 'landing');
  fs.cpSync(path.join(ROOT, 'examples', 'landing'), PROJECT, { recursive: true });
  fs.rmSync(path.join(PROJECT, '.vork'), { recursive: true, force: true });
  // the "dev server" for the page under construction
  const site = http.createServer((req, res) => {
    const f = path.join(PROJECT, 'public', req.url === '/' ? 'index.html' : decodeURIComponent(req.url!.split('?')[0]));
    if (!f.startsWith(path.join(PROJECT, 'public')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'image/png' }); res.end(fs.readFileSync(f));
  }).listen(4794, '127.0.0.1');
  // Test-only vork wrapper: while GATE exists, a final render waits before it runs, so a test can act during one.
  const BIN = path.join(tmp, 'bin'); fs.mkdirSync(BIN); const GATE = path.join(tmp, 'gate');
  const realVork = process.env.PATH!.split(path.delimiter).map((d) => path.join(d, 'vork')).find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return true; } catch { return false; } });
  fs.writeFileSync(path.join(BIN, 'vork'), `#!/bin/sh\ncase "$*" in *std/final*) while [ -e '${GATE}' ]; do sleep 0.05; done;; esac\nexec '${realVork}' "$@"\n`, { mode: 0o755 });
  const url = await startDirector(['--project', PROJECT, '--port', '4793'], { PATH: `${BIN}${path.delimiter}${process.env.PATH}` });
  const cfgFile = path.join(PROJECT, '.vork', 'config.json');
  const setConfig = (c: Record<string, string>) => fs.writeFileSync(cfgFile, JSON.stringify({ assetDir: 'public/vork', ...c }, null, 2));
  setConfig({ pageUrl: 'http://127.0.0.1:4794/', assetUrlPattern: '**/vork/hero.png' });
  const { agentToken } = JSON.parse(fs.readFileSync(path.join(PROJECT, '.vork', 'server.json'), 'utf8'));
  const agent = async (method: string, route: string, body?: unknown) => {
    const r = await fetch(`${url}${route}`, { method, headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  };
  const projectMtimes = () => {
    const out: Record<string, number> = {}; const walk = (d: string): void => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === '.vork') continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[p] = fs.statSync(p).mtimeMs; } };
    walk(PROJECT); return out;
  };

  await check('ADE: an unpaired tab gets no data and says how to pair', async () => {
    const stranger = await newPage(); await stranger.goto(url); await sleep(800);
    assert.match(await stranger.textContent('body') as string, /not paired/); await stranger.close();
  });
  const page = await newPage();
  await page.goto(`${url}/#pair=${PAIR}`);
  await sleep(1500);
  assert.equal(new URL(page.url()).hash, '', 'pairing token is removed from the address bar');
  if (!(await page.textContent('#measure'))!.includes('draft')) {
    await page.waitForFunction(() => document.querySelector('#measure')!.textContent!.includes('draft'), null, { timeout: 60000 });
  }
  await idle(page);

  await check('ADE: UI switches to feedback mode and never offers the built-in proposer', async () => {
    assert.equal(await page.textContent('#h-ask'), 'Feedback to your agent');
    assert.equal(await page.textContent('#askBtn'), 'Send to agent');
    assert.equal(await page.locator('#starters').isVisible(), false);
  });

  let vid: string;
  await check('ADE: an agent proposal made outside the page is announced; the view does not switch by itself', async () => {
    const scene: { nodes: SceneNode[] } = (await agent('GET', '/api/agent/scene')).scene;
    scene.nodes.find((n) => n.name === 'key')!.energy = 60; scene.nodes.find((n) => n.name === 'seed')!.materials![0]!.inputs.emission_luminance = 40;
    const r = await agent('POST', '/api/agent/propose', { scene, interpretation: '夜のヒーロー: seedを主光源に', claimed_changes: [{ node: 'key', what: 'energy 60', why: 'night' }, { node: 'seed', what: 'emission 40', why: 'hero light' }] });
    vid = r.version; assert.ok(vid, JSON.stringify(r));
    await page.waitForSelector('#notice:not([hidden])', { timeout: 10000 });
    assert.doesNotMatch(await page.textContent('#viewing') as string, new RegExp(`^${vid}`), 'the view must not switch by itself');
    await page.click('#notice button');
    await page.waitForSelector(`#canvas[data-ready="${vid}:draft"]`, { timeout: 15000 });
    assert.match(await page.textContent('#review') as string, /Proposed by your ADE agent via MCP/);
  });

  await check('#56 at 1440×900 an opened proposal shows the render and Accept together, without scrolling', async () => {
    await page.setViewportSize({ width: 1440, height: 900 }); await sleep(300);
    const inView = async (sel: string) => { const b = (await page.locator(sel).boundingBox())!; return b.y >= 0 && b.y + b.height <= 900 && b.x >= 0 && b.x + b.width <= 1440; };
    assert.equal(await page.evaluate(() => [document.scrollingElement!.scrollTop, document.querySelector('.inspector')!.scrollTop].join()), '0,0');
    assert.ok(await inView('#acceptBtn'), 'Accept is on screen'); assert.ok(await inView('#canvas'), 'the render is on screen');
    assert.match(await page.textContent('#h-insp') as string, new RegExp(`^${vid} · Proposal`));
    // keyboard order follows the DOM: version list, then the viewport, then the inspector's actions
    assert.ok(await page.evaluate(() => {
      const [a, b, c] = ['#versionList', '#canvas', '#acceptBtn'].map((q) => document.querySelector(q)!);
      return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(b.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING);
    }));
    await page.screenshot({ path: path.join(SHOTS, 'screenshot-proposal.png') });
    await page.setViewportSize({ width: 1500, height: 1000 });
  });

  await check('ADE: feedback with a clicked selection reaches the agent and shows as read', async () => {
    await clickObject(page, 350 / 960, 220 / 540);
    await page.fill('#instruction', '花瓶を少し右へ。見出しと重ならないように'); await page.click('#askBtn');
    await page.waitForFunction(() => document.querySelector('#eventList')!.textContent!.includes('not read yet'), null, { timeout: 5000 });
    const fb = await agent('GET', '/api/agent/feedback?wait=0');
    const ev = fb.events.find((e: { type: string }) => e.type === 'feedback');
    assert.equal(ev.version, vid); assert.deepEqual(ev.selection, ['vase'], JSON.stringify(ev)); assert.match(ev.comment, /花瓶/);
    await page.waitForFunction(() => document.querySelector('#eventList')!.textContent!.includes('read by agent'), null, { timeout: 8000 });
  });

  await check('#54 while a final render runs, the page keeps updating and other versions can be viewed', async () => {
    fs.writeFileSync(GATE, '');
    try {
      await page.click(`button[data-id="${vid}"]`); await page.waitForSelector(`#canvas[data-ready="${vid}:draft"]`);
      await page.click('#finalBtn'); await page.waitForSelector('#finalPlanBox:not([hidden])'); await page.click('#finalApprove');
      await page.waitForSelector(`#jobList [data-status="running"][data-version="${vid}"]`, { timeout: 10000 });
      assert.equal(await page.locator('#finalBtn').isDisabled(), true, 'no second final render of the same version');
      assert.match(await page.textContent('#finalBusy') as string, new RegExp(`${vid} has a running job`));
      // the agent asks for an adoption meanwhile: the request shows up within the poll interval
      const r = await agent('POST', '/api/agent/adoption-request', { version: vid, slug: 'during-job', reason: 'x' });
      await page.waitForFunction(() => document.querySelector('#adoptList')!.textContent!.includes('during-job'), null, { timeout: 3500 });
      // another version can be opened and compared while the job runs
      await page.click('button[data-id="v001"]'); await page.waitForSelector('#canvas[data-ready="v001:draft"]', { timeout: 10000 });
      assert.equal(await page.locator('#finalBtn').isDisabled(), false, 'v001 has no job');
      assert.ok(await page.locator(`#versionList button.busy[data-id="${vid}"]`).count(), 'the version list marks the busy version');
      await page.click(`#jobList [data-version="${vid}"] button[data-cancel-job]`);
      await page.waitForSelector(`#jobList [data-status="cancelled"][data-version="${vid}"]`, { timeout: 10000 });
      await sleep(2000);
      assert.equal(await page.locator(`#jobList [data-status="cancelled"][data-version="${vid}"]`).count(), 1, 'a cancelled job stays listed');
      await page.click(`#jobList [data-version="${vid}"] button[data-dismiss-job]`);
      assert.equal(await page.evaluate(async (id) => (await fetch('/api/adopt/reject', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: id }) })).status, r.request), 200);
      await page.click(`button[data-id="${vid}"]`); await page.waitForSelector(`#canvas[data-ready="${vid}:draft"]`);
    } finally { fs.rmSync(GATE, { force: true }); }
  });

  await check('AC-09 page preview substitutes the candidate without touching project files', async () => {
    const before = projectMtimes();
    const original = await newPage();
    await original.setViewportSize({ width: 1280, height: 800 }); await original.goto('http://127.0.0.1:4794/', { waitUntil: 'networkidle' });
    const origShot = await original.screenshot(); await original.close();
    await page.click('#pageBtn');
    await page.waitForFunction(() => document.querySelector('#measure')!.textContent!.includes('substituted'), null, { timeout: 60000 });
    const m = (await page.textContent('#measure'))!.match(/substituted requests\s*(\d+)/); assert.ok(Number(m![1]) >= 1, await page.textContent('#measure') as string);
    const shot = fs.readFileSync(path.join(PROJECT, '.vork', vid, 'page-draft.png'));
    assert.notDeepEqual(shot, origShot, 'page with candidate must differ from the original page');
    assert.deepEqual(projectMtimes(), before);
    await page.screenshot({ path: path.join(SHOTS, 'screenshot-on-page.png') });
    await page.click('#pageBtn'); await sleep(500);
  });

  await check('AC-09 a pattern that matches nothing warns', async () => {
    setConfig({ pageUrl: 'http://127.0.0.1:4794/', assetUrlPattern: '**/nothing-here.png' });
    const r = await page.evaluate(async (id) => (await fetch('/api/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versionId: id, profile: 'draft' }) })).json(), vid);
    assert.equal(r.ok, true); assert.equal(r.matched, 0); assert.match(r.warning, /no request matched/);
  });

  await check('AC-09 unreachable page shows the reason and falls back to the render', async () => {
    setConfig({ pageUrl: 'http://127.0.0.1:1/', assetUrlPattern: '**/vork/hero.png' });
    await page.reload(); await sleep(1500);
    await page.click(`button[data-id="${vid}"]`); await sleep(500);
    await page.click('[data-profile="previs"]'); await sleep(300); // no cached page preview for previs yet
    await page.click('#pageBtn');
    await page.waitForFunction(() => document.querySelector('#err-view')!.textContent!.includes('unavailable'), null, { timeout: 60000 });
    await sleep(5000);
    // #53: the reason stays on screen (not only for screen readers) next to the render shown instead
    assert.equal(await page.locator('#err-view .err[role=alert]').isVisible(), true);
    assert.doesNotMatch(await page.textContent('#viewing') as string, /on page/);
    assert.equal(await page.locator('#pageBtn').getAttribute('aria-pressed'), 'false');
    await page.focus('#pageBtn'); await page.click('#err-view .err button[aria-label=Dismiss]');
    assert.equal(await page.locator('#err-view .err').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'pageBtn', 'dismissing returns focus to the control');
    await page.click('[data-profile="draft"]');
  });

  await check('ADE: adoption request → human approves in the dialog → image written into the project', async () => {
    const r = await agent('POST', '/api/agent/adoption-request', { version: vid, slug: 'hero', reason: '暗い背景のヒーローに合う' });
    assert.equal(r.status, 'pending_human_approval');
    await page.waitForSelector('#adoptBox:not([hidden])', { timeout: 10000 });
    await page.click('#adoptList button'); await sleep(500);
    assert.match(await page.textContent('#adoptPlan') as string, /public\/vork\/hero\.png/);
    await page.screenshot({ path: path.join(SHOTS, 'screenshot-adoption.png') });
    await page.click('#adoptDlg button[value=approve]');
    await sleep(500); await idle(page, 180000); await sleep(800);
    assert.ok(fs.existsSync(path.join(PROJECT, 'public', 'vork', 'hero.png')));
    assert.ok(fs.existsSync(path.join(PROJECT, '.vork', 'adopted', 'hero.json')));
    assert.equal(await page.locator('#adoptBox').isHidden(), true);
  });

  // A large proposal: 400 added nodes (#35, #36, #37, #38), then one that changes each of them (#37 "Show remaining").
  const BIRDS = 400;
  const bird = (i: number) => ({ type: 'mesh', name: `b${i}`, translation: [-1 + (i % 40) * 0.05, 0.7 + Math.floor(i / 40) * 0.03, -0.3], geometry: { std: 'rounded_box', size: [0.02, 0.02, 0.02], radius: 0.002 }, materials: [{ inputs: { base_color: [0.1, 0.1, 0.1] } }] });
  let flock: string, recolor: string;
  await check('#38 #40 a large proposal is announced with a fixed notice and a "(1)" title until it is opened', async () => {
    assert.match(await page.textContent('#meta') as string, /project landing ·/); assert.equal(await page.getAttribute('#meta', 'title'), PROJECT);
    const scene: { nodes: unknown[] } = (await agent('GET', '/api/agent/scene')).scene;
    scene.nodes.push(...Array.from({ length: BIRDS }, (_, i) => bird(i)));
    const r = await agent('POST', '/api/agent/propose', { scene, interpretation: 'a flock of birds', claimed_changes: [{ node: 'b*', what: 'birds', why: 'flock' }, { node: 'zz*', what: 'nothing', why: 'ghost' }] });
    flock = r.version; assert.ok(flock, JSON.stringify(r));
    await page.waitForSelector('#notice:not([hidden])', { timeout: 10000 });
    assert.match(await page.title(), /^\(1\) /);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click('#notice button');
    await page.waitForSelector(`#canvas[data-ready="${flock}:draft"]`, { timeout: 60000 });
    assert.doesNotMatch(await page.title(), /^\(1\)/); assert.equal(await page.locator('#notice').isHidden(), true);
  });
  await check('#36 a prefix claim shows how many nodes it matched; a prefix that matches nothing is flagged', async () => {
    assert.match(await page.textContent('#review') as string, new RegExp(`b\\*\\s*→ ${BIRDS} nodes: b0 … b${BIRDS - 1} \\(${BIRDS}\\):`));
    assert.match(await page.textContent('#review') as string, /Claimed but not changed: zz\*/);
    assert.equal(await page.locator('#review tr.unclaimed').count(), 0, 'every added bird is claimed');
  });
  await check('#37 the added nodes collapse into one row that stays open across the 2.5 s refresh', async () => {
    const summary = page.locator('#review details[data-group] summary').first();
    assert.match(await summary.textContent() as string, new RegExp(`^${BIRDS} mesh nodes added: b0 … b${BIRDS - 1} \\(${BIRDS}\\)`));
    await summary.click();
    await page.waitForFunction((n) => document.querySelectorAll('#review details[data-group] tbody tr').length === n, BIRDS, { timeout: 5000 });
    // a new agent version changes the state signature, so the poll re-renders the review panel
    await agent('POST', '/api/agent/adoption-request', { version: flock, slug: 'flock', reason: 'refresh' });
    await page.waitForSelector('#adoptBox:not([hidden])', { timeout: 10000 });
    assert.equal(await page.locator('#review details[data-group][open]').count(), 1);
  });
  await check('#35 the OBJECTS list shows at most 200 rows, filters by name, and a selection updates its row', async () => {
    assert.equal(await page.locator('#objectList li').count(), 200);
    assert.match(await page.textContent('#objectMore') as string, /more — type to filter/);
    await page.fill('#objectFilter', 'b39'); await sleep(100);
    assert.deepEqual(await page.locator('#objectList li').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.name)), ['b39', 'b390', 'b391', 'b392', 'b393', 'b394', 'b395', 'b396', 'b397', 'b398', 'b399']);
    await page.locator('#objectList li[data-name="b391"] input').check();
    assert.match(await page.textContent('#selCount') as string, /b391/);
    assert.equal(await page.locator('#objectList label.sel').count(), 1);
    await page.fill('#objectFilter', ''); await sleep(100);
    // #46: the selected object is past the first 200, so it is listed first
    assert.equal(await page.locator('#objectList li').first().getAttribute('data-name'), 'b391');
    assert.equal(await page.locator('#objectList li[data-name="b391"] label.sel').count(), 1);
    await page.locator('#objectList li[data-name="b391"] input').uncheck(); await sleep(100);
    assert.equal(await page.locator('#objectList li').first().getAttribute('data-name'), 'b391', 'a deselected row stays where it was');
    assert.equal(await page.locator('#objectList label.sel').count(), 0);
  });
  await check('#37 more than 200 changed fields: the rest is behind "Show remaining", which stays shown across the refresh', async () => {
    const scene: { nodes: { name: string; materials?: { inputs: Record<string, unknown> }[] }[] } = (await agent('GET', `/api/agent/scene?version=${flock}`)).scene;
    for (const n of scene.nodes) if (/^b\d+$/.test(n.name)) n.materials![0].inputs.base_color = [0.9, 0.9, 0.9];
    const r = await agent('POST', '/api/agent/propose', { base: flock, scene, interpretation: 'white birds', claimed_changes: [{ node: 'b*', what: 'white', why: 'contrast' }] });
    recolor = r.version; assert.ok(recolor, JSON.stringify(r));
    await page.waitForSelector('#notice:not([hidden])', { timeout: 10000 }); await page.click('#notice button');
    await page.waitForSelector(`#canvas[data-ready="${recolor}:draft"]`, { timeout: 60000 });
    assert.equal(await page.locator('#review .difftable > tbody > tr:not(.group)').count(), 200);
    await page.click('#moreDiff');
    assert.equal(await page.locator('#review .difftable > tbody > tr:not(.group)').count(), BIRDS);
    await agent('POST', '/api/agent/adoption-request', { version: recolor, slug: 'flock-white', reason: 'refresh' });
    await page.waitForFunction(() => document.querySelector('#adoptList')!.textContent!.includes('flock-white'), null, { timeout: 10000 });
    assert.equal(await page.locator('#review .difftable > tbody > tr:not(.group)').count(), BIRDS);
  });

  await check('#55 Discard can be undone before it reaches the agent; when the time is up it is decided', async () => {
    await agent('GET', '/api/agent/feedback?wait=0'); // drain
    await page.click(`button[data-id="${recolor}"]`); await page.waitForSelector('#discardBtn');
    await page.click('#discardBtn');
    await page.waitForSelector('#undoBar:not([hidden])');
    assert.equal(await page.locator(`#versionList li.st-discarded button[data-id="${recolor}"]`).count(), 1, 'shown as discarded at once');
    await page.click('#undoBtn');
    await sleep(7000);
    assert.match(await page.textContent('#h-insp') as string, /Proposal/); assert.equal(await page.locator('#undoBar').isHidden(), true);
    assert.deepEqual((await agent('GET', '/api/agent/feedback?wait=0')).events, [], 'the agent heard nothing');
    await page.click('#discardBtn'); await sleep(7500);
    const evs = (await agent('GET', '/api/agent/feedback?wait=0')).events;
    assert.deepEqual(evs.map((e: { type: string }) => e.type), ['decision', 'adoption_rejected']);
    assert.equal(evs[0].decision, 'discard'); assert.equal(evs[0].version, recolor);
    assert.doesNotMatch(await page.textContent('#h-insp') as string, new RegExp(`^${recolor}`), 'the view moves to the parent');
  });

  await check('ADE: no page errors', async () => assert.deepEqual(page.errors, []));
  site.close();
}

await browser.close();
for (const p of procs) p.kill('SIGTERM');
await sleep(300);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
