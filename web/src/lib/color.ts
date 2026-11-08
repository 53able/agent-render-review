// linear <-> sRGB for colour pickers (vork colours are linear Rec.709)
export const toS = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
export const toL = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const linToHex = (rgb: number[]): string => '#' + rgb.map((c) => Math.round(Math.min(1, Math.max(0, toS(c))) * 255).toString(16).padStart(2, '0')).join('');
export const hexToLin = (h: string): number[] => [1, 3, 5].map((i) => +toL(parseInt(h.slice(i, i + 2), 16) / 255).toFixed(4));
export const isColor = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && n >= 0 && n <= 1.5);
