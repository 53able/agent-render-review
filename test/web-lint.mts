// AC-8 and AC-14 of the shadcn/ui plan, as static checks over web/ (plain node, no build needed).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
check('AC-8: vite is locked at 6.0.9 or later (server.cors and allowedHosts defaults)', () => {
  const v: string | undefined = JSON.parse(read(path.join(ROOT, 'package-lock.json'))).packages?.['node_modules/vite']?.version;
  assert.ok(v, 'vite is in package-lock.json');
  const [a, b, c] = v!.split(/[.-]/).map(Number) as [number, number, number];
  assert.ok(a > 6 || (a === 6 && (b > 0 || c >= 9)), `vite ${v} >= 6.0.9`);
});

// zustand plan (#73): the store is zustand, pinned, and set() is its only way in.
const STORE = read(path.join(SRC, 'store.ts'));
const count = (re: RegExp) => STORE.match(new RegExp(re.source, 'g'))?.length ?? 0;
check('zustand AC-1: zustand is pinned to 5.0.16 and the lock entry matches it', () => {
  assert.equal(JSON.parse(read(path.join(ROOT, 'package.json'))).devDependencies?.zustand, '5.0.16');
  const z = JSON.parse(read(path.join(ROOT, 'package-lock.json'))).packages?.['node_modules/zustand'];
  assert.equal(z?.version, '5.0.16');
  assert.equal(z?.resolved, 'https://registry.npmjs.org/zustand/-/zustand-5.0.16.tgz');
  assert.equal(z?.integrity, 'sha512-Uv7e327ihlCfayfja3hDc0M64Upev1LWBKpRobdK4NyovDDPeeX4imWXc/wzC1yc6fkYPoAY/ncKVPAs2jrtQw==');
});
check('zustand AC-2: store.ts keeps no hand-made subscription (useSyncExternalStore, listeners, a state variable)', () => {
  for (const re of [/useSyncExternalStore/, /\blisteners\b/, /(let|const|var)\s+state\b/, /\bstate\s*=(?!=)/]) assert.equal(count(re), 0, String(re));
});
check('zustand AC-9: the store is not exported, and set() is the one writer (store.setState and writing = true once each)', () => {
  assert.equal(count(/export\s+(default\b|const\s+store\b|\{[^}]*\bstore\b)/), 0, 'store is exported');
  assert.equal(count(/\bstore\.setState\b/), 1, 'store.setState');
  assert.equal(count(/\bwriting\s*=\s*true\b/), 1, 'writing = true');
});

console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
