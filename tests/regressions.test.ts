import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TemporalFilter } from '../src/engine/temporal.ts';
import { DEFAULTS, fallbackColors, sanitize } from '../src/shared/settings.ts';
import { exportBackup, importJSON } from '../src/shared/presets.ts';
import { editZones, zoneTrim } from '../src/engine/zones.ts';
import { labToLinear, toLab } from '../src/engine/color.ts';
import type { Profiles, RGB } from '../src/shared/types.ts';
import { world } from './world.ts';

const light = (rgb: RGB) => { const [l, a, b] = toLab(rgb); const [r, g, bl] = labToLinear(l, a, b); return .2126 * r + .7152 * g + .0722 * bl; };

test('Flash Limiter: when pulsed light stops (sound muted, Pulse off), the step back to the plain colour is bounded too', () => {
  const s = sanitize({ flashLimiter: true }), f = new TemporalFilter(), gray: RGB[] = Array.from({ length: 8 }, () => [110, 110, 110]);
  f.setTarget(gray, s);
  for (let i = 0; i < 400; i++) f.step(1 / 30, s);
  const dim = new Float32Array(8).fill(.45);
  let shown = f.step(1 / 30, s, dim);
  for (let i = 0; i < 120; i++) shown = f.step(1 / 30, s, dim);
  // Sound is gone: no gain any more. One frame may move the light by no more than the limiter's rise for that frame.
  const next = f.step(1 / 30, s, null);
  const rise = light(next[0]) - light(shown[0]);
  assert.ok(rise <= .55 / 30 + 1e-3, `one-frame rise ${rise.toFixed(4)} stays within the limit`);
});

test('a stored colour or preset that is not a string is not taken (no NaN light)', () => {
  const s = sanitize({ manualColor: ['#aa0099'], preset: ['moon'], source: 'manual' });
  assert.equal(s.manualColor, DEFAULTS.manualColor); assert.equal(s.preset, DEFAULTS.preset);
  assert.ok(fallbackColors(s, 0)[0].every(Number.isFinite));
});

test('a backup this extension writes can always be read back, even with many fully trimmed site profiles', () => {
  const profiles: Profiles = {};
  for (let i = 0; i < 40; i++) profiles[`site${i}.example`] = { zones: editZones(null, 128, Array.from({ length: 128 }, (_, z) => z), { brightness: 37 + i }) };
  const text = exportBackup(DEFAULTS, profiles, {});
  assert.ok(text.length > 400_000, 'larger than the old limit');
  const back = importJSON(text);
  assert.equal(back.kind, 'backup');
});

test('two settings pages trimming different zones at the same time keep both trims', async () => {
  const w = world();
  try {
    w.seed({ settings: sanitize({}) });
    const one = await w.page('options.html'), two = await w.page('options.html');
    one.store.trimZones(64, [0], { brightness: 20 }); two.store.trimZones(64, [1], { brightness: 30 });
    await w.idle();
    const zones = sanitize((w.data as any).settings).zones;
    assert.deepEqual([zoneTrim(zones, 64, 0).brightness, zoneTrim(zones, 64, 1).brightness], [20, 30]);
    // Dragging a slider gathers the moves on one selection into one change, the last value kept.
    one.store.trimZones(64, [2, 3], { saturation: 150 }, true); one.store.trimZones(64, [2, 3], { saturation: 160 }, true); one.store.flush();
    await w.idle();
    const after = sanitize((w.data as any).settings).zones;
    assert.deepEqual([zoneTrim(after, 64, 2).saturation, zoneTrim(after, 64, 3).saturation, zoneTrim(after, 64, 0).brightness], [160, 160, 20]);
  } finally { w.done(); }
});

test('zone trims during an A/B comparison go to the side shown, and the saved trims stay as they were', async () => {
  const w = world();
  try {
    w.seed({ settings: sanitize({}) });
    const page = await w.page('options.html');
    assert.ok((await page.store.startCompare()).ok);
    page.store.trimZones(64, [5], { on: 0 });
    await w.idle();
    assert.equal(sanitize((w.data as any).settings).zones, null, 'saved settings untouched');
    assert.equal(zoneTrim(sanitize({ zones: (w.data as any).compare.b.zones }).zones, 64, 5).on, 0, 'B has the trim');
  } finally { w.done(); }
});

test('removing the profile under an A/B comparison ends the comparison in the same write', async () => {
  const w = world();
  try {
    w.seed({ settings: sanitize({}), profiles: { 'example.com': { brightness: 30 } } });
    const page = await w.page('options.html');
    page.store.target = 'example.com';
    assert.ok((await page.store.startCompare()).ok);
    assert.ok((await page.store.setProfile('example.com', null)).ok);
    await w.idle();
    assert.ok(!(w.data as any).compare, 'no comparison is left behind');
    assert.equal(page.store.compare, null);
  } finally { w.done(); }
});

