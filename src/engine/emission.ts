import type { ColorSettings, GlowSettings, Rect, RGB } from '../shared/types';
import { clamp } from '../shared/settings';
import { drive as toneDrive, shoulder } from './color2';

const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };

/** Scene colour → virtual LED: its hue at full strength, plus how hard it is driven (0–1). A dark scene drives nothing. */
export function emission(rgb: RGB, curve: number, color?: ColorSettings | null): [number, number, number, number] {
  const peak = Math.max(rgb[0], rgb[1], rgb[2]) / 255;
  const drive = toneDrive(peak, curve, color);
  return drive > 0 ? [rgb[0] / peak, rgb[1] / peak, rgb[2] / peak, drive] : [0, 0, 0, 0];
}

// Zone order: top L→R, bottom L→R, left T→B, right T→B. Around the screen the edge is one ring: top L→R, right T→B,
// bottom R→L, left B→T. `around` is the zone found `j` zones along a side, also past its ends, where the ring carries on
// into the neighbouring side. j = −1 and j = n are the two zones a side meets at its corners.
function around(side: number, j: number, n: number): number {
  const ring = 4 * n, p = (((side === 0 ? j : side === 3 ? n + j : side === 1 ? 3 * n - 1 - j : ring - 1 - j) % ring) + ring) % ring;
  return p < n ? p : p < 2 * n ? 2 * n + p : p < 3 * n ? 4 * n - 1 - p : 6 * n - 1 - p;
}

/** Glow Designer: how far colours run into each other along the edge, as a Gaussian sigma in zones. 0 = not at all. */
export function alongBlur(glow: GlowSettings | null | undefined, n: number): number {
  if (!glow) return 0;
  const share = glow.style === 'halo' ? .02 + .08 * glow.softness / 100 : .05 * Math.max(0, glow.softness - 50) / 50;
  return share * n;
}

/**
 * One side's zones → `length` straight-alpha RGBA samples along that edge.
 * Quadratic B-spline over light (colour × opacity): no visible zone borders, no overshoot, dark zones never tint bright ones.
 * `trim` scales single zones (Zone Studio): 0 switches a zone off, and its neighbours fade into it like into a dark scene.
 * `color` is the Color Engine 2.0 tone mapping (none = the curve and the clipping of 0.8).
 * `blur` (Glow Designer) lets the light of each zone run into its neighbours, around the corners too. A zone switched
 * off stays off.
 * `lift` (Pulse Engine), per zone 0–1: takes a lit zone's opacity that far from where the tone curve leaves it toward
 * full. A zone that is hardly lit is hardly lifted, and a dark one not at all: this never paints where there is no light.
 */
export function ledRow(colors: RGB[], side: number, length: number, gain: number, curve: number,
  out = new Uint8ClampedArray(length * 4), trim?: ArrayLike<number>, color?: ColorSettings | null, blur = 0, lift?: ArrayLike<number> | null): Uint8ClampedArray {
  const n = colors.length / 4, reach = blur > .01 ? Math.ceil(blur * 2.5) : 0, first = -1 - reach, cells = n + 2 + 2 * reach;
  let leds = new Float32Array(cells * 4);
  for (let c = 0; c < cells; c++) {
    const zone = around(side, first + c, n);
    const [r, g, b, drive] = emission(colors[zone], curve, color);
    const toned = shoulder(drive * gain * (trim ? trim[zone] : 1), color);
    const a = lift && lift[zone] > 0 ? toned + (1 - toned) * lift[zone] * Math.min(1, toned * 4) : toned;
    leds.set([r * a, g * a, b * a, a], c * 4);
  }
  if (reach) {
    const weights = Float32Array.from({ length: 2 * reach + 1 }, (_, i) => Math.exp(-.5 * ((i - reach) / blur) ** 2));
    const total = weights.reduce((sum, w) => sum + w, 0), soft = new Float32Array((n + 2) * 4);
    for (let j = 0; j < n + 2; j++) {
      if (trim && trim[around(side, j - 1, n)] === 0) continue;
      for (let i = 0; i <= 2 * reach; i++)
        for (let k = 0; k < 4; k++) soft[j * 4 + k] += leds[(j + i) * 4 + k] * weights[i] / total;
    }
    leds = soft;
  }
  for (let i = 0; i < length; i++) {
    const x = (i + .5) / length * n - .5, c = Math.round(x), u = x - c, at = (c + 1) * 4;
    const w0 = .5 * (.5 - u) ** 2, w1 = .75 - u * u, w2 = .5 * (.5 + u) ** 2;
    const a = leds[at - 1] * w0 + leds[at + 3] * w1 + leds[at + 7] * w2;
    for (let k = 0; k < 3; k++)
      out[i * 4 + k] = a > 0 ? (leds[at - 4 + k] * w0 + leds[at + k] * w1 + leds[at + 4 + k] * w2) / a : 0;
    out[i * 4 + 3] = a * 255;
  }
  return out;
}

