import type { PulseSettings, RGB } from '../shared/types';
import { gamma } from './color';

/**
 * Pulse Engine: what the sound does to the light.
 *
 * The spectrum of the playing media is read in three bands. Each band is measured against its own recent loudness, so a
 * quiet film and a loud one move the light alike. That reference takes a moment to catch up with something much louder,
 * and for that moment the band reads above full: a blast after quiet talk is heard as the surprise it is. What reaches the light is the difference between a band's level now and
 * its level over the last few seconds: a beat, a blast or a sharp effect moves it, a steady sound — however loud — does not.
 * Only how hard the light is driven changes. Its colour stays the picture's.
 *
 * 0.9.3: the amounts are amounts of what is seen. A zone's light goes through a tone curve before it reaches the screen,
 * and that curve halves every change of it: a gain of 1.4 on the light showed as about 1.15 on the screen, and as
 * nothing at all in a bright scene. `gains` now answers in light for a change asked for on the screen, the rest
 * between beats goes further down than it did (in a bright scene that is the only room there is), a beat lasts long
 * enough to be seen, and it travels: it starts at the bottom centre and runs up both sides to the top.
 *
 * 0.9.4: with all of that at its strongest it was still found weak. What moved was only how opaque a strip some 70 px
 * deep is, and in a bright scene that strip is nearly as opaque as it gets. So a beat now also moves the light itself:
 * each edge's light swells into the page (`bloom`), and a beat takes the opacity past where the tone curve stops (`lift`).
 * The beat travels more slowly, with a sharp front, so that the eye can follow it.
 */
const BANDS = [[30, 200], [200, 2500], [2500, 12000]] as const;
const RELEASE = [.2, .15, .1];                 // seconds for a band's level to fall back
const TRAVEL = .32;                            // seconds a beat takes from the bottom centre to the top centre at full Beat Wave
/**
 * A beat's lift, `age` seconds after it reached a zone: a sharp front on a longer body. The front is what the eye
 * follows along the edge; the body is what makes the beat last. 1.3 at the moment it arrives.
 */
