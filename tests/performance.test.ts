import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANALYSIS_BUDGET_MS, AdaptiveQuality, QUALITY } from '../src/engine/adaptive.ts';
import { readingGap } from '../src/capture/frame.ts';
import { LightDirector } from '../src/engine/director.ts';
import { DIRECTOR, TRAILS } from '../src/shared/settings.ts';
import type { Pixels } from '../src/engine/sampling.ts';

const feeder = (q: AdaptiveQuality) => { let now = 0; return (ms: number, frames: number) => { for (let i = 0; i < frames; i++) q.update(ms, now += 83); return q.level; }; };
const picture = (w: number, h: number, paint: (x: number, y: number) => [number, number, number]): Pixels => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, c = paint(x, y); data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255; }
  return { width: w, height: h, data };
};

test('quality levels: load never switches the Light Director off', () => {
  for (const level of QUALITY) {
    assert.ok(!('director' in level), 'no level carries a switch for it');
    assert.ok(level.stride >= 1 && level.every >= 1 && level.interval >= 1 && level.width >= 160);
  }
  assert.deepEqual(QUALITY.map(level => level.interval), [1, 1, 1, 2], 'only the last level analyses less often');
});

test('adaptive quality: frames a little over the limit make the analysis coarser but do not halve its rate', () => {
  // 9 ms is what reading a 1080p video through a 2D canvas costs. Up to 0.9.1 this ended at the last level for good.
  const q = new AdaptiveQuality(), feed = feeder(q);
  assert.equal(feed(9, 600), 2, 'coarser, and no further');
  assert.equal(feed(11.5, 600), 2, `still under the ${ANALYSIS_BUDGET_MS} ms that the last level takes`);
  assert.equal(feed(13, 80), 3, 'over it, the rate is halved');
  assert.equal(feed(11, 400), 3, 'and stays halved while frames are within 1.5 ms of that');
  assert.equal(feed(9, 80), 2, 'under it, the full rate comes back first');
});

test('adaptive quality: a lost level comes back at frame times a real video can reach', () => {
  const q = new AdaptiveQuality(), feed = feeder(q);
  assert.equal(feed(9, 600), 2);
  // 5 ms: more than the 3.5 ms that was needed up to 0.9.1, which reading the video alone could exceed.
  assert.equal(feed(5, 60), 2, 'not at once');
  assert.equal(feed(5, 30), 1); assert.equal(feed(5, 200), 0, 'all the way back');
  assert.equal(feed(7, 600), 0, 'and 7 ms is no reason to leave full quality');
});

test('reading check: the same picture read another way matches, a wrong reading does not', () => {
  const scene = (shift: number) => picture(256, 144, (x, y) => [128 + 100 * Math.sin((x + shift) / 30), 90 + 60 * Math.cos(y / 22), (x + shift) % 256]);
  const a = scene(0), black = picture(256, 144, () => [0, 0, 0]);
  assert.equal(readingGap(a, scene(0)), 0);
  // Rounding and filtering differences between two ways of reading: a step or two per pixel.
  const rounded = picture(256, 144, (x, y) => { const i = (y * 256 + x) * 4; return [a.data[i] + (x + y) % 3 - 1, a.data[i + 1] + (x * 7 + y) % 3 - 1, a.data[i + 2]]; });
  assert.ok(readingGap(a, rounded) < 1, `rounding: ${readingGap(a, rounded)}`);
  // A playing video: the reference frame lies between the two other readings, however fast the picture moves.
  assert.ok(readingGap(scene(3), scene(0), scene(6)) <= 6, `a fast pan, a frame either side: ${readingGap(scene(3), scene(0), scene(6))}`);
  assert.equal(readingGap(scene(3), scene(3), scene(6)), 0, 'the usual case: the reference is the frame one of the two others read');
  assert.equal(readingGap(a, black, scene(0)), 0, 'a cut right after the reference frame');
  assert.equal(readingGap(a, scene(0), black), 0, 'a cut right before it');
  assert.ok(readingGap(a, black, black) > 60, 'a black reading');
  const flipped = picture(256, 144, (x, y) => { const i = ((143 - y) * 256 + x) * 4; return [a.data[i], a.data[i + 1], a.data[i + 2]]; });
  assert.ok(readingGap(a, flipped, flipped) > 6, 'an upside-down reading');
  const swapped = picture(256, 144, (x, y) => { const i = (y * 256 + x) * 4; return [a.data[i + 2], a.data[i + 1], a.data[i]]; });
  assert.ok(readingGap(a, swapped, swapped) > 6, 'red and blue swapped');
  const dim = picture(256, 144, (x, y) => { const i = (y * 256 + x) * 4; return [a.data[i] * .85, a.data[i + 1] * .85, a.data[i + 2] * .85]; });
  assert.ok(readingGap(a, dim, dim) > 6, 'the same picture at another brightness (another tone mapping)');
  const brighter = picture(256, 144, (x, y) => { const i = (y * 256 + x) * 4; return [a.data[i] + 2, a.data[i + 1] + 2, a.data[i + 2] + 2]; });
  assert.ok(readingGap(a, brighter, brighter) > 1, 'two steps brighter everywhere: more than the one step that counts as the same');
  assert.equal(readingGap(a, picture(192, 108, () => [0, 0, 0])), 255, 'another size');
});

test('Light Director: reading every other pixel finds the same light source', () => {
  // A lamp in a dark room, left of centre. Full and quarter reading must agree on where the light goes.
  const lamp = picture(256, 144, (x, y) => Math.hypot(x - 70, y - 50) < 10 ? [255, 220, 150] : [8, 8, 12]);
  const run = (stride: number) => {
    const d = new LightDirector(); let out: Float32Array = new Float32Array(0);
    for (let i = 0; i < 12; i++) out = d.analyse(lamp, { x: 0, y: 0, width: 256, height: 144 }, 64, { ...DIRECTOR, enabled: true }, 1 / 12, stride, TRAILS);
    return { out: Array.from(out), sources: d.stats.sources };
  };
  const full = run(1), quarter = run(2);
  assert.equal(full.sources, 1); assert.equal(quarter.sources, 1);
  const strongest = (v: number[]) => v.indexOf(Math.max(...v));
  assert.equal(Math.floor(strongest(full.out) / 3), Math.floor(strongest(quarter.out) / 3), 'the same zone is lit most');
  const peak = Math.max(...full.out);
  assert.ok(peak > .01, 'there is light');
  for (let i = 0; i < full.out.length; i++) assert.ok(Math.abs(full.out[i] - quarter.out[i]) < peak * .1, `zone value ${i}: ${full.out[i]} / ${quarter.out[i]}`);
});
