// The rules every state change in store.ts goes through, as pure functions so they can be tested without a page.
import type { Data, Version } from './types.ts';

/** The part of the page state the rules read and write. */
export type RuleState = {
  data: Data;
  viewId: string;
  selection: Set<string>;
  finalPlan: { plan: { versionId: string } } | null;
  notice: string | null;
};

export const versionOf = (id: string | null | undefined, s: RuleState): Version | undefined => (id ? s.data.versions.find((v) => v.id === id) : undefined);
/** The version on screen. A view id that the loaded state does not know yet (a version just created) shows HEAD meanwhile. */
export const viewedVersion = (s: RuleState): Version => (versionOf(s.viewId, s) ?? versionOf(s.data.head, s)) as Version;

/** Applies the rules to next (prev with patch applied) and returns the state to store. */
export function applyRules<S extends RuleState>(prev: S, next: S, patch: Partial<S>): S {
  // Only against the version the view id names: while it is not loaded yet, viewedVersion shows HEAD in its place, and
  // HEAD's scene must not prune a selection made in another version.
  const viewed = next.data && (next.data !== prev.data || next.viewId !== prev.viewId) ? versionOf(next.viewId, next) : undefined;
  if (viewed) {
    // Objects that are not in the viewed scene cannot stay selected (app.js renderObjects).
    const names = new Set(viewed.scene.nodes.map((n) => n.name));
    if ([...next.selection].some((s) => !names.has(s))) next = { ...next, selection: new Set([...next.selection].filter((s) => names.has(s))) };
    // The final render plan is for the version on screen only; switching versions closes it (#57).
    if (next.finalPlan && next.finalPlan.plan.versionId !== viewed.id) next = { ...next, finalPlan: null };
  }
  // The notice is done once its proposal is on screen or no longer a proposal.
  if (!('notice' in patch) && next.notice && next.data && (next.notice === viewedVersion(next)?.id || versionOf(next.notice, next)?.status !== 'proposed')) next = { ...next, notice: null };
  return next;
}
