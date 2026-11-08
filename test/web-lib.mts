// Unit tests of web/src/lib (UI-independent logic ported from public/app.js). Plain node, no DOM, no server.
import assert from 'node:assert/strict';
import { api } from '../web/src/lib/api.ts';
import { toS, toL, linToHex, hexToLin, isColor } from '../web/src/lib/color.ts';
import { pick } from '../web/src/lib/ids.ts';
import { signature } from '../web/src/lib/signature.ts';
import { isWildcard, groupDiff, keyOf, checkClaims as checkClaimsOf } from '../web/src/lib/review-model.ts';
import { depth } from '../web/src/lib/depth.ts';
import { canvasColors } from '../web/src/lib/canvas-colors.ts';
import { applyRules, type RuleState } from '../web/src/lib/state-rules.ts';
import type { Data, Version, Diff, Ids, SceneNode } from '../web/src/lib/types.ts';

let pass = 0, failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e: any) { failures++; console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ')}`); }
}

// ---------- api ----------
type Call = { url: string; init: RequestInit | undefined };
function stubFetch(res: { status: number; body?: unknown; badJson?: boolean }) {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => { if (res.badJson) throw new SyntaxError('bad'); return res.body; } } as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}
await check('api: GET without body sends no init options', async () => {
  const s = stubFetch({ status: 200, body: { a: 1 } });
  try { assert.deepEqual(await api('/api/state'), { a: 1 }); assert.deepEqual(s.calls, [{ url: '/api/state', init: {} }]); } finally { s.restore(); }
});
await check('api: body is POSTed as JSON with the content-type header and no credentials option', async () => {
  const s = stubFetch({ status: 200, body: {} });
  try {
    await api('/api/x', { k: [1] });
    assert.deepEqual(s.calls[0].init, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"k":[1]}' });
    assert.equal('credentials' in s.calls[0].init!, false);
  } finally { s.restore(); }
});
await check('api: 202 is success, other non-2xx throws the server error, else HTTP status', async () => {
  let s = stubFetch({ status: 202, body: { id: 'j1' } });
  try { assert.deepEqual(await api('/api/render', {}), { id: 'j1' }); } finally { s.restore(); }
  s = stubFetch({ status: 409, body: { error: 'busy' } });
  try { await assert.rejects(api('/api/x', {}), { message: 'busy' }); } finally { s.restore(); }
  s = stubFetch({ status: 500, body: {} });
  try { await assert.rejects(api('/api/x'), { message: 'HTTP 500' }); } finally { s.restore(); }
  s = stubFetch({ status: 502, badJson: true });
  try { await assert.rejects(api('/api/x'), { message: 'HTTP 502' }); } finally { s.restore(); }
  s = stubFetch({ status: 200, badJson: true });
  try { assert.deepEqual(await api('/api/x'), {}); } finally { s.restore(); }
});

// ---------- color ----------
await check('color: known values and the sRGB/linear curve boundaries', () => {
  assert.equal(linToHex([0, 0, 0]), '#000000');
  assert.equal(linToHex([1, 1, 1]), '#ffffff');
  assert.equal(linToHex([0.2159, 0.2159, 0.2159]), '#808080'); // linear 0.2159 is sRGB 128
  assert.equal(linToHex([-1, 2, 0.5]), '#00ffbc'); // clamped to [0,1]
  assert.deepEqual(hexToLin('#000000'), [0, 0, 0]);
  assert.deepEqual(hexToLin('#ffffff'), [1, 1, 1]);
  assert.ok(Math.abs(toS(0.0031308) - 12.92 * 0.0031308) < 1e-6 && Math.abs(toL(0.04045) - 0.04045 / 12.92) < 1e-9);
});
await check('color: every hex survives hex -> linear -> hex (round-trip)', () => {
  for (let i = 0; i < 256; i += 5) {
    const h = '#' + [i, 255 - i, (i * 7) % 256].map((n) => n.toString(16).padStart(2, '0')).join('');
    assert.equal(linToHex(hexToLin(h)), h);
  }
});
await check('color: linear -> hex -> linear stays within the 8-bit quantization', () => {
  for (const c of [0.001, 0.05, 0.2, 0.5, 0.9]) assert.ok(Math.abs(hexToLin(linToHex([c, c, c]))[0] - c) < 0.01, String(c));
});
await check('color: isColor accepts 3 numbers in [0,1.5] only', () => {
  assert.ok(isColor([0, 0.5, 1.5]));
  for (const bad of [[0, 0], [0, 0, 0, 0], [0, 0, 1.6], [-0.1, 0, 0], ['a', 0, 0], null, undefined, 'abc', { length: 3 }]) assert.equal(isColor(bad), false, JSON.stringify(bad));
});

