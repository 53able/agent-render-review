// Tests that render with vork take this machine-wide lock first and hold it until they exit. Two vork processes
// rendering at the same time on one GPU can fail with "GPU device lost" (#29), which looks like a regression in
// whatever test happened to render. Director itself also takes a lock around each render (src/gpu-lock.mts, #49).
import os from 'node:os';
import path from 'node:path';
import { lockFile } from '../src/gpu-lock.mts';

const LOCK = path.join(os.tmpdir(), 'render-director-gpu-test.lock');

export async function acquireGpuLock(name: string): Promise<void> {
  await lockFile(LOCK, { onWait: (owner) => console.log(`${name}: waiting for another vork test (pid ${owner}, lock ${LOCK})`) });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => process.exit(130));
}
