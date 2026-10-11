// 0.9.1 "Identity Update": Glow Designer, UI Guard, Adaptive Brightness, A/B Comparison, Calibration Wizard, and the
// rename to ECLIRIM as far as it touches stored data. Everything here is the arithmetic; the browser side is in e2e-identity.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HALO_PEAK, alongBlur, glowProfile, glowStrip, isClassicGlow, ledRow } from '../src/engine/emission.ts';
import { FEATHER, PAD, guardCap, guardField, guardLevel, guardLimit, guardReach, mergeRects, sideRect, splitRects } from '../src/engine/guard.ts';
import { AutoExposure, sceneLuma } from '../src/engine/exposure.ts';
import { luminance } from '../src/engine/color.ts';
import { TemporalFilter } from '../src/engine/temporal.ts';
import type { Pixels } from '../src/engine/sampling.ts';
import { COLOR, DEFAULTS, DIRECTOR, EXPOSURE, GLOW, GUARD, HALO, LOOK_KEYS, PULSE, SCHEMA, TRAILS, compareSettings, lookOf, migrate, sanitize, sanitizeCompare, sanitizePreset, sanitizeProfile } from '../src/shared/settings.ts';
import { BUILT_IN, applyPreset, exportBackup, exportPreset, importJSON, matchesPreset } from '../src/shared/presets.ts';
import { WIZARD, WIZARD_START, WIZARD_STEPS, closestPreset, recommend } from '../src/shared/wizard.ts';
import type { GlowSettings, RGB, Rect } from '../src/shared/types.ts';

const STEPS = [0, 25, 50, 75, 100];
const shapes = (style: GlowSettings['style']): GlowSettings[] => STEPS.flatMap(thickness => STEPS.flatMap(curve => STEPS.flatMap(falloff => STEPS.map(softness => ({ style, thickness, curve, falloff, softness })))));
const frame = (w: number, h: number, color: (x: number, y: number) => RGB): Pixels => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([...color(x, y), 255], (y * w + x) * 4);
  return { width: w, height: h, data };
};

// ───── Glow Designer
test('Edge Light with every slider in the middle is the light of 0.9.0, to the last digit', () => {
  assert.ok(isClassicGlow(GLOW) && isClassicGlow(null) && isClassicGlow(undefined)); assert.ok(!isClassicGlow(HALO) && !isClassicGlow({ ...GLOW, softness: 51 }));
  for (const strip of [.015, .03, .06]) for (const spread of [0, .3, .65, 1]) for (let t = 0; t <= 1; t += .001)
    assert.equal(glowProfile(t, strip, spread, GLOW), glowProfile(t, strip, spread));
  // The profile of 0.9.0, written out again here so that a change to the shared code cannot move both sides of the comparison.
  const smooth = (a: number, b: number, v: number) => { const x = Math.min(1, Math.max(0, (v - a) / (b - a))); return x * x * (3 - 2 * x); };
  const before = (t: number, strip: number, spread: number) => {
    const core = 1 - smooth(strip, strip * 2.4, t), d = Math.max(0, t - strip);
    const bloom = .5 * Math.exp(-d / (.024 + .034 * spread)), halo = (.3 + .4 * spread) * Math.exp(-d / (.13 + .25 * spread));
    return core + (1 - core) * Math.min(1, bloom + halo) * (1 - smooth(.5, 1, t));
  };
  for (const spread of [0, .65, 1]) for (let t = 0; t <= 1; t += .0007) assert.equal(glowProfile(t, .03, spread, GLOW), before(t, .03, spread));
  const colors: RGB[] = Array.from({ length: 64 }, (_, i) => [i * 4, 255 - i * 3, (i * 37) % 256]);
  assert.equal(alongBlur(GLOW, 16), 0); assert.equal(alongBlur(null, 16), 0);
  for (let side = 0; side < 4; side++) assert.deepEqual([...ledRow(colors, side, 512, 1.04, 1.1, undefined, undefined, COLOR, alongBlur(GLOW, 16))], [...ledRow(colors, side, 512, 1.04, 1.1, undefined, undefined, COLOR)]);
});

