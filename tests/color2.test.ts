import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromaGain, drive, fromLabInGamut, hueCalm, shadowToe, shoulder, tintProtection } from '../src/engine/color2.ts';
import { fromLab, labToLinear, luminance, toLab } from '../src/engine/color.ts';
import { sampleZones, type Pixels } from '../src/engine/sampling.ts';
import { TemporalFilter } from '../src/engine/temporal.ts';
import { ledRow } from '../src/engine/emission.ts';
import { COLOR, DEFAULTS, MODES, clamp } from '../src/shared/settings.ts';
import type { RGB, Settings } from '../src/shared/types.ts';

const OFF = { ...COLOR, enabled: false }, classic: Settings = { ...DEFAULTS, color: OFF };
const frame = (w: number, h: number, color: (x: number, y: number) => RGB): Pixels => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([...color(x, y), 255], (y * w + x) * 4);
  return { width: w, height: h, data };
};
const hueOf = ([, a, b]: RGB) => Math.atan2(b, a) * 180 / Math.PI;
const settle = (colors: RGB[], s: Settings) => { const f = new TemporalFilter(); f.setTarget(colors, s); let out: RGB[] = []; for (let i = 0; i < 300; i++) out = f.step(.05, { ...s, flashLimiter: false }); return out; };
const alphaOf = (colors: RGB[], s: Settings, gain = s.brightness / 100 * MODES[s.mode].gain) => ledRow(settle(colors, s), 0, 64, gain, MODES[s.mode].curve, undefined, undefined, s.color)[32 * 4 + 3];

test('with Color Engine 2.0 off, every stage is exactly what 0.8 did', () => {
  for (const c of [OFF, null, undefined]) for (let v = 0; v <= 1.5; v += .01) {
    assert.equal(drive(v, 1.1, c), clamp((v - .03) / .97) ** 1.1); assert.equal(shoulder(v, c), Math.min(1, v));
    assert.equal(shadowToe(v, c), v * (v < .2 ? v / .2 : 1)); assert.equal(chromaGain(v, v / 3, c), 1); assert.equal(hueCalm(v, v / 9, c), 1);
  }
  assert.equal(tintProtection(OFF), 0); assert.equal(tintProtection(null), 0);
  // The temporal filter against the 0.8 code, written out again here as the reference.
  const targets: RGB[][] = [[[200, 80, 40], [10, 12, 30], [255, 255, 255], [3, 2, 6]], [[20, 220, 90], [250, 20, 250], [0, 0, 0], [90, 90, 90]]];
  const filter = new TemporalFilter(); let values: RGB[] = targets[0].map(() => [0, 0, 0]);
  for (let round = 0; round < 60; round++) {
    const colors = targets[Math.floor(round / 20) % 2], goal = colors.map(rgb => { const [l, a, b] = toLab(rgb); const sat = classic.saturation / 100 * MODES.cinema.saturation; return [l * (l < .2 ? l / .2 : 1), a * sat, b * sat] as RGB; });
    if (round % 20 === 0) filter.setTarget(colors, classic);
    const out = filter.step(1 / 30, classic), tau = MODES.cinema.tau * (.3 + classic.smoothing / 50), cut = round >= 20 && round % 20 === 0;
    void cut;
    values = values.map((old, i) => {
      const alpha = 1 - Math.exp(-(1 / 30) / tau), next = old.map((v, c) => v + (goal[i][c] - v) * alpha) as RGB;
      const before = luminance(fromLab(old)), after = luminance(fromLab(next)), limit = before + (1 / 30) * (after > before ? .55 : -.85);
      return (after > before && after > limit) || (after < before && after < limit) ? next.map(v => v * Math.cbrt(Math.max(0, limit) / Math.max(after, 1e-9))) as RGB : next;
    });
    // The reference ignores the faster step right after a cut, so the first rounds after each change are compared loosely.
    if (round < 20) out.forEach((rgb, i) => fromLab(values[i]).forEach((v, c) => assert.ok(Math.abs(v - rgb[c]) < 1e-9, `round ${round}`)));
  }
  const colors: RGB[] = Array.from({ length: 64 }, (_, i) => [i * 4, 255 - i * 4, 128]);
  assert.deepEqual([...ledRow(colors, 0, 256, 1.04, 1.1, undefined, undefined, OFF)], [...ledRow(colors, 0, 256, 1.04, 1.1)]);
});