/** Edge Light with every slider in the middle, or no Glow Designer at all: the shape of 0.9.0, computed exactly as it was. */
export const isClassicGlow = (glow?: GlowSettings | null) => !glow || glow.style === 'edge' && glow.thickness === 50 && glow.curve === 50 && glow.falloff === 50 && glow.softness === 50;
// A slider's middle leaves its factor at 1; its ends halve and double it (thickness: quarter and fourfold).
const factor = (value: number, range = 50) => 2 ** ((value - 50) / range);
/** Soft Halo never reaches full opacity: it is indirect light. */
export const HALO_PEAK = .8;
/** How wide the strip at full strength is, as a share of the glow's depth. Soft Halo has none. */
export const glowStrip = (strip: number, glow?: GlowSettings | null) => !glow ? strip : glow.style === 'halo' ? 0 : strip * factor(glow.thickness, 25);

/**
 * Opacity across the glow, from the screen edge (t = 0) to its inner limit (t = 1).
 * Edge Light: a thin strip at full strength, a tight bloom hugging it, then a wide halo that thins out toward the picture.
 * Soft Halo: no strip at all, one soft lobe that starts at full strength on the edge.
 * Glow Designer shapes either one. `thickness`: how wide the part at full strength is. `curve`: the shape of the fall,
 * from a spike with a long tail to a shoulder that holds and then drops. `falloff`: how soon the light is gone.
 * `softness`: how gently the strip ends (and, along the edge, how far colours run together: see `alongBlur`).
 * Whatever the sliders say, the light is strongest on the edge and never grows toward the picture.
 */
export function glowProfile(t: number, strip: number, spread: number, glow?: GlowSettings | null): number {
  const fade = 1 - smooth(.5, 1, t);
  if (isClassicGlow(glow)) {
    const core = 1 - smooth(strip, strip * 2.4, t), d = Math.max(0, t - strip);
    const bloom = .5 * Math.exp(-d / (.024 + .034 * spread)), halo = (.3 + .4 * spread) * Math.exp(-d / (.13 + .25 * spread));
    return core + (1 - core) * Math.min(1, bloom + halo) * fade;
  }
  const g = glow!, shape = factor(g.curve);
  if (g.style === 'halo') {
    // No strip and no full strength: a wash that is brightest on the edge and thins out slowly, with a long tail.
    const d = Math.max(0, t - strip * Math.max(0, factor(g.thickness, 25) - .25)) * factor(g.falloff);
    return HALO_PEAK / (1 + (d / (.11 + .17 * spread)) ** (1.7 * shape)) * fade;
  }
  const width = strip * factor(g.thickness, 25), d = Math.max(0, t - width) * factor(g.falloff);
  const core = 1 - smooth(width, width * (1 + 1.4 * factor(g.softness)), t);
  const bloom = .5 * Math.exp(-((d / (.024 + .034 * spread)) ** shape)), halo = (.3 + .4 * spread) * Math.exp(-((d / (.13 + .25 * spread)) ** shape));
  return core + (1 - core) * Math.min(1, bloom + halo) * fade;
}

/** Both sides light a corner. Easing each one off there keeps the corner as bright as the rest of the edge. */
export function cornerTaper(distance: number, depth: number): number {
  return .62 + .38 * smooth(0, depth, distance);
}

export type FilterPrimitive = { tag: string; children?: FilterPrimitive[] } & Record<string, string | number | FilterPrimitive[] | undefined>;

/**
 * The compositor-only light, as SVG filter primitives applied to the page behind a layer. Script never sees a pixel.
 *
 * Each edge band is blurred hard toward the picture and only slightly along the edge, so every point of the screen edge
 * averages the strip of picture facing it: a zone, in effect. The deep blur is also what carries colour across black bars
 * baked into a protected stream: those cannot be detected without reading pixels, so they are bridged rather than cropped.
 * Top/bottom and left/right are separate filters for separate layers, so they overlap in the corners as two lights would.
 */