test('in both styles and at every slider position, the light is strongest on the screen edge and never grows toward the picture', () => {
  for (const style of ['edge', 'halo'] as const) for (const glow of shapes(style)) for (const spread of [0, .65, 1]) {
    const top = glowProfile(0, .03, spread, glow);
    assert.equal(top, style === 'halo' ? HALO_PEAK : 1, `${style}: the edge itself is the brightest place`);
    assert.equal(glowProfile(1, .03, spread, glow), 0, 'the light is gone at its inner limit');
    let previous = top;
    for (let t = 0; t <= 1; t += .004) {
      const v = glowProfile(t, .03, spread, glow);
      assert.ok(v <= previous + 1e-9 && v >= 0 && v <= 1, `${JSON.stringify(glow)} spread ${spread} t ${t.toFixed(3)}: ${v} after ${previous}`);
      previous = v;
    }
  }
});

test('the four sliders do what their names say, and Soft Halo has no strip', () => {
  const at = (t: number, patch: Partial<GlowSettings>, base = GLOW) => glowProfile(t, .03, .65, { ...base, ...patch });
  // Thickness: the part at full strength gets wider.
  assert.equal(at(.06, { thickness: 100 }), 1); assert.ok(at(.06, { thickness: 0 }) < .7);
  assert.equal(glowStrip(.03, { ...GLOW, thickness: 100 }), .12); assert.equal(glowStrip(.03, GLOW), .03); assert.equal(glowStrip(.03, HALO), 0);
  // Falloff: the same shape, gone sooner.
  for (const t of [.15, .3, .45]) assert.ok(at(t, { falloff: 100 }) < at(t, { falloff: 50, softness: 49 }) && at(t, { falloff: 50, softness: 49 }) < at(t, { falloff: 0 }));
  // Curve: low is a spike with a long tail, high holds near the edge and then drops.
  assert.ok(at(.05, { curve: 100 }) > at(.05, { curve: 0 }), 'a high curve keeps more light close to the edge');
  assert.ok(at(.45, { curve: 100 }) < at(.45, { curve: 0 }), 'and less of it far in');
  // Softness: the strip ends more gently, and along the edge colours start to run together.
  assert.ok(at(.05, { softness: 100 }) > at(.05, { softness: 0 }));
  assert.equal(alongBlur({ ...GLOW, softness: 30 }, 16), 0); assert.ok(alongBlur({ ...GLOW, softness: 100 }, 16) > alongBlur({ ...GLOW, softness: 70 }, 16));
  assert.ok(alongBlur({ ...HALO, softness: 0 }, 16) > 0, 'Soft Halo always blends a little'); assert.ok(alongBlur(HALO, 16) > alongBlur({ ...GLOW, softness: 70 }, 16));
  // Soft Halo: no strip at full strength, more light further in.
  assert.ok(glowProfile(.02, .03, .65, HALO) < 1 && glowProfile(.02, .03, .65, GLOW) === 1);
  assert.ok(glowProfile(.4, .03, .65, HALO) > glowProfile(.4, .03, .65, GLOW));
});

