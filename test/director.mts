// Use case tests of src/director.mts with a fake Renderer: no vork, claude or Chrome. State lives in a temp folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDirector, Refusal } from '../src/director.mts';
import type { Proposer } from '../src/director.mts';
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
const setup = ({ ade = false, proposer }: { ade?: boolean; proposer?: Proposer } = {}) => {
  const base = path.join(tmp, `case-${++n}`); const project = ade ? path.join(base, 'project') : null;
  const runs = project ? path.join(project, '.vork') : path.join(base, 'runs'); fs.mkdirSync(runs, { recursive: true });
  const fake = fakeRenderer();
  return { runs, project, fake, d: createDirector({ runs, project, renderer: fake.renderer, starter, proposer }) };
};
/** Asserts that fn is refused with this kind; returns the refusal. */
const refused = async (kind: Refusal['kind'], fn: () => unknown, message?: RegExp): Promise<Refusal> => {
  try { await fn(); } catch (e) {
    assert.ok(e instanceof Refusal, String(e)); assert.equal(e.kind, kind, e.message); if (message) assert.match(e.message, message); return e;
  }
  assert.fail(`not refused (expected ${kind})`);
};
const waitJob = async <T extends { status: string }>(job: T): Promise<T> => { for (let i = 0; i < 200 && job.status === 'running'; i++) await tick(); return job; };
const agentProposal = (d: ReturnType<typeof setup>['d'], color: number[], base = 'v001') => d.agentPropose({ base, interpretation: 'x', claimed_changes: [], scene: withColor(color) });
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

await check('agent propose: bad fields are refused before rendering; a policy blocker is 422 and makes no version', async () => {
  const { d, fake } = setup({ ade: true });
  await refused('invalid', () => d.agentPropose({ interpretation: 'x', claimed_changes: [{ node: 1 }], scene: starter }), /claimed_changes/);
  await refused('invalid', () => d.agentPropose({ interpretation: 'x', claimed_changes: [], assumptions: [1], scene: starter }), /assumptions/);
  const r = await refused('unprocessable', () => d.agentPropose({ interpretation: 'x', claimed_changes: [], scene: { ...starter, programs: { p: {} } } }), /policy/);
  assert.deepEqual(Object.keys(r.extra), ['blockers', 'log', 'version']);
  assert.equal(fake.calls.length, 0); assert.equal(d.state.versions.length, 1);
  const { v, draft, flags } = await agentProposal(d, [0.2, 0.2, 0.9]);
  assert.ok(draft.ok); assert.deepEqual(flags, []); assert.equal(v.proposal!.via, 'mcp'); assert.equal(v.proposal!.respondsTo, null);
});

await check('#15 agent propose: a base discarded during the validation render makes no version', async () => {
  const { d, fake } = setup({ ade: true });
  const { v: base } = await agentProposal(d, [0.1, 0.1, 0.1]);
  const release = fake.hold();
  const p = agentProposal(d, [0.3, 0.3, 0.3], base.id);
  await tick(); d.decide({ versionId: base.id, decision: 'discard' }); release();
  await refused('conflict', () => p, /discarded while the scene was being validated/);
  assert.equal(d.state.versions.length, 2);
});

await check('built-in propose: the proposer gets the context; a base discarded while it works makes no proposal', async () => {
  const prompts: string[] = []; let hold: Promise<void> | null = null;
  const proposer: Proposer = async (prompt) => { prompts.push(prompt); if (hold) await hold; return { out: { interpretation: 'blue', assumptions: [], clarifying_question: null, claimed_changes: [], scene: withColor([0, 0, 1]) }, cost: 0.01, ms: 1 }; };
  const { d } = setup({ proposer });
  await refused('invalid', () => d.startPropose({ baseId: 'v001', instruction: 1 }));
  const job = await waitJob(d.startPropose({ baseId: 'v001', instruction: 'blue', selection: ['vase', 1], context: { selection: true } }));
  assert.equal(job.status, 'done', JSON.stringify(job)); assert.match(prompts[0], /^SELECTED objects \(director clicked these in the image\): vase$/m);
  const proposed = (job.result as { versionId: string }).versionId;
  assert.equal(d.getV(proposed)!.proposal!.cost, 0.01);
  let release!: () => void; hold = new Promise((r) => (release = r));
  const second = d.startPropose({ baseId: proposed, instruction: 'again' }); await tick();
  d.decide({ versionId: proposed, decision: 'discard' }); release();
  await waitJob(second); assert.equal(second.status, 'failed'); assert.equal(second.error, 'base_discarded');
  await refused('invalid', () => d.startPropose({ baseId: proposed, instruction: 'x' }), /discarded/);
  const ade = setup({ ade: true }).d; await refused('conflict', () => ade.checkCanPropose(), /ADE mode/);
});

