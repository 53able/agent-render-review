// Browser E2E (headless Chrome via playwright-core). Requires vork and Google Chrome.
// Part A: standalone flow (AC-11). Part B: ADE flow — agent proposal appears, feedback, page preview (AC-09), adoption.
// Set E2E_AGENT=1 to also exercise the built-in `claude -p` proposer in standalone mode (costs an API call).
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import type { Route } from 'playwright-core';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireGpuLock } from './gpu-lock.mts';
import { largeScene, largeNodeName, LARGE_SCENE_EXTRA } from './fixtures/large-scene.mts';

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

// ---- Checks added before the React migration (plan Step 1). They select by id, attribute and role only, and check
// presence with page.$ and the hidden attribute, so they run unchanged against the old and the new UI. ----
interface StateVersion { id: string; parent: string | null; status: string; renders: Record<string, unknown>; scene: { nodes: { name: string; materials?: { inputs: Record<string, unknown> }[] }[] } }
const versionsOf = async (page: Page): Promise<StateVersion[]> => (await page.evaluate(() => fetch('/api/state').then((r) => r.json()))).versions;
const isHidden = (page: Page, sel: string) => page.$eval(sel, (e) => e.hasAttribute('hidden'));
// AC-12: these stay in the DOM; only the hidden attribute shows or hides them (no conditional rendering).
const ALWAYS_PRESENT = ['#jobList', '#jobBox', '#notice', '#adoptBox', '#wipe', '#empty', '#starters', '#review', '#eventList', '#adeHint', '#objectMore'];
async function assertAlwaysPresent(page: Page) {
  for (const sel of ALWAYS_PRESENT) {
    const el = await page.$(sel);
    assert.notEqual(el, null, `${sel} must always be in the DOM`);
    assert.ok(await el!.evaluate((e) => e.closest('[hidden]') !== null || e.getClientRects().length > 0), `${sel} is either hidden by the hidden attribute or shown`);
  }
  assert.match(await page.getAttribute('#canvas', 'data-ready') ?? '', /^[\w-]+:(draft|previs|final)$/, '#canvas[data-ready] is `${versionId}:${profile}`');
}
// AC-13: a drag sends several `input` events and one `change` on release. The native value setter is used so a
// framework that tracks the value property sees the same events a real drag produces.
const dragQuickInput = (page: Page, type: 'range' | 'color', values: string[]) => page.evaluate(({ type, values }) => {
  const el = document.querySelector<HTMLInputElement>(`#quick input[type=${type}]`)!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  for (const v of values) { set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, { type, values });
/** Waits until the version count reaches n and the newest version's draft is on screen; returns the versions. */
async function waitForNewVersion(page: Page, n: number) {
  for (let i = 0; i < 100; i++) { const vs = await versionsOf(page); if (vs.length >= n) break; await sleep(150); }
  const vs = await versionsOf(page); assert.equal(vs.length, n, 'exactly one new version');
  await page.waitForSelector(`#canvas[data-ready="${vs.at(-1)!.id}:draft"]`, { timeout: 120000 }); await idle(page);
  await sleep(1500); // a duplicate version from a second change event would have been created by now
  return versionsOf(page);
}
/** A point inside `name` (or, for null, on no object), from the object-id pass of what the canvas shows; fractions of the canvas box. */
const spotOf = (page: Page, name: string | null) => page.evaluate(async (name) => {
  const [id, profile] = document.querySelector('#canvas')!.getAttribute('data-ready')!.split(':');
  const st = await (await fetch('/api/state')).json();
  const r = st.versions.find((v: { id: string }) => v.id === id).renders[profile!];
  const arr = new Uint16Array(await (await fetch(r.ids)).arrayBuffer());
  const names = new Map<number, string>(r.objects.map((o: { pass_index: number; name: string }) => [o.pass_index, o.name]));
  const w: number = r.width, h: number = r.height, m = 4; const hits: number[] = [];
  for (let y = m; y < h - m; y++) for (let x = m; x < w - m; x++) {
    const i = y * w + x; if ((names.get(arr[i]!) ?? null) !== name) continue;
    if ([-m, m].every((d) => arr[i + d] === arr[i] && arr[i + d * w] === arr[i])) hits.push(i);
  }
  if (!hits.length) return null;
  const i = hits[hits.length >> 1]!; return { fx: (i % w + 0.5) / w, fy: (Math.floor(i / w) + 0.5) / h };
}, name);
const canvasPoint = async (page: Page, spot: { fx: number; fy: number }) => { const b = (await page.locator('#canvas').boundingBox())!; return { x: b.x + b.width * spot.fx, y: b.y + b.height * spot.fy }; };

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
  await check('AC-13 standalone: a slider drag (input ×3, then change) creates one version with the released value', async () => {
    await page.waitForSelector('#quick input[type=range]'); await idle(page);
    const before = await versionsOf(page);
    await dragQuickInput(page, 'range', ['0.3', '0.45', '0.62']);
    const after = await waitForNewVersion(page, before.length + 1);
    assert.equal(after.at(-1)!.scene.nodes.find((n) => n.name === 'vase')!.materials![0]!.inputs.specular_roughness, 0.62);
  });
  await check('AC-13 standalone: a colour drag (input ×3, then change) creates one version with the released colour', async () => {
    await page.waitForSelector('#quick input[type=color]'); await idle(page);
    const before = await versionsOf(page);
    await dragQuickInput(page, 'color', ['#ff0000', '#00ff00', '#3366cc']);
    const after = await waitForNewVersion(page, before.length + 1);
    // vork colours are linear: sRGB #3366cc → linear (0.2, 0.4, 0.8 through the sRGB transfer function)
    const lin = [0x33, 0x66, 0xcc].map((c) => ((c / 255 + 0.055) / 1.055) ** 2.4);
    const got = after.at(-1)!.scene.nodes.find((n) => n.name === 'vase')!.materials![0]!.inputs.base_color as number[];
    assert.equal(got.length, 3); got.forEach((c, i) => assert.ok(Math.abs(c - lin[i]!) < 1e-3, `base_color ${JSON.stringify(got)} ≈ ${JSON.stringify(lin)}`));
  });
  await check('standalone: hovering an object shows #tip with its name', async () => {
    await page.waitForSelector('#canvas[data-ready]');
    const vase = await spotOf(page, 'vase'); assert.ok(vase, 'the vase is on screen');
    const p = await canvasPoint(page, vase); await page.mouse.move(p.x, p.y);
    await page.waitForFunction(() => !document.querySelector('#tip')!.hasAttribute('hidden'), null, { timeout: 3000 });
    assert.match(await page.textContent('#tip') as string, /vase/);
  });
  await check('standalone: Shift-click adds an object to the selection', async () => {
    assert.match(await page.textContent('#selCount') as string, /vase/, 'the vase is still selected from the edits above');
    const ring = await spotOf(page, 'ring'); assert.ok(ring, 'the ring is on screen');
    const p = await canvasPoint(page, ring);
    await page.keyboard.down('Shift'); await page.mouse.click(p.x, p.y); await page.keyboard.up('Shift');
    const sel = await page.textContent('#selCount') as string;
    assert.match(sel, /vase/); assert.match(sel, /ring/);
  });
  await check('AC-11 standalone: compare wipe appears against the parent', async () => {
    await page.check('#compareToggle'); await sleep(600);
    assert.equal(await page.locator('#wipe').isVisible(), true);
    await page.uncheck('#compareToggle');
  });
  await check('at 1440×900 the page itself does not scroll in either theme while the job list shows: the panels scroll inside', async () => {
    // A failed job stays listed until dismissed, so a fake one (no GPU) keeps the job list on screen while measuring.
    const v = await page.evaluate(() => document.querySelector('#canvas')!.getAttribute('data-ready')!.split(':')[0]!);
    const steps = Array.from({ length: 8 }, (_, i) => ({ status: 'done', label: `step ${i + 1}`, t: i * 100 }));
    const job = { id: 'fakejob', kind: 'render', status: 'running', versionId: v, steps: [], elapsed: 0, result: null };
    await page.route('**/api/render', (r) => r.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(job) }));
    await page.route('**/api/jobs/fakejob', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...job, status: 'failed', error: 'fake', steps }) }));
    await page.setViewportSize({ width: 1440, height: 900 }); await sleep(300);
    try {
      await page.click('#finalBtn'); await page.waitForSelector('#finalPlanBox:not([hidden])'); await page.click('#finalApprove');
      await page.waitForSelector('#jobList [data-job="fakejob"][data-status="failed"]', { timeout: 5000 });
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme }); await sleep(200);
        const [sh, ih, content] = await page.evaluate(() => [document.documentElement.scrollHeight, window.innerHeight, document.querySelector('.inspector')!.scrollHeight]);
        assert.ok(content > ih, `${colorScheme}: the inspector content (${content} px) is taller than the screen (${ih} px)`);
        assert.equal(sh, ih, `${colorScheme}: scrollHeight ${sh} vs innerHeight ${ih}`);
      }
    } finally {
      await page.click('#jobList [data-job="fakejob"] button[data-dismiss-job]').catch(() => {});
      await page.unroute('**/api/render'); await page.unroute('**/api/jobs/fakejob');
      await page.emulateMedia({ colorScheme: null }); await page.setViewportSize({ width: 1500, height: 1000 }); await sleep(200);
    }
  });
  await check('#57 the final render plan opens inline: the wipe works meanwhile, and switching versions closes it', async () => {
    const head = await page.evaluate(() => document.querySelector('.headmark')!.closest('button')!.getAttribute('data-id'));
    await page.click('#finalBtn'); await page.waitForSelector('#finalPlanBox:not([hidden])');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'h-fplan', 'focus moves to the plan');
    assert.equal(await page.locator('[role=dialog],[role=alertdialog]').count(), 0, 'no modal');
    await page.check('#compareToggle'); await page.waitForSelector('#wipe:not([hidden])');
    const thumb = page.locator('#wipe [role=slider]'); await thumb.press('Home'); await thumb.press('PageUp'); await thumb.press('PageUp'); assert.equal(await thumb.getAttribute('aria-valuenow'), '20'); await page.uncheck('#compareToggle');
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
  // main #54 (87171ad): the poll no longer pauses for jobs or dialogs, and the final render is planned inline (#57),
  // so this pins that /api/state keeps being polled while the plan is open, and after it closes.
  await check('standalone: polling /api/state continues while the final render plan is open and after it closes', async () => {
    await idle(page);
    let polls = 0; const count = (r: { url(): string }) => { if (new URL(r.url()).pathname === '/api/state') polls++; };
    page.on('request', count);
    try {
      await page.click('#finalBtn');
      await page.waitForSelector('#finalPlanBox:not([hidden])', { timeout: 10000 });
      polls = 0;
      await sleep(5600); // more than two 2.5 s poll intervals
      assert.ok(polls >= 2, `polling continued while the plan was open (${polls} requests)`);
      await page.focus('#finalApprove'); await page.keyboard.press('Escape');
      await page.waitForSelector('#finalPlanBox', { state: 'hidden', timeout: 5000 });
      polls = 0;
      await sleep(5600);
      assert.ok(polls >= 2, `polling continued after the plan closed (${polls} requests)`);
    } finally { page.off('request', count); }
  });
  await check('AC-12 standalone: the always-present elements are in the DOM', () => assertAlwaysPresent(page));
  // UI plan AC-11: what is inside the viewport is judged as a render, so its colours must not follow the page theme.
  await check('UI AC-11 standalone: viewport colours are the same in the light and the dark theme', async () => {
    const styles = () => page.evaluate(() => {
      const of = (sel: string, props: string[]) => {
        const el = document.querySelector(sel); if (!el) throw new Error(`${sel} is missing`);
        const cs = getComputedStyle(el); return props.map((p) => `${sel} ${p}: ${cs.getPropertyValue(p)}`);
      };
      return [
        ...of('#viewport', ['background-color']), ...of('#canvas', ['background-color']),
        ...of('#tip', ['color', 'background-color', 'border-top-color']), ...of('#empty', ['color', 'background-color']),
        ...of('#wipe [data-slot=slider-track]', ['background-color']), ...of('#wipe [data-slot=slider-range]', ['background-color']),
        ...of('#wipe [role=slider]', ['background-color', 'border-top-color']),
      ];
    });
    try {
      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForFunction(() => !document.documentElement.classList.contains('dark'), null, { timeout: 3000 });
      const light = await styles();
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForFunction(() => document.documentElement.classList.contains('dark'), null, { timeout: 3000 });
      const dark = await styles();
      assert.deepEqual(dark, light);
      assert.ok(light.includes('#viewport background-color: rgb(0, 0, 0)'), light.join('\n'));
    } finally { await page.emulateMedia({ colorScheme: 'light' }); }
  });
  await check('standalone: the compare wipe thumb has an accessible name', async () => {
    assert.equal(await page.getAttribute('#wipe [role=slider]', 'aria-label'), 'Compare wipe position');
  });
  // UI plan AC-9: the theme follows prefers-color-scheme, is right before first paint and changes without a reload.
  await check('UI AC-9: the dark class follows the colour scheme from DOMContentLoaded on and changes without a reload', async () => {
    const themed = await newPage();
    try {
      await themed.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => { (window as any).__darkAtDCL = document.documentElement.classList.contains('dark'); });
      });
      for (const scheme of ['dark', 'light'] as const) {
        await themed.emulateMedia({ colorScheme: scheme });
        await themed.goto(url); // unpaired is enough: the theme does not depend on the session
        assert.equal(await themed.evaluate(() => (window as any).__darkAtDCL), scheme === 'dark', `dark class at DOMContentLoaded (${scheme})`);
      }
      await themed.evaluate(() => { (window as any).__sameDocument = true; });
      await themed.emulateMedia({ colorScheme: 'dark' });
      await themed.waitForFunction(() => document.documentElement.classList.contains('dark'), null, { timeout: 3000 });
      await themed.emulateMedia({ colorScheme: 'light' });
      await themed.waitForFunction(() => !document.documentElement.classList.contains('dark'), null, { timeout: 3000 });
      assert.equal(await themed.evaluate(() => (window as any).__sameDocument), true, 'no reload');
      assert.deepEqual(themed.errors, []);
    } finally { await themed.close(); }
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
    await page.click('#auditbox summary, .auditbox summary, #auditbox [aria-expanded]');
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
    assert.doesNotMatch(await page.textContent('#viewing') as string, new RegExp(`^Showing ${vid} `), 'the view must not switch by itself');
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

  await check('at 390 px Plan final render… starts at the left edge of the inspector heading', async () => {
    // v001 is HEAD here: its decide row is empty, which is where an unintended gap came from.
    await page.click('button[data-id="v001"]'); await page.waitForSelector('#canvas[data-ready="v001:draft"]');
    await page.setViewportSize({ width: 390, height: 844 }); await sleep(300);
    try {
      await page.click('#tab-insp');
      const [h, b] = await page.evaluate(() => ['#h-insp', '#finalBtn'].map((q) => document.querySelector(q)!.getBoundingClientRect().left));
      assert.ok(Math.abs(h! - b!) < 1, `heading at ${h} px, button at ${b} px`);
    } finally {
      await page.setViewportSize({ width: 1500, height: 1000 }); await sleep(200);
      await page.click(`button[data-id="${vid}"]`); await page.waitForSelector(`#canvas[data-ready="${vid}:draft"]`);
    }
  });

  await check('#60 at 1024 px the render stays on top and Accept is within one screen of scrolling', async () => {
    await page.setViewportSize({ width: 1024, height: 768 }); await sleep(300);
    const top = (sel: string) => page.evaluate((q) => document.querySelector(q)!.getBoundingClientRect().top + window.scrollY, sel);
    assert.ok(await top('#canvas') < 768, 'the render starts on the first screen');
    assert.ok(await top('#acceptBtn') < 768 * 2, `Accept is within one scroll (at ${await top('#acceptBtn')} px)`);
    await page.evaluate(() => window.scrollTo(0, 600)); await sleep(100);
    const b = (await page.locator('#canvas').boundingBox())!; assert.ok(b.y >= 0 && b.y < 200, 'the render stays in view while scrolling');
    await page.click('#tab-versions');
    assert.equal(await page.locator('#versionList').isVisible(), true); assert.equal(await page.locator('#acceptBtn').isVisible(), false);
    await page.click('#tab-insp'); assert.equal(await page.locator('#acceptBtn').isVisible(), true);
    await page.screenshot({ path: path.join(process.env.E2E_SHOTS_DIR || tmp, 'narrow.png') }); // not a README image
    await page.evaluate(() => window.scrollTo(0, 0));
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

  await check('#59 the feedback box names the version it goes to and follows the view; direct edit says what unlocks it', async () => {
    await page.click(`button[data-id="${vid}"]`); await page.waitForSelector(`#canvas[data-ready="${vid}:draft"]`);
    assert.match(await page.textContent('#askTarget') as string, new RegExp(`Feedback on ${vid} \\(proposed`));
    assert.equal(await page.locator('#quick #qAccept').count(), 1); assert.equal(await page.locator('#quick #qHead').count(), 1);
    await page.click('#refineBtn'); assert.equal(await page.evaluate(() => document.activeElement?.id), 'instruction');
    await page.click('#quick #qHead'); await page.waitForSelector('#canvas[data-ready="v001:draft"]');
    assert.match(await page.textContent('#askTarget') as string, /Feedback on v001 \(accepted/);
    await agent('GET', '/api/agent/feedback?wait=0'); // drain
    await page.fill('#instruction', 'about the starter'); await page.click('#askBtn');
    await page.waitForFunction(() => document.querySelector('#eventList')!.textContent!.includes('about the starter'), null, { timeout: 5000 });
    const ev = (await agent('GET', '/api/agent/feedback?wait=0')).events.find((e: { type: string }) => e.type === 'feedback');
    assert.equal(ev.version, 'v001', 'sent to the version the box named');
    assert.equal(await page.locator('#compareToggle').isDisabled(), true, 'v001 has no parent'); assert.match(await page.textContent('#compareWhy') as string, /no parent/);
  });

  await check('#53 refused feedback and decisions stay on screen for 5 s and keep what was typed', async () => {
    await page.click(`button[data-id="${vid}"]`); await page.waitForSelector('#acceptBtn');
    await page.route('**/api/feedback', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'disk full' }) }));
    await page.route('**/api/decide', (r) => r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'this version is being adopted' }) }));
    try {
      await page.fill('#instruction', 'keep me'); await page.click('#askBtn');
      await page.click('#acceptBtn');
      await sleep(5000);
      assert.match(await page.textContent('#err-ask') as string, /Could not send: disk full/); assert.equal(await page.inputValue('#instruction'), 'keep me');
      assert.match(await page.textContent('#err-review') as string, new RegExp(`Cannot accept ${vid}: this version is being adopted`));
      assert.equal(await page.locator('#err-ask .err[role=alert]').isVisible(), true); assert.equal(await page.locator('#err-review .err[role=alert]').isVisible(), true);
    } finally { await page.unroute('**/api/feedback'); await page.unroute('**/api/decide'); }
    await page.click('#err-ask button[aria-label=Dismiss]'); await page.click('#err-review button[aria-label=Dismiss]'); await page.fill('#instruction', '');
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
      // a proposal made now waits for the GPU (its validation render queues behind the final render, #49)
      const scene: { nodes: SceneNode[] } = (await agent('GET', '/api/agent/scene?version=v001')).scene;
      scene.nodes.find((n) => n.name === 'key')!.energy = 77;
      const queued = agent('POST', '/api/agent/propose', { base: 'v001', scene, interpretation: 'made during a final render', claimed_changes: [{ node: 'key', what: 'energy 77', why: 'test' }] });
      // another version can be opened and compared while the job runs
      await page.click('button[data-id="v001"]'); await page.waitForSelector('#canvas[data-ready="v001:draft"]', { timeout: 10000 });
      assert.equal(await page.locator('#finalBtn').isDisabled(), false, 'v001 has no job');
      assert.ok(await page.locator(`#versionList button.busy[data-id="${vid}"]`).count(), 'the version list marks the busy version');
      await page.click(`#jobList [data-version="${vid}"] button[data-cancel-job]`);
      await page.waitForSelector(`#jobList [data-status="cancelled"][data-version="${vid}"]`, { timeout: 10000 });
      await sleep(2000);
      assert.equal(await page.locator(`#jobList [data-status="cancelled"][data-version="${vid}"]`).count(), 1, 'a cancelled job stays listed');
      await page.click(`#jobList [data-version="${vid}"] button[data-dismiss-job]`);
      // once the GPU is free the queued proposal is made, listed and announced
      const made = (await queued).version; assert.ok(made);
      await page.waitForFunction((id) => !!document.querySelector(`#versionList button[data-id="${id}"]`), made, { timeout: 10000 });
      await page.waitForSelector('#notice:not([hidden])', { timeout: 10000 }); await page.click('#notice button[aria-label=Dismiss]');
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
    // #59: what is shown is spelled out, and Compare says why it cannot be used on page
    assert.match(await page.textContent('#viewing') as string, new RegExp(`^Showing ${vid} · proposed · draft on page`));
    assert.equal(await page.locator('#compareToggle').isDisabled(), true); assert.match(await page.textContent('#compareWhy') as string, /not on page/);
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
    await page.waitForFunction(() => document.querySelector('#err-preview')!.textContent!.includes('unavailable'), null, { timeout: 60000 });
    await sleep(5000);
    // #53: the reason stays on screen (not only for screen readers) next to the render shown instead
    assert.equal(await page.locator('#err-preview .err[role=alert]').isVisible(), true);
    assert.doesNotMatch(await page.textContent('#viewing') as string, /on page/);
    assert.equal(await page.locator('#pageBtn').getAttribute('aria-pressed'), 'false');
    await page.focus('#pageBtn'); await page.click('#err-preview .err button[aria-label=Dismiss]');
    assert.equal(await page.locator('#err-preview .err').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'pageBtn', 'dismissing returns focus to the control');
    await page.click('[data-profile="draft"]');
  });

  await check('ADE: adoption request → human approves in the dialog → image written into the project', async () => {
    const r = await agent('POST', '/api/agent/adoption-request', { version: vid, slug: 'hero', reason: '暗い背景のヒーローに合う' });
    assert.equal(r.status, 'pending_human_approval');
    await page.waitForSelector('#adoptBox:not([hidden])', { timeout: 10000 });
    await page.click('#adoptList button'); await sleep(500);
    assert.match(await page.textContent('#adoptPlan') as string, /public\/vork\/hero\.png/);
    // #58: the image to be written is inside the dialog; nothing is replaced yet
    await page.waitForFunction(() => (document.querySelector('#adoptDlg img.write') as HTMLImageElement | null)?.naturalWidth! > 0, null, { timeout: 5000 });
    assert.match(await page.textContent('#adoptImages') as string, /Replaces nothing/);
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
    const summary = page.locator('#review [data-group] [aria-expanded]').first();
    assert.match(await summary.textContent() as string, new RegExp(`^${BIRDS} mesh nodes added: b0 … b${BIRDS - 1} \\(${BIRDS}\\)`));
    await summary.click();
    await page.waitForFunction((n) => document.querySelectorAll('#review [data-group] tbody tr').length === n, BIRDS, { timeout: 5000 });
    // a new agent version changes the state signature, so the poll re-renders the review panel
    await agent('POST', '/api/agent/adoption-request', { version: flock, slug: 'flock', reason: 'refresh' });
    await page.waitForSelector('#adoptBox:not([hidden])', { timeout: 10000 });
    assert.equal(await page.locator('#review [data-group][data-state=open]').count(), 1);
  });
  await check('#35 the OBJECTS list shows at most 200 rows, filters by name, and a selection updates its row', async () => {
    assert.equal(await page.locator('#objectList li').count(), 200);
    assert.match(await page.textContent('#objectMore') as string, /more — type to filter/);
    await page.fill('#objectFilter', 'b39'); await sleep(100);
    assert.deepEqual(await page.locator('#objectList li').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.name)), ['b39', 'b390', 'b391', 'b392', 'b393', 'b394', 'b395', 'b396', 'b397', 'b398', 'b399']);
    await page.locator('#objectList li[data-name="b391"] [role=checkbox]').check();
    assert.match(await page.textContent('#selCount') as string, /b391/);
    assert.equal(await page.locator('#objectList label.sel').count(), 1);
    await page.fill('#objectFilter', ''); await sleep(100);
    // #46: the selected object is past the first 200, so it is listed first
    assert.equal(await page.locator('#objectList li').first().getAttribute('data-name'), 'b391');
    assert.equal(await page.locator('#objectList li[data-name="b391"] label.sel').count(), 1);
    await page.locator('#objectList li[data-name="b391"] [role=checkbox]').uncheck(); await sleep(100);
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
    // #52: built on an unaccepted proposal, so by default it shows what accepting it changes: HEAD → this version
    assert.equal(await page.locator('#review [role=radio][value=head]').isChecked(), true);
    assert.match(await page.textContent('#review') as string, new RegExp(`Includes the changes of ${flock}`));
    assert.match(await page.locator('#review [data-group] [aria-expanded]').first().textContent() as string, new RegExp(`^${BIRDS} mesh nodes added`));
    assert.equal(await page.locator('#review tr.unclaimed').count(), 0, "the flock's own claim covers its birds");
    assert.match(await page.textContent('#compareBase') as string, /^HEAD/);
    await page.check('#review [role=radio][value=parent]');
    assert.match(await page.textContent('#review') as string, new RegExp(`Built on ${flock}, which is proposed`));
    assert.equal(await page.textContent('#compareBase'), 'parent');
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

  await check('#58 an adoption that would overwrite shows the existing image; Cancel writes nothing and keeps the request', async () => {
    const hero = path.join(PROJECT, 'public', 'vork', 'hero.png'); const before = fs.readFileSync(hero);
    const r = await agent('POST', '/api/agent/adoption-request', { version: 'v001', slug: 'hero', reason: 'the starter instead' });
    await page.waitForSelector(`#adoptList button[data-req="${r.request}"]`, { timeout: 10000 });
    await page.click(`#adoptList button[data-req="${r.request}"]`);
    await page.waitForFunction(() => (document.querySelector('#adoptDlg img.existing') as HTMLImageElement | null)?.naturalWidth! > 0, null, { timeout: 5000 });
    assert.match(await page.textContent('#adoptImages') as string, /Replaces public\/vork\/hero\.png · modified/);
    await page.click('#adoptDlg button[value=cancel]'); await sleep(300);
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.req), r.request, 'focus returns to Review…');
    assert.deepEqual(fs.readFileSync(hero), before);
    const st = await page.evaluate(async () => (await fetch('/api/state')).json());
    assert.equal(st.adoptionRequests.find((a: { id: string }) => a.id === r.request).status, 'pending');
    assert.equal(await page.evaluate(async (id) => (await fetch('/api/adopt/reject', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: id }) })).status, r.request), 200);
  });

  await check('AC-12 ADE: the always-present elements are in the DOM', () => assertAlwaysPresent(page));

  const statusOf = async (id: string) => ((await agent('GET', '/api/agent/status')).versions as { id: string; status: string }[]).find((v) => v.id === id)?.status;
  const firstNoticeButton = () => page.locator('#notice button').first();
  let large = '', baseCount = 0;
  await check('ADE: a new agent proposal marks the tab title with (1); the notice offers View first', async () => {
    const base = (await agent('GET', '/api/agent/scene')).scene; baseCount = base.nodes.length;
    const r = await agent('POST', '/api/agent/propose', { scene: largeScene(base), interpretation: '小さな点を250個並べる', claimed_changes: [{ node: 'dot*', what: `add ${LARGE_SCENE_EXTRA} small spheres`, why: 'large-scene fixture' }] });
    large = r.version; assert.ok(large, JSON.stringify(r));
    await page.waitForSelector('#notice:not([hidden])', { timeout: 15000 });
    assert.match(await page.title(), /^\(1\) /);
    assert.match(await firstNoticeButton().textContent() as string, /View/);
  });
  await check('ADE: opening the proposal from the notice clears the notice and the title mark', async () => {
    await firstNoticeButton().click();
    await page.waitForSelector(`#canvas[data-ready="${large}:draft"]`, { timeout: 15000 });
    assert.notEqual(await page.$('#notice'), null); assert.equal(await isHidden(page, '#notice'), true);
    assert.doesNotMatch(await page.title(), /\(1\)/);
  });
  await check('ADE: a scene with more than 200 objects lists 200 and shows #objectMore', async () => {
    assert.equal(await page.locator('#objectList li').count(), 200);
    assert.notEqual(await page.$('#objectMore'), null); assert.equal(await isHidden(page, '#objectMore'), false);
    assert.match(await page.textContent('#objectMore') as string, new RegExp(`\\b${baseCount + LARGE_SCENE_EXTRA - 200} more\\b`));
  });
  await check('ADE: added nodes collapse into a diff group whose rows are not built until it is opened', async () => {
    assert.ok(await page.locator('#review [data-group]').count() >= 1, 'a diff group');
    assert.equal(await page.locator('#review [data-group] tbody tr').count(), 0, 'no rows before the group is opened');
    assert.equal(await page.locator('#review [data-group] [aria-expanded]').first().getAttribute('aria-expanded'), 'false');
  });
  await check('ADE: Accept makes the viewed proposal the new HEAD', async () => {
    await page.click('#acceptBtn');
    for (let i = 0; i < 50 && (await agent('GET', '/api/agent/status')).head !== large; i++) await sleep(100);
    assert.equal((await agent('GET', '/api/agent/status')).head, large);
    assert.equal(await statusOf(large), 'accepted');
  });

  let refine = '', noticed = '';
  await check('ADE: an opened diff group and the remaining rows stay open when the poll re-renders the review', async () => {
    // From the accepted large scene: 3 dots removed (a group) and every other dot changed (more rows than the 200 shown).
    const scene = (await agent('GET', '/api/agent/scene')).scene;
    const gone = new Set([0, 1, 2].map((i) => largeNodeName(LARGE_SCENE_EXTRA - 1 - i)));
    scene.nodes = scene.nodes.filter((n: { name: string }) => !gone.has(n.name));
    for (const n of scene.nodes) if (n.name.startsWith('dot')) n.materials[0].inputs.specular_roughness = 0.2;
    const r = await agent('POST', '/api/agent/propose', { scene, interpretation: '点を少しつややかにして3つ減らす', claimed_changes: [{ node: 'dot*', what: 'roughness 0.2, 3 removed', why: 'large diff fixture' }] });
    refine = r.version; assert.ok(refine, JSON.stringify(r));
    await page.waitForSelector('#notice:not([hidden])', { timeout: 15000 });
    await firstNoticeButton().click();
    await page.waitForSelector(`#canvas[data-ready="${refine}:draft"]`, { timeout: 15000 });
    const trigger = page.locator('#review [data-group] [aria-expanded]').first();
    await trigger.click();
    await page.waitForFunction(() => document.querySelector('#review [data-group] [aria-expanded]')!.getAttribute('aria-expanded') === 'true', null, { timeout: 3000 });
    assert.equal(await page.locator('#review [data-group] tbody tr').count(), 3, 'the opened group lists its rows');
    await page.click('#moreDiff');
    await page.waitForFunction(() => !document.querySelector('#moreDiff'), null, { timeout: 3000 });
    const rows = await page.locator('#review tr').count();
    // Another proposal changes the state; the poll re-renders while the human keeps looking at this one.
    const small = (await agent('GET', `/api/agent/scene?version=${vid}`)).scene;
    // Without the floor and the backdrop, part of the frame shows no object (used by the empty-click check below).
    small.nodes = small.nodes.filter((n: SceneNode) => n.name !== 'floor' && n.name !== 'backdrop');
    const r2 = await agent('POST', '/api/agent/propose', { base: vid, scene: small, interpretation: '床と背景を外す', claimed_changes: [{ node: 'floor', what: 'removed', why: 'poll trigger' }, { node: 'backdrop', what: 'removed', why: 'empty space to click' }] });
    assert.ok(r2.version, JSON.stringify(r2));
    await page.waitForSelector('#notice:not([hidden])', { timeout: 15000 }); // announced after the poll reloaded the page state
    await sleep(300);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true', 'the group is still open');
    assert.equal(await page.locator('#review [data-group] tbody tr').count(), 3);
    assert.equal(await page.$('#moreDiff'), null, 'the remaining rows are still shown');
    assert.equal(await page.locator('#review tr').count(), rows);
    noticed = r2.version;
  });
  await check('ADE: the notice clears when its proposal stops being a proposal without being opened', async () => {
    assert.ok(noticed, 'needs the proposal announced above');
    assert.match(await page.title(), /^\(1\) /);
    const st = await page.evaluate((id) => fetch('/api/decide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versionId: id, decision: 'discard' }) }).then((r) => r.status), noticed);
    assert.equal(st, 200);
    await page.waitForFunction(() => document.querySelector('#notice')!.hasAttribute('hidden'), null, { timeout: 10000 });
    assert.doesNotMatch(await page.title(), /\(1\)/);
    assert.match(await page.getAttribute('#canvas', 'data-ready') ?? '', new RegExp(`^${refine}:`), 'the view did not move');
  });
  await check('ADE: Discard drops the viewed proposal and shows its parent', async () => {
    await page.click('#discardBtn');
    await page.waitForSelector(`#canvas[data-ready="${large}:draft"]`, { timeout: 15000 });
    // #55: the discard is sent once the few-second undo time is over
    for (let i = 0; i < 100 && await statusOf(refine) !== 'discarded'; i++) await sleep(150);
    assert.equal(await statusOf(refine), 'discarded');
    assert.equal((await agent('GET', '/api/agent/status')).head, large);
  });
  await check('ADE: clicking where there is no object clears the selection', async () => {
    assert.ok(noticed, 'needs the proposal without floor and backdrop');
    await page.click(`button[data-id="${noticed}"]`);
    await page.waitForSelector(`#canvas[data-ready="${noticed}:draft"]`, { timeout: 15000 });
    const vase = await spotOf(page, 'vase'); assert.ok(vase, 'the vase is on screen');
    // The vase may still be selected from the feedback check; clicking the only selected object would deselect it.
    if (!/vase/.test(await page.textContent('#selCount') as string)) { const pv = await canvasPoint(page, vase); await page.mouse.click(pv.x, pv.y); }
    assert.match(await page.textContent('#selCount') as string, /vase/);
    const empty = await spotOf(page, null); assert.ok(empty, 'some pixel shows no object');
    const pe = await canvasPoint(page, empty); await page.mouse.click(pe.x, pe.y);
    assert.doesNotMatch(await page.textContent('#selCount') as string, /vase/);
  });

  await check('a direct edit on an accepted version that is not HEAD keeps selected an object HEAD does not have', async () => {
    // v001 as HEAD: the accepted large scene is not HEAD, and its dots are not in HEAD's scene.
    const st = await page.evaluate(() => fetch('/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versionId: 'v001' }) }).then((r) => r.status));
    assert.equal(st, 200);
    // The page knows v001 is HEAD (from the poll): that is the version shown in place of one not loaded yet.
    await page.waitForFunction(() => document.querySelector('.headmark')?.closest('button')?.getAttribute('data-id') === 'v001', null, { timeout: 10000 });
    await page.click(`button[data-id="${large}"]`); await page.waitForSelector(`#canvas[data-ready="${large}:draft"]`, { timeout: 15000 });
    const dot = largeNodeName(0);
    await page.fill('#objectFilter', dot);
    await page.locator(`#objectList li[data-name="${dot}"] [role=checkbox]`).check();
    await page.waitForSelector('#quick input[type=range]'); await idle(page);
    const before = await versionsOf(page);
    // /api/state is held until the edit has answered, so no poll brings the new version in before the page views it.
    let release!: () => void; const answered = new Promise<void>((ok) => { release = ok; });
    await page.route('**/api/state', async (r) => { await answered; await r.continue(); });
    await page.route('**/api/edit', async (r) => { const res = await r.fetch(); await r.fulfill({ response: res }); release(); });
    try { await dragQuickInput(page, 'range', ['0.7']); await answered; }
    finally { await page.unroute('**/api/edit'); await page.unroute('**/api/state'); }
    const after = await waitForNewVersion(page, before.length + 1);
    assert.equal(after.at(-1)!.parent, large);
    assert.match(await page.textContent('#selCount') as string, new RegExp(dot), 'the dot is still selected');
    assert.equal(await page.textContent('#quick b'), dot, 'QuickEdit stays on the dot');
    await page.fill('#objectFilter', '');
  });

  // Versions made by the direct edits below while another version is viewed: their renders are never drawn on this page
  // (so no image of them is cached) until the draw-failure checks.
  let editFailed = '', editMoved = '';
  const quickOnLarge = async () => {
    await page.click(`button[data-id="${large}"]`); await page.waitForSelector(`#canvas[data-ready="${large}:draft"]`, { timeout: 15000 });
    await page.waitForSelector('#quick input[type=range]'); await idle(page);
  };
  const newVersionAfter = async (n: number) => {
    for (let i = 0; i < 100 && (await versionsOf(page)).length < n; i++) await sleep(150);
    const vs = await versionsOf(page); assert.equal(vs.length, n, 'exactly one new version');
    await page.waitForSelector(`#versionList button[data-id="${vs.at(-1)!.id}"]`, { timeout: 10000 }); await idle(page);
    return vs.at(-1)!;
  };
  await check('a direct edit whose reload fails keeps the edited version on screen, not HEAD in place of the new one', async () => {
    await quickOnLarge();
    const before = await versionsOf(page);
    let release!: () => void; const answered = new Promise<void>((ok) => { release = ok; }); let failing = true;
    await page.route('**/api/state', async (r) => {
      await answered;
      if (failing) await r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'state unavailable' }) }); else await r.continue();
    });
    await page.route('**/api/edit', async (r) => { const res = await r.fetch(); await r.fulfill({ response: res }); release(); });
    try {
      await dragQuickInput(page, 'range', ['0.65']); await answered;
      await page.waitForFunction(() => /could not load it/.test(document.querySelector('#err-view')!.textContent!), null, { timeout: 5000 });
      await sleep(300);
      assert.equal(await page.getAttribute('#canvas', 'data-ready'), `${large}:draft`, 'the edited version stays drawn');
    } finally { failing = false; await page.unroute('**/api/edit'); await page.unroute('**/api/state'); }
    const created = await newVersionAfter(before.length + 1);
    assert.equal(created.parent, large);
    assert.equal(await page.getAttribute('#canvas', 'data-ready'), `${large}:draft`, 'the next poll brings the version in without switching to it');
    editFailed = created.id;
  });
  await check('a version opened while a direct edit is loading stays on screen when the load answers', async () => {
    await quickOnLarge();
    const before = await versionsOf(page);
    let release!: () => void; const moved = new Promise<void>((ok) => { release = ok; });
    let answer!: () => void; const answered = new Promise<void>((ok) => { answer = ok; });
    await page.route('**/api/state', async (r) => { await moved; await r.continue(); });
    await page.route('**/api/edit', async (r) => { const res = await r.fetch(); await r.fulfill({ response: res }); answer(); });
    try {
      await dragQuickInput(page, 'range', ['0.75']); await answered;
      await page.click('button[data-id="v001"]'); await page.waitForSelector('#canvas[data-ready="v001:draft"]', { timeout: 15000 });
    } finally { release(); await page.unroute('**/api/edit'); await page.unroute('**/api/state'); }
    const created = await newVersionAfter(before.length + 1);
    assert.equal(created.parent, large);
    await sleep(500);
    assert.equal(await page.getAttribute('#canvas', 'data-ready'), 'v001:draft', 'the view did not move to the new version');
    editMoved = created.id;
  });
  await check('the hover tip goes when another version is drawn under a pointer that does not move', async () => {
    await page.waitForSelector('#canvas[data-ready="v001:draft"]');
    const vase = await spotOf(page, 'vase'); assert.ok(vase, 'the vase is on screen');
    const pt = await canvasPoint(page, vase); await page.mouse.move(pt.x, pt.y);
    await page.waitForFunction(() => !document.querySelector('#tip')!.hasAttribute('hidden'), null, { timeout: 3000 });
    await page.evaluate((id) => document.querySelector<HTMLElement>(`button[data-id="${id}"]`)!.click(), large); // no pointer move
    await page.waitForSelector(`#canvas[data-ready="${large}:draft"]`, { timeout: 15000 });
    assert.equal(await isHidden(page, '#tip'), true);
    await page.mouse.move(0, 0);
  });
  const draftImage = async (id: string) => new URL(((await versionsOf(page)).find((v) => v.id === id)!.renders.draft as { image: string }).image, url).href;
  await check('a draw that a newer draw replaced does not report its failure', async () => {
    assert.ok(editFailed && editMoved, 'needs the two versions made above');
    const slow = await draftImage(editFailed); const match = (u: URL) => u.href === slow;
    const handler = async (r: Route) => { await sleep(1500); await r.abort(); };
    await page.route(match, handler);
    try {
      await page.click(`button[data-id="${editFailed}"]`); await page.click(`button[data-id="${editMoved}"]`);
      await page.waitForSelector(`#canvas[data-ready="${editMoved}:draft"]`, { timeout: 15000 });
      await sleep(1800);
      assert.doesNotMatch(await page.textContent('#err-view') as string, /Cannot show the render/);
    } finally { await page.unroute(match, handler); }
  });
  await check('a failed draw is cleared once the page with the candidate is drawn', async () => {
    setConfig({ pageUrl: 'http://127.0.0.1:4794/', assetUrlPattern: '**/vork/hero.png' });
    const broken = await draftImage(editFailed); const match = (u: URL) => u.href === broken;
    const handler = (r: Route) => r.fulfill({ status: 404, body: '' });
    await page.route(match, handler);
    try {
      await page.click(`button[data-id="${editFailed}"]`);
      await page.waitForFunction(() => /Cannot show the render/.test(document.querySelector('#err-view')!.textContent!), null, { timeout: 10000 });
      await page.click('#pageBtn');
      await page.waitForFunction(() => document.querySelector('#measure')!.textContent!.includes('substituted'), null, { timeout: 60000 });
      assert.doesNotMatch(await page.textContent('#err-view') as string, /Cannot show the render/);
    } finally { await page.unroute(match, handler); }
    await page.click('#pageBtn'); await page.waitForSelector(`#canvas[data-ready="${editFailed}:draft"]`, { timeout: 15000 });
  });
  await check('#55 when the reload after Make HEAD fails, the page says so instead of an unhandled rejection', async () => {
    await page.click(`button[data-id="${large}"]`); await page.waitForSelector('#headBtn');
    const errs = page.errors.length;
    await page.route('**/api/state', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'state unavailable' }) }));
    try {
      await page.click('#headBtn');
      await page.waitForFunction(() => /is now HEAD, but could not reload/.test(document.querySelector('#err-view')!.textContent!), null, { timeout: 5000 });
      await sleep(300);
    } finally { await page.unroute('**/api/state'); }
    assert.equal((await agent('GET', '/api/agent/status')).head, large);
    assert.deepEqual(page.errors.slice(errs), []);
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