test('dark scenes: a dim colour gives a dim light of that colour instead of none', () => {
  let last = -1;
  for (let v = 0; v <= 1.0001; v += .005) { const d = drive(v, 1.1, COLOR); assert.ok(d >= last - 1e-12, `drive rises all the way: ${v}`); last = d; }
  assert.equal(drive(0, 1.1, COLOR), 0); assert.ok(Math.abs(drive(1, 1.1, COLOR) - 1) < 1e-9, 'full is still full');
  assert.equal(drive(.02, 1.1, COLOR), 0, 'black is still black');
  assert.ok(drive(.08, 1.1, COLOR) > drive(.08, 1.1, OFF) * 1.4, 'the low end is lifted');
  assert.ok(Math.abs(drive(.9, 1.1, COLOR) - drive(.9, 1.1, OFF)) < .02, 'the top is left alone');
  assert.ok(shadowToe(.1, COLOR) > shadowToe(.1, OFF) * 1.2 && shadowToe(.1, COLOR) < .1); assert.equal(shadowToe(.3, COLOR), .3);
  assert.ok(drive(.08, 1.1, { ...COLOR, shadows: 100 }) > drive(.08, 1.1, COLOR) && drive(.08, 1.1, COLOR) > drive(.08, 1.1, { ...COLOR, shadows: 0 }), 'the Shadows slider decides how much');
  // A night scene: deep blue at about 7% brightness.
  const night: RGB[] = Array.from({ length: 64 }, () => [6, 9, 24]);
  const now = alphaOf(night, DEFAULTS), before = alphaOf(night, classic), most = alphaOf(night, { ...DEFAULTS, color: { ...COLOR, shadows: 100 } });
  assert.ok(now >= before * 1.4 && now > 6 && now < 40, `more light where there was next to none, still dim: ${before} → ${now}`);
  assert.ok(most > now, `and more again with Shadows at 100: ${most}`);
  const [r, g, b] = settle(night, DEFAULTS)[5];
  assert.ok(b > r * 2 && b > g * 1.5, 'and it is blue');
});

test('near black, where a hue is only noise, the light is neutral instead of tinted', () => {
  assert.equal(chromaGain(.08, .02, COLOR), 0); assert.ok(chromaGain(.3, .02, COLOR) > 1, 'visible colours keep theirs, muted ones gain');
  assert.ok(hueCalm(.1, .005, COLOR) < .5 && hueCalm(.6, .005, COLOR) === 1, 'a dim hue wobbling a little is taken more calmly than a bright one');
  assert.equal(hueCalm(.1, .1, COLOR), 1, 'a real change of colour goes at full speed, even in the dark');
  const noise: RGB[] = Array.from({ length: 64 }, () => [3, 1, 5]);
  const spread = (rgb: RGB) => Math.max(...rgb) - Math.min(...rgb);
  assert.ok(spread(settle(noise, DEFAULTS)[9]) < .5, 'no colour is made out of sensor noise');
  assert.ok(spread(settle(noise, classic)[9]) > spread(settle(noise, DEFAULTS)[9]), '0.8 kept the tint');
});

test('bright scenes: opacity rolls off toward full instead of clipping, so bright zones still differ', () => {
  for (let v = 0; v < .69; v += .03) assert.equal(shoulder(v, COLOR), v, 'untouched below the knee');
  let last = 0;
  for (let v = 0; v <= 4; v += .01) { const a = shoulder(v, COLOR); assert.ok(a >= last && a < 1); last = a; }
  assert.ok(Math.abs(shoulder(.7001, COLOR) - .7001) < 1e-3, 'no step at the knee');
  assert.ok(shoulder(1.5, { ...COLOR, highlights: 100 }) < shoulder(1.5, COLOR) && shoulder(1.5, COLOR) < shoulder(1.5, { ...COLOR, highlights: 0 }), 'the Highlights slider decides where it starts');
  // Vivid at full brightness drives everything twice as hard: 0.8 showed light grey and white exactly alike.
  const vivid: Settings = { ...DEFAULTS, mode: 'vivid', brightness: 100 };
  const zones = (v: number): RGB[] => Array.from({ length: 64 }, () => [v, v, v]);
  assert.equal(alphaOf(zones(190), { ...vivid, color: OFF }), alphaOf(zones(255), { ...vivid, color: OFF }));
  assert.ok(alphaOf(zones(255), vivid) - alphaOf(zones(190), vivid) >= 3, 'now white is still brighter than light grey');
});

