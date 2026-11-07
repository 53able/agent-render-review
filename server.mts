// Render Director — a review surface for renders made with vork (unofficial).
// Standalone mode: `node server.mts` (built-in proposer via `claude -p`).
// ADE mode:        `node server.mts --project <dir>` (your ADE agent proposes through mcp.mts; you review and adopt here).
// This file is the entry point: --selftest, --report, or the server (main.mts). The code lives in main.mts and src/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { policyCheck, diffScenes, resolveInside, reportFromAudit } from './src/policy.mts';
import type { SceneNode, Scene, PolicyResult, AuditEvent } from './src/policy.mts';
import { main } from './main.mts';
import { log, errFields, shutdownLogging } from './src/log.mts';
// Kept importable from here: test/integration.mts and older callers import them from server.mts.
export { policyCheck, diffScenes, resolveInside, reportFromAudit } from './src/policy.mts';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

// ---------- CLI: selftest and report (no server, no state) ----------
if (argv[0] === '--selftest') {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'scenes', 'starter.json'), 'utf8')) as Scene;
  const cases: [string, Scene, (r: PolicyResult) => boolean][] = [
    ['starter passes', base, (r) => !r.blockers.length && !r.flags.length],
    ['absolute asset path blocked', { ...base, nodes: [...base.nodes, { type: 'asset', name: 'x', file: '/etc/passwd' }] }, (r) => r.blockers.length === 1],
    ['parent traversal blocked', { ...base, nodes: [...base.nodes, { type: 'asset', name: 'x', file: 'a/../../b.glb' }] }, (r) => r.blockers.length === 1],
    ['url blocked', { ...base, nodes: [...base.nodes, { type: 'asset', name: 'x', file: 'https://e.com/m.glb' }] }, (r) => r.blockers.length === 1],
    ['local asset flagged R2', { ...base, nodes: [...base.nodes, { type: 'asset', name: 'x', file: 'm.glb' }] }, (r) => !r.blockers.length && r.flags[0]?.level === 'R2'],
    ['custom program blocked', { ...base, programs: { p: { source: 'x' } } }, (r) => r.blockers.some((b) => b.includes('custom'))],
    ['huge resolution blocked', { ...base, render: { resolution: [7680, 4320] } }, (r) => r.blockers.some((b) => b.includes('resolution'))],
    ['skewed resolution blocked', { ...base, render: { resolution: [100000, 10] } }, (r) => r.blockers.some((b) => b.includes('resolution'))],
    ['compositor resolution blocked', { ...base, render: { ...base.render, compositor: [{ material: 'm', resolution: [8000, 8000] }] } }, (r) => r.blockers.some((b) => b.includes('compositor'))],
    ['gltf blocked', { ...base, nodes: [...base.nodes, { type: 'asset', name: 'x', file: 'm.gltf' }] }, (r) => r.blockers.length === 1],
    ['image file object in inputs blocked', { ...base, nodes: [...base.nodes, { type: 'mesh', name: 'q', geometry: { std: 'box' }, materials: [{ inputs: { base_color: { image: { file: '/etc/passwd' } } } }] }] }, (r) => r.blockers.length === 1],
    ['unnamed node blocked', { ...base, nodes: [...base.nodes, { type: 'mesh', geometry: { std: 'box' } }] }, (r) => r.blockers.some((b) => b.includes('name'))],
    ['non-string name blocked', { ...base, nodes: [...base.nodes, { type: 'mesh', name: 1, geometry: { std: 'box' } } as unknown as SceneNode] }, (r) => r.blockers.some((b) => b.includes('name'))],
    ['reserved # name blocked', { ...base, nodes: [...base.nodes, { type: 'light', name: '#10', energy: 5 }] }, (r) => r.blockers.some((b) => b.includes('reserved'))],
    ['null node blocked without throwing', { ...base, nodes: [...base.nodes, null as unknown as SceneNode] }, (r) => r.blockers.some((b) => b.includes('name'))],
    ['duplicate names blocked', { ...base, nodes: [...base.nodes, { type: 'mesh', name: 'vase', geometry: { std: 'box' } }] }, (r) => r.blockers.some((b) => b.includes('duplicate'))],
    ['wrong version blocked', { ...base, version: 1 }, (r) => r.blockers.length === 1],
  ];
  let fail = 0;
  for (const [name, scene, ok] of cases) { const r = policyCheck(scene); const pass = ok(r); fail += !pass as unknown as number; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`, pass ? '' : JSON.stringify(r)); }
  const mod = structuredClone(base); mod.nodes[1].materials![0].inputs!.base_color = [0.1, 0.1, 0.1]; mod.render!.background = [0, 0, 0];
  const d = diffScenes(base, mod);
  const dpass = d.length === 2 && d.some((x) => x.node === 'vase' && x.path === 'materials[0].inputs.base_color') && d.some((x) => x.node === '(scene)' && x.path === 'render.background');
  fail += !dpass as unknown as number; console.log(`${dpass ? 'PASS' : 'FAIL'} diff finds exactly the two edits`, dpass ? '' : JSON.stringify(d));
  // #8: a '#<index>' name must not hide an unnamed node; inherited keys are added, not changed
  const added = (extra: SceneNode[]) => diffScenes(base, { ...base, nodes: [...base.nodes, ...extra] });
  const collide = added([{ type: 'light', name: `#${base.nodes.length + 1}`, energy: 5000 }, { type: 'mesh', geometry: { std: 'box' } }]);
  const inherited = ['constructor', 'toString', '__proto__', 'hasOwnProperty'].map((name) => added([{ type: 'light', name, energy: 5 }]));
  const extraCases: [string, boolean, unknown][] = [
    ['diff: a "#<index>" name does not hide an unnamed node', collide.length === 2 && collide.every((x) => x.path === '(node)' && x.after === 'added'), collide],
    ['diff: inherited key names show as added nodes', inherited.every((x) => x.length === 1 && x[0].path === '(node)' && x[0].after === 'added'), inherited],
  ];
  for (const [name, pass, got] of extraCases) { fail += !pass as unknown as number; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`, pass ? '' : JSON.stringify(got)); }
  // write-back containment
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'vd-self-'));
  fs.mkdirSync(path.join(tmp, 'proj', 'public'), { recursive: true }); fs.mkdirSync(path.join(tmp, 'outside'));
  fs.symlinkSync(path.join(tmp, 'outside'), path.join(tmp, 'proj', 'public', 'escape'));
  fs.writeFileSync(path.join(tmp, 'outside', 'x.png'), ''); fs.symlinkSync(path.join(tmp, 'outside', 'x.png'), path.join(tmp, 'proj', 'public', 'link.png'));
  const proj = path.join(tmp, 'proj');
  const throws = (rel: string) => { try { resolveInside(proj, rel); return false; } catch { return true; } };
  const wcases: [string, boolean][] = [
    ['write: normal path allowed', !throws('public/vork/hero.png')],
    ['write: .. rejected', throws('public/../../outside/x.png')],
    ['write: absolute rejected', throws(path.join(tmp, 'outside', 'x.png'))],
    ['write: symlinked dir escaping rejected', throws('public/escape/x.png')],
    ['write: symlink file rejected', throws('public/link.png')],
  ];
  for (const [name, pass] of wcases) { fail += !pass as unknown as number; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`); }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

if (argv[0] === '--report') {
  const dir = path.resolve(argv[1] || '.');
  const f = path.join(dir, '.vork', 'state.json');
  if (!fs.existsSync(f)) { console.error(`no Director state at ${f}`); process.exit(2); }
  const r = reportFromAudit(JSON.parse(fs.readFileSync(f, 'utf8')).audit as AuditEvent[] || []);
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}

if (argv[0] && argv[0].startsWith('--') && !['--project', '--port'].includes(argv[0])) {
  console.error('usage: node server.mts [--project DIR] [--port N] | --selftest | --report DIR'); process.exit(2);
}
if (process.env.RENDER_DIRECTOR_IMPORT) { /* imported by tests for the pure helpers only */ } else {
  // The exit code and the stack Node prints stay as they were; the event is written first (a no-op before setupLogging).
  await main(argv).catch((e) => { log('main').fatal('director.fatal', 'Director failed to start', { origin: 'main', ...errFields(e) }); shutdownLogging(); throw e; });
}
