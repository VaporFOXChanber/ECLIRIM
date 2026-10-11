import type { Rect } from '../shared/types';
import { clamp } from '../shared/settings';

/**
 * UI Guard. The light is a coloured layer over the page, so wherever it is opaque it hides what lies under it. The guard
 * does not switch the light off around controls, captions and text: it limits how opaque the light may be right over them
 * (`guardCap`), and only there. Where the light is already thinner than that, nothing changes, and the strip on the very
 * edge of the screen stays lit wherever nothing needs to be read under it.
 *
 * How opaque the light is at a point is the glow's shape there times how hard the LEDs along that stretch of edge are
 * driven. The guard looks at both: in a dim scene, where even the full shape stays under the limit, it does nothing at all.
 */
export const guardCap = (strength: number) => .6 - .48 * clamp(strength / 100);
/** Kept clear around what is guarded, and how far beyond that the light eases back to full (CSS px). */
export const PAD = 6, FEATHER = 24;
/** The most of the strip on the screen edge that is kept out of the guard's reach (CSS px). A thicker strip is guarded beyond that. */
export const RIM = 6;
/** LED drive is followed in steps of a sixteenth, upward at once and downward only once it has clearly fallen. */
export function guardLevel(was: number, peak: number): number {
  const up = Math.ceil(clamp(peak) * 16) / 16;
  return up > was || peak < was - .09 ? up : was;
}
/** How much of the glow's shape may be shown over a control whose stretch of edge is driven at `level` (1 = all of it). */
export const guardLimit = (cap: number, level: number) => level > cap ? cap / level : 1;

/**
 * How far in from the edge (px) the light can be more opaque than `cap`. `profile` is the opacity across the glow as
 * 0–255 samples from the edge inward. 0 = the light is nowhere that strong, so there is nothing to guard.
 */
export function guardReach(profile: ArrayLike<number>, cap: number, depth: number): number {
  let last = -1;
  for (let i = 0; i < profile.length; i++) if (profile[i] > cap * 255) last = i;
  return last < 0 ? 0 : (last + 1) / profile.length * depth;
}

/** Rectangles that touch or nearly touch (`gap` px) become one, so a row of buttons is guarded as a row, not as dots. */
export function mergeRects(rects: readonly Rect[], gap: number): Rect[] {
  const out = rects.filter(r => r.width > 0 && r.height > 0).map(r => ({ ...r }));
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) for (let j = i + 1; j < out.length; j++) {
      const a = out[i], b = out[j];
      if (a.x - gap > b.x + b.width || b.x - gap > a.x + a.width || a.y - gap > b.y + b.height || b.y - gap > a.y + a.height) continue;
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      out[i] = { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
      out.splice(j, 1); merged = true; break;
    }
  }
  return out;
}

/**
 * Cuts rectangles into pieces no longer than `piece` px along one side (0 top, 1 bottom: along x; 2 left, 3 right: along y).
 * A long row of buttons then answers to the light over each stretch of it, not to the brightest spot anywhere along it.
 * `parent[i]` says which rectangle piece `i` came from.
 */
export function splitRects(rects: readonly Rect[], side: number, piece = 96): { pieces: Rect[]; parent: number[] } {
  const pieces: Rect[] = [], parent: number[] = [];
  rects.forEach((r, index) => {
    const length = side < 2 ? r.width : r.height, count = Math.max(1, Math.ceil(length / piece)), step = length / count;
    for (let i = 0; i < count; i++) {
      pieces.push(side < 2 ? { x: r.x + i * step, y: r.y, width: step, height: r.height } : { x: r.x, y: r.y + i * step, width: r.width, height: step });
      parent.push(index);
    }
  });
  return { pieces, parent };
}

/** A viewport rectangle as one side sees it: [from, to] along the edge and [from, to] in from it, in px. */
export function sideRect(side: number, r: Rect, view: { width: number; height: number }): [number, number, number, number] {
  if (side === 0) return [r.x, r.x + r.width, r.y, r.y + r.height];
  if (side === 1) return [r.x, r.x + r.width, view.height - r.y - r.height, view.height - r.y];
  if (side === 2) return [r.y, r.y + r.height, r.x, r.x + r.width];
  return [r.y, r.y + r.height, view.width - r.x - r.width, view.width - r.x];
}

/**
 * The opacity of one side's glow with the guard applied. `base` and `out` hold `length` samples along the edge for each
 * of `rows` steps inward ([row * length + along], 0–255), covering `depth` px inward and the whole edge (`span` px).
 * Over each rectangle (viewport px) and a little around it, opacity is cut to that rectangle's limit (`limits`, 0–1 of
 * full opacity; 1 or more leaves it alone); beyond that it eases back. Returns how many rectangles the light was cut for.
 * `rim` (px): the outermost line of the screen edge, which is never cut. It is the light source, and nothing can be
 * read in the few pixels it covers. `touched`, if given, gets a 1 for every rectangle the light was cut for.
 */
export function guardField(base: Float32Array, out: Float32Array, length: number, rows: number, side: number,
  rects: readonly Rect[], view: { width: number; height: number }, depth: number, limits: ArrayLike<number>, rim = 0, touched?: Uint8Array, stretch = 1): number {
  out.set(base);
  const span = side < 2 ? view.width : view.height;
  let reached = 0;
  for (let index = 0; index < rects.length; index++) {
    const limit = limits[index] * 255;
    if (!(limit < 255)) continue;
    // `stretch` (Beat Bloom): the light may be shown scaled up to this much from the edge. A row then lands further in
    // than it is, so every row that can land on the rectangle at any scale is held: the hold starts that much nearer the edge.
    const [a0, a1, inner, c1] = sideRect(side, rects[index], view), near = PAD + FEATHER, c0 = inner / stretch;
    if (c0 - near >= depth || c1 + near <= 0 || a1 + near <= 0 || a0 - near >= span) continue;
    const i0 = Math.max(0, Math.floor((a0 - near) / span * length)), i1 = Math.min(length, Math.ceil((a1 + near) / span * length));
    const r0 = Math.max(0, Math.floor((c0 - near) / depth * rows)), r1 = Math.min(rows, Math.ceil((c1 + near) / depth * rows));
    let cut = false;
    for (let row = r0; row < r1; row++) {
      const c = (row + .5) / rows * depth, dc = Math.max(c0 - PAD - c, c - c1 - PAD, 0);
      if (c < rim) continue;
      for (let i = i0; i < i1; i++) {
        const at = row * length + i, value = base[at];
        if (value <= limit) continue;
        const a = (i + .5) / length * span, da = Math.max(a0 - PAD - a, a - a1 - PAD, 0), far = Math.hypot(da, dc);
        if (far >= FEATHER) continue;
        const t = far / FEATHER, cover = 1 - t * t * (3 - 2 * t), guarded = value + (limit - value) * cover;
        if (guarded < out[at]) { out[at] = guarded; cut = true; }
      }
    }
    if (cut) { reached++; if (touched) touched[index] = 1; }
  }
  return reached;
}