test('light runs along the edge and around the corners; a zone switched off stays off', () => {
  const n = 16, count = n * 4, lit = (zone: number): RGB[] => Array.from({ length: count }, (_, z) => z === zone ? [255, 255, 255] : [0, 0, 0]);
  const alpha = (row: Uint8ClampedArray) => Array.from({ length: row.length / 4 }, (_, i) => row[i * 4 + 3]);
  const sum = (values: number[]) => values.reduce((total, v) => total + v, 0);
  const sharp = alpha(ledRow(lit(8), 0, 512, 1, 1)), soft = alpha(ledRow(lit(8), 0, 512, 1, 1, undefined, undefined, null, 1.5));
  const peak = (values: number[]) => values.indexOf(Math.max(...values));
  assert.ok(Math.abs(peak(soft) - peak(sharp)) <= 1, 'the light stays where it is');
  assert.ok(Math.max(...soft) < Math.max(...sharp) * .6, 'and is spread out');
  assert.ok(Math.abs(sum(soft) - sum(sharp)) < sum(sharp) * .03, `the same amount of light: ${sum(soft)} against ${sum(sharp)}`);
  assert.ok(soft[200] > 3 && sharp[200] === 0, `it reaches zones that were dark: ${soft[200]} against ${sharp[200]}`);
  // The top-left zone belongs to the top side. With blur its light shows on the upper end of the left side, round the corner.
  const corner = lit(0), left = (blur: number) => alpha(ledRow(corner, 2, 512, 1, 1, undefined, undefined, null, blur));
  assert.ok(left(2)[60] > left(0)[60] + 10, `round the corner: ${left(2)[60]} against ${left(0)[60]}`);
  assert.ok(left(2)[500] === 0, 'not at the far end of that side');
  // Zone Studio switched zone 9 off: no light may leak into it from its lit neighbours.
  const all: RGB[] = Array.from({ length: count }, () => [255, 255, 255]), trim = new Float32Array(count).fill(1); trim[9] = 0;
  const off = alpha(ledRow(all, 0, 512, 1, 1, undefined, trim, null, 2)), middle = Math.round((9 + .5) / n * 512);
  assert.ok(off[middle] < 80, `the switched-off zone is dark in its middle: ${off[middle]}`); assert.ok(off[middle - 96] > 200);
  for (const colour of [[255, 0, 0], [0, 0, 255]] as RGB[]) {
    const row = ledRow(Array.from({ length: count }, () => colour), 1, 256, 1, 1, undefined, undefined, null, 1.5);
    for (let i = 0; i < 256; i++) assert.deepEqual([...row.subarray(i * 4, i * 4 + 3)], colour, 'blending one colour with itself changes nothing');
  }
});

// ───── UI Guard
test('UI Guard: the limit, where to look, and rectangles that belong together', () => {
  assert.ok(Math.abs(guardCap(0) - .6) < 1e-9 && Math.abs(guardCap(100) - .12) < 1e-9); assert.ok(guardCap(60) < guardCap(30));
  assert.equal(guardCap(999), guardCap(100));
  // The classic glow, 120 px deep: the light is above the default limit only close to the edge.
  const profile = Float32Array.from({ length: 96 }, (_, i) => glowProfile((i + .5) / 96, .03, .65) * 255);
  const reach = guardReach(profile, guardCap(GUARD.strength), 120);
  assert.ok(reach > 12 && reach < 45, `reach ${reach}`);
  assert.ok(guardReach(profile, guardCap(100), 120) > reach, 'a stricter limit looks further in');
  assert.equal(guardReach(profile.map(v => v * .1), guardCap(GUARD.strength), 120), 0, 'a glow that thin needs no guard');
  const row = [{ x: 10, y: 10, width: 30, height: 30 }, { x: 46, y: 12, width: 30, height: 30 }, { x: 82, y: 10, width: 30, height: 30 }, { x: 400, y: 10, width: 30, height: 30 }];
  assert.deepEqual(mergeRects(row, 10), [{ x: 10, y: 10, width: 102, height: 32 }, { x: 400, y: 10, width: 30, height: 30 }]);
  assert.deepEqual(mergeRects(row, 2), row); assert.deepEqual(mergeRects([{ x: 0, y: 0, width: 0, height: 9 }], 10), []);
  const view = { width: 1000, height: 600 }, r = { x: 100, y: 20, width: 50, height: 10 };
  assert.deepEqual(sideRect(0, r, view), [100, 150, 20, 30]); assert.deepEqual(sideRect(1, r, view), [100, 150, 570, 580]);
  assert.deepEqual(sideRect(2, r, view), [20, 30, 100, 150]); assert.deepEqual(sideRect(3, r, view), [20, 30, 850, 900]);
  // A long bar is cut into pieces along the side it lies on, so each stretch answers to the light over it.
  const bar = { x: 100, y: 850, width: 1000, height: 30 }, cut = splitRects([bar, { x: 5, y: 5, width: 40, height: 40 }], 1);
  assert.equal(cut.pieces.length, 12); assert.deepEqual(cut.parent, [...Array(11).fill(0), 1]);
  assert.ok(cut.pieces.slice(0, 11).every(p => p.width <= 96 && p.y === 850 && p.height === 30));
  assert.ok(Math.abs(cut.pieces[0].x - 100) < 1e-9 && Math.abs(cut.pieces[10].x + cut.pieces[10].width - 1100) < 1e-9, 'the pieces cover the bar exactly');
  assert.equal(splitRects([bar], 2).pieces.length, 1, 'seen from the left side it is 30 px long: one piece');
  // The drive it holds against goes up at once and comes down only once the light has clearly fallen.
  assert.equal(guardLevel(0, .3), .3125); assert.equal(guardLevel(.3125, .3), .3125); assert.equal(guardLevel(.3125, .24), .3125); assert.equal(guardLevel(.3125, .2), .25);
  assert.equal(guardLevel(.5, .9), .9375); assert.equal(guardLevel(0, 0), 0); assert.equal(guardLevel(0, 7), 1);
  assert.equal(guardLimit(.3, .25), 1, 'LEDs driven below the limit need no cut at all'); assert.ok(Math.abs(guardLimit(.3, 1) - .3) < 1e-9); assert.equal(guardLimit(.3, .6), .5);
});