// ---------- ids ----------
const ids: Ids = { w: 4, h: 2, arr: Uint16Array.from([0, 1, 1, 2, 0, 1, 2, 2]), objects: { 1: 'vase', 2: 'table' } };
await check('ids: pick maps displayed coordinates to render pixels', () => {
  // displayed 400x200 -> each id pixel is 100x100
  assert.equal(pick(ids, 150, 50, 400, 200), 'vase'); // (1,0)
  assert.equal(pick(ids, 350, 50, 400, 200), 'table'); // (3,0)
  assert.equal(pick(ids, 150, 150, 400, 200), 'vase'); // (1,1)
  assert.equal(pick(ids, 399.9, 199.9, 400, 200), 'table'); // last pixel
  assert.equal(pick(ids, 15, 5, 40, 20), 'vase'); // scales with the displayed size
});
await check('ids: pick misses return null (background id, unknown id, no ids, outside, zero size)', () => {
  assert.equal(pick(ids, 50, 50, 400, 200), null); // id 0 has no object
  assert.equal(pick({ ...ids, arr: Uint16Array.from([9, 0, 0, 0, 0, 0, 0, 0]) }, 10, 10, 400, 200), null); // id without a name
  assert.equal(pick(null, 10, 10, 400, 200), null);
  assert.equal(pick(ids, -1, 50, 400, 200), null);
  assert.equal(pick(ids, 50, -1, 400, 200), null);
  assert.equal(pick(ids, 400, 50, 400, 200), null); // x == w would wrap to the next row in the raw index
  assert.equal(pick(ids, 50, 200, 400, 200), null);
  assert.equal(pick(ids, 1, 1, 0, 200), null);
  assert.equal(pick(ids, 1, 1, 400, 0), null);
  assert.equal(pick(ids, NaN, 1, 400, 200), null);
});

// ---------- signature ----------
const ver = (id: string, over: Partial<Version> = {}): Version => ({ id, parent: null, status: 'accepted', origin: 'human', hash: 'h', renders: {}, scene: { nodes: [] }, proposal: null as never, diff: [], ...over });
const data = (over: Partial<Data> = {}): Data => ({ head: 'v1', versions: [ver('v1')], vork: '1', adoptionRequests: [], events: [], agentCursor: 0, audit: [], config: {}, ...over });
await check('signature: stable for equal state, and for fields it does not track', () => {
  assert.equal(signature(data()), signature(data()));
  assert.equal(signature(data()), signature(data({ audit: [{ t: 'x', event: 'e' }], vork: '2', model: 'm', project: '/p' })));
  assert.equal(typeof signature(data()), 'string');
});
await check('signature: changes with head, versions, status, renders, adoptions, events, cursor', () => {
  const base = signature(data());
  const diffs = [
    data({ head: 'v2' }),
    data({ versions: [ver('v1'), ver('v2')] }),
    data({ versions: [ver('v1', { status: 'discarded' })] }),
    data({ versions: [ver('v1', { renders: { draft: {} as never } })] }),
    data({ adoptionRequests: [{ id: 'a', status: 'pending', slug: 's', version: 'v1', reason: 'r' }] }),
    data({ events: [{ seq: 1 } as never] }),
    data({ agentCursor: 1 }),
  ].map(signature);
  for (const s of diffs) assert.notEqual(s, base);
  assert.equal(new Set(diffs).size, diffs.length);
  const a = data({ adoptionRequests: [{ id: 'a', status: 'pending', slug: 's', version: 'v1', reason: 'r' }] });
  const b = data({ adoptionRequests: [{ id: 'a', status: 'adopting', slug: 's', version: 'v1', reason: 'r' }] });
  assert.notEqual(signature(a), signature(b));
});

