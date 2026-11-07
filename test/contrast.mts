// AC-10: WCAG contrast of the theme tokens in web/src/index.css, light (:root) and dark (.dark). Tokens must be hex.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(ROOT, 'web', 'src', 'index.css'), 'utf8');
let pass = 0, failures = 0;
function check(name: string, fn: () => void) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e: any) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

/** Custom properties of the first top-level block whose selector is exactly `sel`. */
function tokens(sel: string): Record<string, string> {
  const m = css.match(new RegExp(`(?:^|\\n)${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `${sel} block in index.css`);
  return Object.fromEntries([...m![1]!.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((x) => [x[1]!, x[2]!.trim()]));
}
type RGB = [number, number, number];
const hex = (t: Record<string, string>, name: string): RGB => {
  const v = t[name]; assert.ok(v !== undefined, `--${name} is defined`);
  const m = v!.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i); assert.ok(m, `--${name} is hex (${v})`);
  const h = m![1]!.length === 3 ? [...m![1]!].map((c) => c + c).join('') : m![1]!;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
};
const lum = (c: RGB) => { const [r, g, b] = c.map((x) => { const s = x / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
const ratio = (a: RGB, b: RGB) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
const over = (fg: RGB, alpha: number, bg: RGB): RGB => fg.map((c, i) => Math.round(c * alpha + bg[i]! * (1 - alpha))) as RGB;

const PAIRS: [string, string, number][] = [
  ['foreground', 'background', 4.5], ['muted-foreground', 'background', 4.5], ['muted-foreground', 'card', 4.5],
  ['primary-foreground', 'primary', 4.5],
  ['agent', 'card', 4.5], ['human', 'card', 4.5], ['warn', 'card', 4.5], ['ok', 'card', 4.5], ['destructive', 'card', 4.5],
  ['ring', 'background', 3.0], ['input', 'background', 3.0],
  // state tokens (#60): the state chips and marks in the versions panel, failures on their tint (#53)
  ['st-proposed', 'card', 4.5], ['st-accepted', 'card', 4.5], ['st-discarded', 'card', 4.5], ['st-head', 'card', 4.5], ['st-failed', 'card', 4.5],
  ['foreground', 'bad-soft', 4.5], ['st-failed', 'bad-soft', 3.0],
];
for (const [theme, sel] of [['light', ':root'], ['dark', '.dark']] as const) {
  const t = tokens(sel);
  for (const [fg, bg, min] of PAIRS) {
    check(`${theme}: ${fg} / ${bg} >= ${min}`, () => { const r = ratio(hex(t, fg), hex(t, bg)); assert.ok(r >= min, `${r.toFixed(2)} < ${min}`); });
  }
  // The generated destructive Button (components/ui/button.tsx) draws text-destructive on bg-destructive/10,
  // and on dark:bg-destructive/20 in the dark theme, over the page background. Measured as rendered.
  check(`${theme}: destructive button text / its background >= 4.5`, () => {
    const d = hex(t, 'destructive'); const bg = over(d, theme === 'dark' ? 0.2 : 0.1, hex(t, 'background'));
    const r = ratio(d, bg); assert.ok(r >= 4.5, `${r.toFixed(2)} < 4.5`);
  });
}
check('the generated destructive Button still uses text-destructive on a destructive tint', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'src', 'components', 'ui', 'button.tsx'), 'utf8');
  assert.match(src, /destructive:\s*\n?\s*"bg-destructive\/10 text-destructive[^"]*dark:bg-destructive\/20/);
});

console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
