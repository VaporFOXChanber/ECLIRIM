import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN, applyPreset, builtInName, exportBackup, exportPreset, freePresetName, importJSON, matchesPreset, presetFrom, withoutListening } from '../src/shared/presets.ts';
import { COLOR, DEFAULTS, DIRECTOR, PULSE, SCHEMA, TRAILS, migrate, presetName, sanitize, sanitizePreset, sanitizePresets } from '../src/shared/settings.ts';
import { editZones } from '../src/engine/zones.ts';
import { Store } from '../src/ui/store.ts';
import type { Presets } from '../src/shared/types.ts';

test('the built-in presets are complete looks that never switch sound analysis on or the Flash Limiter off', () => {
  const names = BUILT_IN.map(p => p.name);
  for (const wanted of ['Cinematic Balanced', 'Vivid Action', 'Soft Ambient', 'Overkill']) assert.ok(names.includes(wanted), wanted);
  assert.equal(new Set(names).size, names.length);
  for (const { name, note, look } of BUILT_IN) {
    assert.ok(note.length > 5, `${name} says what it is for`);
    assert.deepEqual(Object.keys(look).sort(), ['brightness', 'color', 'director', 'exposure', 'flashLimiter', 'glow', 'glowWidth', 'intensity', 'mode', 'pulse', 'responseSpeed', 'saturation', 'smoothing', 'trails'], `${name} is a whole look`);
    assert.equal(look.pulse!.enabled, false, `${name} does not turn listening on`); assert.equal(look.flashLimiter, true, `${name} keeps the Flash Limiter`);
    assert.deepEqual(sanitizePreset(look), look, `${name} is already clean`);
  }
  assert.ok(matchesPreset(DEFAULTS, BUILT_IN[0].look), 'Cinematic Balanced is the default look');
  assert.ok(!matchesPreset(DEFAULTS, BUILT_IN[1].look));
});

test('applying a preset changes the look and nothing else', () => {
  const overkill = BUILT_IN.find(p => p.name === 'Overkill')!.look;
  for (const listening of [true, false]) {
    const current = sanitize({ source: 'video', enabled: true, zoneCount: 96, zoneMode: 'manual', hud: true, zones: editZones(null, 64, [1], { on: 0 }), pulse: { ...PULSE, enabled: listening } });
    const patch = applyPreset(current, overkill), next = sanitize({ ...current, ...patch });
    assert.equal(next.pulse.enabled, listening, 'whether sound is analysed stays as the user has it');
    assert.deepEqual({ ...next.pulse, enabled: false }, overkill.pulse); assert.equal(next.brightness, 100); assert.equal(next.mode, 'vivid');
    assert.deepEqual([next.source, next.enabled, next.zoneCount, next.hud], ['video', true, 96, true]); assert.notEqual(next.zones, null, 'zone trims belong to the screen and stay');
    assert.ok(matchesPreset(next, overkill));
  }
  assert.deepEqual(presetFrom(sanitize({ zones: editZones(null, 64, [1], { on: 0 }), pulse: { ...PULSE, enabled: true } })).pulse, PULSE);
  assert.ok(!('zones' in presetFrom(DEFAULTS)));
});

