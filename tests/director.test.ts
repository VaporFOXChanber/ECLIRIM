import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LightDirector, mixLight } from '../src/engine/director.ts';
import { TemporalFilter } from '../src/engine/temporal.ts';
import { luminance } from '../src/engine/color.ts';
import type { Pixels } from '../src/engine/sampling.ts';
import { DEFAULTS, DIRECTOR } from '../src/shared/settings.ts';
import type { DirectorSettings, RGB } from '../src/shared/types.ts';

const W = 256, H = 144, FULL = { x: 0, y: 0, width: W, height: H }, DT = 1 / 12;
type Light = { x: number; y: number; r?: number; color?: RGB };
// A dark picture with round lights in it. Positions are fractions of the picture, radius is in pixels.
const scene = (lights: Light[] = [], background: (x: number, y: number) => RGB = () => [6, 6, 8], noise = 0): Pixels => {
  const data = new Uint8ClampedArray(W * H * 4); let seed = 7;
  const jitter = () => noise ? ((seed = seed * 16807 % 2147483647) % (noise * 2 + 1)) - noise : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const lit = lights.find(l => Math.hypot(x + .5 - l.x * W, y + .5 - l.y * H) <= (l.r ?? 16));
    const c = lit ? lit.color || [255, 240, 200] : background(x, y);
    data.set([c[0] + jitter(), c[1] + jitter(), c[2] + jitter(), 255], (y * W + x) * 4);
  }
  return { width: W, height: H, data };
};
const lum = (out: Float32Array, zone: number) => .2126 * out[zone * 3] + .7152 * out[zone * 3 + 1] + .0722 * out[zone * 3 + 2];
const total = (out: Float32Array) => out.reduce((n, v) => n + v, 0);
const play = (director: LightDirector, frames: Pixels[], d: DirectorSettings = DIRECTOR, count = 64) => {
  let out: Float32Array = new Float32Array(0);
  for (const f of frames) out = director.analyse(f, FULL, count, d, DT);
  return out;
};
const repeat = (f: Pixels, n: number) => Array.from({ length: n }, () => f);
// Zone order for 64 zones: top 0–15 (left→right), bottom 16–31, left 32–47 (top→bottom), right 48–63.
const along = (out: Float32Array, from: number) => {
  let sum = 0, at = 0;
  for (let j = 0; j < 16; j++) { sum += lum(out, from + j); at += lum(out, from + j) * (j + .5) / 16; }
  return at / sum;
};

test('Light Director adds nothing to a dark scene, a noisy dark scene or an evenly bright one', () => {
  assert.equal(total(play(new LightDirector(), repeat(scene(), 6))), 0);
  const noisy = new LightDirector(); let out: Float32Array = new Float32Array(0);
  for (let i = 0; i < 8; i++) out = noisy.analyse(scene([], () => [8, 8, 10], 6), FULL, 64, DIRECTOR, DT);
  assert.ok(Math.max(...out) < 1e-3, `noise in the dark stays dark: ${Math.max(...out)}`);
  // Brightness everywhere is the base lighting's business: nothing in it stands out as a light.
  assert.equal(total(play(new LightDirector(), repeat(scene([], () => [210, 210, 210]), 6))), 0);
  assert.equal(total(play(new LightDirector(), repeat(scene([{ x: .5, y: .5 }]), 6), { ...DIRECTOR, strength: 0 })), 0, 'strength 0 is off');
});

test('a burst in the upper right lights the upper-right zones, and light in the middle reaches every edge a little', () => {
  const out = play(new LightDirector(), [...repeat(scene(), 3), ...repeat(scene([{ x: .86, y: .18, r: 18 }]), 5)]);
  assert.ok(lum(out, 13) > lum(out, 2) * 8, 'top right over top left');
  assert.ok(lum(out, 50) > lum(out, 61) * 3, 'upper right side over lower right side');
  assert.ok(lum(out, 13) > lum(out, 29) * 3, 'top over bottom');
  assert.ok(lum(out, 13) > .05 && lum(out, 13) < .8, `noticeable, not blinding: ${lum(out, 13)}`);
  assert.ok(out[13 * 3] > out[13 * 3 + 2], 'the light keeps the colour of its source (warm)');
  const centre = play(new LightDirector(), repeat(scene([{ x: .5, y: .5, r: 22 }]), 8));
  for (const zone of [7, 24, 40, 56]) assert.ok(lum(centre, zone) > 0, `zone ${zone} gets some of the centre light`);
  assert.ok(lum(centre, 7) < lum(out, 13), 'further away is weaker');
  assert.ok(lum(centre, 7) > lum(centre, 0) * 2, 'and it still falls off along the edge');
});

