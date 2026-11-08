import type { Version } from './types.ts';

/** Indent level (0-3) of a version: the number of ancestors on the way up that have more than one non-discarded child. */
export function depth(v: Version, versions: Version[]): number {
  const byId = (id: string) => versions.find((x) => x.id === id);
  let d = 0, p: Version | undefined = v;
  while (p?.parent && d < 3) {
    const parent = byId(p.parent);
    if (parent && versions.filter((x) => x.parent === parent.id && x.status !== 'discarded').length > 1) d++;
    p = parent;
  }
  return d;
}
