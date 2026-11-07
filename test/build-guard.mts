// Build guard test: Director and mcp.mts refuse a missing or stale dist/ with instructions, RENDER_DIRECTOR_DEV skips
// the check, mcp.mts tells exit 2 (refused) from exit 3 (another Director holds the lock), and scripts/build.mts exits
// non-zero when vite is there but the build fails. Everything runs on a copy of the repository in a temp folder, so
// the real dist/ is only read. vork is a fake that answers `help` and `--version`: nothing is rendered.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distProblem, FIXED_INPUTS } from '../src/build-id.mts';

interface ToolResult { content: { type: string; text: string }[]; isError?: boolean }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problem = distProblem(ROOT);
if (problem) { console.log(`FAIL build-guard: the real dist/ does not match the sources (${problem})`); process.exit(1); }

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rd-guard-')));
const T = path.join(tmp, 'root');
for (const f of ['package.json', 'main.mts', 'server.mts', 'mcp.mts', 'mcp.mjs', 'src', 'scenes', 'web', 'scripts', ...FIXED_INPUTS])
  fs.cpSync(path.join(ROOT, f), path.join(T, f), { recursive: true });
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(T, 'node_modules'));
const DIST = path.join(T, 'dist');
const realDist = () => { fs.rmSync(DIST, { recursive: true, force: true }); fs.cpSync(path.join(ROOT, 'dist'), DIST, { recursive: true }); };

const BIN = path.join(tmp, 'bin'); fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'vork'), '#!/bin/sh\ncase "$1" in\n  --version) echo "vork 0.0.0-fake" ;;\n  help) echo "fake vork help" ;;\n  *) echo "fake vork: $1 is not supported" >&2; exit 1 ;;\nesac\n', { mode: 0o755 });
const ENV: NodeJS.ProcessEnv = { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, RENDER_DIRECTOR_NO_OPEN: '1' };
delete ENV.RENDER_DIRECTOR_DEV;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((ok) => { const srv = net.createServer().listen(0, '127.0.0.1', () => { const p = (srv.address() as { port: number }).port; srv.close(() => ok(p)); }); });
const children: ChildProcess[] = [];
process.on('exit', () => { for (const c of children) try { c.kill('SIGTERM'); } catch {} });

