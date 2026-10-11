import type { RGB } from '../shared/types';

export const PATTERNS = {
  sample: 'Sample Scene', rainbow: 'Rainbow', rgb: 'Red / Green / Blue', moving: 'Moving Light',
  corners: 'Corner Test', gradient: 'Brightness Gradient', identify: 'Zone Identification'
} as const;
export type Pattern = keyof typeof PATTERNS;

function hue(h: number): RGB {
  const f = (n: number) => { const k = (n + h * 6) % 6; return 255 * (1 - Math.max(0, Math.min(k, 4 - k, 1))); };
  return [f(5), f(3), f(1)];
}
/** A zone's place going once round the screen clockwise from the top-left corner, 0–1. Zone order: top, bottom, left, right. */
export function clockwise(zone: number, count: number): number {
  const n = count / 4, side = Math.floor(zone / n), t = (zone % n + .5) / n;
  return [t, 3 - t, 4 - t, 1 + t][side] / 4;
}

/** Zone Studio test signals: zone colours made from nothing but the zone layout and the clock. No picture is involved. */
export function testPattern(name: Pattern, count: number, seconds: number, selected: ReadonlySet<number> = new Set()): RGB[] {
  const n = count / 4;
  return Array.from({ length: count }, (_, zone): RGB => {
    const side = Math.floor(zone / n), t = (zone % n + .5) / n, p = clockwise(zone, count);
    if (name === 'sample') {
      // A calm picture to judge trims against: cool on the left, warm on the right, a little darker along the bottom.
      const x = side < 2 ? t : side - 2, y = side < 2 ? side : t, dim = 1 - .35 * y;
      return [(40 + 215 * x) * dim, (110 + 40 * x) * dim, (230 - 180 * x) * dim];
    }
    if (name === 'rainbow') return hue((p + seconds / 12) % 1);
    if (name === 'rgb') return [[255, 0, 0], [0, 255, 0], [0, 0, 255]][Math.floor(seconds / 1.5) % 3] as RGB;
    if (name === 'moving') {
      const gap = Math.abs(((p - seconds / 6) % 1 + 1.5) % 1 - .5), v = 255 * Math.exp(-((gap / .035) ** 2));
      return [v, v * .86, v * .62];
    }
    if (name === 'corners') {
      const near = t < .2 ? 0 : t > .8 ? 1 : -1;
      // Top-left red, top-right green, bottom-right blue, bottom-left yellow: each corner is lit by the two sides that meet there.
      const corner = near < 0 ? -1 : side === 0 ? near : side === 1 ? 3 - near : side === 2 ? (near ? 3 : 0) : near ? 2 : 1;
      return corner < 0 ? [0, 0, 0] : [[255, 40, 40], [40, 255, 40], [50, 90, 255], [255, 220, 40]][corner] as RGB;
    }
    if (name === 'gradient') { const v = 255 * t; return [v, v, v]; }
    const v = selected.has(zone) ? 200 + 55 * Math.sin(seconds * 5) : 0;
    return [v, v, v];
  });
}