// ---------- diff (review-model.ts, the one implementation the review panel uses) ----------
/** Claims by node name only; what and why do not matter to the check. */
const checkClaims = (nodes: string[], diff: Diff[]) => checkClaimsOf(nodes.map((node) => ({ node, what: '', why: '' })), diff);
/** Node types as the review panel builds them: the base scene first, then the version's own scene overrides it. */
const groupDiffs = (diff: Diff[], baseNodes: SceneNode[], nodes: SceneNode[]) => groupDiff(diff, new Map([...baseNodes, ...nodes].map((n) => [n.name, n.type])));
await check('diff: isWildcard needs a prefix and a trailing *', () => {
  assert.equal(isWildcard('b*'), true);
  assert.equal(isWildcard('chair_*'), true);
  assert.equal(isWildcard('*'), false); // bare * stays a literal name
  assert.equal(isWildcard(''), false);
  assert.equal(isWildcard('b'), false);
  assert.equal(isWildcard('*b'), false);
  assert.equal(isWildcard('**'), true);
});
const node = (name: string, type: string): SceneNode => ({ name, type });
await check('diff: groupDiffs groups (node) rows by type and added/removed, keeps order, and leaves other rows in rest', () => {
  const diff: Diff[] = [
    { node: 'a1', path: '(node)', after: 'added' },
    { node: 'l1', path: '(node)', after: 'added' },
    { node: 'a2', path: '(node)', after: 'added' },
    { node: 'a3', path: '(node)', before: 'x', after: 'removed' },
    { node: 'a1', path: 'location' },
    { node: '(scene)', path: 'render.samples' },
  ];
  const { groups, rest } = groupDiffs(diff, [node('a3', 'mesh')], [node('a1', 'mesh'), node('a2', 'mesh'), node('l1', 'light')]);
  assert.deepEqual(groups.map((g) => [g.type, g.kind, g.ds.map((d) => d.node)]), [['mesh', 'added', ['a1', 'a2']], ['light', 'added', ['l1']], ['mesh', 'removed', ['a3']]]);
  assert.deepEqual(rest.map((d) => d.path), ['location', 'render.samples']);
});
await check('diff: groupDiffs edge cases (empty, unknown type, current scene overrides parent, non-"removed" after counts as added)', () => {
  assert.deepEqual(groupDiffs([], [], []), { groups: [], rest: [] });
  const g1 = groupDiffs([{ node: 'ghost', path: '(node)', after: 'added' }], [], []).groups;
  assert.deepEqual(g1.map((g) => [g.type, g.kind]), [['node', 'added']]);
  const g2 = groupDiffs([{ node: 'n', path: '(node)', after: 'added' }], [node('n', 'mesh')], [node('n', 'light')]).groups;
  assert.equal(g2[0].type, 'light');
  const g3 = groupDiffs([{ node: 'n', path: '(node)' }, { node: 'm', path: '(node)', after: 5 }], [], []).groups;
  assert.deepEqual(g3.map((g) => [g.kind, g.ds.length]), [['added', 2]]);
  const g4 = groupDiffs([{ node: 'n', path: '(node)', after: 'added' }], [], [{ name: 'n', type: '' }]).groups;
  assert.equal(g4[0].type, 'node'); // empty type falls back like app.js
});

