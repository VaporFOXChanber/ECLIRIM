import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STEPS, blankZones, editZones, sanitizeZones, zoneLabel, zoneTrim, zoneTrims } from '../src/engine/zones.ts';
import { AdaptiveQuality, QUALITY } from '../src/engine/adaptive.ts';
import { PATTERNS, clockwise, testPattern, type Pattern } from '../src/engine/patterns.ts';
import { ledRow } from '../src/engine/emission.ts';
import { TemporalFilter } from '../src/engine/temporal.ts';
import { toLab } from '../src/engine/color.ts';
import { DEFAULTS, DIRECTOR, LOOK_KEYS, SCHEMA, migrate, resolveSettings, sanitize, sanitizeProfile, sanitizeProfiles } from '../src/shared/settings.ts';
import { siteKey } from '../src/shared/site.ts';
import type { RGB } from '../src/shared/types.ts';

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

test('zone trims are stored by place on the edge, so they read back exactly at every zone count', () => {
  assert.equal(zoneTrims(null, 64).plain, true); assert.equal(zoneTrims(null, 64).active, 64);
  for (const count of [32, 64, 96, 128]) {
    const n = count / 4, zone = n + 3;   // the fourth zone of the bottom side
    const map = editZones(null, count, [zone], { brightness: 40, saturation: 150, intensity: 20 })!;
    assert.deepEqual(zoneTrim(map, count, zone), { brightness: 40, saturation: 150, intensity: 20, on: 1, mixed: false });
    for (const other of [zone - 1, zone + 1, 3, 2 * n + 3]) assert.equal(zoneTrim(map, count, other).brightness, 100, `${count}: neighbours and other sides untouched`);
    const trims = zoneTrims(map, count);
    assert.ok(Math.abs(trims.gain[zone] - .4) < 1e-6 && trims.saturation[zone] === 1.5 && Math.abs(trims.spread[zone] - .2) < 1e-6);
    assert.equal(trims.active, count); assert.equal(trims.plain, false);
  }
});

test('a change of zone count keeps every trim in its place instead of scrambling it', () => {
  // At 64 zones: the whole left side dimmed, the right half of the top switched off, one bottom zone boosted.
  let map = editZones(null, 64, range(32, 48), { brightness: 50 });
  map = editZones(map, 64, range(8, 16), { on: 0 });
  map = editZones(map, 64, [20], { brightness: 180 })!;
  for (const count of [128, 96, 32]) {
    const n = count / 4, trims = zoneTrims(map, count);
    for (let j = 0; j < n; j++) {
      assert.ok(Math.abs(trims.gain[2 * n + j] - .5) < 1e-6, `${count}: left side stays at 50%`);
      assert.equal(trims.gain[3 * n + j], 1, `${count}: right side untouched`);
      assert.equal(trims.gain[j], j < n / 2 ? 1 : 0, `${count}: right half of the top stays off`);
    }
    assert.equal(trims.active, count - n / 2);
    // Bottom zone 5 of 16 covers 4/16–5/16 of the edge. Whatever zone now lies there carries its share of the boost.
    const at = n + Math.floor(4.5 / 16 * n), share = Math.min(1, n / 16);
    assert.ok(Math.abs(trims.gain[at] - (1 + .8 * share)) < 1e-6, `${count}: the boost is where it was (${trims.gain[at]})`);
  }
  // 128 → 64: two fine zones set differently merge into their mean, and are reported as mixed.
  const fine = editZones(editZones(null, 128, [0], { brightness: 0 }), 128, [1], { brightness: 100 });
  assert.deepEqual(zoneTrim(fine, 64, 0), { brightness: 50, saturation: 100, intensity: 100, on: 1, mixed: true });
});

test('resetting zones leaves no map behind, and broken maps are refused', () => {
  const map = editZones(null, 64, [5], { on: 0 });
  assert.notEqual(map, null);
  assert.equal(editZones(map, 64, [5], { on: 1 }), null, 'back to neutral = nothing stored');
  assert.equal(sanitizeZones(blankZones()), null);
  assert.equal(sanitizeZones({ brightness: [1, 2, 3] }), null); assert.equal(sanitizeZones('zones'), null); assert.equal(sanitizeZones(null), null);
  const wild = blankZones(); wild.brightness[0] = 9999; wild.saturation[1] = -5; wild.on[2] = 7; wild.intensity[3] = NaN;
  const clean = sanitizeZones(wild)!;
  assert.deepEqual([clean.brightness[0], clean.saturation[1], clean.on[2], clean.intensity[3]], [200, 0, 1, 100]);
  assert.equal(clean.brightness.length, STEPS * 4);
  assert.equal(zoneLabel(0, 64), '#1 · 上 1/16'); assert.equal(zoneLabel(63, 64), '#64 · 右 16/16'); assert.equal(zoneLabel(32, 128), '#33 · 下 1/32');
});

