import type { ColorSettings, RGB } from '../shared/types';
import { clamp } from '../shared/settings';
import { gamma, labToLinear } from './color';

/**
 * Color Engine 2.0. Every function takes the colour settings, and with the engine off (or null) returns exactly what 0.8 did,
 * so the old look is one switch away.
 *
 *  - dark scenes: a lower black point and a gentler toe, so a dim colour gives a dim light of that colour instead of none;
 *    below visibility, where a hue is only sensor noise, the colour is let go to neutral instead of being amplified;
 *  - bright scenes: opacity rolls off toward full instead of clipping, so bright zones still differ from each other;
 *    a zone's colour is taken from where it is colourful, so a white highlight inside it does not wash the colour out;
 *  - saturation: muted colours gain more than vivid ones, and a colour too vivid for the display is brought back along
 *    its own hue instead of being clipped channel by channel (which shifts the hue).
 */
const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const on = (c: ColorSettings | null | undefined): c is ColorSettings => !!c?.enabled;

/** How hard a virtual LED is driven (0–1) for a colour whose strongest channel is `peak` (0–1, display-encoded). */
export function drive(peak: number, curve: number, c?: ColorSettings | null): number {
  if (!on(c)) return clamp((peak - .03) / .97) ** curve;
  const lift = c.shadows / 100, black = .03 - .018 * lift, x = clamp((peak - black) / (1 - black));
  // The second term lifts the low end only: it is zero at both ends, so black stays black and full stays full.
  return x ** curve + lift * .5 * x * (1 - x) ** 3;
}

/**
 * LED opacity for drive × gain. 0.8 clipped at 1, so everything driven past full looked the same. Here everything above
 * the knee is compressed and only approaches 1, slowly enough that twice-overdriven zones can still be told apart.
 */
export function shoulder(x: number, c?: ColorSettings | null): number {
  if (!on(c)) return Math.min(1, x);
  const knee = .9 - .4 * c.highlights / 100, over = (x - knee) / (1 - knee);
  return x <= knee ? x : knee + (1 - knee) * over / (1 + over);
}

/** OKLab lightness of a target colour, with the shadow toe applied. 0.8 squared everything below 0.2. */
export function shadowToe(l: number, c?: ColorSettings | null): number {
  if (l >= .2) return l;
  return l * (l / .2) ** (on(c) ? 1 - .7 * c.shadows / 100 : 1);
}

/**
 * What to multiply a colour's OKLab chroma by (on top of the Saturation setting). `l` is its lightness, `chroma` its
 * colourfulness. Muted colours gain more than vivid ones, dim ones a little more still (a dim colour looks less colourful
 * than it is), and below about 1% of full brightness, where a hue is only noise, the colour fades to neutral.
 */
export function chromaGain(l: number, chroma: number, c?: ColorSettings | null): number {
  if (!on(c)) return 1;
  const vibrance = c.vibrance / 100;
  return (1 + vibrance * (.6 * (1 - smooth(0, .22, chroma)) + .25 * (1 - clamp(l / .5)))) * smooth(.09, .15, l);
}

/**
 * How much of a step toward a new colour the hue takes, relative to the brightness. In a dim zone the hue wobbles with
 * noise, so small changes of it are taken more calmly. `far` is how far the hue has to go (OKLab chroma distance):
 * a real change of colour, as after a cut, goes at full speed, so no tint of the scene before is left behind.
 */
export function hueCalm(l: number, far: number, c?: ColorSettings | null): number {
  if (!on(c)) return 1;
  const calm = .4 + .6 * smooth(.15, .4, l);
  return calm + (1 - calm) * smooth(.015, .06, far);
}

/** How strongly a zone's colour is taken from its colourful pixels rather than from all of them (0 = plain average). */
export const tintProtection = (c?: ColorSettings | null): number => on(c) ? .8 * c.highlights / 100 : 0;

const fits = (rgb: RGB) => rgb[0] >= -1e-4 && rgb[1] >= -1e-4 && rgb[2] >= -1e-4 && rgb[0] <= 1.0001 && rgb[1] <= 1.0001 && rgb[2] <= 1.0001;
/**
 * OKLab → display RGB (0–255) for a colour that may be too vivid for the display. The chroma is backed off until it fits;
 * lightness and hue stay where they were.
 */
export function fromLabInGamut([L, a, b]: RGB): RGB {
  let rgb = labToLinear(L, a, b);
  if (!fits(rgb)) {
    let low = 0, high = 1;
    for (let i = 0; i < 10; i++) { const mid = (low + high) / 2; if (fits(labToLinear(L, a * mid, b * mid))) low = mid; else high = mid; }
    rgb = labToLinear(L, a * low, b * low);
  }
  return rgb.map(v => clamp(gamma(Math.max(0, v))) * 255) as RGB;
}
