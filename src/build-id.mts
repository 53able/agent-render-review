// Build ID: a hash of the files the web UI is built from. scripts/build.mts writes it into dist/index.html as
// <meta name="rd-build">, and startup compares it with a fresh computation to refuse a missing or stale dist/.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Inputs outside web/, relative to the repository root. */
export const FIXED_INPUTS = ['vite.config.mts', 'tsconfig.web.json', 'components.json', 'scripts/build.mts', 'src/build-id.mts', 'package-lock.json'];
export const META_NAME = 'rd-build';

/**
 * The input files as sorted POSIX paths relative to root: every file under web/ (whatever its extension, so an asset
 * Vite bundles cannot be left out), except names starting with a dot (files or folders: .DS_Store, editor swap files),
 * and FIXED_INPUTS. package-lock.json is one of them, so any dependency change, even one the UI does not use, makes
 * dist/ stale until `npm install` (which runs the build) or `npm run build`.
 */
export function buildIdInputs(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      const child = rel + '/' + ent.name;
      if (ent.isDirectory()) walk(child);
      else if (ent.isFile()) out.push(child);
    }
  };
  walk('web');
  out.push(...FIXED_INPUTS);
  return out.sort();
}

/** SHA-256 over "path NUL content NUL" for each input, in sorted path order. Throws if an input is missing. */
export function computeBuildId(root: string): string {
  const h = crypto.createHash('sha256');
  for (const rel of buildIdInputs(root)) {
    h.update(rel); h.update('\0');
    h.update(fs.readFileSync(path.join(root, ...rel.split('/'))));
    h.update('\0');
  }
  return h.digest('hex');
}

/** The rd-build value in an index.html, or null when there is none. */
export function readBuildId(html: string): string | null {
  return html.match(/<meta name="rd-build" content="([0-9a-f]{64})">/)?.[1] ?? null;
}

/** html with the rd-build meta inserted at the start of <head>. */
export function injectBuildId(html: string, id: string): string {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error(`bad build id: ${id}`);
  const at = html.indexOf('<head>');
  if (at < 0 || html.indexOf('<head>', at + 1) >= 0) throw new Error('index.html must contain exactly one <head>');
  const end = at + '<head>'.length;
  return html.slice(0, end) + `<meta name="${META_NAME}" content="${id}">` + html.slice(end);
}

export const BUILD_HINT = 'Run `npm install` in the render-director folder (or `npm run build` if npm scripts are disabled).';

/** Why root/dist cannot be served (missing, or built from other sources), or null when it matches the sources. */
export function distProblem(root: string): string | null {
  const index = path.join(root, 'dist', 'index.html');
  let html: string;
  try { html = fs.readFileSync(index, 'utf8'); }
  catch (e: any) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; return `the web UI is not built (${index} is missing). ${BUILD_HINT}`; }
  if (readBuildId(html) !== computeBuildId(root)) return `the web UI in ${path.dirname(index)} is out of date (it was built from other sources). ${BUILD_HINT}`;
  return null;
}
