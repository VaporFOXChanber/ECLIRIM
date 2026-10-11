import type { DirectorSettings, DirectorStats, Rect, RGB, TrailSettings } from '../shared/types';
import type { Pixels } from './sampling';
import { gamma, linear } from './color';

/**
 * Light Director: light that comes from inside the picture.
 *
 * The base lighting only looks at the strip of picture next to each edge. This adds two things on top, both read from a
 * coarse 32×18 grid of the whole frame:
 *   - light sources: cells far brighter than the region around them (a lamp, an explosion, a spark). "Candidates" only:
 *     a bright cell is not proof of a light, so they are weighted softly and never switched on or off as objects;
 *   - onsets: cells whose light has just risen while the rest of the frame did not (something lit up or arrived).
 * Each such cell spills onto the edge zones near it, falling off with distance, so light in the middle still reaches the
 * edges a little. The result is added to the base colours with the remaining headroom in mind, before the temporal
 * filter, so OKLab smoothing and the Flash Limiter treat it like any other light.
 *
 * Two guards keep things that are bright but are not lights in the scene from pulsing on the edges:
 *   - a wide, flat patch near the top or bottom (the shape of a subtitle line) gives no light at all;
 *   - a source that never changes (a channel logo) is slowly let go, over minutes, far too slowly to be seen happening.
 * Both are judged from shape and time alone and can be wrong: a thin row of real lights low in the frame is also left out.
 *
 * Dynamic Light Trails: a source that is being followed and is moving leaves its light behind on the zones it passed,
 * fading over a second or two — the afterglow of something bright crossing a dark room. A source that stays put leaves none.
 *
 * Where light changes (frame difference) and which way it travels are separate things here. A difference has no
 * direction. Direction comes only from following a source's centre from frame to frame, and is used to place its
 * light slightly ahead, where the object will be when the smoothed light arrives.
 */
export const GRID_W = 32, GRID_H = 18, CELLS = GRID_W * GRID_H;
const LINEAR = Float32Array.from({ length: 256 }, (_, i) => linear(i / 255));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
// The strip next to each edge is what the base lighting already shows on that edge. Steady light there is left to it:
// a cell counts as a light source from 6% of the way in, fully from 16%. (Sudden light counts everywhere.)
const INNER = Float32Array.from({ length: 32 * 18 }, (_, c) => {
  const x = (c % 32 + .5) / 32, y = (Math.floor(c / 32) + .5) / 18, t = Math.min(1, Math.max(0, (Math.min(x, 1 - x, y, 1 - y) - .06) / .1));
  return t * t * (3 - 2 * t);
});
// Brightness here is the strongest channel, not luminance: a pure red or blue lamp is as much a light as a white one,
// and it is also what the renderer drives its LEDs by.
const value = (r: number, g: number, b: number) => r > g ? (r > b ? r : b) : g > b ? g : b;
const SURROUND_X = 8, SURROUND_Y = 5;      // half-size of the region a cell is compared with, in cells
const REACH = .2;                           // how far light spills, in picture heights (half strength at this distance)
const UNIT = 7;                             // cells of full-strength light that drive the nearest zone fully
const HABIT = 60;                           // seconds over which an unchanging source is let go
const AREA = 24;                            // cells (about 4% of the picture) beyond which a candidate is a bright region, not a light
const MAX_LEAD = 3;                         // furthest a moving source is placed ahead, in cells
const MAX_TRACKS = 6;
const LIT = .01;                            // a cell gives light, and belongs to a candidate, from this much on
interface Track { x: number; y: number; vx: number; vy: number; energy: number; age: number }

export class LightDirector {
  private rgb = new Float32Array(CELLS * 3); private level = new Float32Array(CELLS); private mean = new Float32Array(CELLS);
  private samples = new Uint16Array(CELLS); private peak = new Float32Array(CELLS);
  private previous = new Float32Array(CELLS); private colour = new Float32Array(CELLS * 3); private surround = new Float32Array(CELLS);
  private source = new Float32Array(CELLS); private onset = new Float32Array(CELLS); private habit = new Float32Array(CELLS);
  private label = new Int8Array(CELLS); private integral = new Float32Array((GRID_W + 1) * (GRID_H + 1));
  private weights = new Float32Array(0); private weightKey = '';
  private columns = new Uint8Array(0); private columnKey = '';
  private target = new Float32Array(0); private glow = new Float32Array(0); private out = new Float32Array(0);
  private passing = new Float32Array(0); private trail = new Float32Array(0);
  private tracks: Track[] = []; private primed = false; private cutHold = 0; private flicker = 0; private bursting = false;
  stats: DirectorStats = { sources: 0, motion: 0, vx: 0, vy: 0, cut: false, calm: 1 };
  /** Seconds a followed source is placed ahead of where it is. 0 lights it exactly where it is. */
  lead = .15;

