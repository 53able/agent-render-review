import type { Diff, SceneNode } from './types.ts';

/** "b*" claims every changed node whose name starts with "b"; a bare "*" stays a literal name so one claim cannot cover everything. */
export const isWildcard = (c: string): boolean => c.length > 1 && c.endsWith('*');

export type DiffGroup = { type: string; kind: 'added' | 'removed'; ds: Diff[] };

/**
 * Large scenes produce thousands of rows: node additions/removals ("(node)" path) collapse into one group per (type, added|removed); everything else stays in `rest`.
 * `parentNodes` and `nodes` supply the node type (later entries win, so the current scene overrides the parent); unknown nodes are typed 'node'.
 */
export function groupDiffs(diff: Diff[], parentNodes: SceneNode[], nodes: SceneNode[]): { groups: DiffGroup[]; rest: Diff[] } {
  const typeOf = new Map([...parentNodes, ...nodes].map((n) => [n.name, n.type]));
  const groups = new Map<string, DiffGroup>();
  const rest: Diff[] = [];
  for (const d of diff) {
    if (d.path !== '(node)') { rest.push(d); continue; }
    const type = String(typeOf.get(d.node) || 'node'), kind = d.after === 'removed' ? 'removed' : 'added';
    const k = JSON.stringify([type, kind]); const g = groups.get(k);
    if (g) g.ds.push(d); else groups.set(k, { type, kind, ds: [d] });
  }
  return { groups: [...groups.values()], rest };
}

/** Scene-level keys (render, animation, ...) appear in the diff as "(scene)" with the key as path head. */
export const keyOf = (d: Diff): string => (d.node === '(scene)' ? d.path.split(/[.[]/)[0] : d.node);

export type ClaimCheck = {
  /** Whether the agent's claimed nodes cover this diff row (exact node, scene key, "scene", or a "prefix*" wildcard). */
  isClaimed: (d: Diff) => boolean;
  /** Per wildcard claim, how many changed nodes it matches. */
  wildCount: Map<string, number>;
  /** Claims that changed nothing: wildcards matching no changed node, plain names absent from the diff ("scene" counts as changed when any "(scene)" row exists). */
  ghost: string[];
};

/** Compares what the agent claims it changed (proposal.claimed_changes[].node) with what the diff shows. Duplicate claims collapse, order of first claim is kept. */
export function checkClaims(claimed: string[], diff: Diff[]): ClaimCheck {
  const claimedNodes = new Set(claimed);
  const prefixes = [...claimedNodes].filter(isWildcard).map((c) => c.slice(0, -1));
  const isClaimed = (d: Diff): boolean => claimedNodes.has(d.node) || claimedNodes.has(keyOf(d)) || (d.node === '(scene)' && claimedNodes.has('scene')) || (d.node !== '(scene)' && prefixes.some((x) => d.node.startsWith(x)));
  const changedKeys = new Set(diff.map(keyOf));
  const changedNodes = [...new Set(diff.map((d) => d.node).filter((n) => n !== '(scene)'))];
  const wildCount = new Map([...claimedNodes].filter(isWildcard).map((c): [string, number] => [c, changedNodes.filter((n) => n.startsWith(c.slice(0, -1))).length]));
  const ghost = [...claimedNodes].filter((n) => (isWildcard(n) ? !wildCount.get(n) : !changedKeys.has(n) && !(n === 'scene' && diff.some((d) => d.node === '(scene)'))));
  return { isClaimed, wildCount, ghost };
}
