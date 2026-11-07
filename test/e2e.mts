// Browser E2E (headless Chrome via playwright-core). Requires vork and Google Chrome.
// Part A: standalone flow (AC-11). Part B: ADE flow — agent proposal appears, feedback, page preview (AC-09), adoption.
// Set E2E_AGENT=1 to also exercise the built-in `claude -p` proposer in standalone mode (costs an API call).
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(CHROME)) { console.log('SKIP e2e: Chrome not found (set CHROME_PATH)'); process.exit(0); }
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vd-e2e-')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, failures = 0; const procs = [];
async function check(name, fn) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ')}`); }
}
const PAIR = 'e2e' + Date.now().toString(16); // test-only pairing token (normally sent only to the OS browser opener)
async function startDirector(args, env = {}) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mts'), ...args], { env: { ...process.env, VORK_DIRECTOR_NO_OPEN: '1', VORK_DIRECTOR_PAIR_TOKEN: PAIR, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p); let out = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 80 && !/vork Director on (http:\/\/\S+)/.test(out); i++) await sleep(150);
  const m = out.match(/vork Director on (http:\/\/\S+)/); if (!m) throw new Error(`Director did not start:\n${out}`);
  return m[1];
}
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const newPage = async () => {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.errors = []; page.on('pageerror', (e) => page.errors.push(String(e)));
  return page;
};
const idle = (page, t = 120000) => page.waitForFunction(() => document.querySelector('#cancelBtn').hidden, null, { timeout: t });
const clickObject = async (page, fx, fy) => { await page.waitForSelector('#canvas[data-ready]'); const b = await page.locator('#canvas').boundingBox(); await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy); };

