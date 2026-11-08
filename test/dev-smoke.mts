// Manual check (not part of npm test) of the zustand devtools path in a development build (#73, AC-11): a Director in
// RENDER_DIRECTOR_DEV mode behind the vite dev server, with a fake Redux devtools extension in the page. Requires vork and
// Google Chrome. DEV_SMOKE_PER_MESSAGE=1 reloads the page before each devtools message (the positive control, run with the
// write guard in store.ts taken out by hand: every message must then FAIL).
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireGpuLock } from './gpu-lock.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const hasVork = process.env.PATH!.split(path.delimiter).some((d) => { try { fs.accessSync(path.join(d, 'vork'), fs.constants.X_OK); return true; } catch { return false; } });
for (const [ok, what] of [[fs.existsSync(CHROME), 'Chrome not found (set CHROME_PATH)'], [hasVork, 'vork not on PATH']] as const) {
  if (ok) continue;
  if (process.env.E2E_REQUIRED === '1') { console.log(`FAIL dev-smoke: ${what}; E2E_REQUIRED=1`); process.exit(1); }
  console.log(`SKIP dev-smoke: ${what}`); process.exit(0);
}
await acquireGpuLock('dev-smoke');

const PER_MESSAGE = process.env.DEV_SMOKE_PER_MESSAGE === '1';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vd-dev-smoke-')));
const TOKEN = 'de0' + Date.now().toString(16); // hex only: main.tsx reads #pair=[0-9a-f]+
const procs: ChildProcess[] = [];
let pass = 0, failures = 0;
async function check(name: string, fn: () => unknown) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e: any) { failures++; console.log(`FAIL ${name}\n     ${String(e.message).split('\n').slice(0, 4).join('\n     ')}`); }
}
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); }); });
/** Starts a process and waits for a line of its output to match. */
async function start(args: string[], env: Record<string, string>, ready: RegExp): Promise<RegExpMatchArray> {
  const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p); let out = '';
  const add = (d: Buffer) => { out += String(d).replace(/\x1b\[[0-9;]*m/g, ''); };
  p.stdout!.on('data', add); p.stderr!.on('data', add);
  for (let i = 0; i < 200; i++) { const m = out.match(ready); if (m) return m; await new Promise((r) => setTimeout(r, 150)); }
  throw new Error(`${args.join(' ')} did not start:\n${out}`);
}
const cleanup = () => { for (const p of procs) p.kill('SIGTERM'); fs.rmSync(tmp, { recursive: true, force: true }); };

