// Unit tests of the review panel's checks (public/review-model.js): claimed changes against the diff, the grouping of
// large diffs, the object list. No browser needed (#48).
import assert from 'node:assert/strict';
import { isWildcard, keyOf, checkClaims, groupDiff } from '../public/review-model.js';

let pass = 0, failures = 0;
async function check(name: string, fn: () => unknown) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e: any) { failures++; console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ')}`); }
}
const added = (node: string) => ({ node, path: '(node)', before: undefined, after: 'added' });
const removed = (node: string) => ({ node, path: '(node)', before: 'present', after: 'removed' });
const field = (node: string, path = 'energy') => ({ node, path, before: 1, after: 2 });

await check('#36 a bare "*" is a literal name; "b*" is a prefix', () => {
  assert.equal(isWildcard('*'), false); assert.equal(isWildcard('b*'), true); assert.equal(isWildcard('b'), false);
  assert.equal(keyOf({ node: '(scene)', path: 'render.resolution' }), 'render'); assert.equal(keyOf(field('key')), 'key');
});

await check('#36 claims cover exact names, prefixes, scene keys; claims that match nothing are ghosts', () => {
  const diff = [...Array.from({ length: 400 }, (_, i) => added(`b${i}`)), field('key'), field('(scene)', 'render.resolution'), field('fill')];
  const { isClaimed, wildMatches, ghost } = checkClaims([
    { node: 'b*', what: 'birds', why: '' }, { node: 'key', what: '', why: '' }, { node: 'render', what: '', why: '' },
    { node: 'x*', what: '', why: '' }, { node: 'rim', what: '', why: '' }, { node: '*', what: '', why: '' },
  ], diff);
  assert.equal(diff.filter((d) => !isClaimed(d)).map((d) => d.node).join(), 'fill');
  assert.equal(wildMatches.get('b*')!.length, 400); assert.deepEqual(wildMatches.get('x*'), []);
  assert.deepEqual(ghost, ['x*', 'rim', '*']);
  assert.ok(checkClaims([{ node: 'scene', what: '', why: '' }], diff).isClaimed(diff[401]), '"scene" claims every scene-level change');
});

await check('#37 node additions and removals collapse per type and kind; other rows stay in order', () => {
  const typeOf = new Map<string, string>([...Array.from({ length: 400 }, (_, i) => [`b${i}`, 'mesh'] as [string, string]), ['sun', 'light'], ['old', 'mesh']]);
  const diff = [added('b0'), field('key'), ...Array.from({ length: 399 }, (_, i) => added(`b${i + 1}`)), added('sun'), removed('old'), added('mystery'), field('fill')];
  const { groups, rest } = groupDiff(diff, typeOf);
  assert.deepEqual(groups.map((g) => [g.type, g.kind, g.ds.length]), [['mesh', 'added', 400], ['light', 'added', 1], ['mesh', 'removed', 1], ['node', 'added', 1]]);
  assert.deepEqual(rest.map((d) => d.node), ['key', 'fill']);
});

console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