test('resetting zones that are already neutral on an inheriting profile writes nothing, so it keeps inheriting', async () => {
  const w = world();
  try {
    w.seed({ settings: sanitize({}), profiles: { 'example.com': { brightness: 30 } } });
    const page = await w.page('options.html');
    page.store.target = 'example.com';
    page.store.trimZones(64, [3], { brightness: 100, saturation: 100, intensity: 100, on: 1 });
    await w.idle();
    assert.ok(!('zones' in (w.data as any).profiles['example.com']), 'the profile does not pin the zone trims');
  } finally { w.done(); }
});

test('the import limit is in bytes, the same for a file, pasted text and an export', () => {
  // Three bytes per character in UTF-8: under the limit in characters, over it in bytes.
  const text = JSON.stringify({ app: 'ECLIRIM', kind: 'preset', name: 'x', look: {}, pad: 'あ'.repeat(2_000_000) });
  const result = importJSON(text);
  assert.equal(result.kind, 'error');
  if (result.kind === 'error') assert.match(result.error, /大きすぎ/);
});

test('after pulsed light the filter is not settled until what is shown is back, so painting goes on', () => {
  const s = sanitize({ flashLimiter: true }), f = new TemporalFilter(), gray: RGB[] = Array.from({ length: 4 }, () => [180, 180, 180]);
  f.setTarget(gray, s);
  for (let i = 0; i < 400; i++) f.step(1 / 30, s);
  const dim = new Float32Array(4).fill(.3);
  for (let i = 0; i < 60; i++) f.step(1 / 30, s, dim);
  f.step(1 / 30, s, null);
  assert.equal(f.settled, false, 'still returning');
  for (let i = 0; i < 600; i++) f.step(1 / 30, s, null);
  assert.equal(f.settled, true);
});

test('hushing the Pulse Engine forgets the sound but keeps the beat spacing and count', async () => {
  const { PulseAnalyser } = await import('../src/engine/pulse.ts');
  const { PULSE } = await import('../src/shared/settings.ts');
  const p = new PulseAnalyser(), bins = 1024, rate = 48000;
  const quiet = new Float32Array(bins).fill(-120), kick = new Float32Array(bins).fill(-120);
  for (let i = 1; i < 6; i++) kick[i] = -6;
  for (let i = 0; i < 40; i++) p.update(quiet, rate, 1 / 60, PULSE, true);
  let beats = 0;
  for (let i = 0; i < 3; i++) { p.update(kick, rate, 1 / 60, PULSE, true); }
  beats = p.beats;
  p.hush();
  assert.equal(p.beats, beats); assert.equal(p.frame.silent, true);
  // Right after the hush, a kick cannot count as a new beat before a third of a second has passed since the last one.
  if (beats) { p.update(quiet, rate, 1 / 60, PULSE, true); p.update(kick, rate, 1 / 60, PULSE, true); assert.equal(p.beats, beats); }
});

test('feedback draft: two settings pages changing different fields at once keep both; a clear empties it', async () => {
  const w = world();
  try {
    const { handleMessage } = await import('../src/service.ts');
    const { url } = await import('./world.ts');
    const options = { id: 'eclirim-test', url: url('options.html') } as chrome.runtime.MessageSender;
    const send = (patch: Record<string, unknown> | null) => handleMessage({ target: 'background', type: 'draft', patch }, options);
    await Promise.all([send({ good: 'よかった' }), send({ idea: 'こうしたい' })]);
    assert.deepEqual([(w.data as any).feedbackDraft.good, (w.data as any).feedbackDraft.idea], ['よかった', 'こうしたい']);
    await send(null);
    assert.equal((w.data as any).feedbackDraft.good, '');
    // Only a settings page may write it.
    assert.equal(handleMessage({ target: 'background', type: 'draft', patch: { good: 'x' } }, { id: 'eclirim-test', url: url('popup.html') } as chrome.runtime.MessageSender), undefined);
  } finally { w.done(); }
});

test('returning a compared profile setting to the global one waits until the comparison ends', async () => {
  const w = world();
  try {
    w.seed({ settings: sanitize({}), profiles: { 'example.com': { brightness: 30 } } });
    const page = await w.page('options.html');
    page.store.target = 'example.com';
    assert.ok((await page.store.startCompare()).ok);
    const result = await page.store.inherit('example.com', ['brightness']);
    assert.equal(result.ok, false);
    assert.deepEqual((w.data as any).profiles['example.com'], { brightness: 30 });
  } finally { w.done(); }
});