try {
  const dPort = await freePort(), vPort = await freePort();
  await start([path.join(ROOT, 'server.mts'), '--port', String(dPort)], {
    RENDER_DIRECTOR_RUNS: path.join(tmp, 'runs'), RENDER_DIRECTOR_DEV: '1', RENDER_DIRECTOR_NO_OPEN: '1', RENDER_DIRECTOR_PAIR_TOKEN: TOKEN,
  }, /Render Director on (http:\/\/\S+)/);
  const [, viteUrl] = await start([path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', 'vite.config.mts', '--port', String(vPort)], { PORT: String(dPort) }, /Local:\s+(http:\/\/\S+?)\/?\s/);

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors: string[] = [], dtErrors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && m.text().startsWith('[zustand devtools middleware]')) dtErrors.push(m.text()); });
  // The fake extension: init and send are recorded in window.__dt, the listener the store subscribes is kept.
  await page.addInitScript(() => {
    const w = window as any; w.__dt = [];
    w.__REDUX_DEVTOOLS_EXTENSION__ = {
      connect: () => ({
        init: (state: unknown) => { w.__dt.push({ kind: 'init', state }); },
        send: (action: unknown, state: unknown) => { w.__dt.push({ kind: 'send', action, state }); },
        subscribe: (l: unknown) => { w.__dtListener = l; return () => {}; },
      }),
    };
  });
  const open = async (hash = '') => {
    await page.goto(`${viteUrl}/${hash}`);
    try { await page.waitForSelector('#canvas[data-ready]', { timeout: 120000 }); }
    catch (e) { throw new Error(`${(e as Error).message.split('\n')[0]}\npage: ${(await page.textContent('body'))?.slice(0, 600)}\npageerror: ${errors.join(' | ')}`); }
  };
  await open(`#pair=${TOKEN}`);

  await check('1 a failure with focus on the button throws nothing', async () => {
    await page.route('**/api/propose', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"dev-smoke"}' }));
    await page.evaluate(() => { (window as any).__dtBefore = (window as any).__dt.length; });
    await page.fill('#instruction', 'dev-smoke request');
    await page.click('#askBtn');
    await page.waitForFunction(() => document.querySelector('#err-ask .err[role=alert]')?.textContent?.includes('dev-smoke'), null, { timeout: 10000 });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'askBtn');
    assert.deepEqual(errors, []);
    await page.unroute('**/api/propose');
  });
  await check('2 what devtools receives holds no DOM', async () => {
    const r = await page.evaluate(() => {
      const w = window as any; const all = w.__dt as { kind: string }[];
      const text = all.map((e) => { try { return JSON.stringify(e); } catch (err) { return `THROWS ${(err as Error).message}`; } });
      return { inits: all.filter((e) => e.kind === 'init').length, sendsAfter: all.slice(w.__dtBefore).filter((e) => e.kind === 'send').length, bad: text.filter((t) => t.startsWith('THROWS') || t.includes('__reactFiber')) };
    });
    assert.equal(r.inits, 1, 'one init');
    assert.ok(r.sendsAfter >= 1, `sends after step 1: ${r.sendsAfter}`);
    assert.deepEqual(r.bad, []);
  });

  // Message shapes as zustand 5.0.16 middleware.mjs:138-229 reads them. RESET goes last: the initial state has data null.
  const W = JSON.stringify({ instruction: 'DT-WROTE' });
  const messages: [string, unknown][] = [
    ['ACTION', { type: 'ACTION', payload: JSON.stringify({ type: '__setState', state: { instruction: 'DT-WROTE' } }) }],
    ['ROLLBACK', { type: 'DISPATCH', payload: { type: 'ROLLBACK' }, state: W }],
    ['JUMP_TO_STATE', { type: 'DISPATCH', payload: { type: 'JUMP_TO_STATE' }, state: W }],
    ['IMPORT_STATE', { type: 'DISPATCH', payload: { type: 'IMPORT_STATE', nextLiftedState: { computedStates: [{ state: { instruction: 'DT-WROTE' } }] } } }],
    ['RESET', { type: 'DISPATCH', payload: { type: 'RESET' } }],
  ];
  if (!PER_MESSAGE) await page.fill('#instruction', 'BEFORE');
  for (const [name, msg] of messages) {
    if (PER_MESSAGE) { await open(); await page.fill('#instruction', 'BEFORE'); }
    const e0 = errors.length, d0 = dtErrors.length;
    await check(`3 devtools ${name} writes nothing`, async () => {
      await page.evaluate((m) => (window as any).__dtListener(m), msg);
      await page.waitForTimeout(300);
      const value = await page.inputValue('#instruction', { timeout: 3000 }).catch(async () => `(no #instruction; page: ${(await page.textContent('body'))?.trim().slice(0, 120)})`);
      const pageErrors = errors.slice(e0), shapeErrors = dtErrors.slice(d0);
      assert.ok(value === 'BEFORE' && !pageErrors.length && !shapeErrors.length,
        `#instruction=${JSON.stringify(value)}, pageerror=${JSON.stringify(pageErrors)}, [zustand devtools middleware] errors=${JSON.stringify(shapeErrors)}`);
    });
  }
  await browser.close();
} catch (e) {
  failures++; console.log(`FAIL dev-smoke: ${(e as Error).message}`);
} finally {
  cleanup();
}
console.log(`\n${pass} passed, ${failures} failed${PER_MESSAGE ? ' (per message)' : ''}`);
process.exit(failures ? 1 : 0);
