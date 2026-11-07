// A machine-wide lock file, so vork renders do not run at the same time on one GPU: two vork processes rendering at
// once can fail with "GPU device lost" (#29, #49). The file holds the owner's pid; a lock whose owner is gone is taken
// over. Within one process the callers queue first, so the file is never contended by the process that holds it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The lock every Director takes around a vork render. RENDER_DIRECTOR_GPU_LOCK names another file (tests). */
export const VORK_LOCK = process.env.RENDER_DIRECTOR_GPU_LOCK || path.join(os.tmpdir(), 'render-director-vork.lock');

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; } };
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((r) => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });

/**
 * Takes the lock file, waiting while another live process holds it. Resolves to a release function, or null when
 * signal aborted first. onWait is called once, with the owner's pid, if the lock was held by another process.
 */
export async function lockFile(file: string, { signal, onWait }: { signal?: AbortSignal; onWait?: (owner: number) => void } = {}): Promise<(() => void) | null> {
  let told = false;
  for (;;) {
    if (signal?.aborted) return null;
    try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); break; }
    catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      let owner: number, age: number;
      try { owner = Number(fs.readFileSync(file, 'utf8').trim() || 0); age = Date.now() - fs.statSync(file).mtimeMs; } catch { continue; }
      // An empty lock is being written by its owner; only an old empty one is stale.
      if (!owner && age < 5000) { await sleep(100, signal); continue; }
      if (owner && owner !== process.pid && alive(owner)) {
        if (!told) { onWait?.(owner); told = true; }
        await sleep(250, signal); continue;
      }
      // Stale lock: only one waiter can rename it away; if what it grabbed is a fresh lock, it puts it back.
      const grab = `${file}.${process.pid}`;
      try { fs.renameSync(file, grab); } catch { continue; }
      if (Number(fs.readFileSync(grab, 'utf8').trim() || 0) !== owner) { try { fs.linkSync(grab, file); } catch {} }
      fs.rmSync(grab, { force: true });
    }
  }
  let released = false;
  const release = () => {
    if (released) return; released = true; process.off('exit', release);
    try { if (Number(fs.readFileSync(file, 'utf8')) === process.pid) fs.rmSync(file); } catch {}
  };
  process.on('exit', release);
  return release;
}

let queue: Promise<unknown> = Promise.resolve();
/**
 * Runs fn while holding the vork lock: one at a time in this process, and one at a time across processes that use
 * the same file. Resolves to null without calling fn when signal aborts while waiting.
 */
export function withGpuLock<T>(fn: () => Promise<T>, { signal, file = VORK_LOCK, onWait }: { signal?: AbortSignal; file?: string; onWait?: (owner: number) => void } = {}): Promise<T | null> {
  const mine = queue.catch(() => {}).then(async () => {
    const release = await lockFile(file, { signal, onWait });
    if (!release) return null;
    try { return await fn(); } finally { release(); }
  });
  queue = mine;
  return mine;
}