test('UI Guard cuts the light over a control to the limit, eases back around it, and touches nothing else', () => {
  const LENGTH = 200, ROWS = 40, view = { width: 1000, height: 600 }, depth = 120;
  // Opacity falling from 255 on the edge to 0 at the inner limit, the same along the whole side.
  const base = Float32Array.from({ length: LENGTH * ROWS }, (_, i) => 255 * (1 - (Math.floor(i / LENGTH) + .5) / ROWS));
  const at = (field: Float32Array, px: number, inward: number) => field[Math.floor(inward / depth * ROWS) * LENGTH + Math.floor(px / 1000 * LENGTH)];
  const button: Rect = { x: 480, y: 30, width: 40, height: 24 }, out = new Float32Array(base.length), flags = new Uint8Array(2);
  assert.equal(guardField(base, out, LENGTH, ROWS, 0, [{ x: 900, y: 500, width: 20, height: 20 }, button], view, depth, [.3, .3], 0, flags), 1);
  assert.deepEqual([...flags], [0, 1], 'it says which rectangles the light was cut for');
  assert.equal(guardField(base, out, LENGTH, ROWS, 0, [button], view, depth, [.3]), 1);
  for (let i = 0; i < out.length; i++) assert.ok(out[i] <= base[i] + 1e-6, 'the guard never adds light');
  assert.ok(Math.abs(at(out, 500, 40) - .3 * 255) < 1e-3, `over the control the light is at the limit: ${at(out, 500, 40)}`);
  assert.equal(at(out, 500, 100), at(base, 500, 100), 'where the light is already thinner than the limit, nothing changes');
  assert.equal(at(out, 200, 40), at(base, 200, 40), 'away from the control, nothing changes');
  const near = at(out, 480 - PAD - FEATHER / 2, 40);
  assert.ok(near > .3 * 255 + 5 && near < at(base, 480, 40) - 5, `beside it the light eases back: ${near}`);
  assert.equal(at(out, 480 - PAD - FEATHER - 6, 40), at(base, 0, 40));
  // The same rectangle from the other sides: the bottom, left and right edges are nowhere near it.
  for (const side of [1, 2, 3]) { assert.equal(guardField(base, out, LENGTH, ROWS, side, [button], view, depth, [.3]), 0); assert.deepEqual(out, base); }
  // LEDs too dim to need it: no cut, and it says so.
  assert.equal(guardField(base, out, LENGTH, ROWS, 0, [button], view, depth, [1]), 0); assert.deepEqual(out, base);
  // The outermost line of the edge is the light source: it stays lit above a control, even one that reaches the edge,
  // and the light is held back from just inside it.
  for (const control of [button, { x: 480, y: 0, width: 40, height: 24 }]) {
    guardField(base, out, LENGTH, ROWS, 0, [control], view, depth, [.3], 6);
    assert.equal(at(out, 500, 2), at(base, 500, 2), 'the outermost line stays'); assert.ok(at(out, 500, 12) < at(base, 500, 12) - 20, 'the light just inside it is held back');
  }
  assert.ok(Math.abs(at(out, 500, 12) - .3 * 255) < 1e-3, 'to the limit, where the control itself is');
  // A control on the right edge, seen by the right side.
  assert.equal(guardField(base, out, LENGTH, ROWS, 3, [{ x: 950, y: 290, width: 30, height: 20 }], view, depth, [.3]), 1);
  assert.ok(Math.abs(out[Math.floor(35 / depth * ROWS) * LENGTH + Math.floor(300 / 600 * LENGTH)] - .3 * 255) < 1e-3);
});

