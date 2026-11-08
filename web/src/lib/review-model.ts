// The checks the review panel shows next to the agent's own account: which changes it claimed, how the diff groups,
// which objects the list shows. Pure functions without the DOM, so test/review-model.mts can test them (#48).
// Ported from public/review-model.js when public/ was removed.
import type { Diff } from './types.ts';

export type Claim = { node: string; what: string; why: string };
export type NameRun = { stem: string; count: number; first: string; last: string };

/** "b*" claims every changed node whose name starts with "b"; a bare "*" stays a literal name, so one claim cannot cover everything. */
export const isWildcard = (c: string): boolean => c.length > 1 && c.endsWith('*');

/** A name without its trailing digits: the part that numbered copies (b0 … b3999) share. */
export const nameStem = (name: string): string => name.replace(/\d+$/, '');

/** Names grouped by stem, in the order they first appear: b0, b1, backdrop → b0…b1 (2), backdrop (1). */
export function nameRuns(names: string[]): NameRun[] {
  const runs = new Map<string, NameRun>();
  for (const n of names) {
    const stem = nameStem(n); const r = runs.get(stem);
    if (r) { r.count++; r.last = n; } else runs.set(stem, { stem, count: 1, first: n, last: n });
  }
  return [...runs.values()];
}

/** One line for a list of names: "b0 … b3999 (4000), backdrop". At most max runs are named; the rest are counted. */
export function describeNames(names: string[], max = 4): string {
  const runs = nameRuns(names);
  const shown = runs.slice(0, max).map((r) => (r.count === 1 ? r.first : `${r.first} … ${r.last} (${r.count})`));
  const rest = runs.slice(max).reduce((n, r) => n + r.count, 0);
  return shown.join(', ') + (rest ? `, +${rest} more` : '');
}

/** Scene-level keys (render, animation, …) appear in the diff as "(scene)" with the key as path head. */
export const keyOf = (d: Diff): string => (d.node === '(scene)' ? d.path.split(/[.[]/)[0]! : d.node);

/**
 * Compares the agent's claimed changes with the computed diff.
 * - isClaimed(d): whether a diff row is covered by a claim
 * - wildMatches: for each "prefix*" claim, the changed node names it covers (#36), so the human sees what it hides (#47)
 * - ghost: claims that match no change
 */
export function checkClaims(claims: Claim[], diff: Diff[]): { isClaimed: (d: Diff) => boolean; wildMatches: Map<string, string[]>; ghost: string[] } {
  const claimed = new Set(claims.map((c) => c.node));
  const prefixes = [...claimed].filter(isWildcard).map((c) => c.slice(0, -1));
  const isClaimed = (d: Diff): boolean => claimed.has(d.node) || claimed.has(keyOf(d)) || (d.node === '(scene)' && claimed.has('scene')) || (d.node !== '(scene)' && prefixes.some((x) => d.node.startsWith(x)));
  const changedKeys = new Set(diff.map(keyOf));
  const changedNodes = [...new Set(diff.map((d) => d.node).filter((n) => n !== '(scene)'))];
  const wildMatches = new Map([...claimed].filter(isWildcard).map((c): [string, string[]] => [c, changedNodes.filter((n) => n.startsWith(c.slice(0, -1)))]));
  const ghost = [...claimed].filter((n) => (isWildcard(n) ? !wildMatches.get(n)?.length : !changedKeys.has(n) && !(n === 'scene' && diff.some((d) => d.node === '(scene)'))));
  return { isClaimed, wildMatches, ghost };
}

/**
 * Large scenes produce thousands of rows: node additions and removals collapse into one group per (type, added|removed),
 * in diff order; every other row stays in rest. typeOf: node name → type, from the parent and the version.
 */
export function groupDiff(diff: Diff[], typeOf: Map<string, string | undefined>): { groups: { type: string; kind: string; ds: Diff[] }[]; rest: Diff[] } {
  const groups = new Map<string, { type: string; kind: string; ds: Diff[] }>(); const rest: Diff[] = [];
  for (const d of diff) {
    if (d.path !== '(node)') { rest.push(d); continue; }
    const type = String(typeOf.get(d.node) || 'node'), kind = d.after === 'removed' ? 'removed' : 'added';
    const k = JSON.stringify([type, kind]); const g = groups.get(k); if (g) g.ds.push(d); else groups.set(k, { type, kind, ds: [d] });
  }
  return { groups: [...groups.values()], rest };
}

/**
 * The objects the list shows: those matching filter (case-insensitive, by name), at most cap of them, plus every
 * pinned (selected) match past the cap, which comes first so a selection made in the image is visible in the list (#46).
 * pin: the names to keep listed (the selection, and what was selected since the list was built).
 * Returns pinned: the selected matches past the cap.
 */
export function visibleObjects<N extends { name: string }>(nodes: N[], filter: string, pin: Set<string>, cap: number): { shown: N[]; pinned: string[]; rest: number; matches: number } {
  const f = filter.trim().toLowerCase();
  const matches = nodes.filter((n) => n.name && n.name.toLowerCase().includes(f));
  const head = matches.slice(0, cap); const extra = matches.slice(cap).filter((n) => pin.has(n.name));
  return { shown: [...extra, ...head], pinned: extra.map((n) => n.name), rest: matches.length - head.length - extra.length, matches: matches.length };
}
