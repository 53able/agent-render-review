// Use case tests of src/director.mts with a fake Renderer: no vork, claude or Chrome. State lives in a temp folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDirector } from '../src/director.mts';
import type { Renderer, RenderOutcome } from '../src/vork.mts';
import type { Scene } from '../src/policy.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const starter = JSON.parse(fs.readFileSync(path.join(ROOT, 'scenes', 'starter.json'), 'utf8')) as Scene;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vd-director-')));
let pass = 0, failures = 0, n = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e: any) { failures++; console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ')}`); }
}

/** A Renderer that writes a small file per render. hold() keeps renders waiting until the returned release is called. */
function fakeRenderer() {
  const calls: { dir: string; profile: string; aborted: () => boolean }[] = [];
  let gate: Promise<void> | null = null; let failWith: string | null = null;
  const renderer: Renderer = {
    version: 'fake 1.0',
    async render({ scene, dir, profile, signal }): Promise<RenderOutcome> {
      calls.push({ dir, profile, aborted: () => signal.aborted });
      if (gate) await Promise.race([gate, new Promise((r) => signal.addEventListener('abort', r))]);
      if (signal.aborted) return { ok: false, code: null, timedOut: false, log: 'killed', seconds: 0 };
      if (failWith) return { ok: false, code: 1, timedOut: false, log: failWith, seconds: 0 };
      const file = path.join(dir, `${profile}.png`); fs.writeFileSync(file, `png ${profile} ${JSON.stringify(scene)}`);
      return {
        ok: true, file, seconds: 0.01, width: 2, height: 1, ids: Buffer.from([1, 0, 2, 0]), objects: [{ pass_index: 1, name: 'vase' }],
        exposure: { mean: 0.5, clipped: 0, near_black: 0 }, settings: { integrator: 'path', samples: 4, denoiser: null }, warnings: [],
      };
    },
  };
  const hold = () => { let release!: () => void; gate = new Promise((r) => (release = r)); return () => { gate = null; release(); }; };
  return { renderer, calls, hold, fail: (log: string | null) => { failWith = log; } };
}
const setup = ({ project = null as string | null } = {}) => {
  const runs = path.join(tmp, `runs-${++n}`); fs.mkdirSync(runs);
  const fake = fakeRenderer();
  return { runs, fake, d: createDirector({ runs, project, renderer: fake.renderer, starter }) };
};
const tick = () => new Promise((r) => setTimeout(r, 10));
const withColor = (c: number[]): Scene => { const s = structuredClone(starter); s.nodes.find((x) => x.name === 'vase')!.materials![0].inputs!.base_color = c; return s; };

await check('a new state starts with the starter scene as accepted HEAD and is saved', async () => {
  const { runs, d } = setup();
  assert.equal(d.state.head, 'v001'); assert.equal(d.getV('v001')!.status, 'accepted'); assert.equal(d.mode, 'standalone');
  assert.deepEqual(d.sceneOf('v001'), starter);
  const saved = JSON.parse(fs.readFileSync(path.join(runs, 'state.json'), 'utf8'));
  assert.equal(saved.versions.length, 1); assert.equal(saved.audit[0].event, 'init');
});

await check('a state.json from an older Director is filled with defaults on load', async () => {
  const runs = path.join(tmp, 'old'); fs.mkdirSync(path.join(runs, 'v001'), { recursive: true });
  fs.writeFileSync(path.join(runs, 'v001', 'scene.json'), JSON.stringify(starter));
  fs.writeFileSync(path.join(runs, 'state.json'), JSON.stringify({ versions: [{ id: 'v001', parent: null, origin: 'starter', instruction: null, proposal: null, status: 'accepted', created: 'x', renders: {} }] }));
  const d = createDirector({ runs, project: null, renderer: fakeRenderer().renderer, starter });
  assert.equal(d.state.head, null); assert.deepEqual([d.state.audit, d.state.events, d.state.adoptionRequests, d.state.agentCursor], [[], [], [], 0]);
});

