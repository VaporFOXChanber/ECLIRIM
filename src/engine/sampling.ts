import type { Rect, RGB } from '../shared/types';
import { gamma, linear } from './color';
import { glowDepth } from '../shared/settings';
export interface Pixels { width: number; height: number; data: Uint8ClampedArray }
const full = (f: Pixels): Rect => ({ x: 0, y: 0, width: f.width, height: f.height });
const LINEAR = Float32Array.from({ length: 256 }, (_, i) => linear(i / 255));

// Only symmetric, nearly uniform black borders are candidates. Never crop a dark scene.
export function detectBars(f: Pixels): Rect {
  const { width: w, height: h, data } = f;
  const black = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return Math.max(data[i], data[i + 1], data[i + 2]) < 9;
  };
  let lit = 0;
  for (let y = Math.floor(h * .3); y < h * .7; y += 3)
    for (let x = Math.floor(w * .3); x < w * .7; x += 3) if (!black(x, y)) lit++;
  if (lit < w * h / 300) return full(f);
  const row = (y: number) => {
    let n = 0; for (let x = 0; x < w; x++) if (black(x, y)) n++;
    return n / w > .995;
  };
  let top = 0, bottom = 0;
  while (top < h * .24 && row(top)) top++;
  while (bottom < h * .24 && row(h - 1 - bottom)) bottom++;
  const yy = top >= 2 && Math.abs(top - bottom) <= 2 ? Math.min(top, bottom) : 0;
  const col = (x: number) => {
    let n = 0; for (let y = yy; y < h - yy; y++) if (black(x, y)) n++;
    return n / (h - yy * 2) > .995;
  };
  let left = 0, right = 0;
  while (left < w * .24 && col(left)) left++;
  while (right < w * .24 && col(w - 1 - right)) right++;
  const xx = left >= 2 && Math.abs(left - right) <= 2 ? Math.min(left, right) : 0;
  return { x: xx, y: yy, width: w - xx * 2, height: h - yy * 2 };
}
export class BarTracker {
  private candidate = ''; private hits = 0; private rect: Rect | null = null;
  update(f: Pixels): Rect {
    const next = detectBars(f), key = JSON.stringify(next);
    this.hits = key === this.candidate ? this.hits + 1 : 1;
    this.candidate = key;
    if (!this.rect || this.hits >= 12) this.rect = this.hits >= 12 ? next : full(f);
    // Full dark frames must stay dark, regardless of the retained crop.
    return this.rect;
  }
  reset(): void { this.rect = null; this.hits = 0; this.candidate = ''; }
}

// Ordering: top L→R, bottom L→R, left T→B, right T→B.
// `protect` (0–1, Color Engine 2.0): how far a zone's colour comes from its colourful pixels instead of from all of them.
// Its brightness always comes from all of them, so a white highlight or a grey wall in the zone no longer washes the colour out.
export function sampleZones(f: Pixels, count: number, region: Rect = full(f), protect = 0): RGB[] {
  const n = count / 4, depthX = Math.max(2, region.width * .13), depthY = Math.max(2, region.height * .13);
  const average = (x: number, y: number, width: number, height: number): RGB => {
    const sum: RGB = [0, 0, 0], tint: RGB = [0, 0, 0]; let total = 0;
    for (let py = Math.max(0, Math.floor(y)); py < Math.min(f.height, Math.ceil(y + height)); py++) {
      for (let px = Math.max(0, Math.floor(x)); px < Math.min(f.width, Math.ceil(x + width)); px++) {
        const i = (py * f.width + px) * 4;
        // Light adds up linearly: a small bright subject should outweigh the dark around it.
        const r = LINEAR[f.data[i]], g = LINEAR[f.data[i + 1]], b = LINEAR[f.data[i + 2]];
        sum[0] += r; sum[1] += g; sum[2] += b; total++;
        if (protect) {
          // A pixel counts toward the colour by how colourful it is. The small constant keeps dark noise from counting.
          const top = Math.max(r, g, b), w = (top - Math.min(r, g, b)) / (top + .05);
          tint[0] += r * w; tint[1] += g * w; tint[2] += b * w;
        }
      }
    }
    if (!total) return [0, 0, 0];
    const mean = sum.map(v => v / total) as RGB, strongest = Math.max(tint[0], tint[1], tint[2]);
    if (protect && strongest > 1e-6) {
      const k = Math.max(mean[0], mean[1], mean[2]) / strongest;
      for (let c = 0; c < 3; c++) mean[c] += (tint[c] * k - mean[c]) * protect;
    }
    return mean.map(v => gamma(v) * 255) as RGB;
  };
  return Array.from({ length: count }, (_, z) => {
    const side = Math.floor(z / n), t = (z % n) / n;
    if (side < 2) return average(region.x + t * region.width,
      region.y + (side === 1 ? region.height - depthY : 0), region.width / n, depthY);
    return average(region.x + (side === 3 ? region.width - depthX : 0),
      region.y + t * region.height, depthX, region.height / n);
  });
}

// Renderer has a finite cutoff; sample strictly inside it to prevent optical feedback.
export function safeCaptureRect(rect: Rect, width: number, height: number, glowPercent: number): Rect | null {
  const inset = glowDepth(width, height, glowPercent) + 4;
  const x = Math.max(rect.x, inset), y = Math.max(rect.y, inset);
  const right = Math.min(rect.x + rect.width, width - inset);
  const bottom = Math.min(rect.y + rect.height, height - inset);
  return right - x >= 32 && bottom - y >= 24 ? { x, y, width: right - x, height: bottom - y } : null;
}
