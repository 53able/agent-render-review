// Large-scene fixture for the E2E: the given scene plus `count` small spheres (250 by default), so the object list
// passes its 200-row cap and the review diff collapses the added nodes into a group. The spheres sit in a band above
// the starter objects and stay tiny, so a draft render stays fast and the vase keeps its place on screen.
// Run directly to print the scene: node test/fixtures/large-scene.mts [count] > scene.json (based on scenes/starter.json)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LARGE_SCENE_EXTRA = 250;
export const largeNodeName = (i: number) => `dot${String(i).padStart(3, '0')}`;

interface LargeSceneNode { type: string; name: string; [k: string]: unknown }
export function largeScene<T extends { nodes: LargeSceneNode[] }>(base: T, count = LARGE_SCENE_EXTRA): T {
  const cols = 25;
  const dots: LargeSceneNode[] = Array.from({ length: count }, (_, i) => ({
    type: 'mesh', name: largeNodeName(i),
    translation: [-2.4 + (i % cols) * 0.2, 1.3 + Math.floor(i / cols) * 0.12, -1.5],
    geometry: { std: 'sphere', radius: 0.03 },
    materials: [{ inputs: { base_color: [0.6, 0.6, 0.65], specular_roughness: 0.5 } }],
  }));
  return { ...structuredClone(base), nodes: [...structuredClone(base.nodes), ...dots] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const starter = JSON.parse(fs.readFileSync(path.join(ROOT, 'scenes', 'starter.json'), 'utf8'));
  process.stdout.write(JSON.stringify(largeScene(starter, Number(process.argv[2] || LARGE_SCENE_EXTRA))) + '\n');
}
