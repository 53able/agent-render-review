// `npm run build` and `prepare`: builds web/ into dist.tmp, stamps the build ID into its index.html and swaps it into
// dist. Exits 0 without building only when the vite package itself is absent (npm install --omit=dev); startup then
// refuses with instructions. Any other failure exits non-zero.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeBuildId, injectBuildId } from '../src/build-id.mts';
import { swapDist } from './swap-dist.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'dist.tmp');

let vite: typeof import('vite');
try { vite = await import('vite'); }
catch (e: any) {
  if (e?.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).startsWith("Cannot find package 'vite' imported from ")) {
    console.warn('render-director: vite is not installed, so the web UI was not built. Run `npm install` (with dev dependencies) before starting.');
    process.exit(0);
  }
  throw e;
}

const id = computeBuildId(ROOT);
// outDir is outside the Vite root, so emptyOutDir must be explicit.
await vite.build({ configFile: path.join(ROOT, 'vite.config.mts'), build: { outDir: TMP, emptyOutDir: true } });
const index = path.join(TMP, 'index.html');
fs.writeFileSync(index, injectBuildId(fs.readFileSync(index, 'utf8'), id));
swapDist(ROOT);
console.log(`render-director: built dist/ (${id.slice(0, 12)})`);