test('zone trims reach the light: a zone switched off goes dark, a dimmed one is dimmer, a desaturated one greyer', () => {
  const colors: RGB[] = Array.from({ length: 64 }, () => [200, 80, 40]);
  const plain = ledRow(colors, 0, 512, 1, 1);
  const trims = zoneTrims(editZones(editZones(null, 64, [4], { on: 0 }), 64, [10], { brightness: 50 }), 64);
  const row = ledRow(colors, 0, 512, 1, 1, undefined, trims.gain);
  const alpha = (r: Uint8ClampedArray, zone: number) => r[(zone * 32 + 16) * 4 + 3];
  assert.equal(alpha(row, 4), Math.round(alpha(plain, 4) * .25), 'the spline still blends a dark zone with its lit neighbours');
  assert.ok(Math.abs(alpha(row, 10) / alpha(plain, 10) - .625) < .02, 'half drive in the middle of the dimmed zone, blended with full neighbours');
  assert.equal(alpha(row, 7), alpha(plain, 7), 'zones in between are untouched');
  assert.deepEqual([...ledRow(colors, 0, 512, 1, 1, undefined, zoneTrims(null, 64).gain)], [...plain], 'neutral trims change nothing');
  const three = editZones(null, 64, [3, 4, 5], { on: 0 });
  assert.equal(alpha(ledRow(colors, 0, 512, 1, 1, undefined, zoneTrims(three, 64).gain), 4), 0, 'with its neighbours off too, the zone is fully dark');
  // A muted colour, so that twice the saturation still fits the display (Color Engine 2.0 holds back what does not).
  const muted: RGB[] = Array.from({ length: 64 }, () => [150, 120, 105]);
  const filter = new TemporalFilter(), chroma = new Float32Array(64).fill(1); chroma[2] = 0; chroma[3] = 2;
  filter.setTarget(muted, DEFAULTS, chroma);
  for (let i = 0; i < 400; i++) filter.step(.05, { ...DEFAULTS, flashLimiter: false });
  const out = filter.step(.05, DEFAULTS).map(toLab);
  assert.ok(Math.hypot(out[2][1], out[2][2]) < .005, 'saturation 0 = grey');
  assert.ok(Math.hypot(out[3][1], out[3][2]) > Math.hypot(out[1][1], out[1][2]) * 1.5, 'saturation 200% = more colour');
});

test('adaptive quality: a spike changes nothing, sustained load steps down, and it comes back only after a long calm', () => {
  const q = new AdaptiveQuality(); let now = 0;
  const feed = (ms: number, frames: number) => { for (let i = 0; i < frames; i++) q.update(ms, now += 83); return q.level; };
  assert.equal(feed(2, 120), 0);
  assert.equal(feed(40, 3), 0, 'three slow frames in a row are a spike'); assert.equal(feed(2, 60), 0);
  assert.equal(feed(14, 30), 1, 'two and a half seconds of slow frames step down once');
  assert.equal(feed(14, 20), 1, 'and not again within four seconds');
  assert.equal(feed(14, 60), 2); assert.equal(feed(14, 200), 3); assert.equal(feed(14, 200), 3, 'the lowest level is the floor');
  assert.equal(QUALITY[3].interval, 2, 'the floor analyses on every other tick');
  assert.equal(feed(2, 40), 3, 'three seconds of calm are not enough to come back');
  assert.equal(feed(2, 40), 2, 'five are');
  // Right at the limit: the level that was regained is lost again at once, so the next attempt has to wait twice as long.
  assert.equal(feed(14, 45), 3);
  assert.equal(feed(2, 100), 3, 'eight seconds of calm no longer suffice'); assert.equal(feed(2, 40), 2);
  q.reset(); assert.equal(q.level, 0);
});

test('test patterns light what they say, for every zone count', () => {
  for (const count of [32, 64, 96, 128]) {
    const n = count / 4;
    for (const name of Object.keys(PATTERNS) as Pattern[]) {
      const colors = testPattern(name, count, 1.2, new Set([3]));
      assert.equal(colors.length, count);
      for (const rgb of colors) for (const v of rgb) assert.ok(v >= 0 && v <= 255, `${name} stays in range`);
    }
    const identify = testPattern('identify', count, 0, new Set([3, n + 1]));
    assert.deepEqual(identify.map((c, i) => c[0] > 0 ? i : -1).filter(i => i >= 0), [3, n + 1], 'only the selected zones are lit');
    const corners = testPattern('corners', count, 0);
    assert.ok(corners[0][0] > 200 && corners[0][1] < 100, 'top-left red, on the top side');
    assert.deepEqual(corners[2 * n], corners[0], 'and on the left side');
    assert.deepEqual(corners[n - 1], corners[3 * n], 'top-right green on both of its sides');
    assert.deepEqual(corners[2 * n - 1], corners[4 * n - 1], 'bottom-right blue'); assert.deepEqual(corners[n], corners[3 * n - 1], 'bottom-left yellow');
    assert.deepEqual(corners[Math.floor(n / 2)], [0, 0, 0], 'the middle of a side is dark');
    const gradient = testPattern('gradient', count, 0);
    assert.ok(gradient[0][0] < gradient[n - 1][0] && gradient[2 * n][0] < gradient[3 * n - 1][0]);
    // The moving light is one spot travelling clockwise: top left→right, then down the right side.
    const brightest = (t: number) => { const c = testPattern('moving', count, t); return c.reduce((best, v, i) => v[0] > c[best][0] ? i : best, 0); };
    assert.ok(brightest(.4) < brightest(1.1) && brightest(1.1) < n, 'along the top');
    assert.ok(brightest(2.2) >= 3 * n, 'then on the right side');
    assert.ok(clockwise(0, count) < clockwise(n - 1, count) && clockwise(n - 1, count) < clockwise(3 * n, count) && clockwise(3 * n, count) < clockwise(2 * n - 1, count));
  }
  assert.deepEqual(testPattern('rgb', 64, 0)[10], [255, 0, 0]); assert.deepEqual(testPattern('rgb', 64, 1.6)[10], [0, 255, 0]); assert.deepEqual(testPattern('rgb', 64, 3.1)[10], [0, 0, 255]);
});