await check('a render is stored with hashes of the file and the object ids', async () => {
  const { d } = setup(); const v = d.getV('v001')!;
  const r = await d.renderVersion(d.newJob('render', v.id), v, 'draft');
  assert.ok(r.ok); const info = v.renders.draft!;
  assert.match(info.image, /^\/runs\/v001\/draft\.png\?\d+$/); assert.equal(info.sceneHash, d.hashScene('v001'));
  assert.equal(fs.readFileSync(path.join(d.vdir('v001'), 'draft.ids.bin')).length, 4);
});

await check('#28 concurrent renders of one version and profile render once and share the result', async () => {
  const { d, fake } = setup(); const v = d.getV('v001')!;
  const release = fake.hold();
  const all = [0, 1, 2].map(() => d.renderVersion(d.newJob('render', v.id), v, 'previs'));
  await tick(); release();
  const rs = await Promise.all(all);
  assert.ok(rs.every((r) => r.ok)); assert.equal(fake.calls.length, 1);
  assert.equal(d.renderLocks.size, 0, 'the render lock is dropped when the render ends (#32)');
});

await check('renders of one version run one at a time', async () => {
  const { d, fake } = setup(); const v = d.getV('v001')!;
  const release = fake.hold();
  const a = d.renderVersion(d.newJob('render', v.id), v, 'previs'); const b = d.renderVersion(d.newJob('render', v.id), v, 'draft');
  await tick(); assert.equal(fake.calls.length, 1, 'the second render waits for the first');
  release(); await Promise.all([a, b]); assert.equal(fake.calls.length, 2);
});

await check('#16 cancelling a job aborts its render and nothing is stored', async () => {
  const { d, fake } = setup(); const v = d.getV('v001')!;
  const release = fake.hold();
  const job = d.newJob('render', v.id); const p = d.renderVersion(job, v, 'previs');
  await tick(); job.status = 'cancelled'; job.ac.abort();
  const r = await p; release();
  assert.equal(r.cancelled, true); assert.equal(fake.calls[0].aborted(), true); assert.equal(v.renders.previs, undefined);
});

await check('#15 a final render of a version discarded while it runs is not kept', async () => {
  const { d, fake } = setup();
  const job = d.newJob('propose', 'v001'); const { v } = await d.createProposal(job, { baseId: 'v001', scene: withColor([0.1, 0.2, 0.3]), instruction: 'x', proposal: { interpretation: 'x', assumptions: [], claimed_changes: [], policy: { blockers: [], flags: [] }, context: [], via: 'mcp' } });
  const release = fake.hold();
  const p = d.renderVersion(d.newJob('render', v.id), v, 'final');
  await tick(); v.status = 'discarded'; release();
  const r = await p;
  assert.equal(r.ok, false); assert.match(r.log!, /discarded during the render/); assert.equal(v.renders.final, undefined);
});

await check('validation: a policy blocker renders nothing; a renderer failure is "invalid"; the throwaway folder is removed', async () => {
  const { d, fake } = setup();
  const blocked = await d.validateScene(d.newJob('x', 'v001'), { ...starter, programs: { p: {} } });
  assert.equal(blocked.kind, 'blocked'); assert.equal(fake.calls.length, 0);
  fake.fail('bad field');
  const invalid = await d.validateScene(d.newJob('x', 'v001'), starter);
  assert.equal(invalid.kind, 'invalid'); assert.equal(invalid.log, 'bad field');
  fake.fail(null);
  assert.equal((await d.validateScene(d.newJob('x', 'v001'), starter)).ok, true);
  assert.deepEqual(fs.readdirSync(d.runs).filter((f) => f.startsWith('tmp-')), []);
});

await check('createProposal stores a proposed version, renders draft then previs, HEAD stays', async () => {
  const { d, fake } = setup();
  const { v, draft } = await d.createProposal(d.newJob('agent-propose', 'v001', { listed: false }), { baseId: 'v001', scene: withColor([0.5, 0.5, 0.5]), instruction: 'grey', proposal: { interpretation: 'grey', assumptions: [], claimed_changes: [], policy: { blockers: [], flags: [] }, context: [], via: 'mcp' } });
  assert.ok(draft.ok); assert.equal(v.status, 'proposed'); assert.equal(d.state.head, 'v001');
  assert.deepEqual(fake.calls.map((c) => c.profile), ['draft', 'previs']);
  assert.equal(d.state.audit.at(-1)!.event, 'proposed');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
