import type { RGB, Settings } from '../shared/types';
import { MODES, clamp } from '../shared/settings';
import { fromLab, labToLinear, toLab, luminance } from './color';
import { chromaGain, fromLabInGamut, hueCalm, shadowToe } from './color2';

// The Flash Limiter: how fast the light of a zone may change, in linear luminance per second. Gentler up than down.
const RISE = .55, FALL = .85;
/** `after`, held to what the limiter allows coming from `before`. Both are OKLab; the hue is kept. */
function limited(before: RGB, after: RGB, dt: number): RGB {
  const was = luminance(fromLab(before)), now = luminance(fromLab(after));
  const limit = was + dt * (now > was ? RISE : -FALL);
  if ((now > was && now > limit) || (now < was && now < limit)) {
    const ratio = Math.cbrt(Math.max(0, limit) / Math.max(now, 1e-9));
    return after.map(v => v * ratio) as RGB;
  }
  return after;
}

/**
 * Light the Pulse Engine has scaled is held to the same rates, with one exception: a beat may lift a zone by up to STEP
 * at once, and let it back down by up to BACK at once, so that it arrives on the beat and is gone before the next one
 * instead of being smeared into a slow swell. (Up to 0.9.2 a beat could lift a zone by 0.018 a frame like anything
 * else, and had mostly died away before the light got there.)
 * The Pulse Engine counts at most three beats a second while the Flash Limiter is on, and STEP is below a tenth of full
 * brightness. Everything else the sound does to the light is bounded exactly as before.
 * Over a stretch of time `t` a zone's light rises by no more than RISE·t, plus STEP for each beat in it, and falls by
 * no more than FALL·t, plus BACK for each beat.
 */