const struck = (age: number) => .55 * Math.exp(-age / .25) + .75 * Math.exp(-age / .07);
const UP = 1.5, DOWN = .6;                     // how far the screen's light may be lifted and lowered, per unit of Pulse Depth
const DIP = 1.5;                               // a band below its recent level lowers the light by this much more than one above it lifts it
// The edge as a path from the bottom centre (0) to the top centre (1), for a 16:9 screen: half the bottom, a side, half the top.
const HALF = 8, SIDE = 9, PATH = HALF + SIDE + HALF;
const SILENCE = .001, FLOOR = .004;            // amplitude: below the first nothing is playing; the second caps the auto-gain
const clamp = (v: number, min = 0, max = 1) => Math.min(max, Math.max(min, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export interface PulseFrame {
  /** Level of each band against its recent loudness: 1 = as loud as it has lately been, above 1 = louder than that. */
  low: number; mid: number; high: number;
  /** 1 at a beat or a blast, falling away after it. */
  beat: number; impact: number;
  /** A beat was counted in this very reading. */
  onset: boolean;
  /** How much of the sound each band carries, 0–1: a band far quieter than the loudest one hardly counts. */
  share: [number, number, number];
  silent: boolean;
}

export class PulseAnalyser {
  private reference = [0, 0, 0]; private level = [0, 0, 0]; private centre = [0, 0, 0]; private last = [0, 0, 0];
  private beat = 0; private impact = 0; private sinceBeat = 9; private quiet = 9;
  // The last few beats: how long ago, and how hard. A beat reaches a zone further along the edge a little later.
  private hits: { age: number; strength: number; blast: boolean }[] = [];
  // What the bass has been doing over the last quarter of a second, newest first: it travels along the edge with the beats.
  private bass: { age: number; swing: number }[] = [];
  /**
   * Per zone, 0–1: how far a beat takes the zone's opacity from where the tone curve leaves it toward full. Worked out
   * together with `gains`. In a bright scene the opacity sits just under its ceiling and the gain alone shows nothing.
   */
  lift = new Float32Array(0);
  /** Beats counted since the start, for the Diagnostics page. */
  beats = 0;
  frame: PulseFrame = { low: 0, mid: 0, high: 0, beat: 0, impact: 0, onset: false, share: [0, 0, 0], silent: true };
  reset(): void {
    this.reference = [0, 0, 0]; this.level = [0, 0, 0]; this.centre = [0, 0, 0]; this.last = [0, 0, 0];
    this.beat = this.impact = 0; this.sinceBeat = this.quiet = 9; this.beats = 0; this.hits = []; this.bass = [];
    this.frame = { low: 0, mid: 0, high: 0, beat: 0, impact: 0, onset: false, share: [0, 0, 0], silent: true };
  }
  /**
   * One reading of the spectrum. `decibels` is what AnalyserNode.getFloatFrequencyData gives: one value per frequency bin
   * up to half the sample rate. `calm` (Flash Limiter on) keeps beats at least a third of a second apart.
   */
  update(decibels: Float32Array, sampleRate: number, dt: number, s: PulseSettings, calm = true): PulseFrame {
    dt = clamp(dt, .001, .2);
    const hz = sampleRate / 2 / decibels.length, now = [0, 0, 0], flux = [0, 0, 0], top = Math.max(...this.reference);
    let loudest = 0;
    for (let b = 0; b < 3; b++) {
      let power = 0;
      for (let i = Math.max(1, Math.round(BANDS[b][0] / hz)), end = Math.min(decibels.length, Math.round(BANDS[b][1] / hz)); i < end; i++) power += 10 ** (decibels[i] / 10);
      const amplitude = Math.sqrt(power); loudest = Math.max(loudest, amplitude);
      // "Full" is how loud the band has lately been. Both this reading and the one before are judged against the same
      // reference, so a jump in loudness is a jump here too. After silence there is nothing to judge against yet.
      if (this.reference[b] < FLOOR) this.reference[b] = Math.max(amplitude, FLOOR);
      // A band 30 dB below the loudest one is not part of the sound: what little is there is the other bands spilling over.
      const full = this.reference[b], absent = full < top * .03, scaled = (a: number) => a < SILENCE || absent ? 0 : Math.min(2, (a / full) ** .7);
      now[b] = scaled(amplitude); flux[b] = now[b] - scaled(this.last[b]); this.last[b] = amplitude;
      this.reference[b] = amplitude > full ? full + (amplitude - full) * (1 - Math.exp(-dt / .35)) : Math.max(FLOOR, full * Math.exp(-dt / 8));
      this.level[b] = now[b] > this.level[b] ? now[b] : this.level[b] + (now[b] - this.level[b]) * (1 - Math.exp(-dt / RELEASE[b]));
      // When the sound stops there is nothing left to be louder or quieter than: the light goes back to where the
      // picture has it within a moment, instead of staying lowered for as long as the memory of the sound lasts.
      this.centre[b] += (this.level[b] - this.centre[b]) * (1 - Math.exp(-dt / (this.quiet > .4 ? .25 : 2.5)));
    }
    this.quiet = loudest < SILENCE ? this.quiet + dt : 0;
    // A beat: the bass jumps, and is well above where it has been. A blast: bass and mids jump together, near their peak.
    const jump = lerp(.3, .08, s.sensitivity / 100);
    this.sinceBeat += dt;
    this.beat *= Math.exp(-dt / .2); this.impact *= Math.exp(-dt / .4);
    for (const hit of this.hits) hit.age += dt;
    if (this.hits.length && this.hits[0].age > 1.5) this.hits.shift();
    if (flux[0] > jump && now[0] > this.centre[0] + jump / 2 && this.sinceBeat > (calm ? 1 / 3 : .18)) {
      this.beat = 1; this.sinceBeat = 0; this.beats++;
      const blast = flux[1] > jump && now[0] > .75 && now[1] > .6;
      // A harder hit lifts more: from seven tenths for one that only just counts to one and a third for a big one.
      this.hits.push({ age: 0, strength: clamp(.55 + flux[0], .7, 1.3), blast }); if (this.hits.length > 6) this.hits.shift();
      if (blast) this.impact = 1;
    }
    // Each band is judged against itself, which says nothing about which band the sound is made of. This does.
    const loud = Math.max(...this.reference), share = this.reference.map(r => r <= FLOOR || r < loud * .03 ? 0 : Math.sqrt(r / loud)) as [number, number, number];
    for (const past of this.bass) past.age += dt;
    while (this.bass.length && this.bass[this.bass.length - 1].age > TRAVEL + .1) this.bass.pop();
    this.bass.unshift({ age: 0, swing: this.swing(0, share) });
    return this.frame = { low: this.level[0], mid: this.level[1], high: this.level[2], beat: this.beat, impact: this.impact, onset: this.sinceBeat === 0, share, silent: this.quiet > .4 };
  }
  /** How far a band is from its recent level, as it counts for the light: a fall counts for more than a rise. */
  private swing(b: number, share: readonly number[]): number { const d = this.level[b] - this.centre[b]; return (d > 0 ? d : d * DIP) * share[b]; }
  /**
   * What to multiply each zone's light by, for `count` zones (top, bottom, left, right). 1 = leave it alone.
   * Bass leans to the bottom edge and treble to the top, with the sides in between, the way a room answers sound.
   *
   * Pulse Depth is about what is seen: at 40% a zone is shown up to 1.6 times as strongly on a beat and down to about
   * three quarters in between. The light itself has to change by the square of that to show it (see the top of this file).
   */
  gains(count: number, s: PulseSettings, out: Float32Array = new Float32Array(count)): Float32Array {
    if (out.length !== count) out = new Float32Array(count);
    if (this.lift.length !== count) this.lift = new Float32Array(count);
    const depth = s.depth / 100, n = count / 4, share = this.frame.share, reach = TRAVEL * s.wave / 100;
    const mid = (this.swing(1, share) + this.impact * .6) * s.mid / 100, high = this.swing(2, share) * 1.2 * s.treble / 100;
    for (let zone = 0; zone < count; zone++) {
      const side = Math.floor(zone / n), t = (zone % n + .5) / n, down = side === 0 ? 0 : side === 1 ? 1 : t;
      // How far along the edge this zone is from the bottom centre, where a beat starts.
      const far = (side === 1 ? Math.abs(t - .5) * 2 * HALF : side === 0 ? HALF + SIDE + (1 - Math.abs(t - .5) * 2) * HALF : HALF + (1 - t) * SIDE) / PATH;
      // The bass as it was when it set out from the bottom centre: its level against its recent one, and its beats.
      // (The two zones either side of the bottom centre are where it starts: they answer in the very frame of the beat.)
      const delay = reach * Math.max(0, far - HALF / n / PATH); let beat = 0, blast = 0, low = 0;
      for (const hit of this.hits) {
        const age = hit.age - delay;
        if (age >= 0) { beat += hit.strength * struck(age); if (hit.blast) blast = Math.max(blast, Math.exp(-age / .4)); }
      }
      for (const past of this.bass) if (past.age >= delay - 1e-9) { low = past.swing; break; }
      // A blast is bass and mids together, so it answers to those two amounts like everything else does. Its bass travels
      // with the beat it came with; its mids are everywhere at once.
      const bass = (low * 1.2 + beat * share[0] + blast * .8) * s.bass / 100;
      const pulse = lerp(.55, 1, down) * bass + lerp(.7, .6, down) * mid + lerp(1, .3, down) * high;
      const shown = clamp(1 + depth * pulse, 1 - DOWN * depth, 1 + UP * depth);
      out[zone] = shown * shown;
      this.lift[zone] = clamp(depth * pulse * .45, 0, .85);
    }
    return out;
  }
  /**
   * Beat Bloom: how far each edge's light swells into the page on a beat, per side (top, bottom, left, right), 0–1 of
   * the most the Beat Bloom setting allows. The bottom edge swells on the beat, the sides and the top when the beat
   * gets there (Beat Wave). Opacity can only change what is already lit; this moves the light itself.
   */
  bloom(s: PulseSettings, out: Float32Array = new Float32Array(4)): Float32Array {
    const reach = TRAVEL * s.wave / 100, amount = s.bloom / 100 * Math.min(1, s.depth / 40) * s.bass / 100 * this.frame.share[0];
    for (let side = 0; side < 4; side++) {
      // Where along the path the middle of this edge is: the bottom at the start, a side half-way up, the top a quarter from its centre.
      const delay = reach * (side === 1 ? 0 : side === 0 ? (HALF + SIDE + HALF / 2) / PATH : (HALF + SIDE / 2) / PATH);
      let swell = 0;
      for (const hit of this.hits) { const age = hit.age - delay; if (age >= 0) swell += (hit.blast ? 1.3 : hit.strength) * Math.exp(-age / .22); }
      out[side] = clamp(swell) * amount;
    }
    return out;
  }
}

function hue(h: number): RGB {
  const f = (n: number) => { const k = (n + h * 6) % 6; return 1 - Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}
/**
 * Music Mode: colours from the sound alone, for `count` zones. Warm along the bottom where the bass sits, cool along the
 * top where the treble does; the whole palette sways a little, slowly, so it never stands still. Each edge is as bright
 * as the bands it listens to.
 * This is the steady part; beats move it through `gains` like any other light. Silence is dark.
 */
export function musicColors(frame: PulseFrame, count: number, seconds: number): RGB[] {
  const n = count / 4;
  return Array.from({ length: count }, (_, zone): RGB => {
    if (frame.silent) return [0, 0, 0];
    const side = Math.floor(zone / n), t = (zone % n + .5) / n, down = side === 0 ? 0 : side === 1 ? 1 : t, across = side < 2 ? t : side - 2;
    const band = (level: number, i: number) => Math.min(1, level) * frame.share[i];
    const loud = (lerp(.3, 1, down) * band(frame.low, 0) + .6 * band(frame.mid, 1) + lerp(1, .25, down) * band(frame.high, 2)) / (lerp(.3, 1, down) + .6 + lerp(1, .25, down));
    const [r, g, b] = hue((lerp(.62, .02, down) + (across - .5) * .12 + .05 * Math.sin(seconds * Math.PI / 20) + 1) % 1), light = .06 + .94 * loud;
    return [gamma(r * light) * 255, gamma(g * light) * 255, gamma(b * light) * 255];
  });
}
