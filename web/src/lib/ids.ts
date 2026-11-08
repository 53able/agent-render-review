import type { Ids } from './types.ts';

/**
 * Object name under a pointer, or null. (x, y) is the pointer position relative to the top-left of the displayed canvas,
 * (w, h) its displayed size in the same unit; the id buffer is addressed in render pixels.
 * Unlike public/app.js, positions outside the canvas (or a zero-sized one) return null instead of reading a wrapped index.
 */
export function pick(ids: Ids | null, x: number, y: number, w: number, h: number): string | null {
  if (!ids || !(w > 0) || !(h > 0)) return null;
  const px = Math.floor(x / w * ids.w), py = Math.floor(y / h * ids.h);
  if (!(px >= 0 && px < ids.w && py >= 0 && py < ids.h)) return null;
  return ids.objects[ids.arr[py * ids.w + px]] || null;
}
