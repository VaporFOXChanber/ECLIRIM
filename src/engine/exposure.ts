import type { ExposureSettings, Rect } from '../shared/types';
import { clamp } from '../shared/settings';
import { linear } from './color';
import type { Pixels } from './sampling';

const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const LINEAR = Float32Array.from({ length: 256 }, (_, i) => linear(i / 255));

/**
 * How bright a picture is as a whole: the mean perceptual lightness (0–1) of every `stride`th pixel of the region.
 * Lightness, not light: a small lamp in a night scene leaves the scene dark, as it does for the eye.
 */
export function sceneLuma(f: Pixels, region: Rect, stride = 4): number {
  const x0 = Math.max(0, Math.floor(region.x)), x1 = Math.min(f.width, Math.ceil(region.x + region.width));
  const y0 = Math.max(0, Math.floor(region.y)), y1 = Math.min(f.height, Math.ceil(region.y + region.height));
  let sum = 0, count = 0;
  for (let y = y0; y < y1; y += stride) for (let x = x0; x < x1; x += stride) {
    const i = (y * f.width + x) * 4;
    sum += Math.cbrt(.2126 * LINEAR[f.data[i]] + .7152 * LINEAR[f.data[i + 1]] + .0722 * LINEAR[f.data[i + 2]]); count++;
  }
  return count ? sum / count : 0;
}

/** Scenes darker than this are dark all the way; the holding back of bright zones fades out up to the second value. */
const DARK = [.22, .45] as const;
/** From the first value on a scene counts as bright; at the second it is as bright as scenes get. */
const BRIGHT = [.58, .85] as const;

/**
 * Adaptive Brightness. It follows how bright the whole picture is (`key`), slowly, and from that decides two things.
 * In a dark scene the brightest zones are held back, so the light does not flood a picture the eye has adapted to, while
 * dim zones are left exactly as they are: dark colours keep glowing darkly. In a bright scene all of the light is
 * lowered, which takes the glare away and keeps bright zones from all ending up at full strength.
 * Scenes in between are not touched. What comes out still passes the time smoothing and the Flash Limiter.
 */
export class AutoExposure {
  /** Below 0: no picture seen yet. */
  key = -1;
  update(luma: number, dt: number, s: ExposureSettings): void {
    if (!Number.isFinite(luma)) return;
    // The first picture, and the first one after a long gap (a pause, another video), is taken as it is.
    if (this.key < 0 || !(dt >= 0) || dt > 3) { this.key = clamp(luma); return; }
    // A cut to a very different scene is followed faster than a slow change within one.
    const tau = (2.4 - 2 * s.speed / 100) * (Math.abs(luma - this.key) > .25 ? .35 : 1);
    this.key += (clamp(luma) - this.key) * (1 - Math.exp(-dt / tau));
  }
  /**
   * What a zone of OKLab lightness `l` is multiplied by (all three components, so its hue stays).
   * The factors are in lightness, which is close to how bright the light looks. (In physical light they would be
   * much smaller numbers, and the tone mapping further on compresses bright zones, so a quarter less lightness shows
   * as about a fifth less opacity of a fully lit zone.)
   */
  scale(l: number, s: ExposureSettings): number {
    if (this.key < 0) return 1;
    const dark = 1 - smooth(DARK[0], DARK[1], this.key), bright = smooth(BRIGHT[0], BRIGHT[1], this.key);
    // The cube keeps the holding back to zones that really are bright (a zone at a third of full lightness loses under 1%),
    // and a brighter zone still never comes out darker than a dimmer one.
    return (1 - .5 * s.bright / 100 * bright) / (1 + .5 * s.dark / 100 * dark * l * l * l);
  }
  /** What the lightness of a fully bright zone is multiplied by right now (1 = untouched). */
  level(s: ExposureSettings): number { return this.scale(1, s); }
  reset(): void { this.key = -1; }
}