await check('diff: keyOf uses the path head only for (scene) rows', () => {
  assert.equal(keyOf({ node: '(scene)', path: 'render.samples' }), 'render');
  assert.equal(keyOf({ node: '(scene)', path: 'frames[0].x' }), 'frames');
  assert.equal(keyOf({ node: '(scene)', path: 'animation' }), 'animation');
  assert.equal(keyOf({ node: 'cube', path: 'location.x' }), 'cube');
});
await check('diff: checkClaims.isClaimed matches exact, scene key, "scene", and prefix claims; unclaimed rows are flagged', () => {
  const { isClaimed } = checkClaims(['cube', 'render', 'b*'], []);
  assert.equal(isClaimed({ node: 'cube', path: 'location' }), true);
  assert.equal(isClaimed({ node: 'lamp', path: 'energy' }), false); // changed but not mentioned
  assert.equal(isClaimed({ node: '(scene)', path: 'render.samples' }), true);
  assert.equal(isClaimed({ node: '(scene)', path: 'animation.fps' }), false);
  assert.equal(isClaimed({ node: 'bowl', path: 'x' }), true); // b*
  assert.equal(isClaimed({ node: 'apple', path: 'x' }), false);
  assert.equal(checkClaims(['scene'], []).isClaimed({ node: '(scene)', path: 'anything' }), true);
  assert.equal(checkClaims(['scene'], []).isClaimed({ node: 'scene', path: 'x' }), true); // literal node named scene
  assert.equal(checkClaims(['b*'], []).isClaimed({ node: '(scene)', path: 'b.x' }), false); // prefixes never cover scene rows
  assert.equal(checkClaims(['*'], []).isClaimed({ node: 'anything', path: 'x' }), false); // bare * is a literal name
  assert.equal(checkClaims(['*'], []).isClaimed({ node: '*', path: 'x' }), true);
});
await check('diff: checkClaims.wildMatches lists distinct changed nodes per wildcard claim', () => {
  const diff: Diff[] = [
    { node: 'b1', path: 'x' }, { node: 'b1', path: 'y' }, { node: 'b2', path: '(node)' }, { node: 'c1', path: 'x' }, { node: '(scene)', path: 'b.q' },
  ];
  const { wildMatches } = checkClaims(['b*', 'c*', 'z*', 'b1', '*', 'b*'], diff);
  assert.deepEqual([...wildMatches], [['b*', ['b1', 'b2']], ['c*', ['c1']], ['z*', []]]); // b1 counted once, (scene) never counted, bare * and plain names absent, duplicate claim collapsed
});
await check('diff: checkClaims.ghost lists claims that changed nothing (plain, wildcard, scene boundaries)', () => {
  const diff: Diff[] = [{ node: 'cube', path: 'x' }, { node: '(scene)', path: 'render.samples' }, { node: 'b1', path: 'x' }];
  assert.deepEqual(checkClaims(['cube', 'lamp', 'render', 'frames', 'b*', 'q*', 'scene', '*'], diff).ghost, ['lamp', 'frames', 'q*', '*']);
  assert.deepEqual(checkClaims(['scene'], [{ node: 'cube', path: 'x' }]).ghost, ['scene']); // no (scene) row
  assert.deepEqual(checkClaims(['scene'], [{ node: '(scene)', path: 'render' }]).ghost, []);
  assert.deepEqual(checkClaims(['cube'], []).ghost, ['cube']);
  assert.deepEqual(checkClaims([], [{ node: 'cube', path: 'x' }]).ghost, []);
  assert.deepEqual(checkClaims(['a', 'a'], []).ghost, ['a']); // duplicates collapse
  assert.deepEqual(checkClaims(['cube'], [{ node: '(scene)', path: 'cube.x' }]).ghost, []); // scene path head "cube" counts as changed key (same as app.js)
});

// ---------- depth ----------
await check('depth: counts ancestors with more than one live child, capped at 3', () => {
  const vs = [
    ver('v1'), ver('v2', { parent: 'v1' }), ver('v3', { parent: 'v1' }), // v1 has two live children
    ver('v4', { parent: 'v2' }), ver('v5', { parent: 'v4' }),
  ];
  assert.equal(depth(vs[0], vs), 0);
  assert.equal(depth(vs[1], vs), 1);
  assert.equal(depth(vs[4], vs), 1); // only v1 branches
  const chain = [ver('c0'), ...[1, 2, 3, 4, 5].flatMap((i) => [ver(`c${i}`, { parent: `c${i - 1}` }), ver(`s${i}`, { parent: `c${i - 1}` })])];
  assert.equal(depth(chain.find((v) => v.id === 'c5')!, chain), 3); // capped
  assert.equal(depth(chain.find((v) => v.id === 'c2')!, chain), 2);
});
await check('depth: discarded siblings do not branch; missing parent and no versions are 0', () => {
  const vs = [ver('v1'), ver('v2', { parent: 'v1' }), ver('v3', { parent: 'v1', status: 'discarded' })];
  assert.equal(depth(vs[1], vs), 0);
  assert.equal(depth(ver('orphan', { parent: 'gone' }), []), 0);
  assert.equal(depth(ver('x'), []), 0);
});