  reset(): void {
    this.primed = false; this.tracks = []; this.cutHold = 0; this.flicker = 0; this.bursting = false;
    this.glow.fill(0); this.out.fill(0); this.habit.fill(0); this.trail.fill(0);
    this.stats = { sources: 0, motion: 0, vx: 0, vy: 0, cut: false, calm: 1 };
  }

  /** Mean linear colour and brightest point of every grid cell. `stride` 2 reads a quarter of the pixels. */
  private reduce(f: Pixels, r: Rect, stride: number): void {
    const x0 = Math.max(0, Math.floor(r.x)), x1 = Math.min(f.width, Math.ceil(r.x + r.width));
    const y0 = Math.max(0, Math.floor(r.y)), y1 = Math.min(f.height, Math.ceil(r.y + r.height));
    const { rgb, samples, peak, mean, level } = this, data = f.data, w = x1 - x0, h = y1 - y0;
    rgb.fill(0); samples.fill(0); peak.fill(0);
    // Which grid column each pixel column falls in: the same for every row, so it is worked out once.
    if (this.columnKey !== `${x0}:${w}`) {
      this.columnKey = `${x0}:${w}`; this.columns = new Uint8Array(Math.max(0, w));
      for (let x = 0; x < w; x++) this.columns[x] = Math.min(GRID_W - 1, Math.floor(x * GRID_W / w));
    }
    const columns = this.columns, step = stride * 4;
    for (let py = y0; py < y1; py += stride) {
      const row = Math.min(GRID_H - 1, Math.floor((py - y0) * GRID_H / h)) * GRID_W;
      for (let x = 0, i = (py * f.width + x0) * 4; x < w; x += stride, i += step) {
        const c = row + columns[x], k = c * 3;
        const R = LINEAR[data[i]], G = LINEAR[data[i + 1]], B = LINEAR[data[i + 2]], y = value(R, G, B);
        rgb[k] += R; rgb[k + 1] += G; rgb[k + 2] += B; samples[c]++;
        if (y > peak[c]) peak[c] = y;
      }
    }
    for (let c = 0; c < CELLS; c++) {
      const n = samples[c] || 1, k = c * 3;
      rgb[k] /= n; rgb[k + 1] /= n; rgb[k + 2] /= n;
      mean[c] = value(rgb[k], rgb[k + 1], rgb[k + 2]);
      // A point much brighter than its cell (a spark) counts for part of what it would if it filled the cell.
      level[c] = mean[c] + (peak[c] - mean[c]) * .25;
    }
  }