// ───── Adaptive Brightness
test('scene brightness is the lightness of the whole picture, not its brightest spot', () => {
  assert.equal(sceneLuma(frame(64, 36, () => [0, 0, 0]), { x: 0, y: 0, width: 64, height: 36 }), 0);
  assert.ok(Math.abs(sceneLuma(frame(64, 36, () => [255, 255, 255]), { x: 0, y: 0, width: 64, height: 36 }) - 1) < 1e-6);
  const grey = sceneLuma(frame(64, 36, () => [119, 119, 119]), { x: 0, y: 0, width: 64, height: 36 });
  assert.ok(grey > .55 && grey < .62, `mid grey: ${grey}`);
  // A night scene with one small lamp stays a dark scene.
  const lamp = sceneLuma(frame(64, 36, (x, y) => x >= 28 && x < 36 && y >= 14 && y < 22 ? [255, 255, 255] : [8, 8, 12]), { x: 0, y: 0, width: 64, height: 36 });
  assert.ok(lamp < .2, `lamp at night: ${lamp}`);
  // Only the picture counts: black bars around it are left out.
  const barred = frame(64, 36, (_x, y) => y < 6 || y >= 30 ? [0, 0, 0] : [200, 200, 200]);
  assert.ok(sceneLuma(barred, { x: 0, y: 6, width: 64, height: 24 }) > sceneLuma(barred, { x: 0, y: 0, width: 64, height: 36 }) + .1);
});

test('Adaptive Brightness: dark scenes hold back only bright zones, bright scenes lower everything, the middle is left alone', () => {
  const s = EXPOSURE, seen = (luma: number) => { const e = new AutoExposure(); e.update(luma, 0, s); return e; };
  const never = new AutoExposure();
  assert.equal(never.scale(1, s), 1, 'before any picture, nothing is changed'); assert.equal(never.level(s), 1);
  for (const key of [.46, .5, .57]) for (const l of [.1, .5, 1]) assert.equal(seen(key).scale(l, s), 1, `a scene of ordinary brightness (${key}) is not touched`);
  const dark = seen(.12);
  assert.ok(Math.abs(dark.scale(1, s) - .8) < 1e-9, `a full-bright zone in a dark scene loses a fifth of its lightness: ${dark.scale(1, s)}`);
  assert.ok(dark.scale(.2, s) > .997 && dark.scale(.33, s) > .99, `a dim zone keeps glowing as it was: ${dark.scale(.2, s)}`);
  assert.ok(Math.abs(seen(.12).scale(1, { ...s, dark: 100 }) - 2 / 3) < 1e-9, 'and at most a third');
  let previous = 0;
  for (const setting of [s, { ...s, dark: 100 }]) { previous = 0; for (let l = 0; l <= 1.0001; l += .02) { const out = l * dark.scale(l, setting); assert.ok(out >= previous - 1e-12, 'a brighter zone never ends up darker than a dimmer one'); previous = out; } }
  const bright = seen(.9);
  assert.ok(Math.abs(bright.level(s) - .75) < 1e-9, `all of the light gets a quarter less bright at the default: ${bright.level(s)}`);
  assert.equal(bright.scale(.2, s), bright.scale(1, s), 'by the same share for every zone, so the picture keeps its balance');
  assert.ok(Math.abs(seen(.9).level({ ...s, bright: 100 }) - .5) < 1e-9, 'and never by more than half');
  // Each slider at 0 switches its half off.
  assert.equal(seen(.1).scale(1, { ...s, dark: 0 }), 1); assert.equal(seen(.95).scale(1, { ...s, bright: 0 }), 1);
  assert.ok(seen(.1).scale(1, { ...s, dark: 100 }) < seen(.1).scale(1, s));
});

