import { BarTracker, sampleZones, type Pixels } from '../engine/sampling';
import { LightDirector, mixLight } from '../engine/director';
import { tintProtection } from '../engine/color2';
import { sceneLuma } from '../engine/exposure';
import { QUALITY } from '../engine/adaptive';
import { GpuReader } from './gpu';
import type { ColorSettings, DirectorSettings, DirectorStats, Reader, Rect, RGB, TrailSettings } from '../shared/types';
export type ColorSpace = 'srgb' | 'display-p3';
/**
 * `luma`: how bright the whole picture is (mean perceptual lightness, 0–1). `readMs`: the part of `ms` spent getting the
 * pixels out of the video, and `reader` the way they were got. `settling`: this frame was read both ways to compare them,
 * which happens for the first frames of a video and takes longer than a frame will take from then on.
 */
export interface FrameResult { colors: RGB[]; ms: number; readMs: number; reader: Reader; settling: boolean; directorMs: number; black: boolean; stats: DirectorStats | null; luma: number }
/** How a frame is read. Everything left out reads it the way 0.7 did: base lighting only, sRGB, full quality. */
export interface SampleOptions {
  director?: DirectorSettings | null; trails?: TrailSettings | null; color?: ColorSettings | null;
  /** Index into QUALITY. */
  quality?: number;
  /** The colour space pixels are read in. display-p3 keeps colours of a wide-gamut video that sRGB would clip. */
  space?: ColorSpace;
}

/**
 * How far a reading of a picture (`reference`) is from another way of reading it, taken just `before` and just `after`:
 * the largest distance, over blocks (8 across, 8 down) and channels, of the reference's mean colour from the range the
 * other two span, in 8-bit steps. On a playing video the three readings can be of three different frames. The one in
 * the middle then lies between the outer two, or equals one of them across a cut, so only a real disagreement counts.
 */
export function readingGap(reference: Pixels, before: Pixels, after: Pixels = before): number {
  if (reference.width !== before.width || reference.height !== before.height || after.width !== before.width || after.height !== before.height) return 255;
  const N = 8, w = reference.width, h = reference.height, r = reference.data, a = before.data, b = after.data; let worst = 0;
  for (let by = 0; by < N; by++) for (let bx = 0; bx < N; bx++) {
    const x1 = Math.floor((bx + 1) * w / N), y1 = Math.floor((by + 1) * h / N), sum = [0, 0, 0, 0, 0, 0, 0, 0, 0]; let count = 0;
    for (let y = Math.floor(by * h / N); y < y1; y += 2) for (let x = Math.floor(bx * w / N), i = (y * w + x) * 4; x < x1; x += 2, i += 8) {
      for (let c = 0; c < 3; c++) { sum[c] += r[i + c]; sum[3 + c] += a[i + c]; sum[6 + c] += b[i + c]; }
      count++;
    }
    for (let c = 0; c < 3 && count; c++) {
      const mean = sum[c] / count, low = Math.min(sum[3 + c], sum[6 + c]) / count, high = Math.max(sum[3 + c], sum[6 + c]) / count;
      worst = Math.max(worst, low - mean, mean - high);
    }
  }
  return worst;
}
/**
 * The GPU's reading is used only where it gives what the canvas gives: block means within one 8-bit step. Measured on
 * files and streamed video (H.264, VP8, VP9; 480p to 4K), the two differ by at most one step in single pixels and by
 * less than 0.1 in block means, so the light is the same whichever way a frame was read.
 */
const SAME = 1;
/** How long the GPU's reading is left alone after it disagreed three times. Doubles each time, up to a minute. */
const RETRY = 2000;
/** Whether there is enough picture to compare: something clearly brighter than black among every 16th pixel of every 4th row. */
function lit(f: Pixels): boolean {
  for (let y = 0; y < f.height; y += 4) for (let x = 0, i = y * f.width * 4; x < f.width; x += 16, i += 64)
    if (f.data[i] > 48 || f.data[i + 1] > 48 || f.data[i + 2] > 48) return true;
  return false;
}