test('presets travel as JSON and come back the same; anything else in the file is dropped', () => {
  const mine = presetFrom(sanitize({ mode: 'ambient', brightness: 42, director: { ...DIRECTOR, strength: 77 }, color: { ...COLOR, vibrance: 90 }, trails: { ...TRAILS, length: 10 } }));
  const back = importJSON(exportPreset('  My <b>look</b>\n', mine));
  assert.deepEqual(back, { kind: 'preset', name: 'My blook/b', look: mine });
  // A file from someone else: it may say anything.
  const hostile = importJSON(JSON.stringify({ app: 'CineGlow', kind: 'preset', schema: SCHEMA, name: 'x', look: {
    brightness: 9999, mode: 'nuclear', pulse: { enabled: true, depth: 500 }, zones: editZones(null, 64, [1], { on: 0 }), source: 'music', enabled: false, hud: true, __proto__: { polluted: 1 }, script: '<script>' } }));
  assert.equal(hostile.kind, 'preset');
  if (hostile.kind === 'preset') {
    assert.deepEqual(Object.keys(hostile.look).sort(), ['brightness', 'mode', 'pulse']); assert.equal(hostile.look.brightness, 100); assert.equal(hostile.look.mode, 'cinema');
    assert.deepEqual(hostile.look.pulse, { ...PULSE, depth: 100, enabled: false }, 'it cannot switch listening on');
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  for (const [text, why] of [['{', /JSONとして/], ['[1,2]', /ECLIRIMの書き出し/], [JSON.stringify({ app: 'Other', kind: 'preset' }), /ECLIRIMの書き出し/], [JSON.stringify({ app: 'CineGlow', kind: 'preset', name: '', look: {} }), /名前/],
    [JSON.stringify({ app: 'CineGlow', kind: 'theme' }), /種類/], [JSON.stringify({ app: 'CineGlow', kind: 'preset', schema: SCHEMA + 1, name: 'x', look: {} }), /新しい版/], ['x'.repeat(400_001), /大きすぎ/]] as const) {
    const result = importJSON(text); assert.equal(result.kind, 'error'); if (result.kind === 'error') assert.match(result.error, why);
  }
  assert.equal(presetName('  a\tb  '), 'ab'); assert.equal(presetName('x'.repeat(60)).length, 40); assert.equal(presetName(5), ''); assert.equal(presetName('   '), '');
  assert.deepEqual(Object.keys(sanitizePresets({ ' ok ': { mode: 'vivid' }, '': {}, '<>': {} })), ['ok']);
});

test('a backup holds everything and restores it; reading one never starts sound analysis', () => {
  const settings = sanitize({ mode: 'vivid', source: 'music', pulse: { ...PULSE, enabled: true, depth: 80 }, zones: editZones(null, 64, [2], { brightness: 50 }), hud: true });
  const profiles = { 'www.youtube.com': { mode: 'ambient' as const, pulse: { ...PULSE, enabled: true } } }, presets = { Mine: presetFrom(settings) };
  const back = importJSON(exportBackup(settings, profiles, presets));
  assert.deepEqual(back, { kind: 'backup', settings, profiles, presets });
  if (back.kind !== 'backup') return;
  const quiet = withoutListening(back, DEFAULTS);
  assert.equal(quiet.settings.pulse.enabled, false); assert.equal(quiet.settings.pulse.depth, 80); assert.equal(quiet.settings.source, 'video', 'Music Mode listens too');
  assert.equal(quiet.profiles['www.youtube.com'].pulse!.enabled, false); assert.equal(quiet.profiles['www.youtube.com'].mode, 'ambient');
  assert.notEqual(quiet.settings.zones, null); assert.equal(quiet.settings.hud, true);
  const already = withoutListening(back, sanitize({ source: 'music', pulse: { ...PULSE, enabled: true } }));
  assert.equal(already.settings.pulse.enabled, true); assert.equal(already.settings.source, 'music'); assert.equal(already.profiles['www.youtube.com'].pulse!.enabled, true);
});

test('settings stored by 0.8.1 keep every value; what is new starts at its default, with sound analysis off', () => {
  const old = { enabled: true, mode: 'vivid', source: 'video', brightness: 80, glowWidth: 14, intensity: 30, saturation: 120, smoothing: 20, responseSpeed: 150, zoneCount: 96, zoneMode: 'manual',
    flashLimiter: false, manualColor: '#112233', preset: 'moon', protectedLight: 'drift', director: { ...DIRECTOR, strength: 70 }, zones: editZones(null, 64, [3], { on: 0 }), hud: true, adaptive: false };
  const { settings, profiles, presets, schema } = migrate({ settings: old, profiles: { localhost: { mode: 'ambient' } }, schema: 2 }, '0.8.1');
  for (const [key, value] of Object.entries(old)) assert.deepEqual(settings[key as keyof typeof old], value, key);
  assert.deepEqual([settings.pulse, settings.color, settings.trails], [PULSE, COLOR, TRAILS]); assert.equal(PULSE.enabled, false);
  assert.deepEqual(profiles, { localhost: { mode: 'ambient' } }); assert.deepEqual(presets, {}); assert.equal(schema, SCHEMA);
  assert.deepEqual(sanitize({ pulse: { enabled: true, depth: -4, bass: 'x' }, color: { enabled: false, wideGamut: 'yes' }, trails: { length: 300 } }),
    { ...DEFAULTS, pulse: { ...PULSE, enabled: true, depth: 0 }, color: { ...COLOR, enabled: false }, trails: { ...TRAILS, length: 100 } });
  assert.equal(sanitize({ source: 'music' }).source, 'music');
});

test('an imported preset never loops, never overwrites, and keeps its number whole', () => {
  const look = presetFrom(DEFAULTS), mine: Presets = {};
  // Import the same file again and again, the way the settings page does.
  const take = (name: string) => { const free = freePresetName(name, mine); assert.equal(presetName(free), free, 'stored exactly as named'); mine[free] = look; return free; };
  for (const length of [40, 39, 38, 36, 12]) {
    const name = 'あ'.repeat(length - 1) + 'x';
    assert.equal(take(name), name);
    for (let n = 2; n <= 12; n++) {
      const next = take(name);
      assert.ok(next.endsWith(` (${n})`) && next.length <= 40, `${length}: ${next}`);
      assert.ok(!next.includes('  ') && next === next.trim());
    }
    assert.equal(Object.keys(mine).length, 12, `${length}: no import replaced another`);
    for (const key of Object.keys(mine)) delete mine[key];
  }
  // A name that would end in a space once shortened loses the space, not the number.
  assert.equal(freePresetName('a'.repeat(35) + ' bcd', { ['a'.repeat(35) + ' bcd']: look }), 'a'.repeat(35) + ' (2)');
  assert.equal(freePresetName('  ', {}), ''); assert.equal(freePresetName(42, {}), '');
});

test('names are shortened between characters: an emoji is never cut in half, so a stored name is found again', () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, look = presetFrom(DEFAULTS);
  // What Chrome keeps of a key (half a character becomes U+FFFD), read back the way loadPresets reads it.
  const stored = (presets: Presets): Presets => sanitizePresets(Object.fromEntries(Object.entries(presets).map(([key, value]) => [key.replace(new RegExp(lone, 'g'), '�'), value])));
  const name = 'a' + '😀'.repeat(19) + 'z';
  assert.equal(name.length, 40); assert.equal(presetName(name), name, 'a whole name of 40 units stays as it is');
  assert.equal(presetName('a' + '😀'.repeat(20)), 'a' + '😀'.repeat(19)); assert.equal(presetName('😀'.repeat(25)), '😀'.repeat(20));
  let mine: Presets = {};
  for (let n = 1; n <= 11; n++) {
    const free = freePresetName(name, mine);
    assert.ok(!lone.test(free) && free.length <= 40 && presetName(free) === free, free);
    mine = stored({ ...mine, [free]: look });
    assert.equal(Object.keys(mine).length, n, `import ${n} replaced nothing`); assert.ok(Object.hasOwn(mine, free), `${free} is found again`);
  }
  assert.ok(Object.hasOwn(mine, 'a' + '😀'.repeat(17) + ' (2)') && Object.hasOwn(mine, 'a' + '😀'.repeat(17) + ' (10)'));
  // From (9) to (10) the number grows by one unit, and the name gives it up.
  const plain = 'b'.repeat(40), taken: Presets = { [plain]: look };
  for (let n = 2; n <= 9; n++) taken[freePresetName(plain, taken)] = look;
  assert.ok(Object.hasOwn(taken, 'b'.repeat(36) + ' (9)'));
  assert.equal(freePresetName(plain, taken), 'b'.repeat(35) + ' (10)');
});