await check('decide, checkout and direct edits keep HEAD on an accepted version and tell the agent', async () => {
  const { d } = setup({ ade: true });
  const { v } = await agentProposal(d, [0.5, 0.1, 0.1]);
  await refused('invalid', () => d.checkout({ versionId: v.id }), /accepted/);
  assert.equal(d.decide({ versionId: v.id, decision: 'accept', comment: 'ok' }), v.id);
  await refused('invalid', () => d.decide({ versionId: v.id, decision: 'discard' }), /only proposed/);
  d.checkout({ versionId: 'v001' }); assert.equal(d.state.head, 'v001');
  await refused('invalid', () => d.directEdit({ baseId: 'v001', node: 'vase', field: 'toString', value: 1 }), /unsupported/);
  await refused('invalid', () => d.directEdit({ baseId: 'v001', node: 'vase', field: 'energy', value: 5 }), /not a light/);
  const { v: edited, job } = d.directEdit({ baseId: 'v001', node: 'vase', field: 'specular_roughness', value: 0.3 });
  assert.equal(d.state.head, edited.id); await waitJob(job); assert.equal(job.status, 'done'); assert.ok(edited.renders.draft && edited.renders.previs);
  assert.deepEqual(d.takeEvents().map((e) => e.type), ['decision', 'checkout', 'direct_edit']);
});

await check('#31 two waiting agents get one event once in total; an aborted wait returns without reading', async () => {
  const { d } = setup();
  const gone = new AbortController(); const aborted = d.waitForEvents(10_000, gone.signal); gone.abort(); await aborted;
  const waits = [0, 1].map(() => d.waitForEvents(10_000, new AbortController().signal).then(() => d.takeEvents()));
  await tick(); d.feedback({ versionId: 'v001', selection: ['vase', 2], comment: ' darker ' });
  const got = await Promise.all(waits);
  assert.deepEqual(got.map((evs) => evs.length).sort(), [0, 1]);
  const ev = got.flat()[0]; assert.ok(ev.type === 'feedback' && ev.comment === 'darker' && ev.selection.length === 1);
  assert.equal(d.state.agentCursor, ev.seq); assert.deepEqual(d.takeEvents(), []);
});

await check('adoption: request, plan, adopt writes the asset and manifest, accepts the proposal and tells the agent', async () => {
  const { d, project } = setup({ ade: true });
  const { v } = await agentProposal(d, [0.9, 0.9, 0.1]);
  await refused('invalid', () => d.requestAdoption({ version: v.id, slug: '../evil' }), /slug/);
  const requestId = d.requestAdoption({ version: v.id, slug: 'hero', reason: 'fits' });
  await refused('conflict', () => d.requestAdoption({ version: v.id, slug: 'hero' }), /already pending/);
  const first = d.planAdoption({ requestId }); const plan = d.planAdoption({ requestId });
  assert.deepEqual(plan.writes, ['public/vork/hero.png', '.vork/adopted/hero.json']); assert.equal(plan.needsFinalRender, true);
  await refused('forbidden', () => d.startAdoption(first.ticket), /fresh approval/);
  const job = await waitJob(d.startAdoption(plan.ticket));
  assert.equal(job.status, 'done', JSON.stringify(job));
  const manifest = JSON.parse(fs.readFileSync(path.join(project!, '.vork/adopted/hero.json'), 'utf8'));
  assert.equal(manifest.vork, 'fake 1.0'); assert.equal(manifest.version, v.id);
  assert.ok(fs.readFileSync(path.join(project!, 'public/vork/hero.png')).toString().startsWith('png final'));
  assert.equal(v.status, 'accepted'); assert.equal(d.state.head, v.id); assert.equal(d.state.adoptionRequests[0].status, 'adopted');
  assert.equal(d.takeEvents().filter((e) => e.type === 'adopted').length, 1);
  await refused('forbidden', () => d.startAdoption(plan.ticket));
  await refused('conflict', () => setup().d.requestAdoption({ version: 'v001', slug: 'x' }), /--project/);
});