let pass = 0, failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e: any) { failures++; console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 4).join('\n     ')}`); }
}

/** Runs `node server.mts` in T until it exits or until server.json appears in runs (then leaves it running). */
async function director(args: string[], env: NodeJS.ProcessEnv, runsDir: string): Promise<{ code: number | null; stderr: string; proc: ChildProcess; url?: string }> {
  const proc = spawn(process.execPath, [path.join(T, 'server.mts'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(proc);
  let stderr = ''; proc.stderr!.on('data', (d) => { stderr += d; }); proc.stdout!.resume();
  let code: number | null | undefined; proc.on('exit', (c) => { code = c; });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (code !== undefined) return { code, stderr, proc };
    const f = path.join(runsDir, 'server.json');
    if (fs.existsSync(f)) { try { return { code: null, stderr, proc, url: JSON.parse(fs.readFileSync(f, 'utf8')).url }; } catch {} }
  }
  throw new Error(`Director neither exited nor started in 10 s; stderr:\n${stderr}`);
}
const stop = async (proc: ChildProcess) => { if (proc.exitCode !== null) return; const gone = new Promise((r) => proc.once('exit', r)); proc.kill('SIGTERM'); await gone; };

async function mcpCall(project: string, env: NodeJS.ProcessEnv = ENV): Promise<{ result: ToolResult; ms: number }> {
  const client = new Client({ name: 'build-guard-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(T, 'mcp.mts'), '--project', project], stderr: 'pipe', env: env as Record<string, string> }));
  const t0 = Date.now();
  try { const result = await client.callTool({ name: 'director_status', arguments: {} }) as unknown as ToolResult; return { result, ms: Date.now() - t0 }; }
  finally { await client.close(); }
}
const textOf = (r: ToolResult) => r.content.map((c) => c.text).join('\n');

await check('no dist/: server.mts exits 2 and tells to run npm install', async () => {
  fs.rmSync(DIST, { recursive: true, force: true });
  const runs = path.join(tmp, 'runs-nodist');
  const r = await director(['--port', String(await freePort())], { ...ENV, RENDER_DIRECTOR_RUNS: runs }, runs);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /not built/);
  assert.match(r.stderr, /npm install/); assert.match(r.stderr, /npm run build/);
});

await check('stale dist/ (rd-build differs): server.mts exits 2 and tells to run npm install', async () => {
  realDist();
  const index = path.join(DIST, 'index.html');
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace(/(name="rd-build" content=")[0-9a-f]{64}/, `$1${'0'.repeat(64)}`));
  const runs = path.join(tmp, 'runs-stale');
  const r = await director(['--port', String(await freePort())], { ...ENV, RENDER_DIRECTOR_RUNS: runs }, runs);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /out of date/); assert.match(r.stderr, /npm install/);
});

await check('a source edit after the build makes dist/ stale', async () => {
  realDist();
  const app = path.join(T, 'web', 'index.html'); const orig = fs.readFileSync(app, 'utf8');
  fs.writeFileSync(app, orig + '\n');
  try {
    const runs = path.join(tmp, 'runs-edited');
    const r = await director(['--port', String(await freePort())], { ...ENV, RENDER_DIRECTOR_RUNS: runs }, runs);
    assert.equal(r.code, 2, r.stderr); assert.match(r.stderr, /out of date/);
  } finally { fs.writeFileSync(app, orig); }
});

await check('a copy of the real dist/ matches the copied sources: Director starts and serves /', async () => {
  realDist();
  const runs = path.join(tmp, 'runs-ok');
  const r = await director(['--port', String(await freePort())], { ...ENV, RENDER_DIRECTOR_RUNS: runs }, runs);
  try {
    assert.equal(r.code, null, r.stderr);
    assert.doesNotMatch(r.stderr, /build check skipped/);
    const res = await fetch(`${r.url}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<meta name="rd-build" content="[0-9a-f]{64}">/);
  } finally { await stop(r.proc); }
});

await check('RENDER_DIRECTOR_DEV=1 without dist/: starts, warns once, / and static files are 404 with instructions', async () => {
  fs.rmSync(DIST, { recursive: true, force: true });
  const runs = path.join(tmp, 'runs-dev');
  const r = await director(['--port', String(await freePort())], { ...ENV, RENDER_DIRECTOR_RUNS: runs, RENDER_DIRECTOR_DEV: '1' }, runs);
  try {
    assert.equal(r.code, null, r.stderr);
    assert.equal(r.stderr.split('\n').filter((l) => l === 'build check skipped (RENDER_DIRECTOR_DEV)').length, 1, r.stderr);
    assert.match(r.stderr, /served by vite dev/);
    const root = await fetch(`${r.url}/`);
    assert.equal(root.status, 404);
    assert.match(await root.text(), /npm run dev/);
    const asset = await fetch(`${r.url}/assets/index.js`);
    assert.equal(asset.status, 404); // not 500: the missing root is caught before the path checks
  } finally { await stop(r.proc); }
});

await check('mcp.mts without dist/: returns the instructions as the tool error within 5 s', async () => {
  fs.rmSync(DIST, { recursive: true, force: true });
  const project = path.join(tmp, 'proj-nodist'); fs.mkdirSync(project);
  const { result, ms } = await mcpCall(project);
  assert.equal(result.isError, true, textOf(result));
  assert.match(textOf(result), /npm install/);
  assert.ok(ms < 5000, `took ${ms} ms`);
  assert.equal(fs.existsSync(path.join(project, '.vork', 'server.log')), false, 'refused before spawning');
});