test('standard preset names are taken in any case; the user\'s own are told apart exactly', () => {
  assert.ok(builtInName('Overkill') && builtInName('overkill') && builtInName('SOFT AMBIENT') && !builtInName('Overkill 2'));
  assert.equal(freePresetName('overkill', {}), 'overkill (2)');
  assert.equal(freePresetName(' Cinematic Balanced ', {}), 'Cinematic Balanced (2)');
  assert.equal(freePresetName('mine', { Mine: {} }), 'mine', 'a different case is a different preset of the user\'s');
  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) assert.equal(freePresetName(name, {}), name, `${name} is free while nobody has it`);
});

test('presets named like object properties are kept, listed, read back, removed and backed up', async () => {
  const look = presetFrom(sanitize({ mode: 'vivid' })), names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
  const raw = JSON.parse('{' + names.map(name => JSON.stringify(name) + ':' + JSON.stringify(look)).join(',') + '}');
  const clean = sanitizePresets(raw);
  assert.deepEqual(Object.keys(clean).sort(), [...names].sort());
  for (const name of names) { assert.ok(Object.hasOwn(clean, name), name); assert.deepEqual(clean[name], look, name); }
  assert.equal(Object.getPrototypeOf(clean), Object.prototype, 'the dictionary keeps its prototype');
  assert.equal(({} as Record<string, unknown>).mode, undefined, 'nothing reached Object.prototype');
  const back = importJSON(exportBackup(DEFAULTS, {}, clean));
  assert.equal(back.kind, 'backup'); if (back.kind === 'backup') assert.deepEqual(back.presets, clean);
  // The store, with storage receiving what Chrome would.
  const written: { presets?: unknown }[] = [];
  (globalThis as any).chrome = { storage: { local: { set: async (items: Record<string, unknown>) => { written.push(JSON.parse(JSON.stringify(items))); } } } };
  try {
    const store = new Store(message => assert.fail(message));
    (store as unknown as { loaded: boolean }).loaded = true;
    for (const name of names) assert.equal(store.setPreset(name, look), name);
    for (const name of names) assert.ok(Object.hasOwn(store.presets, name) && store.presets[name].mode === 'vivid', name);
    assert.equal(freePresetName('__proto__', store.presets), '__proto__ (2)');
    assert.equal(freePresetName('constructor', store.presets), 'constructor (2)');
    store.setPreset('__proto__', null); store.setPreset('toString', null);
    assert.deepEqual(Object.keys(store.presets).sort(), ['constructor', 'hasOwnProperty']);
    await store.saved;
    assert.deepEqual(Object.keys(sanitizePresets(written[written.length - 1].presets)).sort(), ['constructor', 'hasOwnProperty']);
    store.restore(DEFAULTS, {}, clean);
    assert.deepEqual(Object.keys(store.presets).sort(), [...names].sort());
    await store.saved;
    assert.deepEqual(sanitizePresets(written[written.length - 1].presets), clean, 'a restored backup is written whole');
  } finally { delete (globalThis as any).chrome; }
});