await check('#14 #27 while an adoption renders, discard is refused; discarding later rejects pending requests', async () => {
  const { d, fake, project } = setup({ ade: true });
  const { v } = await agentProposal(d, [0.3, 0.6, 0.3]);
  const requestId = d.requestAdoption({ version: v.id, slug: 'race' });
  const release = fake.hold();
  const job = d.startAdoption(d.planAdoption({ requestId }).ticket); await tick();
  await refused('conflict', () => d.decide({ versionId: v.id, decision: 'discard' }), /being adopted/);
  await refused('conflict', () => d.rejectAdoption({ requestId }), /running/);
  d.cancelJob(job.id); release(); await tick();
  assert.equal(job.status, 'cancelled'); assert.equal(fs.existsSync(path.join(project!, 'public/vork/race.png')), false);
  d.takeEvents();
  d.decide({ versionId: v.id, decision: 'discard' });
  assert.equal(d.state.adoptionRequests[0].status, 'rejected');
  assert.ok(d.takeEvents().some((e) => e.type === 'adoption_rejected' && e.comment === 'version discarded'));
});

await check('final render: needs a ticket for the exact scene; a ticket of a discarded version is refused', async () => {
  const { d } = setup({ ade: true });
  await refused('forbidden', () => d.startRender({ versionId: 'v001', profile: 'final', ticket: 'x' }));
  const job = await waitJob(d.startRender({ versionId: 'v001', profile: 'final', ticket: d.planFinal('v001').ticket }));
  assert.equal(job.status, 'done'); assert.ok(d.getV('v001')!.renders.final);
  const { v } = await agentProposal(d, [0.7, 0.2, 0.7]); const { ticket } = d.planFinal(v.id);
  d.decide({ versionId: v.id, decision: 'discard' });
  await refused('conflict', () => d.startRender({ versionId: v.id, profile: 'final', ticket }), /discarded/);
  await refused('not_found', () => d.agentRender('v999', 'draft'));
  await refused('forbidden', () => d.agentRender(v.id, 'final'), /human approval/);
});

await check('#17 policy.mts and director.mts do not load node:http, node:child_process or playwright-core, also through their imports', async () => {
  const forbidden = /^(node:)?(http|child_process)$|^playwright-core(\/|$)/;
  // Runtime imports only: `import type` is erased, so it loads nothing.
  const importsOf = (file: string) => [...fs.readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)\s+(?!type\b)[^'";]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm)].map((m) => m[1] ?? m[2] ?? m[3]);
  for (const start of ['policy.mts', 'director.mts']) {
    const seen = new Set<string>(); const todo = [path.join(ROOT, 'src', start)];
    while (todo.length) {
      const file = todo.pop()!; if (seen.has(file)) continue; seen.add(file);
      for (const spec of importsOf(file)) {
        assert.doesNotMatch(spec, forbidden, `${path.relative(ROOT, file)} imports ${spec} (reached from src/${start})`);
        if (spec.startsWith('.')) todo.push(path.resolve(path.dirname(file), spec));
      }
    }
  }
  // The check itself must see the imports it is meant to find.
  assert.ok(importsOf(path.join(ROOT, 'src', 'vork.mts')).includes('node:child_process'));
  assert.ok(importsOf(path.join(ROOT, 'src', 'http.mts')).includes('node:http'));
  assert.ok(importsOf(path.join(ROOT, 'src', 'preview.mts')).includes('playwright-core'));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