test("a zone's colour comes from where it is colourful: white and grey beside it no longer wash it out", () => {
  // The top strip: left half a white highlight, right half saturated red.
  const mixed = frame(256, 144, x => x % 16 < 8 ? [255, 255, 255] : [230, 20, 20]);
  const plain = sampleZones(mixed, 64)[4], kept = sampleZones(mixed, 64, undefined, tintProtection(COLOR))[4];
  assert.ok(plain[1] / plain[0] > .7, 'plain average: pink');
  assert.ok(kept[1] / kept[0] < plain[1] / plain[0] - .15, `protected: clearly redder (${plain} → ${kept})`);
  assert.ok(Math.abs(Math.max(...kept) - Math.max(...plain)) < .5, 'and exactly as bright');
  const even = frame(256, 144, () => [40, 120, 200]);
  sampleZones(even, 64, undefined, .8)[7].forEach((v, c) => assert.ok(Math.abs(v - sampleZones(even, 64)[7][c]) < 1e-6, 'a zone of one colour is unchanged'));
  // Dark noise must not be read as colour: a nearly black zone with a few coloured specks stays what its average says.
  let seed = 3; const speck = () => (seed = seed * 16807 % 2147483647) % 9;
  const dark = frame(256, 144, () => [speck(), speck(), speck()]);
  const a = sampleZones(dark, 64)[9], b = sampleZones(dark, 64, undefined, .8)[9];
  assert.ok(Math.abs((b[0] - b[2]) - (a[0] - a[2])) < 1.5, `noise is not amplified: ${a} → ${b}`);
});

test('a colour too vivid for the display is brought back along its own hue', () => {
  const vivid = toLab([20, 200, 90]).map((v, i) => i ? v * 1.9 : v) as RGB;         // the same green, saturation almost doubled
  assert.ok(labToLinear(vivid[0], vivid[1], vivid[2]).some(v => v < 0 || v > 1), 'it does not fit');
  const kept = toLab(fromLabInGamut(vivid)), clipped = toLab(fromLab(vivid));
  assert.ok(Math.abs(hueOf(kept) - hueOf(vivid)) < 1.5, `hue kept: ${hueOf(vivid)} → ${hueOf(kept)}`);
  assert.ok(Math.abs(hueOf(clipped) - hueOf(vivid)) > Math.abs(hueOf(kept) - hueOf(vivid)) * 2, 'channel clipping, as in 0.8, shifts it more');
  assert.ok(Math.abs(kept[0] - vivid[0]) < .02, 'lightness kept');
  for (const rgb of [[200, 80, 40], [10, 12, 30], [255, 255, 255], [0, 0, 0], [90, 90, 90]] as RGB[])
    fromLabInGamut(toLab(rgb)).forEach((v, c) => assert.ok(Math.abs(v - fromLab(toLab(rgb))[c]) < 1e-6, 'colours that fit are untouched'));
  // Muted colours gain more than vivid ones; a vivid colour is never pushed out of range.
  assert.ok(chromaGain(.6, .03, COLOR) > chromaGain(.6, .25, COLOR) && chromaGain(.6, .25, COLOR) === 1);
  for (const rgb of settle(Array.from({ length: 64 }, () => [255, 30, 10] as RGB), { ...DEFAULTS, saturation: 180 })) for (const v of rgb) assert.ok(v >= 0 && v <= 255);
});

test('after a cut from a bright scene into a dark one, no tint of the old scene lingers', () => {
  const orange: RGB[] = Array.from({ length: 64 }, () => [250, 140, 40]), night: RGB[] = Array.from({ length: 64 }, () => [8, 12, 34]);
  const run = (s: Settings) => {
    const f = new TemporalFilter(); f.setTarget(orange, s); for (let i = 0; i < 200; i++) f.step(.05, s);
    f.setTarget(night, s); let out: RGB = [0, 0, 0];
    for (let i = 0; i < 45; i++) out = f.step(1 / 30, s)[7];          // a second and a half later
    return out;
  };
  for (const s of [DEFAULTS, classic]) { const [r, , b] = run(s); assert.ok(b > r * 1.5, `${s.color.enabled ? '2.0' : '0.8'}: the edge is blue by now, not still orange (${run(s)})`); }
});