test('Adaptive Brightness follows slowly, a cut faster, and its changes still pass the Flash Limiter', () => {
  const run = (speed: number, from: number, to: number, seconds: number) => {
    const e = new AutoExposure(), s = { ...EXPOSURE, speed };
    e.update(from, 0, s);
    for (let t = 0; t < seconds; t += 1 / 12) e.update(to, 1 / 12, s);
    return e.key;
  };
  const slow = run(50, .5, .62, 1), fast = run(100, .5, .62, 1), slowest = run(0, .5, .62, 1);
  assert.ok(slow > .5 && slow < .62 && fast > slow && slowest < slow, `after 1 s: ${slowest} / ${slow} / ${fast}`);
  assert.ok(run(50, .5, .62, 12) > .619, 'it arrives in the end');
  // A cut to a very different scene is followed faster than a drift within one.
  assert.ok((run(50, .2, .9, 1) - .2) / .7 > (run(50, .5, .62, 1) - .5) / .12 + .2);
  // After a pause or another video, the first picture is taken as it is.
  const e = new AutoExposure(); e.update(.2, 0, EXPOSURE); e.update(.8, 10, EXPOSURE); assert.equal(e.key, .8);
  e.update(Number.NaN, .1, EXPOSURE); assert.equal(e.key, .8); e.reset(); assert.equal(e.key, -1);
  // The whole chain: a white picture, then Adaptive Brightness starts lowering it. The light on screen moves no faster than the limiter allows.
  const s = { ...DEFAULTS, brightness: 100, mode: 'vivid' as const, smoothing: 0, responseSpeed: 200 }, filter = new TemporalFilter(), white: RGB[] = Array.from({ length: 64 }, () => [255, 255, 255]);
  let before = 0, lowest = 1;
  for (let i = 0; i < 400; i++) {
    filter.setTarget(white, s, undefined, i < 200 ? null : () => .6);
    const l = luminance(filter.step(1 / 30, s)[0]);
    assert.ok(l - before < .55 / 30 + .002 && before - l < .85 / 30 + .002, `frame ${i}: ${before} → ${l}`);
    before = l; if (i > 200) lowest = Math.min(lowest, l);
  }
  assert.ok(lowest < .3, `the light did come down: ${lowest}`);
});

// ───── Stored data, presets and the rename
test('everything stored by CineGlow 0.9.0 is kept; what is new starts at its default', () => {
  const old = { enabled: true, mode: 'vivid', source: 'video', brightness: 80, glowWidth: 14, intensity: 30, saturation: 120, smoothing: 20, responseSpeed: 150, zoneCount: 96, zoneMode: 'manual',
    flashLimiter: false, manualColor: '#112233', preset: 'moon', protectedLight: 'drift', director: { ...DIRECTOR, strength: 70 }, pulse: { ...PULSE, enabled: true, depth: 55 },
    color: { ...COLOR, shadows: 80 }, trails: { ...TRAILS, enabled: false }, zones: null, hud: true, adaptive: false };
  const profiles = { 'www.youtube.com': { mode: 'ambient', pulse: { ...PULSE, depth: 70 } } }, presets = { 'My look': { brightness: 33, color: { ...COLOR, vibrance: 90 } } };
  const next = migrate({ settings: old, profiles, presets, schema: 3 }, '0.9.0');
  for (const [key, value] of Object.entries(old)) assert.deepEqual(next.settings[key as keyof typeof old], value, key);
  assert.deepEqual([next.settings.glow, next.settings.guard, next.settings.exposure], [GLOW, GUARD, EXPOSURE]);
  assert.deepEqual(next.profiles, profiles); assert.deepEqual(next.presets, presets); assert.equal(next.schema, SCHEMA); assert.equal(SCHEMA, 4);
  assert.deepEqual(sanitize({ glow: { style: 'neon', thickness: 400, curve: 'x' }, guard: { enabled: 'no', strength: -5, pointer: false }, exposure: { enabled: false, speed: 200 } }),
    { ...DEFAULTS, glow: { ...GLOW, thickness: 100 }, guard: { ...GUARD, strength: 0, pointer: false }, exposure: { ...EXPOSURE, enabled: false, speed: 100 } });
  assert.equal(sanitize({ glow: { style: 'halo' } }).glow.style, 'halo');
  for (const key of ['glow', 'guard', 'exposure'] as const) assert.ok(LOOK_KEYS.includes(key), `${key} can be kept per site`);
  assert.deepEqual(sanitizeProfile({ glow: HALO, guard: { ...GUARD, enabled: false }, bogus: 1 }), { glow: HALO, guard: { ...GUARD, enabled: false } });
});