export function edgeFilters(o: { width: number; height: number; depth: number; picture: Rect; curve: number; saturation: number }): { rows: FilterPrimitive[]; columns: FilterPrimitive[]; span: { rows: number[]; columns: number[] } } {
  const { width: w, height: h, depth: d, picture: p } = o, step = (v: number) => Math.round(v / 8) * 8;
  // Known gaps (page layout, letterboxing done by the player) are simply skipped: the band starts where the picture does.
  const gap = { top: Math.round(clamp(p.y, 0, h)), bottom: Math.round(clamp(h - p.y - p.height, 0, h)),
    left: Math.round(clamp(p.x, 0, w)), right: Math.round(clamp(w - p.x - p.width, 0, w)) };
  // Reach about a quarter of the picture inward; smooth only a little along the edge, roughly a zone's width.
  const reachY = step(clamp(p.height * .24, 48, h * .5)), reachX = step(clamp(p.width * .16, 48, w * .4));
  const alongX = step(clamp(w * .02, 12, 48)), alongY = step(clamp(h * .02, 12, 48));
  // Light only the stretch of edge that faces the picture, so the page beside a small player does not colour the glow.
  const x0 = Math.max(0, gap.left - alongX * 2), x1 = Math.min(w, w - gap.right + alongX * 2);
  const y0 = Math.max(0, gap.top - alongY * 2), y1 = Math.min(h, h - gap.bottom + alongY * 2);
  const band = (result: string, dx: number, dy: number, deviation: string, x: number, y: number, width: number, height: number): FilterPrimitive[] => {
    const moved: FilterPrimitive[] = dx || dy ? [{ tag: 'feOffset', in: 'SourceGraphic', dx, dy, result: `${result}Source` }] : [];
    return [...moved, { tag: 'feGaussianBlur', in: moved.length ? `${result}Source` : 'SourceGraphic', stdDeviation: deviation,
      x, y, width: Math.max(1, width), height: Math.max(1, height), result }];
  };
  // Blurring spreads the picture over the bars and thins it out, so mid-tones are lifted; a toe keeps dark scenes dark.
  const lift = .56 * o.curve, toe = .04 + .055 * o.curve;
  const tableValues = Array.from({ length: 17 }, (_, i) => ((i / 16) ** lift * (1 - Math.exp(-i / 16 / toe))).toFixed(3)).join(' ');
  // One channel spread over R, G and B (opaque), so that `lighten` across the three leaves the brightest channel.
  const channel = (index: number, result: string): FilterPrimitive => {
    const row = [0, 0, 0, 0, 0].map((_, i) => +(i === index)).join(' ');
    return { tag: 'feColorMatrix', in: 'colour', type: 'matrix', values: `${row} ${row} ${row} 0 0 0 0 1`, result };
  };
  const light = (near: FilterPrimitive[], far: FilterPrimitive[]): FilterPrimitive[] => [...near, ...far,
    { tag: 'feMerge', result: 'bands', children: [near, far].map(side => ({ tag: 'feMergeNode', in: side[side.length - 1].result })) },
    // A blur next to the screen edge is partly transparent. Restoring full alpha keeps the colour and removes the dimming.
    { tag: 'feComponentTransfer', in: 'bands', result: 'lifted', children: [{ tag: 'feFuncA', type: 'linear', slope: 50 },
      ...['feFuncR', 'feFuncG', 'feFuncB'].map(tag => ({ tag, type: 'table', tableValues }))] },
    { tag: 'feColorMatrix', in: 'lifted', type: 'saturate', values: (o.saturation * (1.9 - lift)).toFixed(2), result: 'colour' },
    // Light, not paint, exactly as in emission(): opacity becomes the brightest channel while the colour stays as it is.
    // A dark picture then leaves the page, and the other pair of edges, untouched instead of covering them with black.
    channel(0, 'red'), channel(1, 'green'), channel(2, 'blue'),
    { tag: 'feBlend', in: 'red', in2: 'green', mode: 'lighten', result: 'warm' },
    { tag: 'feBlend', in: 'warm', in2: 'blue', mode: 'lighten', result: 'peak' },
    { tag: 'feColorMatrix', in: 'peak', type: 'matrix', values: '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1 0 0 0 1', result: 'shade' },
    { tag: 'feComposite', in: 'colour', in2: 'shade', operator: 'arithmetic', k1: 0, k2: 1, k3: -1, k4: 0 }];
  return {
    rows: light(band('top', 0, -gap.top, `${alongX} ${reachY}`, x0, 0, x1 - x0, d), band('bottom', 0, gap.bottom, `${alongX} ${reachY}`, x0, h - d, x1 - x0, d)),
    columns: light(band('left', -gap.left, 0, `${reachX} ${alongY}`, 0, y0, d, y1 - y0), band('right', gap.right, 0, `${reachX} ${alongY}`, w - d, y0, d, y1 - y0)),
    // Where each pair fades in and out along its edge: [clear, full, full, clear] in px. The layer's mask applies it.
    span: { rows: [gap.left - alongX * 2, gap.left, w - gap.right, w - gap.right + alongX * 2],
      columns: [gap.top - alongY * 2, gap.top, h - gap.bottom, h - gap.bottom + alongY * 2] }
  };
}