// ---------- state-rules (what store.ts set() does to every change) ----------
const scene = (...names: string[]) => ({ nodes: names.map((n) => node(n, 'mesh')) });
const ruleData = (...vs: Version[]): Data => data({ head: 'v1', versions: vs });
const rs = (over: Partial<RuleState> = {}): RuleState => ({ data: ruleData(ver('v1', { scene: scene('a', 'b') }), ver('v2', { parent: 'v1', scene: scene('a') })), viewId: 'v1', selection: new Set(), finalPlan: null, notice: null, ...over });
const plan = (versionId: string) => ({ plan: { versionId } });
/** set(patch) as store.ts does it. */
const rule = (prev: RuleState, patch: Partial<RuleState>) => applyRules(prev, { ...prev, ...patch }, patch);
await check('state-rules: switching to another loaded version drops selected objects it does not have', () => {
  const next = rule(rs({ selection: new Set(['a', 'b']) }), { viewId: 'v2' });
  assert.deepEqual([...next.selection], ['a']);
});
await check('state-rules: new data under the same view drops selected objects that are gone', () => {
  const prev = rs({ selection: new Set(['a', 'b']) });
  const next = rule(prev, { data: ruleData(ver('v1', { scene: scene('a') })) });
  assert.deepEqual([...next.selection], ['a']);
});
/** Viewing v2, whose scene has an object HEAD (v1) lacks, with that object selected and v2's final plan open. */
const onV2 = () => rs({ data: ruleData(ver('v1', { scene: scene('a') }), ver('v2', { parent: 'v1', scene: scene('a', 'b') })), viewId: 'v2', selection: new Set(['a', 'b']), finalPlan: plan('v2') });
await check('state-rules: a view id not loaded yet keeps the selection (HEAD shown meanwhile does not prune it)', () => {
  assert.deepEqual([...rule(onV2(), { viewId: 'v9' }).selection], ['a', 'b']);
});
await check('state-rules: a patch that changes neither data nor view id does not prune the selection', () => {
  const next = rule(rs({ viewId: 'v2' }), { selection: new Set(['a', 'b']) });
  assert.deepEqual([...next.selection], ['a', 'b']);
});
await check('state-rules: switching to another loaded version closes the final plan', () => {
  assert.equal(rule(rs({ finalPlan: plan('v1') }), { viewId: 'v2' }).finalPlan, null);
});
await check('state-rules: staying on the same version keeps the final plan', () => {
  const fp = plan('v1');
  assert.equal(rule(rs({ finalPlan: fp }), { data: ruleData(ver('v1', { scene: scene('a', 'b') })) }).finalPlan, fp);
});
await check('state-rules: switching to a version not loaded yet keeps the final plan', () => {
  const prev = onV2();
  assert.equal(rule(prev, { viewId: 'v9' }).finalPlan, prev.finalPlan);
});
const noticed = () => rs({ data: ruleData(ver('v1'), ver('p1', { parent: 'v1', status: 'proposed' })), notice: 'p1' });
await check('state-rules: viewing the announced proposal ends the notice', () => {
  assert.equal(rule(noticed(), { viewId: 'p1' }).notice, null);
});
await check('state-rules: the announced version no longer being a proposal ends the notice', () => {
  assert.equal(rule(noticed(), { data: ruleData(ver('v1'), ver('p1', { parent: 'v1', status: 'accepted' })) }).notice, null);
});
await check('state-rules: an unrelated patch keeps the notice while another version is on screen and it is still a proposal', () => {
  assert.equal(rule(noticed(), { selection: new Set(['a']) }).notice, 'p1');
});
await check('state-rules: new data with the announced version still proposed keeps the notice', () => {
  assert.equal(rule(noticed(), { data: ruleData(ver('v1'), ver('p1', { parent: 'v1', status: 'proposed' })) }).notice, 'p1');
});
await check('state-rules: a patch that sets notice keeps it', () => {
  assert.equal(rule(rs({ data: ruleData(ver('v1'), ver('p1', { parent: 'v1', status: 'proposed' })), viewId: 'p1' }), { notice: 'p1' }).notice, 'p1');
});

// ---------- canvas-colors ----------
await check('canvas-colors: fixed constants match app.js/style.css', () => {
  assert.equal(canvasColors.viewportBg, '#000');
  assert.equal(canvasColors.wipeLine, '#3ee6f0');
  assert.equal(canvasColors.wipeLabel, '#fff');
  assert.deepEqual(canvasColors.overlaySelected, [62, 230, 240]);
  assert.equal(canvasColors.emptyFg, '#8b939e');
  for (const k of ['tipFg', 'tipBg', 'emptyBg', 'wipeTrack', 'wipeThumb'] as const) assert.ok(canvasColors[k], k);
});

console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
