// Puts a finished build (dist.tmp) in place of dist. rename(2) fails with ENOTEMPTY onto a non-empty folder, so this
// takes three steps: dist -> dist.old, dist.tmp -> dist, remove dist.old. Not atomic: a request between the two
// renames gets a 404. A dist.old left by an interrupted swap is removed first, so the next build recovers.
import fs from 'node:fs';
import path from 'node:path';

export function swapDist(root: string): void {
  const dist = path.join(root, 'dist'), tmp = path.join(root, 'dist.tmp'), old = path.join(root, 'dist.old');
  fs.statSync(tmp); // throws ENOENT before dist is touched
  fs.rmSync(old, { recursive: true, force: true });
  try { fs.renameSync(dist, old); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  fs.renameSync(tmp, dist);
  fs.rmSync(old, { recursive: true, force: true });
}