test('presets carry the glow and Adaptive Brightness, never the UI Guard; files written as CineGlow are still read', () => {
  for (const { name, look } of BUILT_IN) {
    assert.ok(look.glow && look.exposure, `${name} says how the light is shaped`); assert.ok(!('guard' in look) && !('zones' in look), `${name} leaves the UI Guard alone`);
  }
  assert.equal(BUILT_IN.find(p => p.name === 'Soft Ambient')!.look.glow!.style, 'halo'); assert.ok(matchesPreset(DEFAULTS, BUILT_IN[0].look));
  assert.deepEqual(sanitizePreset({ brightness: 50, guard: { ...GUARD, enabled: false }, glow: HALO }), { brightness: 50, glow: HALO });
  const guarded = sanitize({ guard: { ...GUARD, strength: 90 } }), overkill = BUILT_IN.find(p => p.name === 'Overkill')!.look;
  assert.deepEqual(sanitize({ ...guarded, ...applyPreset(guarded, overkill) }).guard, guarded.guard, 'Overkill does not loosen the guard');
  // A look saved by 0.9.0 has no glow in it: applying it leaves the glow as it is.
  assert.deepEqual(sanitize({ ...sanitize({ glow: HALO }), ...applyPreset(sanitize({ glow: HALO }), { brightness: 20 }) }).glow, HALO);
  const written = JSON.parse(exportPreset('Mine', { brightness: 40, glow: HALO }));
  assert.deepEqual([written.app, written.kind, written.schema], ['ECLIRIM', 'preset', SCHEMA]);
  assert.equal(JSON.parse(exportBackup(DEFAULTS, {}, {})).app, 'ECLIRIM');
  for (const app of ['ECLIRIM', 'CineGlow']) {
    const read = importJSON(JSON.stringify({ app, kind: 'preset', schema: 3, name: 'Old', look: { brightness: 40 } }));
    assert.deepEqual(read, { kind: 'preset', name: 'Old', look: { brightness: 40 } }, app);
    const backup = importJSON(JSON.stringify({ app, kind: 'backup', schema: 3, settings: { brightness: 12 }, profiles: {}, presets: {} }));
    assert.ok(backup.kind === 'backup' && backup.settings.brightness === 12 && backup.settings.glow.style === 'edge', app);
  }
  assert.equal(importJSON(JSON.stringify({ app: 'Other', kind: 'preset', name: 'x', look: {} })).kind, 'error');
});