test('direction comes from following a source, with the right sign and speed, never from a frame difference', () => {
  const travel = (from: number, to: number, axis: 'x' | 'y' = 'x') => Array.from({ length: 15 }, (_, i) => {
    const p = from + (to - from) * i / 14;
    return scene([axis === 'x' ? { x: p, y: .4 } : { x: .5, y: p }]);
  });
  // 0.7 of the width in 14 frames at 12 fps = 0.6 widths per second.
  const right = new LightDirector(); play(right, travel(.15, .85));
  assert.ok(Math.abs(right.stats.vx - .6) < .12, `left→right is positive: ${right.stats.vx}`);
  assert.ok(Math.abs(right.stats.vy) < .05);
  const left = new LightDirector(); play(left, travel(.85, .15));
  assert.ok(Math.abs(left.stats.vx + .6) < .12, `right→left is negative: ${left.stats.vx}`);
  const down = new LightDirector(); play(down, travel(.2, .8, 'y'));
  assert.ok(down.stats.vy > .3 && Math.abs(down.stats.vx) < .05, `top→bottom: ${down.stats.vy}`);
  const still = new LightDirector(); play(still, repeat(scene([{ x: .5, y: .4 }]), 15));
  assert.ok(Math.abs(still.stats.vx) < 1e-3 && Math.abs(still.stats.vy) < 1e-3, 'a light that stays put has no direction');
  // A light that goes out here and comes on far away is two events, not one object flying across.
  const jump = new LightDirector(); play(jump, [...repeat(scene([{ x: .1, y: .4 }]), 4), ...repeat(scene([{ x: .9, y: .4 }]), 2)]);
  assert.equal(jump.stats.vx, 0, 'no direction is made up from a change of place alone');
});

test('a followed source is lit slightly ahead of where it is, in the direction it travels', () => {
  const quick = { ...DIRECTOR, response: 100, smoothing: 0 };
  const arriving = (from: number, lead: number) => {
    const director = new LightDirector(); director.lead = lead;
    return along(play(director, Array.from({ length: 9 }, (_, i) => scene([{ x: from + (.5 - from) * i / 8, y: .3 }])), quick), 0);
  };
  const fromLeft = arriving(.1, .15) - arriving(.1, 0), fromRight = arriving(.9, .15) - arriving(.9, 0);
  assert.ok(fromLeft > .02, `moving right, the light leads to the right: ${fromLeft}`);
  assert.ok(fromRight < -.02, `moving left, it leads to the left: ${fromRight}`);
  assert.ok(Math.abs(fromLeft) < .12 && Math.abs(fromRight) < .12, 'only a little: at most three grid cells');
});

test('a bright object that stays put gives a steady light', () => {
  const director = new LightDirector(), seen: number[] = [], lamp = scene([{ x: .3, y: .25 }], () => [8, 8, 10], 2);
  for (let i = 0; i < 40; i++) {
    const out = director.analyse(lamp, FULL, 64, DIRECTOR, DT);
    if (i >= 25) seen.push(lum(out, 4));
  }
  const min = Math.min(...seen), max = Math.max(...seen);
  assert.ok(min > .02, 'it does light its zone');
  assert.ok((max - min) / max < .03, `and holds it within 3% over these 1.25 seconds: ${min}–${max}`);
  // Left unchanged for minutes (a channel logo), it is let go, slowly enough that no step of it can be seen.
  let previous = seen[seen.length - 1], after = 0;
  for (let i = 0; i < 12 * 240; i++) {
    after = lum(director.analyse(lamp, FULL, 64, DIRECTOR, DT), 4);
    assert.ok(Math.abs(after - previous) < max * .01, 'never more than 1% in one frame'); previous = after;
  }
  assert.ok(after < max * .1, `four minutes later it is nearly gone: ${after}`);
});

