// Unit tests of scripts/swap-dist.mts without vite: dist.tmp replaces dist, including after an interrupted swap.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { swapDist } from '../scripts/swap-dist.mts';

let pass = 0, failures = 0;
function check(name: string, fn: (root: string) => void) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rd-swap-')));
  try { fn(root); pass++; console.log(`PASS ${name}`); }
  catch (e: any) { failures++; console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ')}`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const put = (root: string, dir: string, body: string) => { fs.mkdirSync(path.join(root, dir, 'assets'), { recursive: true }); fs.writeFileSync(path.join(root, dir, 'index.html'), body); fs.writeFileSync(path.join(root, dir, 'assets', 'x.js'), body); };
const after = (root: string, body: string) => {
  assert.deepEqual(fs.readdirSync(root).sort(), ['dist']);
  assert.equal(fs.readFileSync(path.join(root, 'dist', 'index.html'), 'utf8'), body);
  assert.deepEqual(fs.readdirSync(path.join(root, 'dist', 'assets')), ['x.js']);
};

check('first build: no dist yet', (root) => { put(root, 'dist.tmp', 'new'); swapDist(root); after(root, 'new'); });
check('rebuild: dist is replaced, not merged', (root) => {
  put(root, 'dist', 'old'); fs.writeFileSync(path.join(root, 'dist', 'assets', 'stale.js'), 'x');
  put(root, 'dist.tmp', 'new'); swapDist(root); after(root, 'new');
});
check('a dist.old left by an interrupted swap, next to dist', (root) => {
  put(root, 'dist', 'old'); put(root, 'dist.old', 'older'); put(root, 'dist.tmp', 'new'); swapDist(root); after(root, 'new');
});
check('only dist.old is left (crash between the two renames)', (root) => {
  put(root, 'dist.old', 'old'); put(root, 'dist.tmp', 'new'); swapDist(root); after(root, 'new');
});
check('no dist.tmp: throws and leaves dist alone', (root) => {
  put(root, 'dist', 'old');
  assert.throws(() => swapDist(root), { code: 'ENOENT' });
  assert.equal(fs.readFileSync(path.join(root, 'dist', 'index.html'), 'utf8'), 'old');
});

console.log(`\n${pass} passed, ${failures} failed`);
if (failures) process.exit(1);