await check('mcp.mts: a child that exits 2 (runs folder inside dist/) fails at once with the server.log tail', async () => {
  realDist();
  const project = path.join(DIST, 'x'); fs.mkdirSync(project);
  try {
    const { result, ms } = await mcpCall(project);
    assert.equal(result.isError, true, textOf(result));
    assert.match(textOf(result), /exit 2/);
    assert.match(textOf(result), /is inside .*served without a session/);
    assert.ok(ms < 5000, `took ${ms} ms`);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

await check('mcp.mts: a child that exits with another code (1: vork missing) fails at once with the server.log tail', async () => {
  realDist();
  const noVork = path.join(tmp, 'bin-novork'); fs.mkdirSync(noVork, { recursive: true });
  fs.writeFileSync(path.join(noVork, 'vork'), '#!/bin/sh\nexit 1\n', { mode: 0o755 }); // vorkInstalled() reads it as missing
  const project = path.join(tmp, 'proj-exit1'); fs.mkdirSync(project);
  const { result, ms } = await mcpCall(project, { ...ENV, PATH: `${noVork}${path.delimiter}${ENV.PATH}` });
  assert.equal(result.isError, true, textOf(result));
  assert.match(textOf(result), /exit 1/); assert.match(textOf(result), /vork not found/);
  assert.ok(ms < 5000, `took ${ms} ms (not the 15 s wait)`);
});

await check('mcp.mts does not read or write another file through server.log (symlink or hard link)', async () => {
  realDist();
  const secret = path.join(tmp, 'secret.txt'); const SECRET = 'do-not-leak-this-line';
  const noVork = path.join(tmp, 'bin-novork'); // the child exits 1 at once, so the error carries the log tail
  const env = { ...ENV, PATH: `${noVork}${path.delimiter}${ENV.PATH}` };
  // A symlink: the log is not opened through it, so the child is not started and nothing is appended to the target.
  fs.writeFileSync(secret, SECRET + '\n');
  const p1 = path.join(tmp, 'proj-symlog'); fs.mkdirSync(path.join(p1, '.vork'), { recursive: true });
  fs.symlinkSync(secret, path.join(p1, '.vork', 'server.log'));
  const r1 = (await mcpCall(p1, env)).result;
  assert.equal(r1.isError, true, textOf(r1)); assert.doesNotMatch(textOf(r1), new RegExp(SECRET));
  assert.equal(fs.readFileSync(secret, 'utf8'), SECRET + '\n', 'the symlink target is untouched');
  // A hard link (two links to one file): the tail is not read back into the error.
  const p2 = path.join(tmp, 'proj-hardlog'); fs.mkdirSync(path.join(p2, '.vork'), { recursive: true });
  fs.linkSync(secret, path.join(p2, '.vork', 'server.log'));
  const r2 = (await mcpCall(p2, env)).result;
  assert.equal(r2.isError, true, textOf(r2)); assert.match(textOf(r2), /not a plain file with one link/);
  assert.doesNotMatch(textOf(r2), new RegExp(SECRET));
});

await check('mcp.mts: server.log as a hard link is removed and the other file is not appended to', async () => {
  realDist();
  const other = path.join(tmp, 'other.txt'); fs.writeFileSync(other, 'other\n');
  const p = path.join(tmp, 'proj-hardlog2'); fs.mkdirSync(path.join(p, '.vork'), { recursive: true });
  const log = path.join(p, '.vork', 'server.log'); fs.linkSync(other, log);
  const r = (await mcpCall(p, { ...ENV, PATH: `${path.join(tmp, 'bin-novork')}${path.delimiter}${ENV.PATH}` })).result;
  assert.equal(r.isError, true, textOf(r)); assert.match(textOf(r), /not a plain file with one link/);
  await sleep(500); // a child, had one been started, would have written its error by now
  assert.equal(fs.readFileSync(other, 'utf8'), 'other\n', 'the other file is untouched');
  assert.equal(fs.statSync(other).nlink, 1, 'our name of it was removed');
  assert.equal(fs.existsSync(log), false);
});

await check('mcp.mts: server.log as a FIFO does not block the MCP process', async () => {
  realDist();
  const p = path.join(tmp, 'proj-fifolog'); fs.mkdirSync(path.join(p, '.vork'), { recursive: true });
  const mk = spawnSync('mkfifo', [path.join(p, '.vork', 'server.log')]); assert.equal(mk.status, 0, String(mk.stderr));
  const t0 = Date.now();
  const r = await Promise.race([mcpCall(p).then((x) => x.result), sleep(10000).then(() => null)]);
  assert.ok(r, `no answer in ${Date.now() - t0} ms`);
  assert.equal(r.isError, true, textOf(r));
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

await check('the runs folder check ignores letter case on macOS and Windows (dist/ missing, DEV)', async () => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') { console.log('     (skipped: case-sensitive platform)'); return; }
  fs.rmSync(DIST, { recursive: true, force: true });
  const runs = path.join(T, 'DIST', 'runs');
  const r = await director(['--port', String(await freePort())], { ...ENV, RENDER_DIRECTOR_RUNS: runs, RENDER_DIRECTOR_DEV: '1' }, runs);
  try { assert.equal(r.code, 2, r.stderr); assert.match(r.stderr, /is inside .*served without a session/); }
  finally { await stop(r.proc); fs.rmSync(path.join(T, 'DIST'), { recursive: true, force: true }); }
});

await check('the runs folder may not be inside dist.tmp or dist.old either (the next dist, or dist during a swap)', async () => {
  realDist();
  for (const d of ['dist.tmp', 'dist.old']) {
    const runs = path.join(T, d, 'x');
    try {
      const r = await director(['--port', String(await freePort())], { ...ENV, RENDER_DIRECTOR_RUNS: runs }, runs);
      try { assert.equal(r.code, 2, r.stderr); assert.match(r.stderr, new RegExp(`is inside .*${d.replace('.', '\\.')}, which is served without a session`)); }
      finally { await stop(r.proc); }
    } finally { fs.rmSync(path.join(T, d), { recursive: true, force: true }); }
  }
});

await check('mcp.mts: a child that exits 3 (another Director holds the lock) is not a failure', async () => {
  realDist();
  const project = path.join(tmp, 'proj-lock'); fs.mkdirSync(project);
  const vork = path.join(project, '.vork'), serverFile = path.join(vork, 'server.json'), log = path.join(vork, 'server.log');
  // 1. Director A holds the lock.
  const a = await director(['--project', project, '--port', String(await freePort())], ENV, vork);
  try {
    assert.equal(a.code, null, a.stderr);
    // 2. server.json points at a URL where ping fails, so mcp.mts spawns its own child.
    const good = fs.readFileSync(serverFile, 'utf8');
    fs.writeFileSync(serverFile, JSON.stringify({ ...JSON.parse(good), url: `http://127.0.0.1:${await freePort()}` }));
    // 4. Once the child has given up on the lock, put A's server.json back.
    let restored = false;
    const restore = (async () => {
      for (let i = 0; i < 150 && !restored; i++) {
        if (fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('already running')) { fs.writeFileSync(serverFile, good); restored = true; }
        else await sleep(100);
      }
    })();
    // 3. A fresh MCP process (no cached connection) calls a tool.
    const { result, ms } = await mcpCall(project);
    restored = true; await restore;
    // 5.
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(JSON.parse(result.content[0].text).director_url, JSON.parse(good).url);
    assert.match(fs.readFileSync(log, 'utf8'), /already running/);
    assert.ok(ms < 15000, `took ${ms} ms`);
  } finally { await stop(a.proc); }
});

await check('scripts/build.mts exits non-zero when vite is installed but the build fails', async () => {
  const main = path.join(T, 'web', 'src', 'main.tsx');
  fs.appendFileSync(main, '\nexport const broken = ;\n');
  const r = spawnSync(process.execPath, [path.join(T, 'scripts', 'build.mts')], { encoding: 'utf8', env: ENV });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.status === null, false, 'exited, not killed');
});

await check('scripts/build.mts exits 0 with a warning when the vite package is absent', async () => {
  const bare = path.join(tmp, 'bare');
  for (const f of ['scripts', 'src/build-id.mts']) fs.cpSync(path.join(ROOT, f), path.join(bare, f), { recursive: true });
  const r = spawnSync(process.execPath, [path.join(bare, 'scripts', 'build.mts')], { encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /vite is not installed/);
  assert.equal(fs.existsSync(path.join(bare, 'dist')), false);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