test('a light counts in the dark, not in a bright picture; a bright region is not a big light; the edge strip is left to the base lighting', () => {
  const settled = (f: Pixels) => { const director = new LightDirector(); return total(play(director, repeat(f, 12))); };
  const lamp = { x: .5, y: .45, r: 12 };
  // The same lamp, standing out just as much against its surroundings, in a dim room and in a sunlit one.
  const dim = settled(scene([lamp], () => [20, 20, 22])), sunlit = settled(scene([lamp], () => [205, 205, 205]));
  assert.ok(dim > 0); assert.equal(sunlit, 0, 'in a bright picture nothing is added');
  const dusk = settled(scene([lamp], () => [150, 150, 150]));
  assert.ok(dusk > 0 && dusk < dim * .75, `and in between it counts for less: ${dusk} of ${dim}`);
  // Sixteen times the area is nowhere near sixteen times the light: beyond the size of a light, a candidate is a bright region.
  const compact = settled(scene([{ x: .5, y: .5, r: 12 }])), region = settled(scene([{ x: .5, y: .5, r: 48 }]));
  assert.ok(region < compact * 2.5, `a bright region: ${region} vs a compact light: ${compact}`);
  // A lamp inside the strip the base lighting already reads gives no steady light of its own. Appearing there still counts.
  const atEdge = new LightDirector(), strip = scene([{ x: .5, y: .03, r: 5 }]);
  play(atEdge, repeat(scene(), 4));
  const appearing = total(atEdge.analyse(strip, FULL, 64, { ...DIRECTOR, response: 100 }, DT));
  assert.ok(appearing > 0, 'the moment it comes on is an event anywhere in the picture');
  assert.ok(total(play(atEdge, repeat(strip, 60))) < appearing * .05, 'after that it is the base lighting that shows it');
});

test('a subtitle-shaped bar gives no light, where a compact light in the same place does', () => {
  // Wide and flat near the bottom, appearing all at once: what burned-in subtitles look like at analysis resolution.
  const bar = (y: number) => scene([], (x, py) => Math.abs(py - y * H) < 5 && x > W * .3 && x < W * .7 ? [190, 190, 190] : [6, 6, 8]);
  const shown = (f: Pixels) => { const director = new LightDirector(); play(director, repeat(scene(), 4)); return { first: total(director.analyse(f, FULL, 64, DIRECTOR, DT)), held: total(play(director, repeat(f, 10))), sources: director.stats.sources }; };
  assert.deepEqual(shown(bar(.88)), { first: 0, held: 0, sources: 0 });
  assert.deepEqual(shown(bar(.08)), { first: 0, held: 0, sources: 0 }, 'also along the top');
  const lamp = shown(scene([{ x: .5, y: .88, r: 9 }]));
  assert.ok(lamp.first > 0 && lamp.held > 0 && lamp.sources === 1, 'a lamp down there still counts');
  assert.ok(shown(bar(.5)).held > 0, 'and so does a bar across the middle: only the caption areas are guarded');
});

test('a cut is not treated as something lighting up; a single burst is', () => {
  const lamp = scene([{ x: .2, y: .3 }]);
  const other = scene([{ x: .75, y: .7 }], (x, y) => [40 + x / 3, 60 + y / 2, 90]);
  const quick = { ...DIRECTOR, response: 100 };
  // Zone 28 is the bottom edge below the new scene's lamp; zone 3 the top edge above the old one.
  const director = new LightDirector(); play(director, repeat(lamp, 8), quick);
  const lingering = lum(director.last, 3);
  const atCut = director.analyse(other, FULL, 64, quick, DT), arrived = lum(atCut, 28), left = lum(atCut, 3);
  assert.equal(director.stats.cut, true, 'most of the frame changed at once');
  const settled = lum(play(director, repeat(other, 40), quick), 28);
  assert.ok(arrived <= settled * 1.05, `the new scene's lamp gets no kick on the cut: ${arrived} vs ${settled}`);
  assert.ok(left < lingering * .65, `and the old scene's light is let go quickly: ${left} of ${lingering}`);
  // The same lamp coming on in an otherwise unchanged scene is an event: it gets a kick above its steady light.
  const burst = new LightDirector(); play(burst, repeat(scene(), 6));
  const first = lum(burst.analyse(lamp, FULL, 64, quick, DT), 3);
  assert.equal(burst.stats.cut, false);
  const steady = lum(play(burst, repeat(lamp, 40), quick), 3);
  assert.ok(first > steady * 1.2, `onset ${first} over steady ${steady}`);
  assert.equal(burst.stats.calm, 1, 'one burst is not flicker');
});

