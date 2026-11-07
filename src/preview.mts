// Page preview: the real page in headless Chrome, with the candidate substituted by request interception.
import fs from 'node:fs';
import path from 'node:path';
import { LIMITS, sha256 } from './policy.mts';
import type { Profile, Version, PagePreviewResult } from './policy.mts';
import type { Director } from './director.mts';

/**
 * The PNG a page preview substitutes: the version's render at profile (or its draft), with the bytes recorded when it
 * finished. Waits for renders of the version queued so far, because vork writes the PNG in place (#30). Needs no
 * browser, so it is tested on its own (#48).
 */
export async function recordedPng(director: Director, v: Version, profile: Profile): Promise<{ ok: false; reason: string } | { ok: true; png: Buffer; source: Profile }> {
  await director.rendersQueued(v.id);
  const render = v.renders[profile] || v.renders.draft;
  if (!render) return { ok: false, reason: 'render the version first' };
  // The bytes must be the ones recorded when the render finished; otherwise a render started after the wait is writing it.
  let png: Buffer;
  try { png = fs.readFileSync(director.renderFile(v.id, render.profile)); } catch { return { ok: false, reason: 'the render file is missing; render the version again' }; }
  if (sha256(png) !== render.sha256) return { ok: false, reason: 'the render is being updated; try again when it finishes' };
  return { ok: true, png, source: render.profile };
}

export async function pagePreview(director: Director, v: Version, profile: Profile): Promise<PagePreviewResult> {
  const config = director.readConfig();
  if (!config.pageUrl || !config.assetUrlPattern) return { ok: false, reason: 'set pageUrl and assetUrlPattern in .vork/config.json' };
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(String(config.pageUrl))) return { ok: false, reason: 'pageUrl must be an http(s) URL on 127.0.0.1, localhost or [::1]' };
  const rec = await recordedPng(director, v, profile);
  if (!rec.ok) return rec;
  const { png, source } = rec;
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { return { ok: false, reason: 'playwright-core is not installed (npm install)' }; }
  const exe = process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
  if (!exe) return { ok: false, reason: 'Chrome not found (set CHROME_PATH)' };
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    let matched = 0;
    await page.route(config.assetUrlPattern, (route) => { matched++; route.fulfill({ status: 200, contentType: 'image/png', body: png }); });
    try { await page.goto(config.pageUrl, { waitUntil: 'networkidle', timeout: LIMITS.page }); }
    catch (e: any) { return { ok: false, reason: `could not open ${config.pageUrl}: ${String(e.message).split('\n')[0]}` }; }
    const file = path.join(director.vdir(v.id), `page-${source}.png`);
    const shot = await page.screenshot({ path: file, fullPage: false });
    return { ok: true, matched, sha256: sha256(shot), source, warning: matched ? null : `no request matched ${config.assetUrlPattern}; the screenshot shows the page without the candidate` };
  } finally { await browser.close(); }
}
