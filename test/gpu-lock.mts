// Tests that render with vork take this machine-wide lock first. Two vork processes rendering at the same time on
// one GPU can fail with "GPU device lost" (#29), which looks like a regression in whatever test happened to render.
// The lock is a file holding the owner's pid; a lock whose owner is gone is taken over.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCK = path.join(os.tmpdir(), 'render-director-gpu-test.lock');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; } };

export async function acquireGpuLock(name: string): Promise<void> {
  let told = false;
  for (;;) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); break; }
    catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      let owner: number, age: number;
      try { owner = Number(fs.readFileSync(LOCK, 'utf8').trim() || 0); age = Date.now() - fs.statSync(LOCK).mtimeMs; } catch { continue; }
      // An empty lock is being written by its owner; only an old empty one is stale.
      if (!owner && age < 5000) { await new Promise((r) => setTimeout(r, 100)); continue; }
      if (owner && owner !== process.pid && alive(owner)) {
        if (!told) { console.log(`${name}: waiting for another vork test (pid ${owner}, lock ${LOCK})`); told = true; }
        await new Promise((r) => setTimeout(r, 500)); continue;
      }
      // Stale lock: only one waiter can rename it away; if what it grabbed is a fresh lock, it puts it back.
      const grab = `${LOCK}.${process.pid}`;
      try { fs.renameSync(LOCK, grab); } catch { continue; }
      if (Number(fs.readFileSync(grab, 'utf8').trim() || 0) !== owner) { try { fs.linkSync(grab, LOCK); } catch {} }
      fs.rmSync(grab, { force: true });
    }
  }
  process.on('exit', () => { try { if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.rmSync(LOCK); } catch {} });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => process.exit(130));
}