test('light that keeps blinking is turned down', () => {
  const director = new LightDirector(), on = scene([{ x: .5, y: .3, r: 20 }]), off = scene();
  for (let i = 0; i < 48; i++) director.analyse(Math.floor(i / 3) % 2 ? on : off, FULL, 64, DIRECTOR, DT);
  assert.ok(director.stats.calm < .6, `2 Hz blinking: ${director.stats.calm}`);
  play(director, repeat(on, 60));
  assert.ok(director.stats.calm > .95, `and it recovers once the blinking stops: ${director.stats.calm}`);
});

test('the two sensitivities decide what counts as a light and what counts as an onset', () => {
  const dim = scene([{ x: .5, y: .2, color: [125, 120, 110] }]);
  const source = (value: number) => total(play(new LightDirector(), repeat(dim, 10), { ...DIRECTOR, source: value, motion: 0 }));
  assert.equal(source(15), 0, 'a dim patch is not a light at low sensitivity');
  assert.ok(source(90) > 0, 'and is one at high sensitivity');
  // A faint patch appearing: too dark to be a light source at all, so only the onset can answer.
  const faint = scene([{ x: .5, y: .2, color: [66, 64, 60] }]);
  const onset = (value: number) => {
    const director = new LightDirector(), d = { ...DIRECTOR, source: 0, motion: value, response: 100 };
    play(director, repeat(scene(), 4), d);
    return total(director.analyse(faint, FULL, 64, d, DT));
  };
  assert.equal(onset(10), 0); assert.ok(onset(90) > 0);
});

test('several lights are several candidates, each lighting its own edge', () => {
  const director = new LightDirector();
  const out = play(director, repeat(scene([{ x: .15, y: .2 }, { x: .85, y: .2 }, { x: .5, y: .85 }]), 8));
  assert.equal(director.stats.sources, 3);
  assert.ok(lum(out, 2) > lum(out, 8) * 1.5 && lum(out, 13) > lum(out, 8) * 1.5, 'two peaks along the top, a dip between them');
  assert.ok(lum(out, 24) > lum(out, 17) * 1.5, 'and one in the middle of the bottom');
});

test('letterboxed picture, changing zone count and the reduced-load path all hold up', () => {
  const picture = { x: 0, y: 20, width: W, height: 104 };
  const boxed = scene([{ x: .8, y: .28, r: 10 }], (_, y) => y < 20 || y >= 124 ? [0, 0, 0] : [6, 6, 8]);
  const director = new LightDirector(); let out: Float32Array = new Float32Array(0);
  for (let i = 0; i < 8; i++) out = director.analyse(boxed, picture, 64, DIRECTOR, DT);
  assert.ok(lum(out, 12) > lum(out, 3) * 5, 'placed by its position inside the picture, bars left out');
  out = director.analyse(boxed, picture, 128, DIRECTOR, DT);
  assert.equal(out.length, 128 * 3, 'a new zone count simply starts over');
  const fine = play(new LightDirector(), repeat(scene([{ x: .7, y: .3 }]), 12));
  const coarse = new LightDirector(); let half: Float32Array = new Float32Array(0);
  for (let i = 0; i < 12; i++) half = coarse.analyse(scene([{ x: .7, y: .3 }]), FULL, 64, DIRECTOR, DT, 2);
  assert.ok(Math.abs(lum(half, 11) / lum(fine, 11) - 1) < .25, 'reading a quarter of the pixels gives nearly the same light');
  assert.equal(coarse.last, half);
});

test('added light fills headroom instead of clipping, keeps its hue, and leaves untouched zones exactly as they were', () => {
  const base: RGB[] = [[10, 10, 10], [250, 250, 250], [0, 0, 0], [30, 60, 200]];
  assert.ok(mixLight(base, new Float32Array(12)).every((rgb, i) => rgb === base[i]), 'nothing to add: the very same colours');
  const out = mixLight(base, Float32Array.from([.4, .2, 0, 5, 5, 5, 50, 25, 0, 0, 0, 0]));
  assert.ok(out[0][0] > out[0][1] && out[0][1] > out[0][2] && out[0][2] >= 10);
  for (const rgb of out) for (const v of rgb) assert.ok(v <= 255 && v >= 0);
  assert.ok(out[1].every(v => v <= 255 && v >= 250), 'a zone already at full strength has no room left');
  // However much is added, the result stays below full strength and keeps the 2:1 red-to-green ratio in linear light.
  const lin = (v: number) => ((v / 255 + .055) / 1.055) ** 2.4;
  assert.ok(out[2][0] < 255 && out[2][0] > 250); assert.ok(Math.abs(lin(out[2][0]) / lin(out[2][1]) - 2) < .05); assert.equal(out[2][2], 0);
  assert.equal(out[3], base[3]);
  assert.equal(mixLight(base, new Float32Array(3)), base, 'a result for another zone count is ignored');
});