// ───── A/B Comparison
test('an A/B comparison changes what a tab shows, only for the settings it belongs to, and nothing that is stored', () => {
  const saved = sanitize({ brightness: 60 }), a = lookOf(saved), b = { ...a, brightness: 90, glow: HALO };
  assert.deepEqual(Object.keys(a).sort(), [...LOOK_KEYS].sort(), 'a look is every setting a site can have for itself');
  const compare = sanitizeCompare({ active: 'b', a, b, target: '' })!;
  assert.equal(compareSettings(saved, compare, '').brightness, 90); assert.equal(compareSettings(saved, compare, '').glow.style, 'halo');
  assert.deepEqual(compareSettings(saved, { ...compare, active: 'a' }, ''), saved, 'A is the saved look');
  assert.equal(compareSettings(saved, compare, 'www.youtube.com'), saved, 'a tab governed by other settings is not touched');
  assert.equal(compareSettings(saved, null, ''), saved); assert.equal(saved.brightness, 60, 'the saved settings are never written to');
  // Global-only settings (on/off, the light source) are not part of a look and cannot be changed by a comparison.
  const sneaky = sanitizeCompare({ active: 'b', a, b: { ...b, enabled: false, source: 'music' }, target: '' })!;
  assert.equal(compareSettings(saved, sneaky, '').enabled, true); assert.equal(compareSettings(saved, sneaky, '').source, 'video');
  for (const broken of [null, 'x', {}, { a }, { a, b: 'no' }]) assert.equal(sanitizeCompare(broken), null);
  assert.equal(sanitizeCompare({ a, b, active: 'z', target: 'Not A Host!' })!.active, 'a'); assert.equal(sanitizeCompare({ a, b, target: 'Not A Host!' })!.target, '');
  assert.equal(sanitizeCompare({ a, b, target: 'www.youtube.com' })!.target, 'www.youtube.com');
});

// ───── Calibration Wizard
test('the wizard turns three answers into a complete, valid look; the middle answers are the default look', () => {
  const start = recommend(WIZARD_START);
  assert.ok(matchesPreset(DEFAULTS, start), 'standard / standard / standard is Cinematic Balanced');
  assert.deepEqual(closestPreset(start), { name: 'Cinematic Balanced', exact: true });
  const keys = Object.keys(BUILT_IN[0].look).sort();
  for (let amount = 0; amount < WIZARD.amount.options.length; amount++) for (let width = 0; width < WIZARD.width.options.length; width++) for (let softness = 0; softness < WIZARD.softness.options.length; softness++) {
    const look = recommend({ amount, width, softness }), label = `${amount}/${width}/${softness}`;
    assert.deepEqual(Object.keys(look).sort(), keys, `${label} is a whole look, like a preset`);
    assert.deepEqual(sanitizePreset(look), look, `${label} is valid as it stands`);
    assert.equal(look.pulse!.enabled, false, `${label} does not switch sound analysis on`); assert.equal(look.flashLimiter, true, `${label} keeps the Flash Limiter`);
    assert.equal(look.glow!.style, softness === 2 ? 'halo' : 'edge'); assert.ok(BUILT_IN.some(p => p.name === closestPreset(look).name));
    if (amount) assert.ok(look.brightness! > recommend({ amount: amount - 1, width, softness }).brightness!, 'more light is more light');
    if (width) assert.ok(look.glowWidth! > recommend({ amount, width: width - 1, softness }).glowWidth!, 'wider is wider');
    if (softness) assert.ok(look.smoothing! > recommend({ amount, width, softness: softness - 1 }).smoothing!, 'softer is calmer');
  }
  assert.deepEqual(recommend({ amount: 99, width: -3, softness: Number.NaN }), recommend({ amount: 3, width: 0, softness: 0 }), 'answers out of range are brought in');
  assert.deepEqual([...WIZARD_STEPS], ['amount', 'width', 'softness']);
  for (const key of WIZARD_STEPS) for (const option of WIZARD[key].options) assert.ok(option.name && option.note.length > 5);
  // Applying a wizard result keeps what the user decided elsewhere: the UI Guard, and whether sound is analysed.
  const mine = sanitize({ guard: { ...GUARD, enabled: false }, pulse: { ...PULSE, enabled: true } }), applied = sanitize({ ...mine, ...applyPreset(mine, recommend({ amount: 3, width: 2, softness: 2 })) });
  assert.equal(applied.guard.enabled, false); assert.equal(applied.pulse.enabled, true); assert.equal(applied.brightness, 100);
});
