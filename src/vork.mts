// vork: the Renderer port Director renders through, and its implementation with the vork CLI.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { LIMITS, PROFILES } from './policy.mts';
import type { Profile, Scene, Exposure, RenderObject, RenderInfo } from './policy.mts';

/** A finished render: dir/<profile>.png (file) and the object index of every pixel (ids, uint16 little endian). */
export type RenderOutcome =
  | { ok: true; file: string; seconds: number; width: number; height: number; ids: Buffer; objects: RenderObject[]; exposure: Exposure; settings: RenderInfo['settings']; warnings: string[] }
  | { ok: false; code: number | null; timedOut: boolean; log: string; seconds: number };
export interface Renderer {
  /** Version string written into adoption manifests. */
  version: string;
  /**
   * Renders scene at profile into dir/<profile>.png. Scene file references are project-relative.
   * After signal aborts, the promise still settles only when the renderer has stopped writing into dir.
   */
  render(req: { scene: Scene; dir: string; profile: Profile; signal: AbortSignal }): Promise<RenderOutcome>;
}

export interface RunResult { code: number | null; signal?: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }
// An aborted signal kills the process with SIGTERM (spawn's own handling). The promise settles when the process has
// exited, not at the abort, so a render lock is held until vork stops writing its output.
export function run(cmd: string, args: string[], { timeout, input, cwd, signal }: { timeout?: number; input?: string; cwd?: string; signal: AbortSignal }): Promise<RunResult> {
  if (signal.aborted) return Promise.resolve({ code: -1, signal: null, stdout: '', stderr: 'cancelled', timedOut: false });
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], signal });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
    child.stdout.on('data', (d) => (stdout += d)); child.stderr.on('data', (d) => (stderr += d));
    if (input) child.stdin.end(input); else child.stdin.end();
    child.on('close', (code, sig) => { clearTimeout(timer); resolve({ code, signal: sig, stdout, stderr, timedOut }); });
    child.on('error', (e) => { if (e.name === 'AbortError') return; clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(e), timedOut }); });
  });
}

/** vork's help text and version, or null when vork is not on PATH. */
export function vorkInstalled(): { help: string; version: string } | null {
  let help: string;
  try { help = execFileSync('vork', ['help'], { encoding: 'utf8' }); } catch { return null; }
  return { help, version: execFileSync('vork', ['--version'], { encoding: 'utf8' }).trim() };
}

// `<out>.meta.json` written by vork render
interface VorkMeta { object_ids: RenderObject[]; exposure: Exposure; denoiser: unknown; settings: { integrator: unknown; samples: number } }

// assetBase: the folder scene file references are relative to (the project, or scenes/ in standalone mode).
export function createVorkRenderer({ assetBase, version }: { assetBase: string; version: string }): Renderer {
  // Scene file references are project-relative (policy-checked). vork resolves them relative to the scene
  // file, so the rendered copy rewrites them to point from the version directory into the project.
  function sceneForRender(scene: Scene, dir: string) {
    const walk = (x: unknown): unknown => {
      if (Array.isArray(x)) return x.map(walk);
      if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, k === 'file' && typeof val === 'string' ? path.relative(dir, path.join(assetBase, val)) : walk(val)]));
      return x;
    };
    return walk(scene);
  }
  return {
    version,
    async render({ scene, dir, profile, signal }) {
      const sceneFile = path.join(dir, 'scene.render.json');
      fs.writeFileSync(sceneFile, JSON.stringify(sceneForRender(scene, dir)));
      const out = path.join(dir, `${profile}.png`);
      const args = ['render', sceneFile, '--out', out, '--profile', PROFILES[profile], '--channels', 'color,object_index'];
      const t0 = Date.now();
      const r = await run('vork', args, { timeout: LIMITS[profile], cwd: dir, signal });
      const seconds = (Date.now() - t0) / 1000;
      if (r.code !== 0) return { ok: false, code: r.code, timedOut: r.timedOut, log: (r.stderr + r.stdout).slice(-4000), seconds };
      const meta = JSON.parse(fs.readFileSync(`${out}.meta.json`, 'utf8')) as VorkMeta;
      const ids = decodeGray16(fs.readFileSync(path.join(dir, `${profile}.object_index.png`)));
      const warnings = (r.stderr + r.stdout).split('\n').filter((l) => /warn/i.test(l)).slice(0, 20);
      return {
        ok: true, file: out, seconds, width: ids.w, height: ids.h, ids: ids.data, objects: meta.object_ids, exposure: meta.exposure,
        settings: { integrator: meta.settings.integrator, samples: meta.settings.samples, denoiser: meta.denoiser }, warnings,
      };
    },
  };
}

// 16-bit grayscale PNG decode (object_index channel)
export function decodeGray16(buf: Buffer): { w: number; h: number; data: Buffer } {
  let off = 8, w = 0, h = 0, depth = 0, ctype = 0; const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  if (depth !== 16 || ctype !== 0) throw new Error(`unexpected object_index PNG format depth=${depth} type=${ctype}`);
  const raw = zlib.inflateSync(Buffer.concat(idat)); const bpp = 2, stride = w * bpp;
  const out = Buffer.alloc(w * h * 2); let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)]; const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = v & 255;
    }
    for (let x = 0; x < w; x++) out.writeUInt16LE(line.readUInt16BE(x * 2), (y * w + x) * 2);
    prev = line;
  }
  return { w, h, data: out };
}
