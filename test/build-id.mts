// Unit tests of src/build-id.mts on a temp root: which files count as inputs, and how the ID reacts to changes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIdInputs, computeBuildId, FIXED_INPUTS, injectBuildId, readBuildId } from '../src/build-id.mts';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rd-build-id-')));
let pass = 0, failures = 0;
function check(name: string, fn: () => void) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e: any) { failures++; console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ')}`); }
}
const write = (rel: string, body: string) => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
for (const f of FIXED_INPUTS) write(f, `// ${f}\n`);
write('web/index.html', '<!doctype html><html><head></head><body></body></html>');
write('web/src/App.tsx', 'export const A = 1;\n');
write('web/src/index.css', '@import "tailwindcss";\n');
const base = computeBuildId(tmp);

check('inputs are the web/ files and the fixed files, sorted', () => {
  assert.deepEqual(buildIdInputs(tmp), [...FIXED_INPUTS, 'web/index.html', 'web/src/App.tsx', 'web/src/index.css'].sort());
});
check('ID is 64 hex chars and stable', () => {
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(computeBuildId(tmp), base);
});
check('dotfiles, dot folders and files outside web/ do not change the ID', () => {
  write('web/.DS_Store', 'x'); write('web/src/.DS_Store', 'x'); write('web/src/.App.tsx.swp', 'x');
  write('web/.cache/x.ts', 'x'); write('README.md', 'x');
  assert.equal(computeBuildId(tmp), base);
});
check('a file under web/ of any other type is an input (an asset Vite bundles, e.g. .png or .woff2)', () => {
  write('web/src/logo.png', 'x');
  assert.ok(buildIdInputs(tmp).includes('web/src/logo.png'));
  assert.notEqual(computeBuildId(tmp), base);
  fs.rmSync(path.join(tmp, 'web/src/logo.png'));
  assert.equal(computeBuildId(tmp), base);
});
check('editing a .tsx changes the ID', () => {
  write('web/src/App.tsx', 'export const A = 2;\n');
  assert.notEqual(computeBuildId(tmp), base);
  write('web/src/App.tsx', 'export const A = 1;\n');
  assert.equal(computeBuildId(tmp), base);
});
check('renaming a file changes the ID', () => {
  fs.renameSync(path.join(tmp, 'web/src/App.tsx'), path.join(tmp, 'web/src/Main.tsx'));
  assert.notEqual(computeBuildId(tmp), base);
  fs.renameSync(path.join(tmp, 'web/src/Main.tsx'), path.join(tmp, 'web/src/App.tsx'));
});
check('editing a fixed input changes the ID', () => {
  write('package-lock.json', '{}\n');
  assert.notEqual(computeBuildId(tmp), base);
  write('package-lock.json', '// package-lock.json\n');
});
check('a missing fixed input throws', () => {
  fs.rmSync(path.join(tmp, 'components.json'));
  assert.throws(() => computeBuildId(tmp), { code: 'ENOENT' });
  write('components.json', '// components.json\n');
});
check('injectBuildId and readBuildId round-trip; a page without the meta reads null', () => {
  const html = injectBuildId('<html><head><title>t</title></head></html>', base);
  assert.equal(readBuildId(html), base);
  assert.equal(readBuildId('<html><head></head></html>'), null);
  assert.throws(() => injectBuildId('<html></html>', base));
  assert.throws(() => injectBuildId('<head></head>', 'nothex'));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
if (failures) process.exit(1);
