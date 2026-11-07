// Composition root: arguments, the runs folder and its lock, project config, wiring Director, HTTP and vork, listening
// and signals. `node server.mts` calls main().
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from './src/policy.mts';
import type { Scene } from './src/policy.mts';
import { createVorkRenderer, vorkInstalled } from './src/vork.mts';
import { createDirector } from './src/director.mts';
import { createClaudeProposer } from './src/proposer.mts';
import { createHttp } from './src/http.mts';
import { setupLogging, shutdownLogging, log, errFields } from './src/log.mts';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

export async function main(argv: string[]) {
  const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const PROJECT = arg('--project') ? fs.realpathSync(path.resolve(arg('--project')!)) : null;
  const MODE = PROJECT ? 'ade' : 'standalone';
  const RUNS = PROJECT ? path.join(PROJECT, '.vork') : path.resolve(process.env.RENDER_DIRECTOR_RUNS || path.join(ROOT, 'runs'));
  const MODEL = process.env.DIRECTOR_MODEL || 'sonnet';
  // Files under PUBLIC are served without a session, so RUNS (server.json, state.json) must not live there.
  // Checked before mkdir, on the real path of the nearest existing ancestor.
  // realpathSync.native returns the on-disk letter case, so PUBLIC/x is caught on case-insensitive file systems.
  const realish = (p: string): string => { let probe = p; while (!fs.existsSync(probe)) probe = path.dirname(probe); return path.join(fs.realpathSync.native(probe), path.relative(probe, p)); };
  const runsReal = realish(RUNS), publicReal = fs.realpathSync.native(PUBLIC);
  if (runsReal === publicReal || runsReal.startsWith(publicReal + path.sep)) { console.error(`refusing to start: the runs folder ${RUNS} is inside ${PUBLIC}, which is served without a session`); process.exit(2); }
  fs.mkdirSync(RUNS, { recursive: true });
  const LOCK = path.join(RUNS, 'lock');
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; } };
  for (;;) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); break; }
    catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      const other = Number(fs.readFileSync(LOCK, 'utf8'));
      if (other && other !== process.pid && alive(other)) { console.error(`Director is already running for ${RUNS} (pid ${other})`); process.exit(3); }
      // Stale lock. Only one starter can rename it away; if what we grabbed is a fresh lock, put it back.
      const grab = `${LOCK}.${process.pid}.stale`;
      try { fs.renameSync(LOCK, grab); } catch { continue; }
      if (Number(fs.readFileSync(grab, 'utf8')) !== other) { try { fs.linkSync(grab, LOCK); } catch {} }
      fs.rmSync(grab, { force: true });
    }
  }
  process.on('exit', () => { try { if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.rmSync(LOCK); } catch {} });
  // Logging starts once this process owns RUNS: a second Director must not write to the first one's log.
  // The console.error calls above stay: they run before logging exists and are meant for people.
  setupLogging({ dir: RUNS });
  const L = log('main');
  // A monitor only observes: Node still prints the error and exits with code 1.
  process.on('uncaughtExceptionMonitor', (e, origin) => L.fatal('director.fatal', 'Director crashed', { origin, ...errFields(e) }));
  process.on('exit', shutdownLogging);

  const vork = vorkInstalled();
  if (!vork) {
    console.error('vork not found on PATH. Install it first: https://github.com/voyager-so/vork');
    L.fatal('director.fatal', 'vork not found on PATH', { origin: 'vork', errorType: 'VorkNotFound' });
    process.exit(1);
  }
  const { help: VORK_HELP, version: VORK_VERSION } = vork;

  if (PROJECT) {
    if (!fs.existsSync(path.join(RUNS, 'config.json'))) fs.writeFileSync(path.join(RUNS, 'config.json'), JSON.stringify(DEFAULT_CONFIG, null, 2));
    if (!fs.existsSync(path.join(RUNS, '.gitignore'))) fs.writeFileSync(path.join(RUNS, '.gitignore'), '*\n!.gitignore\n!config.json\n!adopted/\n!adopted/**\n');
  }

  // Scene file references are relative to the project, or to scenes/ in standalone mode.
  const renderer = createVorkRenderer({ assetBase: PROJECT || path.join(ROOT, 'scenes'), version: VORK_VERSION });
  const starter = JSON.parse(fs.readFileSync(path.join(ROOT, 'scenes', 'starter.json'), 'utf8')) as Scene;
  const proposer = PROJECT ? undefined : createClaudeProposer({ model: MODEL, vorkHelp: VORK_HELP, vorkVersion: VORK_VERSION, cwd: RUNS });
  const director = createDirector({ runs: RUNS, project: PROJECT, renderer, starter, proposer });

  const web = createHttp({ director, root: ROOT, publicDir: PUBLIC, vorkVersion: VORK_VERSION, model: MODEL, port: Number(arg('--port') || process.env.PORT || 4747) });

  // Listen; in ADE mode try the next ports if busy, then publish the address for mcp.mts.
  const { server } = web;
  const listen = (port: number) => new Promise<void>((ok, bad) => { server.once('error', bad); server.listen(port, '127.0.0.1', () => { server.off('error', bad); ok(); }); });
  for (let attempt = 0; ; attempt++) {
    try { await listen(web.port); break; }
    catch (e: any) { if (e.code !== 'EADDRINUSE' || !PROJECT || attempt >= 20) throw e; web.port++; }
  }
  const SERVER_FILE = path.join(RUNS, 'server.json');
  fs.writeFileSync(SERVER_FILE, JSON.stringify({ url: `http://127.0.0.1:${web.port}`, pid: process.pid, agentToken: web.agentToken, project: PROJECT, mode: MODE, started: new Date().toISOString() }, null, 2), { mode: 0o600 });
  L.info('director.start', 'Director started', { mode: MODE, port: web.port, vorkVersion: VORK_VERSION, pid: process.pid });
  const cleanup = (signal: NodeJS.Signals) => {
    try { const s = JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8')) as { pid?: number }; if (s.pid === process.pid) fs.rmSync(SERVER_FILE); } catch {}
    L.info('director.stop', 'Director stopped', { signal });
    shutdownLogging(); process.exit(0);
  };
  process.on('SIGINT', cleanup); process.on('SIGTERM', cleanup); process.on('SIGHUP', cleanup);
  process.on('SIGUSR1', () => { web.rotatePair(); web.openPairing(); });
  web.openPairing();
  console.log(`Render Director on http://127.0.0.1:${web.port}  mode=${MODE}${PROJECT ? `  project=${PROJECT}` : ''}  (${VORK_VERSION}${MODE === 'standalone' ? `, built-in agent: claude ${MODEL}` : ''})`);
}
