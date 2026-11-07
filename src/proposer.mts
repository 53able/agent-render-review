// The built-in proposer of standalone mode: `claude -p` with a JSON schema turns the director's request into a scene.
import { run } from './vork.mts';
import { LIMITS } from './policy.mts';
import type { AgentOutput } from './policy.mts';
import type { Proposer } from './director.mts';

// cwd: where claude runs (the runs folder).
export function createClaudeProposer({ model: MODEL, vorkHelp: VORK_HELP, vorkVersion: VORK_VERSION, cwd }: { model: string; vorkHelp: string; vorkVersion: string; cwd: string }): Proposer {
  const PROPOSAL_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['interpretation', 'assumptions', 'clarifying_question', 'claimed_changes', 'scene'],
    properties: {
      interpretation: { type: 'string', description: 'One sentence: what you understood the director wants.' },
      assumptions: { type: 'array', items: { type: 'string' } },
      clarifying_question: { type: ['string', 'null'], description: 'Non-null only if the request is too ambiguous to act on safely.' },
      claimed_changes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['node', 'what', 'why'], properties: { node: { type: 'string' }, what: { type: 'string' }, why: { type: 'string' } } } },
      scene: { type: 'object', description: 'The complete revised vork scene (version 2).' },
    },
  };
  const SYSTEM = `You are the scene assistant inside "Render Director". A human director looks at renders and asks for changes.
You edit vork scene JSON (API v2). You do NOT render; the app renders and the director judges the image.
Rules:
- Return the COMPLETE revised scene in "scene". Keep every node "name" stable; give every new node a unique, non-empty name that does not start with "#".
- Change only what the request needs. If objects are SELECTED, scope changes to them unless the request clearly says otherwise.
- Never reference files, URLs or downloads. Do not add custom programs/shader code unless explicitly asked.
- Unknown fields are errors in vork; use only fields documented below. Keep resolution unchanged unless asked.
- If the request is ambiguous in a way that changes the result a lot, set clarifying_question and return the scene unchanged.
- claimed_changes must describe every edit you made. The app compares them with the real diff and shows mismatches.
vork reference (from \`vork help\`, ${VORK_VERSION}):
${VORK_HELP}`;

  return async (prompt, signal) => {
    const args = ['-p', '--model', MODEL, '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
      '--output-format', 'json', '--json-schema', JSON.stringify(PROPOSAL_SCHEMA), '--system-prompt', SYSTEM];
    const r = await run('claude', args, { timeout: LIMITS.agent, input: prompt, cwd, signal });
    if (signal.aborted) return null;
    if (r.code !== 0) throw new Error(r.timedOut ? 'agent timed out' : `claude exited ${r.code}: ${(r.stderr || r.stdout).slice(-600)}`);
    const env = JSON.parse(r.stdout) as { structured_output?: AgentOutput; result?: unknown; total_cost_usd?: number; duration_ms?: number };
    const out = env.structured_output ?? (typeof env.result === 'string' ? JSON.parse(env.result) : null);
    if (!out) throw new Error('agent returned no structured output');
    return { out, cost: env.total_cost_usd, ms: env.duration_ms };
  };
}
