// AC-8 and AC-14 of the shadcn/ui plan, as static checks over web/ (plain node, no build needed).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEB_EXTENSIONS } from '../src/build-id.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web'), SRC = path.join(WEB, 'src'), UI = path.join(SRC, 'components', 'ui');
let pass = 0, failures = 0;
function check(name: string, fn: () => void) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e: any) { failures++; console.log(`FAIL ${name}\n     ${String(e.message).split('\n').join('\n     ')}`); }
}
/** Every file under dir; names starting with a dot are skipped only when skipDot is set. */
const walk = (dir: string, skipDot = false): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (skipDot && e.name.startsWith('.')) return [];
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p, skipDot) : [p];
});
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/');
const read = (p: string) => fs.readFileSync(p, 'utf8');

check('AC-8: no raw button/dialog/table/textarea/details/input outside components/ui (QuickEdit range/color excepted)', () => {
  const bad: string[] = [];
  for (const f of walk(SRC).filter((f) => !f.startsWith(UI + path.sep))) {
    const text = read(f);
    for (const m of text.matchAll(/<(button|dialog|table|textarea|details|input)\b[^>]*/g)) {
      const allowed = m[1] === 'input' && path.basename(f) === 'QuickEdit.tsx' && /\btype="(range|color)"/.test(m[0]);
      if (!allowed) bad.push(`${rel(f)}: ${m[0].slice(0, 60)}`);
    }
  }
  assert.deepEqual(bad, []);
});
check('AC-8: no web fonts (@font-face, fonts.googleapis, @fontsource) in web/ or the dependencies', () => {
  const re = /@font-face|fonts\.googleapis|@fontsource/;
  const bad = walk(WEB).filter((f) => re.test(read(f))).map(rel);
  if (re.test(read(path.join(ROOT, 'package.json')))) bad.push('package.json');
  assert.deepEqual(bad, []);
});
check('AC-14: no HTML strings (innerHTML and relatives) in web/src', () => {
  const re = /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML/;
  assert.deepEqual(walk(SRC).filter((f) => re.test(read(f))).map(rel), []);
});
check(`AC-8: web/ holds only build-ID input types (${WEB_EXTENSIONS.join(' ')}; dotfiles excepted)`, () => {
  assert.deepEqual(walk(WEB, true).filter((f) => !WEB_EXTENSIONS.includes(path.extname(f))).map(rel), []);
});
check('AC-8: vite is locked at 6.0.9 or later (server.cors and allowedHosts defaults)', () => {
  const v: string | undefined = JSON.parse(read(path.join(ROOT, 'package-lock.json'))).packages?.['node_modules/vite']?.version;
  assert.ok(v, 'vite is in package-lock.json');
  const [a, b, c] = v!.split(/[.-]/).map(Number) as [number, number, number];
  assert.ok(a > 6 || (a === 6 && (b > 0 || c >= 9)), `vite ${v} >= 6.0.9`);
});

console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