test('settings saved by earlier versions keep every value and gain the new defaults', () => {
  const old = { enabled: true, mode: 'vivid', source: 'video', brightness: 80, glowWidth: 14, intensity: 30, saturation: 120, smoothing: 20,
    responseSpeed: 150, zoneCount: 96, zoneMode: 'manual', flashLimiter: false, manualColor: '#112233', preset: 'moon', protectedLight: 'drift' };
  const { settings, profiles, schema } = migrate({ settings: old }, '0.7.1');
  for (const [key, value] of Object.entries(old)) assert.equal(settings[key as keyof typeof old], value, key);
  assert.deepEqual(settings.director, DIRECTOR); assert.equal(settings.zones, null); assert.equal(settings.hud, false); assert.equal(settings.adaptive, true);
  assert.deepEqual(profiles, {}); assert.equal(schema, SCHEMA);
  assert.deepEqual(migrate({}).settings, DEFAULTS, 'a fresh install');
  assert.equal(migrate({ settings: { protectedLight: 'preset' } }, '0.7.0').settings.protectedLight, 'off', "0.7.0's default follows the new one");
  assert.equal(migrate({ settings: { protectedLight: 'preset' } }, '0.7.1').settings.protectedLight, 'preset', 'a later choice is kept');
  assert.deepEqual(sanitize({ director: { enabled: false, motion: 500, strength: -3, source: 'x' } }).director, { ...DIRECTOR, enabled: false, motion: 100, strength: 0 });
  assert.equal(DIRECTOR.enabled, true); assert.ok(DIRECTOR.strength <= 40, 'on by default, at a modest strength');
});

test('a site profile holds only what differs, inherits the rest, and never carries global-only settings', () => {
  const global = sanitize({ mode: 'cinema', brightness: 65, source: 'video', zoneCount: 64, zoneMode: 'manual' });
  const profile = sanitizeProfile({ mode: 'vivid', director: { ...DIRECTOR, motion: 90 }, enabled: false, source: 'manual', zoneCount: 128, hud: true, brightness: 'loud' });
  assert.deepEqual(Object.keys(profile).sort(), ['brightness', 'director', 'mode'], 'look settings only');
  assert.equal(profile.brightness, 65, 'an invalid value falls back to the default instead of poisoning the profile');
  const used = resolveSettings(global, { mode: 'vivid', director: { ...DIRECTOR, motion: 90 } });
  assert.equal(used.mode, 'vivid'); assert.equal(used.director.motion, 90);
  assert.equal(used.brightness, 65); assert.equal(used.enabled, true); assert.equal(used.source, 'video'); assert.equal(used.zoneCount, 64);
  // Inheritance: what the profile does not set follows later changes of the global settings.
  assert.equal(resolveSettings({ ...global, brightness: 30 }, { mode: 'vivid' }).brightness, 30);
  assert.equal(resolveSettings(global, null), global); assert.equal(resolveSettings(global, undefined), global);
  // A profile may also say "no zone trims here" while the global settings have some.
  const trimmed = { ...global, zones: editZones(null, 64, [1], { on: 0 }) };
  assert.equal(resolveSettings(trimmed, { zones: null }).zones, null); assert.notEqual(resolveSettings(trimmed, {}).zones, null);
  assert.deepEqual(Object.keys(sanitizeProfiles({ 'www.youtube.com': { mode: 'vivid' }, 'bad host!': {}, file: {}, '': {} })).sort(), ['file', 'www.youtube.com']);
  assert.deepEqual(sanitizeProfiles('nope'), {});
  assert.ok(!LOOK_KEYS.includes('enabled' as never) && !LOOK_KEYS.includes('source' as never) && !LOOK_KEYS.includes('protectedLight' as never));
  assert.equal(siteKey('https://www.youtube.com/watch?v=1'), 'www.youtube.com'); assert.equal(siteKey('http://localhost:4173/a'), 'localhost');
  assert.equal(siteKey('file:///Users/me/movie.html'), 'file'); assert.equal(siteKey('chrome://extensions'), null); assert.equal(siteKey('not a url'), null);
});