  /** Mean brightness of the region around every cell. */
  private regions(): void {
    const { integral, mean, surround } = this, W = GRID_W + 1;
    for (let y = 0; y < GRID_H; y++) for (let x = 0, run = 0; x < GRID_W; x++) {
      run += mean[y * GRID_W + x]; integral[(y + 1) * W + x + 1] = integral[y * W + x + 1] + run;
    }
    for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) {
      const x0 = Math.max(0, x - SURROUND_X), x1 = Math.min(GRID_W, x + SURROUND_X + 1);
      const y0 = Math.max(0, y - SURROUND_Y), y1 = Math.min(GRID_H, y + SURROUND_Y + 1);
      surround[y * GRID_W + x] = (integral[y1 * W + x1] - integral[y0 * W + x1] - integral[y1 * W + x0] + integral[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
    }
  }

  /**
   * Groups lit cells into candidates, drops the ones shaped like a subtitle line, and follows each remaining one's centre.
   * This is the only place direction comes from. Returns, per group, how far ahead to place it (cells) and how much of its
   * steady light counts: nothing for a subtitle shape, less the larger it is beyond the size of a light. `moving` is 0 for
   * a group that stays put and rises to 1 for one that crosses the picture in a few seconds: only those leave a trail.
   */
  private follow(dt: number): { shift: Float32Array; share: Float32Array; moving: Float32Array } {
    const { label, source, onset } = this, found: Track[] = [], stack: number[] = [], captions: boolean[] = [], sizes: number[] = [];
    label.fill(-1);
    for (let start = 0; start < CELLS; start++) {
      if (source[start] + onset[start] <= LIT || label[start] !== -1) continue;
      const id = Math.min(found.length, 126);
      let energy = 0, sx = 0, sy = 0, cells = 0, left = GRID_W, right = 0, top = GRID_H, bottom = 0;
      stack.push(start); label[start] = id;
      while (stack.length) {
        const c = stack.pop()!, x = c % GRID_W, y = (c - x) / GRID_W, e = source[c] + onset[c];
        energy += e; sx += e * (x + .5); sy += e * (y + .5); cells++;
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
        for (let ny = Math.max(0, y - 1); ny <= Math.min(GRID_H - 1, y + 1); ny++)
          for (let nx = Math.max(0, x - 1); nx <= Math.min(GRID_W - 1, x + 1); nx++) {
            const n = ny * GRID_W + nx;
            if (source[n] + onset[n] > LIT && label[n] === -1) { label[n] = id; stack.push(n); }
          }
      }
      if (id !== found.length) continue;
      const width = right - left + 1, height = bottom - top + 1;
      captions.push(height <= 3 && width >= 6 && width >= height * 3 && (top >= GRID_H * 2 / 3 || bottom < GRID_H / 5));
      found.push({ x: sx / energy, y: sy / energy, vx: 0, vy: 0, energy, age: 0 }); sizes.push(cells);
    }
    // The strongest candidates take over the nearest earlier track within reach; anything further is a new object.
    const order = found.map((_, i) => i).filter(i => !captions[i]).sort((a, b) => found[b].energy - found[a].energy).slice(0, MAX_TRACKS);
    const taken = new Set<Track>(), next: Track[] = [], shift = new Float32Array(found.length * 2), moving = new Float32Array(found.length);
    for (const i of order) {
      const now = found[i]; let best: Track | null = null, distance = Infinity;
      for (const old of this.tracks) {
        const dx = now.x - old.x, dy = now.y - old.y, d = dx * dx + dy * dy;
        if (!taken.has(old) && Math.abs(dx) <= 7 && Math.abs(dy) <= 5 && d < distance) { best = old; distance = d; }
      }
      if (best) {
        taken.add(best);
        const vx = (now.x - best.x) / dt, vy = (now.y - best.y) / dt;
        now.vx = best.age ? best.vx + (vx - best.vx) * .5 : vx; now.vy = best.age ? best.vy + (vy - best.vy) * .5 : vy;
        now.age = best.age + 1;
        // Only a source followed for a few frames is trusted enough to be placed ahead of where it is.
        const trust = Math.min(1, (now.age - 1) / 2) * this.lead;
        shift[i * 2] = Math.max(-MAX_LEAD, Math.min(MAX_LEAD, now.vx * trust));
        shift[i * 2 + 1] = Math.max(-MAX_LEAD, Math.min(MAX_LEAD, now.vy * trust));
        // Speed in picture widths / heights per second. Under 4% a second is standing still; from 25% it is plainly travelling.
        const pace = Math.min(1, Math.max(0, (Math.hypot(now.vx / GRID_W, now.vy / GRID_H) - .04) / .21));
        if (now.age >= 2) moving[i] = pace * pace * (3 - 2 * pace);
      }
      next.push(now);
    }
    this.tracks = next;
    let energy = 0, vx = 0, vy = 0;
    for (const t of next) if (t.age >= 2) { energy += t.energy; vx += t.vx * t.energy; vy += t.vy * t.energy; }
    this.stats.sources = captions.filter(caption => !caption).length;
    this.stats.vx = energy ? vx / energy / GRID_W : 0; this.stats.vy = energy ? vy / energy / GRID_H : 0;
    return { shift, moving, share: Float32Array.from(captions, (caption, i) => caption ? -1 : Math.min(1, AREA / sizes[i])) };
  }

  /** How much of a cell's light reaches each zone. Zone order: top L→R, bottom L→R, left T→B, right T→B. */
  private spill(count: number, aspect: number): void {
    const key = `${count}:${aspect.toFixed(3)}`;
    if (key === this.weightKey) return;
    this.weightKey = key; this.weights = new Float32Array(CELLS * count);
    const n = count / 4;
    for (let c = 0; c < CELLS; c++) {
      const cx = (c % GRID_W + .5) / GRID_W, cy = (Math.floor(c / GRID_W) + .5) / GRID_H;
      for (let z = 0; z < count; z++) {
        const side = Math.floor(z / n), t = (z % n + .5) / n;
        const dx = (cx - (side < 2 ? t : side === 2 ? 0 : 1)) * aspect, dy = cy - (side < 2 ? side : t);
        this.weights[c * count + z] = REACH * REACH / (REACH * REACH + dx * dx + dy * dy);
      }
    }
  }

  /**
   * One analysed frame → the light to add to each of `count` zones, as linear RGB (3 values per zone).
   * `dt` is the time since the previous analysed frame, in seconds. `trails`: Dynamic Light Trails, or null for none.
   */
  analyse(f: Pixels, region: Rect, count: number, d: DirectorSettings, dt: number, stride = 1, trails: TrailSettings | null = null): Float32Array {
    dt = Math.min(.5, Math.max(.02, dt));
    if (this.glow.length !== count * 3) {
      this.glow = new Float32Array(count * 3); this.target = new Float32Array(count * 3); this.out = new Float32Array(count * 3);
      this.passing = new Float32Array(count * 3); this.trail = new Float32Array(count * 3);
    }
    this.reduce(f, region, stride); this.regions();
    const { level, mean, previous, colour, surround, source, onset, rgb, habit } = this;
    const sourceSense = d.source / 100, motionSense = d.motion / 100;
    // More sensitive = a cell needs less brightness and less contrast to count, and a smaller rise to count as an onset.
    const floor = lerp(.28, .035, sourceSense), ratio = lerp(2.4, 1.2, sourceSense);
    const quiet = lerp(.1, .012, motionSense), kick = lerp(.6, 2, motionSense);
    const settle = 1 - Math.exp(-dt / HABIT);
    let drift = 0, change = 0, changed = 0, scene = 0;
    for (let c = 0; c < CELLS; c++) scene += mean[c];
    scene /= CELLS;
    // A lamp lights a dark room, not a sunlit field: in a bright picture the same bright patch counts for less, down to nothing.
    const dark = Math.min(1, Math.max(0, (.55 - scene) / .4)), darkness = dark * dark * (3 - 2 * dark);
    for (let c = 0, k = 0; c < CELLS; c++, k += 3) {
      // Whether the scene changed is judged by colour: a cut between two equally bright pictures is still a cut.
      const diff = Math.max(Math.abs(rgb[k] - colour[k]), Math.abs(rgb[k + 1] - colour[k + 1]), Math.abs(rgb[k + 2] - colour[k + 2]));
      drift += level[c] - previous[c]; change += diff; if (diff > .02) changed++;
      colour[k] = rgb[k]; colour[k + 1] = rgb[k + 1]; colour[k + 2] = rgb[k + 2];
    }
    drift /= CELLS; change /= CELLS;
    // A change across most of the frame is a cut or a full-frame flash, not something happening in one place.
    const cut = this.primed && changed > CELLS * .5 && change > .05;
    this.cutHold = cut ? .3 : Math.max(0, this.cutHold - dt);
    let burst = 0, moved = 0;
    for (let c = 0; c < CELLS; c++) {
      // A soft gate, not a switch: nothing at the threshold, the cell's full brightness from twice the threshold up.
      const threshold = Math.max(floor, surround[c] * ratio), gate = Math.min(1, Math.max(0, level[c] / threshold - 1));
      const lit = level[c] * gate * gate * (3 - 2 * gate) * darkness;
      // What has been there unchanged for minutes stops counting; anything new in the same place counts in full.
      const held = lit * INNER[c];
      source[c] = Math.max(0, held - habit[c]); habit[c] += (held - habit[c]) * settle;
      const rise = this.primed && !this.cutHold ? level[c] - previous[c] - Math.max(0, drift) - quiet : 0;
      onset[c] = rise > 0 ? rise * kick : 0;
      burst += onset[c]; if (this.primed) moved += Math.max(0, Math.abs(level[c] - previous[c]) - Math.abs(drift));
      previous[c] = level[c];
    }
    const { shift, share, moving } = this.follow(dt);
    // Light that keeps bursting (a strobe, rapid blinking) is turned down; a single burst is not.
    this.flicker *= Math.exp(-dt / 1.2);
    if (burst > .8 && !this.bursting) this.flicker++;
    this.bursting = burst > .8;
    const calm = 1 / (1 + Math.max(0, this.flicker - 1.2) * .9) ** 2;

    this.spill(count, region.width / Math.max(1, region.height));
    const { target, glow, weights, label, out, passing, trail } = this;
    target.fill(0); passing.fill(0);
    for (let c = 0; c < CELLS; c++) {
      const id = label[c];
      // Every lit cell belongs to a candidate. The ones in a subtitle-shaped candidate give nothing.
      if (id < 0 || share[id] < 0) continue;
      const light = source[c] * share[id] + onset[c];
      let at = c;
      if (id * 2 < shift.length && (shift[id * 2] || shift[id * 2 + 1])) {
        const x = Math.max(0, Math.min(GRID_W - 1, c % GRID_W + Math.round(shift[id * 2])));
        const y = Math.max(0, Math.min(GRID_H - 1, Math.floor(c / GRID_W) + Math.round(shift[id * 2 + 1])));
        at = y * GRID_W + x;
      }
      // The cell's own colour, scaled so that its strongest channel is the light it gives.
      const scale = light / Math.max(mean[c], 1e-3) / UNIT, r = rgb[c * 3] * scale, g = rgb[c * 3 + 1] * scale, b = rgb[c * 3 + 2] * scale;
      for (let z = 0, w = at * count; z < count; z++, w++) {
        const k = weights[w]; target[z * 3] += r * k; target[z * 3 + 1] += g * k; target[z * 3 + 2] += b * k;
      }
      // What a moving source lights where it really is right now: that is what it leaves behind when it has moved on.
      const pace = trails?.enabled && id < moving.length ? moving[id] : 0;
      if (pace) for (let z = 0, w = c * count; z < count; z++, w++) {
        const k = weights[w] * pace; passing[z * 3] += r * k; passing[z * 3 + 1] += g * k; passing[z * 3 + 2] += b * k;
      }
    }
    // Quick to rise, slow to fall: the light answers an event and then lingers the way a room does.
    // After a cut there is nothing left to linger for: the previous scene's light is let go quickly.
    const attack = lerp(.3, .02, d.response / 100), strength = d.strength / 100 * calm;
    const release = this.cutHold ? Math.min(.15, lerp(.06, 1.4, d.smoothing / 100)) : lerp(.06, 1.4, d.smoothing / 100);
    for (let z = 0; z < count; z++) {
      const i = z * 3, rising = value(target[i], target[i + 1], target[i + 2]) > value(glow[i], glow[i + 1], glow[i + 2]);
      const k = 1 - Math.exp(-dt / (rising ? attack : release));
      for (let c = 0; c < 3; c++) { glow[i + c] += (target[i + c] - glow[i + c]) * k; out[i + c] = glow[i + c] * strength; }
    }
    if (trails?.enabled) {
      // The trail keeps the brightest a passing source made each zone and lets it fade. It only ever fills in where the
      // light has already moved on, so a source is never lit twice in the place where it is.
      const fade = Math.exp(-dt / (this.cutHold ? .1 : lerp(.3, 2.4, trails.length / 100))), amount = trails.strength / 100 * strength;
      for (let i = 0; i < count * 3; i++) {
        trail[i] = Math.max(trail[i] * fade, passing[i]);
        if (trail[i] * amount > out[i]) out[i] = trail[i] * amount;
      }
    } else if (trail[0] || trail.some(v => v > 0)) trail.fill(0);
    this.primed = true;
    this.stats.motion = Math.min(1, moved / CELLS * 12); this.stats.cut = cut; this.stats.calm = calm;
    return out;
  }
  /** The last result again, for frames the Light Director sits out under load. */
  get last(): Float32Array { return this.out; }
}

/**
 * Base colours plus the Light Director's light. Added in linear light, and only into the headroom the base leaves:
 * the brightest channel approaches full strength without clipping, so the added hue is kept and nothing turns white.
 */
export function mixLight(base: RGB[], add: Float32Array): RGB[] {
  if (add.length !== base.length * 3) return base;
  return base.map((rgb, z) => {
    const r = add[z * 3], g = add[z * 3 + 1], b = add[z * 3 + 2], peak = Math.max(r, g, b);
    if (peak < 1e-4) return rgb;
    const lin = rgb.map(v => linear(v / 255)), room = 1 - Math.max(lin[0], lin[1], lin[2]);
    const k = room > 0 ? room * (1 - Math.exp(-peak / room)) / peak : 0;
    return [gamma(lin[0] + r * k) * 255, gamma(lin[1] + g * k) * 255, gamma(lin[2] + b * k) * 255] as RGB;
  });
}