test('the Flash Limiter and OKLab smoothing still bound light the Light Director adds', () => {
  const director = new LightDirector(); play(director, repeat(scene(), 4));
  const flash = scene([{ x: .5, y: .12, r: 40 }]);
  const dark: RGB[] = Array.from({ length: 64 }, () => [0, 0, 0]);
  const target = mixLight(dark, play(director, repeat(flash, 3), { ...DIRECTOR, strength: 100, response: 100 }));
  assert.ok(luminance(target[7]) > .3, 'the request itself is a big jump');
  const filter = new TemporalFilter(), settings = { ...DEFAULTS, flashLimiter: true };
  filter.setTarget(dark, settings); filter.step(.033, settings); filter.setTarget(target, settings);
  let before = 0;
  for (let i = 0; i < 20; i++) {
    const now = luminance(filter.step(1 / 30, settings)[7]);
    assert.ok(now - before <= .55 / 30 + 1e-6, `rise per frame stays within the limiter: ${now - before}`);
    before = now;
  }
  assert.ok(before > 0, 'and the light does arrive');
});

test('Light Trails: a moving source leaves an afterglow where it has been; one that stays put leaves none', () => {
  const trail = { enabled: true, length: 50, strength: 100 };
  // The ordinary lingering is switched off here, so that what remains after the source has gone is the trail alone.
  const quick = { ...DIRECTOR, smoothing: 0 };
  const crossing = (trails: typeof trail | null, then: Pixels = scene()) => {
    const director = new LightDirector(), after: number[] = [];
    for (let i = 0; i < 15; i++) director.analyse(scene([{ x: .15 + .7 * i / 14, y: .4 }]), FULL, 64, quick, DT, 1, trails);
    // Zone 5 is the top edge above x ≈ 0.34, which the light passed about a second before it left the picture.
    for (let i = 0; i < 14; i++) after.push(lum(director.analyse(then, FULL, 64, quick, DT, 1, trails), 5));
    return after;
  };
  const glow = crossing(trail), plain = crossing(null);
  assert.ok(glow[3] > .01 && glow[3] > plain[3] * 3, `a third of a second after it left: ${glow[3]} with trails, ${plain[3]} without`);
  assert.ok(glow[13] < glow[3] && glow[13] > 0, 'and it fades');
  for (let i = 1; i < glow.length; i++) assert.ok(glow[i] <= glow[i - 1] + 1e-9, 'never brightening again by itself');
  assert.ok(crossing({ ...trail, length: 100 })[13] > glow[13] && glow[13] > crossing({ ...trail, length: 0 })[13], 'Length decides how long');
  assert.ok(Math.abs(crossing({ ...trail, strength: 50 })[3] / glow[3] - .5) < .1, 'Strength decides how bright');
  assert.deepEqual(crossing({ ...trail, enabled: false }), plain, 'switched off is off');
  // A light that does not move gets exactly the light it had without trails.
  const still = (trails: typeof trail | null) => [...play2(new LightDirector(), repeat(scene([{ x: .5, y: .4 }]), 20), trails)];
  assert.deepEqual(still(trail), still(null));
  // A cut ends the scene, and its trails with it.
  const other = scene([{ x: .75, y: .7 }], (x, y) => [40 + x / 3, 60 + y / 2, 90]);
  assert.ok(crossing(trail, other)[5] - crossing(null, other)[5] < glow[5] * .1, 'after a cut the trail is let go within half a second');
});
const play2 = (director: LightDirector, frames: Pixels[], trails: { enabled: boolean; length: number; strength: number } | null) => {
  let out: Float32Array = new Float32Array(0);
  for (const f of frames) out = director.analyse(f, FULL, 64, DIRECTOR, DT, 1, trails);
  return out;
};