export class FrameSampler {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  private space: ColorSpace = 'srgb';
  private bars = new BarTracker(); private director = new LightDirector();
  private directed = false; private turn = 0; private analysedAt = 0;
  private gpu = new GpuReader(); private width = 0; private height = 0;
  // The GPU's reading is used for a video only once it has been seen to match the canvas's reading of the same video.
  private checked = ''; private misses = 0; private retryAt = 0; private wait = RETRY;
  /** The 2D canvas: the reference way. Chrome copies the whole decoded frame out of the GPU for it. */
  private draw(video: HTMLVideoElement, r: Rect, w: number, h: number, space: ColorSpace): Pixels {
    if (space !== this.space) {
      // A canvas keeps the colour space it was first given, so another space needs another canvas.
      this.canvas = document.createElement('canvas'); this.space = space;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true, colorSpace: space })!;
    }
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.ctx.drawImage(video, r.x, r.y, r.width, r.height, 0, 0, w, h);
    return this.ctx.getImageData(0, 0, w, h);
  }
  private pixels(video: HTMLVideoElement, r: Rect, w: number, h: number, space: ColorSpace): { frame: Pixels; reader: Reader; settling?: boolean } {
    const key = `${video.videoWidth}x${video.videoHeight}:${space}`, now = performance.now();
    // A live stream (a captured canvas or tab, a camera, a call) is left to the canvas: read through the GPU, a captured
    // canvas came out about half a step brighter and differently along sharp edges. Files and streamed video did not.
    const tried = key === this.checked || now >= this.retryAt && !video.srcObject;
    const fast = tried && this.gpu.available ? this.gpu.read(video, r, w, h, space) : null;
    if (!fast) return { frame: this.draw(video, r, w, h, space), reader: 'canvas' };
    if (key === this.checked) return { frame: fast, reader: 'gpu' };
    // First frames of this video (or of this size of it): the canvas's reading is the one used, with the GPU's taken
    // just before and just after it for comparison.
    const before = { width: w, height: h, data: fast.data.slice() }, frame = this.draw(video, r, w, h, space);
    // Two black pictures are alike whatever went wrong, so a dark frame settles nothing. Look again in half a second.
    if (!lit(frame)) { this.retryAt = now + 500; return { frame, reader: 'canvas', settling: true }; }
    const after = this.gpu.read(video, r, w, h, space);
    if (after && readingGap(frame, before, after) <= SAME) { this.checked = key; this.misses = 0; this.wait = RETRY; }
    // Three disagreements in a row are not three unlucky frames: the GPU reads this video differently (an HDR video is
    // tone-mapped another way, for one). The canvas goes on reading it, and the comparison is repeated ever more rarely.
    else if (++this.misses >= 3) { this.misses = 0; this.retryAt = now + this.wait; this.wait = Math.min(60000, this.wait * 2); }
    return { frame, reader: 'canvas', settling: true };
  }
  read(video: HTMLVideoElement, count: number, region?: Rect, options: SampleOptions = {}): FrameResult {
    const start = performance.now(), q = QUALITY[options.quality || 0] || QUALITY[0], space = options.space || 'srgb';
    const r = region || { x: 0, y: 0, width: video.videoWidth, height: video.videoHeight };
    const w = q.width, h = Math.max(64, Math.min(192, Math.round(w * r.height / r.width)));
    if (this.width !== w || this.height !== h) { this.width = w; this.height = h; this.bars.reset(); }
    const { frame, reader, settling = false } = this.pixels(video, r, w, h, space), readMs = performance.now() - start, picture = this.bars.update(frame);
    let colors = sampleZones(frame, count, picture, tintProtection(options.color)), directorMs = 0, stats: DirectorStats | null = null;
    const director = options.director;
    if (director?.enabled) {
      const began = performance.now();
      // Under load the Light Director looks at every other frame and holds its light in between.
      if (this.turn++ % q.every === 0) {
        colors = mixLight(colors, this.director.analyse(frame, picture, count, director, (began - this.analysedAt) / 1000, q.stride, options.trails));
        this.analysedAt = began;
      } else colors = mixLight(colors, this.director.last);
      this.directed = true; stats = this.director.stats; directorMs = performance.now() - began;
    } else if (this.directed) { this.director.reset(); this.directed = false; }
    let max = 0;
    for (let i = 0, data = frame.data; i < data.length && max < 9; i += 4) {
      if (data[i] > max) max = data[i];
      if (data[i + 1] > max) max = data[i + 1];
      if (data[i + 2] > max) max = data[i + 2];
    }
    const luma = sceneLuma(frame, picture);
    return { colors, ms: performance.now() - start, readMs, reader, settling, directorMs, black: max < 9, stats, luma };
  }
  reset(): void { this.canvas.width = 1; this.canvas.height = 1; this.width = this.height = 0; this.bars.reset(); this.director.reset(); this.turn = 0; this.checked = ''; this.misses = 0; this.retryAt = 0; this.wait = RETRY; }
  /** Also gives the GPU context back. For when nothing is being read any more. */
  close(): void { this.reset(); this.gpu.close(); }
}
