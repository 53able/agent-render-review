// The checks the review panel shows next to the agent's own account: which changes it claimed, how the diff groups,
// which objects the list shows. Pure functions without the DOM, so test/review-model.mts can test them (#48).

/** @typedef {{ node: string, path: string, before?: unknown, after?: unknown }} Diff */
/** @typedef {{ node: string, what: string, why: string }} Claim */
/** @typedef {{ stem: string, count: number, first: string, last: string }} NameRun */

/**
 * "b*" claims every changed node whose name starts with "b"; a bare "*" stays a literal name, so one claim cannot
 * cover everything.
 * @param {string} c
 */
export const isWildcard = (c) => c.length > 1 && c.endsWith('*');

/**
 * A name without its trailing digits: the part that numbered copies (b0 … b3999) share.
 * @param {string} name
 */
export const nameStem = (name) => name.replace(/\d+$/, '');

/**
 * Names grouped by stem, in the order they first appear: b0, b1, backdrop → b0…b1 (2), backdrop (1).
 * @param {string[]} names
 * @returns {NameRun[]}
 */
export function nameRuns(names) {
  /** @type {Map<string, NameRun>} */
  const runs = new Map();
  for (const n of names) {
    const stem = nameStem(n); const r = runs.get(stem);
    if (r) { r.count++; r.last = n; } else runs.set(stem, { stem, count: 1, first: n, last: n });
  }
  return [...runs.values()];
}

/**
 * One line for a list of names: "b0 … b3999 (4000), backdrop". At most max runs are named; the rest are counted.
 * @param {string[]} names
 * @param {number} [max]
 */
export function describeNames(names, max = 4) {
  const runs = nameRuns(names);
  const shown = runs.slice(0, max).map((r) => (r.count === 1 ? r.first : `${r.first} … ${r.last} (${r.count})`));
  const rest = runs.slice(max).reduce((n, r) => n + r.count, 0);
  return shown.join(', ') + (rest ? `, +${rest} more` : '');
}

/**
 * Scene-level keys (render, animation, …) appear in the diff as "(scene)" with the key as path head.
 * @param {Diff} d
 */
export const keyOf = (d) => (d.node === '(scene)' ? d.path.split(/[.[]/)[0] : d.node);

/**
 * Compares the agent's claimed changes with the computed diff.
 * - isClaimed(d): whether a diff row is covered by a claim
 * - wildMatches: for each "prefix*" claim, the changed node names it covers (#36), so the human sees what it hides (#47)
 * - ghost: claims that match no change
 * @param {Claim[]} claims
 * @param {Diff[]} diff
 */
export function checkClaims(claims, diff) {
  const claimed = new Set(claims.map((c) => c.node));
  const prefixes = [...claimed].filter(isWildcard).map((c) => c.slice(0, -1));
  /** @param {Diff} d */
  const isClaimed = (d) => claimed.has(d.node) || claimed.has(keyOf(d)) || (d.node === '(scene)' && claimed.has('scene')) || (d.node !== '(scene)' && prefixes.some((x) => d.node.startsWith(x)));
  const changedKeys = new Set(diff.map(keyOf));
  const changedNodes = [...new Set(diff.map((d) => d.node).filter((n) => n !== '(scene)'))];
  /** @type {Map<string, string[]>} */
  const wildMatches = new Map([...claimed].filter(isWildcard).map((c) => [c, changedNodes.filter((n) => n.startsWith(c.slice(0, -1)))]));
  const ghost = [...claimed].filter((n) => (isWildcard(n) ? !wildMatches.get(n)?.length : !changedKeys.has(n) && !(n === 'scene' && diff.some((d) => d.node === '(scene)'))));
  return { isClaimed, wildMatches, ghost };
}

/**
 * Large scenes produce thousands of rows: node additions and removals collapse into one group per (type, added|removed),
 * in diff order; every other row stays in rest.
 * @param {Diff[]} diff
 * @param {Map<string, string | undefined>} typeOf node name → type, from the parent and the version
 */
export function groupDiff(diff, typeOf) {
  /** @type {Map<string, { type: string, kind: string, ds: Diff[] }>} */
  const groups = new Map(); /** @type {Diff[]} */ const rest = [];
  for (const d of diff) {
    if (d.path !== '(node)') { rest.push(d); continue; }
    const type = String(typeOf.get(d.node) || 'node'), kind = d.after === 'removed' ? 'removed' : 'added';
    const k = JSON.stringify([type, kind]); const g = groups.get(k); if (g) g.ds.push(d); else groups.set(k, { type, kind, ds: [d] });
  }
  return { groups: [...groups.values()], rest };
}