export const STEP = .08, BACK = STEP * FALL / RISE;
/** Seconds a beat's step up stays available to a zone (a beat reaches the zones along the edge one after the other), and its step back down. */
const REACH = .45, RETURN = .75;
const light = (lab: RGB) => { const [r, g, b] = labToLinear(lab[0], lab[1], lab[2]); return .2126 * r + .7152 * g + .0722 * b; };
export class TemporalFilter {
  private values: RGB[] = []; private targets: RGB[] = []; private cut = false;
  // What was last sent to the screen, when the Pulse Engine moves the light after smoothing.
  private emitted: RGB[] = [];
  // Per zone: what is left of the steps the last beat allows (see STEP), and how long ago that beat was.
  private spare = new Float32Array(0); private back = new Float32Array(0); private sinceBeat = 9;
  /** `after`, held to what the Flash Limiter allows a zone's pulsed light coming from `before`. Measured before any clipping, so that it holds exactly. */
  private bounded(i: number, before: RGB, after: RGB, dt: number): RGB {
    const was = light(before), now = light(after);
    let limit = was + dt * (now > was ? RISE : -FALL);
    if (now > was && now > limit && this.sinceBeat < REACH && this.spare[i] > 0) {
      const step = Math.min(this.spare[i], now - limit);
      this.spare[i] -= step; limit += step;
    } else if (now < was && now < limit && this.sinceBeat < RETURN && this.back[i] > 0) {
      const step = Math.min(this.back[i], limit - now);
      this.back[i] -= step; limit -= step;
    }
    if ((now > was && now > limit) || (now < was && now < limit)) {
      const ratio = Math.cbrt(Math.max(0, limit) / Math.max(now, 1e-9));
      return after.map(v => v * ratio) as RGB;
    }
    return after;
  }
  /**
   * `chroma` scales the saturation of single zones (Zone Studio). `scale` (Adaptive Brightness) says what a zone of a given
   * lightness is multiplied by: it changes the target, so the time smoothing and the Flash Limiter act on it like on any scene.
   */
  setTarget(colors: RGB[], s: Settings, chroma?: ArrayLike<number>, scale?: ((lightness: number) => number) | null): void {
    const profile = MODES[s.mode], color = s.color;
    const next = colors.map((rgb, i) => {
      const [l, a, b] = toLab(rgb);
      // A soft shadow toe preserves real darkness rather than lifting blacks.
      const sat = s.saturation / 100 * profile.saturation * (chroma ? chroma[i] : 1) * chromaGain(l, Math.hypot(a, b), color);
      const k = scale ? scale(l) : 1;
      return [shadowToe(l, color) * k, a * sat * k, b * sat * k] as RGB;
    });
    if (this.values.length !== next.length) { this.values = next.map(() => [0, 0, 0]); this.emitted = []; }
    this.cut = this.targets.length === next.length && next.reduce((v, c, i) =>
      v + Math.hypot(...c.map((k, j) => k - this.targets[i][j])), 0) / next.length > .22;
    this.targets = next;
  }
  /**
   * One painted frame. `gain` (Pulse Engine) multiplies each zone's light after smoothing, so a beat is not smeared by it.
   * The Flash Limiter is the last thing every path goes through: it bounds the smoothed colour, and then once more whatever
   * the gain made of it, against what was really shown the frame before. `beat`: the Pulse Engine has just counted a beat.
   */
  step(dt: number, s: Settings, gain?: ArrayLike<number> | null, beat = false): RGB[] {
    dt = clamp(dt, 0, .08); // Background resumes cannot bypass the rate limiter.
    if (this.spare.length !== this.values.length) { this.spare = new Float32Array(this.values.length); this.back = new Float32Array(this.values.length); }
    this.sinceBeat = beat ? 0 : this.sinceBeat + dt;
    if (beat) { this.spare.fill(STEP); this.back.fill(BACK); }
    const profile = MODES[s.mode], color = s.color, decode = color.enabled ? fromLabInGamut : fromLab;
    const tau = profile.tau * (.3 + s.smoothing / 50) / (s.responseSpeed / 100);
    const alpha = 1 - Math.exp(-dt / (tau * (this.cut ? .65 : 1)));
    return this.values.map((old, i) => {
      const target = this.targets[i], calm = alpha * hueCalm(Math.max(old[0], target[0]), Math.hypot(target[1] - old[1], target[2] - old[2]), color);
      let next: RGB = [old[0] + (target[0] - old[0]) * alpha, old[1] + (target[1] - old[1]) * calm, old[2] + (target[2] - old[2]) * calm];
      // Bound scene flashes in linear luminance, with a gentler rise than fall.
      if (s.flashLimiter) next = limited(old, next, dt);
      this.values[i] = next;
      if (!gain) { this.emitted[i] = next; return decode(next); }
      // A zone can only be driven up to full: one that is nearly there has little room left to pulse into. A lift is
      // bent toward that ceiling instead of being cut off at it, so a strong beat still rises and falls instead of
      // sitting flat at full strength until it has decayed (which also left no time for the dip between two beats).
      const linear = labToLinear(next[0], next[1], next[2]), room = 1 / Math.max(linear[0], linear[1], linear[2], 1e-6) - 1;
      const lifted = gain[i] <= 1 ? gain[i] : room > 1e-6 ? 1 + room * (1 - Math.exp(-(gain[i] - 1) / room)) : 1;
      // Light scales linearly, OKLab is its cube root: all three components by the same factor keeps the hue.
      const k = Math.cbrt(Math.max(0, lifted));
      let lit: RGB = [next[0] * k, next[1] * k, next[2] * k];
      if (s.flashLimiter) lit = this.bounded(i, this.emitted[i] || next, lit, dt);
      this.emitted[i] = lit;
      return decode(lit);
    });
  }
  /** For diagnostics: how many zones, their brightest lightness now and wanted, and whether anything is not a number. */
  probe(): Record<string, unknown> {
    const peak = (list: RGB[]) => list.reduce((max, c) => Math.max(max, c[0]), 0), bad = (list: RGB[]) => list.filter(c => c.some(v => !Number.isFinite(v))).length;
    return { zones: this.values.length, now: peak(this.values), wanted: peak(this.targets), shown: peak(this.emitted.filter(Boolean)), notNumbers: bad(this.values) + bad(this.targets), settled: this.settled };
  }
  get settled(): boolean {
    return this.values.every((color, i) => color.every((v, channel) => Math.abs(v - this.targets[i][channel]) < .0005));
  }
  reset(): void { this.values = []; this.targets = []; this.emitted = []; this.spare = new Float32Array(0); this.back = new Float32Array(0); this.sinceBeat = 9; }
}
