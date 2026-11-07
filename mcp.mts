// MCP server for ADE agents (Claude Code, Codex, ...). Register it once per project:
//   claude mcp add vork -- node /path/to/vork-director/mcp.mjs --project .
// The agent writes vork scenes and sees renders; a human reviews, gives feedback and adopts in Director.
// The agent has no tool to accept, discard, approve a final render or approve an adoption.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { TextContent, ImageContent } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const i = argv.indexOf('--project');
const PROJECT = fs.realpathSync(path.resolve(i >= 0 ? argv[i + 1] : process.cwd()));
const SERVER_FILE = path.join(PROJECT, '.vork', 'server.json');
const log = (...a: unknown[]) => process.stderr.write(`[vork-mcp] ${a.join(' ')}\n`); // stdout is the MCP channel

interface Conn { url: string; agentToken: string; project?: string }
let conn: Conn | null = null;
async function ping(c: Conn) {
  try { const r = await fetch(`${c.url}/api/agent/status`, { headers: { authorization: `Bearer ${c.agentToken}` }, signal: AbortSignal.timeout(2000) }); return r.ok; }
  catch { return false; }
}
const readServerFile = () => { try { return JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8')); } catch { return null; } };

// Find a running Director for this project, or start one.
async function director() {
  if (conn && (await ping(conn))) return conn;
  const existing = readServerFile();
  if (existing && existing.project === PROJECT && (await ping(existing))) return (conn = existing);
  log('starting Director for', PROJECT);
  fs.mkdirSync(path.dirname(SERVER_FILE), { recursive: true });
  const out = fs.openSync(path.join(PROJECT, '.vork', 'server.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mts'), '--project', PROJECT], { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  for (let t = 0; t < 60; t++) {
    await new Promise((r) => setTimeout(r, 250));
    const s = readServerFile(); // our child, or another session's Director that won the lock
    if (s && s.project === PROJECT && (await ping(s))) return (conn = s);
  }
  throw new Error(`Director did not start; see ${path.join(PROJECT, '.vork', 'server.log')}`);
}

async function call(method: string, route: string, body?: unknown) {
  const c = await director();
  const r = await fetch(`${c.url}${route}`, {
    method, headers: { authorization: `Bearer ${c.agentToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(300_000),
  });
  const json: any = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, json, url: c.url };
}

const text = (t: unknown): TextContent => ({ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) });
const image = (file: string): ImageContent => ({ type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType: 'image/png' });
const fail = (msg: string, extra?: unknown) => ({ isError: true, content: [text(extra ? `${msg}\n${JSON.stringify(extra, null, 2)}` : msg)] });
interface RenderInfo { profile: string; seconds: number; width: number; height: number; exposure: { mean: number; clipped: number; near_black: number }; objects: string[]; warnings: string[]; file?: string }
const renderText = (r: RenderInfo | null | undefined) => r && {
  profile: r.profile, seconds: r.seconds, size: `${r.width}x${r.height}`,
  exposure: { mean: +r.exposure.mean.toFixed(3), clipped_pct: +(r.exposure.clipped * 100).toFixed(2), near_black_pct: +(r.exposure.near_black * 100).toFixed(2) },
  object_ids: r.objects, warnings: r.warnings,
};

const server = new McpServer({ name: 'vork-director', version: '0.2.0' });

server.registerTool('director_status', {
  annotations: { readOnlyHint: true },
  description: 'Show the Director URL the human should open, the current HEAD version and version history. Call this first in a session.',
  inputSchema: {},
}, async () => {
  const r = await call('GET', '/api/agent/status');
  return { content: [text({ ...r.json, director_url: r.url, note: 'Director opened a review tab for the human when it started. If they have none, call open_review_tab. The bare URL alone is not enough: the browser must be paired.' })] };
});

server.registerTool('open_review_tab', {
  annotations: { readOnlyHint: false, destructiveHint: false },
  description: 'Open a Director tab in the human\'s browser with a one-time pairing link (the link goes to the browser, not to you). Use when the human says they cannot see Director.',
  inputSchema: {},
}, async () => {
  const r = await call('POST', '/api/agent/open-tab', {});
  return r.ok ? { content: [text(r.json)] } : fail(r.json.error || `HTTP ${r.status}`);
});

server.registerTool('vork_help', {
  annotations: { readOnlyHint: true },
  description: 'Read vork documentation. No topic: the first page (scene format, node fields, conventions). Topics include materials, lights, cameras, geometry, std, render, limits. Use field to look up one exact field path.',
  inputSchema: { topic: z.string().regex(/^[a-z-]+$/).optional(), field: z.string().regex(/^[A-Za-z0-9_.\[\]]+$/).optional() },
}, async ({ topic, field }) => {
  const args = field ? ['help', 'field', field] : topic ? ['help', topic] : ['help'];
  const out = await new Promise<string>((ok) => execFile('vork', args, { maxBuffer: 4e6 }, (e, so, se) => ok(e ? `${so}${se}` : so)));
  return { content: [text(out)] };
});

server.registerTool('get_scene', {
  annotations: { readOnlyHint: true },
  description: 'Return the vork scene JSON of a version (default: HEAD). Start every change from this.',
  inputSchema: { version: z.string().regex(/^v\d{3}$/).optional() },
}, async ({ version }) => {
  const r = await call('GET', `/api/agent/scene${version ? `?version=${version}` : ''}`);
  return r.ok ? { content: [text(r.json)] } : fail(r.json.error || `HTTP ${r.status}`);
});

server.registerTool('propose_scene', {
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  description: [
    'Propose a complete revised vork scene (version 2). Director checks it against a policy (relative .glb/image files only, no custom shader programs, resolution <= 1920x1080, a unique non-empty name on every node, not starting with "#"),',
    'validates it with a previs render, stores it as a PROPOSED version (HEAD does not move) and renders a draft. The draft image is returned so you can inspect it.',
    'claimed_changes must list every edit; the human sees them next to the real diff. Then ask the human to review and call wait_for_feedback.',
  ].join(' '),
  inputSchema: {
    scene: z.record(z.string(), z.unknown()).describe('Complete vork scene JSON, version 2'),
    interpretation: z.string().min(1).max(4000).describe('One sentence: what you are trying to achieve'),
    claimed_changes: z.array(z.object({ node: z.string().max(200), what: z.string().max(1000), why: z.string().max(1000) })).max(50),
    assumptions: z.array(z.string().max(1000)).max(20).optional(),
    base: z.string().regex(/^v\d{3}$/).optional().describe('Version this builds on (default HEAD)'),
    responds_to: z.number().int().optional().describe('seq of the feedback event this proposal answers'),
  },
}, async (args) => {
  const r = await call('POST', '/api/agent/propose', args);
  if (!r.ok) return fail(`Proposal rejected (${r.json.error || r.status}). No version was created.`, { blockers: r.json.blockers, vork_log_tail: r.json.log?.slice(-1500) });
  const content: (TextContent | ImageContent)[] = [text({ version: r.json.version, status: r.json.status, head: r.json.head, diff: r.json.diff, flags: r.json.flags, render: renderText(r.json.render), render_error: r.json.renderError, review_url: r.url })];
  if (r.json.render?.file) content.push(image(r.json.render.file));
  return { content };
});

server.registerTool('get_render', {
  annotations: { readOnlyHint: true },
  description: 'Return the rendered image of a version (default HEAD) plus vork exposure measurements and object ids. previs/draft are rendered on demand; final exists only after a human approved it.',
  inputSchema: { version: z.string().regex(/^v\d{3}$/).optional(), profile: z.enum(['previs', 'draft', 'final']).optional() },
}, async ({ version, profile }) => {
  const q = new URLSearchParams(); if (version) q.set('version', version); if (profile) q.set('profile', profile);
  const r = await call('GET', `/api/agent/render?${q}`);
  if (!r.ok) return fail(r.json.error || `HTTP ${r.status}`, r.json.log ? { log: r.json.log.slice(-1500) } : undefined);
  return { content: [text({ version: r.json.version, status: r.json.status, render: renderText(r.json.render) }), image(r.json.render.file)] };
});

server.registerTool('wait_for_feedback', {
  annotations: { readOnlyHint: true },
  description: [
    'Wait for the human in Director. Returns events: feedback (comment + selected node names on a version), decision (accept/discard),',
    'direct_edit (the human changed a value themselves), adopted (an image was written into the project; asset path included), adoption_rejected.',
    'Returns {timeout:true} when nothing happened within timeout_sec; that is normal, call again or tell the human you are waiting.',
  ].join(' '),
  inputSchema: { timeout_sec: z.number().int().min(0).max(120).optional() },
}, async ({ timeout_sec }) => {
  const r = await call('GET', `/api/agent/feedback?wait=${timeout_sec ?? 60}`);
  return r.ok ? { content: [text(r.json)] } : fail(r.json.error || `HTTP ${r.status}`);
});

server.registerTool('request_adoption', {
  annotations: { readOnlyHint: false, destructiveHint: false },
  description: 'Ask the human to adopt a version into the project as <assetDir>/<slug>.png (default public/vork/). This only queues a request; the human approves or rejects it in Director. Learn the result with wait_for_feedback (event "adopted" carries the asset path to use in code). A second request for the same version and slug while one is pending is refused with the pending request id; at most 20 requests can be pending.',
  inputSchema: { version: z.string().regex(/^v\d{3}$/), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), reason: z.string().min(1).max(4000).describe('Why this candidate fits the page') },
}, async (args) => {
  const r = await call('POST', '/api/agent/adoption-request', args);
  return r.ok ? { content: [text({ ...r.json, review_url: r.url })] } : fail(r.json.error || `HTTP ${r.status}`);
});

await server.connect(new StdioServerTransport());
log('ready for', PROJECT);
