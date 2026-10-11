import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, MODES, autoZoneCount, glowDepth, sanitize } from '../src/shared/settings.ts';
import { BarTracker, detectBars, safeCaptureRect, sampleZones, type Pixels } from '../src/engine/sampling.ts';
import { fromLab, luminance, toLab } from '../src/engine/color.ts';
import { TemporalFilter } from '../src/engine/temporal.ts';
import { cornerTaper, edgeFilters, emission, glowProfile, ledRow } from '../src/engine/emission.ts';
import type { RGB } from '../src/shared/types.ts';
import { captureBlockReason, lightingPath } from '../src/shared/capture-policy.ts';
import { serviceName } from '../src/capture/video.ts';
import { sitePattern } from '../src/shared/site.ts';
const frame = (w: number, h: number, color: (x: number, y: number) => RGB): Pixels => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([...color(x, y), 255], (y * w + x) * 4);
  return { width: w, height: h, data };
};
test('64 local zones preserve left/right color and every side orientation', () => {
  const f = frame(256, 144, (x, y) => [x, y, 0]); const zones = sampleZones(f, 64);
  assert.equal(zones.length, 64);
  assert.ok(zones[0][0] < zones[15][0]); assert.ok(zones[16][0] < zones[31][0]);
  assert.ok(zones[32][1] < zones[47][1]); assert.ok(zones[48][1] < zones[63][1]);
  assert.ok(zones[48][0] > 230); assert.ok(zones[32][0] < 20);
});
test('bar detection requires stable symmetric borders, not dark scenes or one-sided content', () => {
  const bars = frame(256, 144, (_, y) => y < 20 || y >= 124 ? [0, 0, 0] : [80, 130, 220]);
  assert.deepEqual(detectBars(bars), { x: 0, y: 20, width: 256, height: 104 });
  const tracker = new BarTracker();
  for (let i = 0; i < 11; i++) assert.equal(tracker.update(bars).y, 0);
  assert.equal(tracker.update(bars).y, 20);
  assert.equal(detectBars(frame(256, 144, () => [2, 2, 2])).y, 0);
  assert.equal(detectBars(frame(256, 144, (_, y) => y < 20 ? [0, 0, 0] : [90, 70, 120])).y, 0);
});
test('capture ROI never includes any illuminated perimeter at 16:9, 16:10, 21:9', () => {
  for (const [w, h] of [[1920, 1080], [1920, 1200], [3440, 1440]]) {
    for (const width of [2, 10, 20]) {
      const safe = safeCaptureRect({ x: 0, y: 0, width: w, height: h }, w, h, width)!;
      const depth = glowDepth(w, h, width);
      assert.ok(safe.x > depth); assert.ok(safe.y > depth);
      assert.ok(safe.x + safe.width < w - depth); assert.ok(safe.y + safe.height < h - depth);
    }
  }
  assert.equal(safeCaptureRect({ x: 0, y: 0, width: 80, height: 50 }, 1920, 1080, 20), null);
});
test('OKLab round trip keeps color to within a fraction of a channel', () => {
  for (const rgb of [[255, 0, 0], [0, 255, 0], [0, 0, 255], [50, 130, 220], [0, 0, 0], [255, 255, 255]] as RGB[])
    fromLab(toLab(rgb)).forEach((v, i) => assert.ok(Math.abs(v - rgb[i]) < .002));
});
test('flash limiter caps both rising and falling linear luminance at maximum brightness', () => {
  const s = { ...DEFAULTS, brightness: 100, mode: 'vivid' as const, smoothing: 0, responseSpeed: 200 };
  const filter = new TemporalFilter(); let previous = 0;
  for (let i = 0; i < 200; i++) {
    filter.setTarget(Array.from({ length: 64 }, () => i < 100 ? [255, 255, 255] : [0, 0, 0]), s);
    const l = luminance(filter.step(1/30, s)[0]);
    assert.ok(l - previous < .55 / 30 + .002); assert.ok(previous - l < .85 / 30 + .002);
    previous = l;
  }
  assert.ok(previous < .001);
});
test('sustained darkness fades to black, count changes are safe', () => {
  const f = new TemporalFilter(); f.setTarget(Array.from({ length: 64 }, () => [240, 100, 20]), DEFAULTS);
  for (let i = 0; i < 180; i++) f.step(1/30, DEFAULTS);
  f.setTarget(Array.from({ length: 128 }, () => [0, 0, 0]), DEFAULTS);
  assert.equal(f.step(1/30, DEFAULTS).length, 128);
  assert.deepEqual(f.step(1/30, DEFAULTS)[0], [0, 0, 0]);
});
test('monitor resolution drives auto zones with bounds and Retina scaling', () => {
  assert.equal(autoZoneCount(1920, 1080, 1), 64);
  assert.equal(autoZoneCount(2560, 1440, 1), 96);
  assert.equal(autoZoneCount(3840, 2160, 1), 128);
  assert.equal(autoZoneCount(1920, 1080, 2), 128);
  assert.equal(autoZoneCount(3440, 1440, 1), 96);
  assert.equal(autoZoneCount(7680, 4320, 1), 128);
  assert.equal(autoZoneCount(400, 300, 1), 32);
  assert.equal(autoZoneCount(NaN, 0, 0), 64);
});
test('very slow Ambient transitions keep running until the fixed light and blackout settle', () => {
  const s = { ...DEFAULTS, mode: 'ambient' as const, smoothing: 100, responseSpeed: 25 };
  const f = new TemporalFilter(); f.setTarget(Array.from({ length: 32 }, () => [200, 150, 100]), s);
  for (let i = 0; i < 120; i++) f.step(1/30, s);
  assert.equal(f.settled, false, 'A four-second idle timeout must not freeze a slow transition');
  for (let i = 0; i < 2400; i++) f.step(1/30, s);
  assert.equal(f.settled, true);
  f.setTarget(Array.from({ length: 32 }, () => [0, 0, 0]), s);
  let output;
  for (let i = 0; i < 2400; i++) output = f.step(1/30, s);
  assert.equal(f.settled, true); assert.ok(Math.max(...output![0]) < .01);
});
test('storage input is bounded and invalid enums cannot enter processing', () => {
  assert.deepEqual(sanitize(null), DEFAULTS);
  assert.equal(sanitize({ brightness: Infinity, glowWidth: 500, zoneCount: 9, manualColor: 'red', source: '__proto__' }).glowWidth, 20);
  assert.equal(sanitize({ zoneCount: 9 }).zoneCount, 64);
  assert.equal(sanitize({ preset: '__proto__' }).preset, 'warm');
});
test('protected playback and known subscription services never start tab capture', () => {
  const context = { rect: null, viewport: { width: 1920, height: 1080 }, paused: false, hidden: false, protected: false, fullscreenUnsupported: false };
  assert.equal(captureBlockReason(context, 'https://www.youtube.com/watch?v=example'), null);
  assert.equal(captureBlockReason(context, 'http://localhost:4173/'), null);
  for (const url of ['https://www.amazon.co.jp/gp/video/detail/example', 'https://www.netflix.com/watch/example', 'https://www.primevideo.com/']) assert.ok(captureBlockReason(context, url));
  assert.ok(captureBlockReason({ ...context, protected: true }, 'https://www.youtube.com/watch?v=example'));
  assert.equal(captureBlockReason(context, 'https://amazon.co.jp.example.org/'), null);
});
test('a zone becomes light: full-strength hue, opacity follows scene brightness, darkness is transparent', () => {
  assert.deepEqual(emission([0, 0, 0], 1), [0, 0, 0, 0]);
  assert.equal(emission([6, 5, 7], 1)[3], 0, 'near-black must not leave a dark film on the page');
  const dim = emission([30, 60, 120], 1), bright = emission([60, 120, 240], 1);
  assert.equal(Math.max(...dim.slice(0, 3)), 255); assert.equal(Math.max(...bright.slice(0, 3)), 255);
  assert.ok(Math.abs(dim[0] / dim[2] - 30 / 120) < 1e-9, 'hue is kept');
  assert.ok(bright[3] > dim[3] && dim[3] > 0);
  for (const mode of Object.values(MODES)) assert.ok(emission([255, 255, 255], mode.curve)[3] === 1);
  assert.ok(emission([60, 60, 60], MODES.cinema.curve)[3] < emission([60, 60, 60], MODES.vivid.curve)[3], 'Cinema holds dark scenes back');
});
test('LED row keeps side orientation, blends zones without dark seams, and brightness only changes opacity', () => {
  const zones = Array.from({ length: 64 }, (_, z) => (z < 16 ? (z < 8 ? [255, 0, 0] : [0, 0, 0]) : [0, 0, 255]) as RGB);
  const row = ledRow(zones, 0, 512, 1, 1), at = (i: number) => [...row.subarray(i * 4, i * 4 + 4)];
  assert.deepEqual(at(100), [255, 0, 0, 255]);
  assert.equal(at(400)[3], 0, 'dark zones emit nothing');
  for (let i = 0; i < 511; i++) assert.ok(Math.abs(row[i * 4 + 3] - row[i * 4 + 7]) < 12, 'no step between zones');
  const fading = at(256);
  assert.ok(fading[3] > 0 && fading[3] < 255); assert.ok(fading[0] > 250 && fading[1] < 5, 'a dark neighbour dims red, never muddies it');
  assert.ok(at(0)[2] > 20, 'the corner leans toward the adjacent side');
  const half = ledRow(zones, 0, 512, .5, 1);
  assert.deepEqual([...half.subarray(400, 403)], [255, 0, 0]); assert.ok(Math.abs(half[403] - 127.5) <= 1);
  assert.deepEqual([...ledRow(zones, 2, 512, 1, 1).subarray(1024, 1028)], [0, 0, 255, 255]);
});
test('glow is a full-strength strip at the edge that only ever fades inward, to nothing', () => {
  for (const spread of [0, .65, 1]) {
    assert.equal(glowProfile(0, .03, spread), 1); assert.equal(glowProfile(1, .03, spread), 0);
    let previous = 1;
    for (let t = 0; t <= 1; t += .005) { const v = glowProfile(t, .03, spread); assert.ok(v <= previous + 1e-9); previous = v; }
  }
  assert.ok(glowProfile(.3, .03, 1) > glowProfile(.3, .03, 0), 'Glow Intensity spreads the light further in');
  assert.ok(cornerTaper(0, 100) < 1); assert.equal(cornerTaper(100, 100), 1);
});
test('which light a tab gets: analysis where pixels may be read, the CSS path where they may not, honesty where neither works', () => {
  const windows = 'Windows', mac = 'macOS';
  for (const platform of [windows, mac, 'MacIntel', 'Linux']) {
    assert.equal(lightingPath('video', serviceName('www.youtube.com'), false, platform), 'analysis', 'YouTube keeps real zone analysis');
    assert.equal(lightingPath('video', serviceName('localhost'), false, platform), 'analysis');
    assert.equal(lightingPath('video', serviceName('netflix.com.example.org'), false, platform), 'analysis', 'look-alike hosts are not Netflix');
    assert.equal(lightingPath('compatibility', serviceName('www.youtube.com'), false, platform), 'compatibility', 'an explicit choice applies to readable video everywhere');
    // Unprotected video on a streaming site (a trailer) can still be composited.
    for (const host of ['www.netflix.com', 'www.primevideo.com', 'www.amazon.co.jp', 'www.amazon.com'])
      assert.equal(lightingPath('video', serviceName(host), false, platform), 'compatibility', host);
    for (const source of ['manual', 'preset', 'drift'] as const)
      assert.equal(lightingPath(source, 'Netflix', true, platform), 'fixed', 'fixed lighting chosen by the user is never overridden');
  }
  // Protected video: the CSS path where the browser composites it normally...
  assert.equal(lightingPath('video', 'Prime Video', true, windows), 'compatibility');
  assert.equal(lightingPath('video', serviceName('example.org'), true, 'Linux'), 'compatibility', 'encrypted media on any site');
  // ...but Chrome on macOS keeps it in a layer no page effect can see, so nothing may be claimed there.
  for (const platform of [mac, 'MacIntel']) {
    assert.equal(lightingPath('video', 'Prime Video', true, platform), 'unreadable');
    assert.equal(lightingPath('video', 'Netflix', true, platform), 'unreadable');
    assert.equal(lightingPath('video', serviceName('example.org'), true, platform), 'unreadable');
    assert.equal(lightingPath('compatibility', 'Prime Video', true, platform), 'unreadable', 'choosing the CSS path by hand cannot make it see the picture');
  }
  assert.equal(sanitize({ protectedLight: 'drift' }).protectedLight, 'drift'); assert.equal(sanitize({ protectedLight: 'video' }).protectedLight, 'off');
  assert.equal(sanitize({}).protectedLight, 'off', 'no light on protected video unless the user picks one');
});
test('"always light this site" covers exactly the page host and only web pages', () => {
  assert.equal(sitePattern('https://www.youtube.com/watch?v=abc#t=10'), 'https://www.youtube.com/*');
  assert.equal(sitePattern('https://www.netflix.com/watch/1'), 'https://www.netflix.com/*');
  assert.equal(sitePattern('http://localhost:4173/?page=2'), 'http://localhost/*');
  assert.notEqual(sitePattern('https://music.youtube.com/'), sitePattern('https://www.youtube.com/'), 'other subdomains are separate sites');
  for (const url of ['chrome://extensions', 'file:///Users/me/movie.mp4', 'about:blank', 'chrome-extension://abc/popup.html', '', 'not a url', undefined])
    assert.equal(sitePattern(url), null, String(url));
});
test('CSS-only light: each edge is blurred deep into the picture and little along itself, and is emitted as light', () => {
  const base = { width: 1920, height: 1080, depth: 160, curve: MODES.cinema.curve, saturation: 1 };
  const full = edgeFilters({ ...base, picture: { x: 0, y: 0, width: 1920, height: 1080 } });
  const blurs = (list: typeof full.rows) => list.filter(p => p.tag === 'feGaussianBlur').map(p => String(p.stdDeviation).split(' ').map(Number));
  for (const [along, deep] of blurs(full.rows)) { assert.ok(deep >= along * 4, 'top and bottom reach down into the picture'); assert.ok(deep >= 1080 * .2, 'far enough to cross a 2.39:1 letterbox bar'); }
  for (const [deep, along] of blurs(full.columns)) assert.ok(deep >= along * 4, 'left and right reach sideways into the picture');
  assert.equal(full.rows.some(p => p.tag === 'feOffset'), false, 'a picture that fills the screen needs no shift');
  assert.deepEqual(full.rows.at(-1), { tag: 'feComposite', in: 'colour', in2: 'shade', operator: 'arithmetic', k1: 0, k2: 1, k3: -1, k4: 0 },
    'opacity follows the brightest channel: darkness is transparent, never a black band');
  // A small player in a page: skip the known gaps, and light only the stretch of edge that faces the picture.
  const inPage = edgeFilters({ ...base, picture: { x: 320, y: 200, width: 1280, height: 720 } });
  const shift = (list: typeof full.rows, result: string) => { const p = list.find(p => p.result === result)!; return [p.dx, p.dy]; };
  assert.deepEqual(shift(inPage.rows, 'topSource'), [0, -200]); assert.deepEqual(shift(inPage.rows, 'bottomSource'), [0, 160]);
  assert.deepEqual(shift(inPage.columns, 'leftSource'), [-320, 0]); assert.deepEqual(shift(inPage.columns, 'rightSource'), [320, 0]);
  assert.deepEqual(inPage.span.rows.slice(1, 3), [320, 1600]); assert.deepEqual(inPage.span.columns.slice(1, 3), [200, 920]);
  assert.ok(inPage.span.rows[0] < 320 && inPage.span.rows[3] > 1600, 'the ends fade rather than stop');
  // Tone: black stays black, mid-tones are lifted to make up for the blur, and Vivid lifts more than Cinema.
  const table = (curve: number) => String(edgeFilters({ ...base, curve, picture: { x: 0, y: 0, width: 1920, height: 1080 } }).rows
    .find(p => p.tag === 'feComponentTransfer')!.children!.find(c => c.tag === 'feFuncR')!.tableValues).split(' ').map(Number);
  const cinema = table(MODES.cinema.curve), vivid = table(MODES.vivid.curve);
  assert.equal(cinema[0], 0); assert.ok(cinema.at(-1)! > .99); assert.ok(cinema[8] > .5);
  for (let i = 1; i < cinema.length; i++) { assert.ok(cinema[i] >= cinema[i - 1]); assert.ok(vivid[i] >= cinema[i]); }
});