// ---------------- Part A: standalone ----------------
{
  const url = await startDirector(['--port', '4791'], { VORK_DIRECTOR_RUNS: path.join(tmp, 'runs') });
  const page = await newPage();
  await page.goto(`${url}/#pair=${PAIR}`);
  await page.waitForFunction(() => document.querySelector('#measure').textContent.includes('draft'), null, { timeout: 60000 });
  await idle(page);

  await check('AC-11 standalone: click selects the vase via object ids', async () => {
    await clickObject(page, 350 / 960, 220 / 540);
    assert.match(await page.textContent('#selCount'), /vase/);
  });
  await check('AC-11 standalone: one direct edit creates exactly one human version', async () => {
    const before = await page.locator('#versionList li').count();
    const slider = page.locator('#quick input[type=range]').first();
    await slider.fill('0.8'); await slider.dispatchEvent('change');
    await sleep(400); await idle(page);
    assert.equal(await page.locator('#versionList li').count(), before + 1);
    assert.match(await page.textContent('#versionList'), /vase\.specular_roughness = 0\.8/);
  });
  await check('AC-11 standalone: compare wipe appears against the parent', async () => {
    await page.check('#compareToggle'); await sleep(600);
    assert.equal(await page.locator('#wipe').isVisible(), true);
    await page.uncheck('#compareToggle');
  });
  await check('AC-11 standalone: final render needs dialog approval, then shows final', async () => {
    await page.click('#finalBtn'); await sleep(300);
    assert.equal(await page.locator('#finalDlg').evaluate((d) => d.open), true);
    await page.keyboard.press('Escape'); await sleep(200);
    await page.click('#finalBtn'); await sleep(300); await page.click('#finalDlg button[value=approve]');
    await page.waitForFunction(() => document.querySelector('[data-profile="final"]').getAttribute('aria-checked') === 'true', null, { timeout: 120000 });
    assert.match(await page.textContent('#measure'), /final/);
  });
  if (process.env.E2E_AGENT === '1') {
    await check('AC-11 standalone: built-in agent proposal can be discarded', async () => {
      await page.fill('#instruction', 'rimライトを強めて輪郭を際立たせる'); await page.click('#askBtn'); await sleep(800);
      await idle(page, 240000); await sleep(800);
      assert.match(await page.textContent('#viewing'), /proposed/);
      await page.click('#discardBtn'); await sleep(800);
      assert.doesNotMatch(await page.textContent('#viewing'), /proposed/);
    });
  }
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
    const f = path.join(PROJECT, 'public', req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(path.join(PROJECT, 'public')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'image/png' }); res.end(fs.readFileSync(f));
  }).listen(4794, '127.0.0.1');
  const url = await startDirector(['--project', PROJECT, '--port', '4793']);
  const cfgFile = path.join(PROJECT, '.vork', 'config.json');
  const setConfig = (c) => fs.writeFileSync(cfgFile, JSON.stringify({ assetDir: 'public/vork', ...c }, null, 2));
  setConfig({ pageUrl: 'http://127.0.0.1:4794/', assetUrlPattern: '**/vork/hero.png' });
  const { agentToken } = JSON.parse(fs.readFileSync(path.join(PROJECT, '.vork', 'server.json'), 'utf8'));
  const agent = async (method, route, body) => {
    const r = await fetch(`${url}${route}`, { method, headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  };
  const projectMtimes = () => {
    const out = {}; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === '.vork') continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[p] = fs.statSync(p).mtimeMs; } };
    walk(PROJECT); return out;
  };

  await check('ADE: an unpaired tab gets no data and says how to pair', async () => {
    const stranger = await newPage(); await stranger.goto(url); await sleep(800);
    assert.match(await stranger.textContent('body'), /not paired/); await stranger.close();
  });
  const page = await newPage();
  await page.goto(`${url}/#pair=${PAIR}`);
  await sleep(1500);
  assert.equal(new URL(page.url()).hash, '', 'pairing token is removed from the address bar');
  if (!(await page.textContent('#measure')).includes('draft')) {
    await page.waitForFunction(() => document.querySelector('#measure').textContent.includes('draft'), null, { timeout: 60000 });
  }
  await idle(page);

  await check('ADE: UI switches to feedback mode and never offers the built-in proposer', async () => {
    assert.equal(await page.textContent('#h-ask'), 'Feedback to your agent');
    assert.equal(await page.textContent('#askBtn'), 'Send to agent');
    assert.equal(await page.locator('#starters').isVisible(), false);
  });

  let vid;
  await check('ADE: an agent proposal made outside the page is announced; the view does not switch by itself', async () => {
    const scene = (await agent('GET', '/api/agent/scene')).scene;
    scene.nodes.find((n) => n.name === 'key').energy = 60; scene.nodes.find((n) => n.name === 'seed').materials[0].inputs.emission_luminance = 40;
    const r = await agent('POST', '/api/agent/propose', { scene, interpretation: '夜のヒーロー: seedを主光源に', claimed_changes: [{ node: 'key', what: 'energy 60', why: 'night' }, { node: 'seed', what: 'emission 40', why: 'hero light' }] });
    vid = r.version; assert.ok(vid, JSON.stringify(r));
    await page.waitForSelector('#notice:not([hidden])', { timeout: 10000 });
    assert.doesNotMatch(await page.textContent('#viewing'), new RegExp(`^${vid}`), 'the view must not switch by itself');
    await page.click('#notice button');
    await page.waitForSelector(`#canvas[data-ready="${vid}:draft"]`, { timeout: 15000 });
    assert.match(await page.textContent('#review'), /Proposed by your ADE agent via MCP/);
  });

  await check('ADE: feedback with a clicked selection reaches the agent and shows as read', async () => {
    await clickObject(page, 350 / 960, 220 / 540);
    await page.fill('#instruction', '花瓶を少し右へ。見出しと重ならないように'); await page.click('#askBtn');
    await page.waitForFunction(() => document.querySelector('#eventList').textContent.includes('not read yet'), null, { timeout: 5000 });
    const fb = await agent('GET', '/api/agent/feedback?wait=0');
    const ev = fb.events.find((e) => e.type === 'feedback');
    assert.equal(ev.version, vid); assert.deepEqual(ev.selection, ['vase'], JSON.stringify(ev)); assert.match(ev.comment, /花瓶/);
    await page.waitForFunction(() => document.querySelector('#eventList').textContent.includes('read by agent'), null, { timeout: 8000 });
  });

  await check('AC-09 page preview substitutes the candidate without touching project files', async () => {
    const before = projectMtimes();
    const original = await newPage();
    await original.setViewportSize({ width: 1280, height: 800 }); await original.goto('http://127.0.0.1:4794/', { waitUntil: 'networkidle' });
    const origShot = await original.screenshot(); await original.close();
    await page.click('#pageBtn');
    await page.waitForFunction(() => document.querySelector('#measure').textContent.includes('substituted'), null, { timeout: 60000 });
    const m = (await page.textContent('#measure')).match(/substituted requests\s*(\d+)/); assert.ok(Number(m[1]) >= 1, await page.textContent('#measure'));
    const shot = fs.readFileSync(path.join(PROJECT, '.vork', vid, 'page-draft.png'));
    assert.notDeepEqual(shot, origShot, 'page with candidate must differ from the original page');
    assert.deepEqual(projectMtimes(), before);
    await page.screenshot({ path: path.join(ROOT, 'docs', 'screenshot-on-page.png') });
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
    await page.waitForFunction(() => document.querySelector('#alert').textContent.includes('unavailable'), null, { timeout: 60000 });
    await sleep(3000);
    assert.doesNotMatch(await page.textContent('#viewing'), /on page/);
    assert.equal(await page.locator('#pageBtn').getAttribute('aria-pressed'), 'false');
    await page.click('[data-profile="draft"]');
  });

  await check('ADE: adoption request → human approves in the dialog → image written into the project', async () => {
    const r = await agent('POST', '/api/agent/adoption-request', { version: vid, slug: 'hero', reason: '暗い背景のヒーローに合う' });
    assert.equal(r.status, 'pending_human_approval');
    await page.waitForSelector('#adoptBox:not([hidden])', { timeout: 10000 });
    await page.click('#adoptList button'); await sleep(500);
    assert.match(await page.textContent('#adoptPlan'), /public\/vork\/hero\.png/);
    await page.screenshot({ path: path.join(ROOT, 'docs', 'screenshot-adoption.png') });
    await page.click('#adoptDlg button[value=approve]');
    await sleep(500); await idle(page, 180000); await sleep(800);
    assert.ok(fs.existsSync(path.join(PROJECT, 'public', 'vork', 'hero.png')));
    assert.ok(fs.existsSync(path.join(PROJECT, '.vork', 'adopted', 'hero.json')));
    assert.equal(await page.locator('#adoptBox').isHidden(), true);
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
