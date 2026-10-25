import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN, applyPreset, builtInName, exportBackup, exportPreset, freePresetName, guardRestore, importJSON, limiterKept, matchesPreset, presetFrom, resetProfile } from '../src/shared/presets.ts';
import { COLOR, DEFAULTS, DIRECTOR, PULSE, SCHEMA, TRAILS, lookOf, migrate, presetName, sanitize, sanitizePreset, sanitizePresets } from '../src/shared/settings.ts';
import { editZones } from '../src/engine/zones.ts';
import { command } from '../src/service.ts';
import type { Presets } from '../src/shared/types.ts';
import { world } from './world.ts';

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
  const quiet = guardRestore(back, { settings: DEFAULTS, profiles: {} });
  assert.equal(quiet.settings.pulse.enabled, false); assert.equal(quiet.settings.pulse.depth, 80); assert.equal(quiet.settings.source, 'video', 'Music Mode listens too');
  assert.equal(quiet.profiles['www.youtube.com'].pulse!.enabled, false); assert.equal(quiet.profiles['www.youtube.com'].mode, 'ambient');
  assert.notEqual(quiet.settings.zones, null); assert.equal(quiet.settings.hud, true); assert.ok(quiet.quieted && !quiet.limiter, "it says listening was kept off");
  const already = guardRestore(back, { settings: sanitize({ source: 'music', pulse: { ...PULSE, enabled: true } }), profiles: {} });
  assert.equal(already.settings.pulse.enabled, true); assert.equal(already.settings.source, 'music'); assert.equal(already.profiles['www.youtube.com'].pulse!.enabled, true);
  assert.ok(!already.quieted, "nothing was kept off");
  // Listening is judged per site: a site where it is off here stays off, whatever the global switch says.
  const site = guardRestore(back, { settings: sanitize({ source: 'music', pulse: { ...PULSE, enabled: true } }), profiles: { 'www.youtube.com': { pulse: { ...PULSE, enabled: false } }, 'quiet.example': { pulse: PULSE } } });
  assert.equal(site.settings.pulse.enabled, true); assert.equal(site.profiles['www.youtube.com'].pulse!.enabled, false); assert.equal(site.profiles['www.youtube.com'].mode, 'ambient');
  assert.equal(site.profiles['quiet.example'].pulse!.enabled, false, 'a site the backup does not have keeps listening off'); assert.ok(site.quieted, "it says listening was kept off");
});

test('applying a preset never turns a Flash Limiter that is on off; one that is off takes what the preset says', () => {
  const loud = { ...BUILT_IN.find(p => p.name === 'Overkill')!.look, flashLimiter: false };
  for (const listening of [true, false]) {
    const on = sanitize({ flashLimiter: true, pulse: { ...PULSE, enabled: listening } }), patch = applyPreset(on, loud), next = sanitize({ ...on, ...patch });
    assert.equal(next.flashLimiter, true, 'kept on'); assert.ok(limiterKept(on, loud), "it says so");
    assert.equal(next.pulse.enabled, listening, 'Pulse protection still holds'); assert.equal(next.brightness, 100); assert.equal(next.mode, 'vivid'); assert.equal(next.saturation, 150, 'the rest of the look is applied');
  }
  const off = sanitize({ flashLimiter: false });
  assert.equal(sanitize({ ...off, ...applyPreset(off, loud) }).flashLimiter, false); assert.ok(!limiterKept(off, loud), "nothing was kept");
  assert.equal(sanitize({ ...off, ...applyPreset(off, BUILT_IN[0].look) }).flashLimiter, true, 'a preset may still turn it on');
  assert.ok(!limiterKept(DEFAULTS, BUILT_IN[0].look) && !limiterKept(DEFAULTS, { mode: 'vivid' }), "nothing to keep");
});

test('restoring a backup keeps the Flash Limiter on wherever it is on, globally and on each site', () => {
  const wanted = { settings: sanitize({ flashLimiter: false, brightness: 30 }), profiles: {
    'off.example': { flashLimiter: false, mode: 'ambient' as const }, 'inherit.example': { brightness: 20 }, 'new.example': { flashLimiter: false } } };
  // Here: on globally, and on mine.example through its own profile, which the backup does not have.
  const here = { settings: sanitize({ flashLimiter: true }), profiles: { 'mine.example': { flashLimiter: true } } };
  const kept = guardRestore(wanted, here);
  assert.equal(kept.settings.flashLimiter, true); assert.equal(kept.settings.brightness, 30, 'the rest is restored'); assert.ok(kept.limiter && !kept.quieted, "it says the Flash Limiter was kept");
  for (const site of ['off.example', 'inherit.example', 'new.example']) assert.equal(sanitize({ ...kept.settings, ...kept.profiles[site] }).flashLimiter, true, site);
  assert.equal(kept.profiles['off.example'].mode, 'ambient'); assert.equal(kept.profiles['inherit.example'].brightness, 20);
  // Off globally here, but on for one site: only that site keeps it, and a profile the backup lacks is kept to hold it.
  const some = guardRestore(wanted, { settings: sanitize({ flashLimiter: false }), profiles: { 'off.example': { flashLimiter: true }, 'mine.example': { flashLimiter: true }, 'plain.example': { mode: 'vivid' } } });
  assert.equal(some.settings.flashLimiter, false, 'off here: the backup decides');
  assert.equal(some.profiles['off.example'].flashLimiter, true); assert.deepEqual(some.profiles['mine.example'], { flashLimiter: true });
  assert.equal(some.profiles['new.example'].flashLimiter, false); assert.ok(!('plain.example' in some.profiles), 'a profile with nothing to protect is not kept'); assert.ok(some.limiter, "it says the Flash Limiter was kept");
  // Off everywhere here: the backup is taken as it is.
  const none = guardRestore(wanted, { settings: sanitize({ flashLimiter: false }), profiles: {} });
  assert.deepEqual(none.settings, wanted.settings); assert.deepEqual(none.profiles, wanted.profiles); assert.ok(!none.limiter && !none.quieted, "nothing was kept");
});

test('each site takes what the backup asks of it, not what protecting the global settings gave', () => {
  // Off on this site here, and the backup leaves it off there: it stays off, although the global settings keep it on.
  const limiter = guardRestore({ settings: sanitize({ flashLimiter: false }), profiles: {} }, { settings: sanitize({ flashLimiter: true }), profiles: { 'off.example': { flashLimiter: false } } });
  assert.equal(limiter.settings.flashLimiter, true); assert.deepEqual(limiter.profiles['off.example'], { flashLimiter: false });
  // Listening on this site here, and the backup listens: it keeps listening, although the global settings stay quiet.
  const pulse = guardRestore({ settings: sanitize({ pulse: { ...PULSE, enabled: true } }), profiles: {} }, { settings: DEFAULTS, profiles: { 'loud.example': { pulse: { ...PULSE, enabled: true } } } });
  assert.equal(pulse.settings.pulse.enabled, false); assert.equal(pulse.profiles['loud.example'].pulse!.enabled, true);
});

test('restoring is judged by what is showing: the side of a comparison counts', () => {
  const saved = sanitize({ flashLimiter: false }), wanted = { settings: sanitize({ flashLimiter: false }), profiles: { 'site.example': {} } };
  const showing = (active: 'a' | 'b', target = '') => ({ id: 'x', active, a: lookOf(saved), b: { ...lookOf(saved), flashLimiter: true }, target });
  const global = guardRestore(wanted, { settings: saved, profiles: {}, compare: showing('b') });
  assert.equal(global.settings.flashLimiter, true); assert.ok(global.limiter, "it says the Flash Limiter was kept");
  assert.equal(guardRestore(wanted, { settings: saved, profiles: {}, compare: showing('a') }).settings.flashLimiter, false, 'A is what is saved');
  const site = guardRestore(wanted, { settings: saved, profiles: { 'site.example': {} }, compare: showing('b', 'site.example') });
  assert.equal(site.settings.flashLimiter, false); assert.equal(site.profiles['site.example'].flashLimiter, true);
});

test('resetting a site profile keeps a Flash Limiter that is on and listening that is off', () => {
  const global = sanitize({ flashLimiter: false, pulse: { ...PULSE, enabled: true } });
  assert.deepEqual(resetProfile(sanitize({ flashLimiter: true, pulse: { ...PULSE, enabled: false } }), global), { flashLimiter: true, pulse: { ...PULSE, enabled: false } });
  assert.deepEqual(resetProfile(sanitize({ flashLimiter: false, pulse: { ...PULSE, enabled: true, depth: 90 } }), global), {}, 'nothing to keep: the site follows the global settings');
  assert.deepEqual(resetProfile(DEFAULTS, DEFAULTS), {});
});

// The Store tests below go through the real background (service.ts) over a stand-in chrome.storage: see world.ts.
test('a page that closes right after restoring a backup or keeping B leaves storage whole', async () => {
  const w = world();
  try {
    w.seed({ settings: sanitize({ brightness: 40 }) });
    const { store, close } = await w.page();
    void store.startCompare(); void store.change({ brightness: 90, flashLimiter: false });
    await store.saved;
    void store.restore(sanitize({ brightness: 25 }), { 'www.youtube.com': { mode: 'ambient' } }, { Mine: { mode: 'vivid' } }); close();
    await w.idle();
    assert.equal(sanitize(w.data.settings).brightness, 25, 'the restored settings are stored'); assert.deepEqual(Object.keys(w.data.profiles as object), ['www.youtube.com']);
    assert.deepEqual(Object.keys(w.data.presets as object), ['Mine']); assert.ok(!('compare' in w.data), 'and the comparison is ended with them');
  } finally { w.done(); }
  for (const site of ['', 'site.example']) {
    const w = world();
    try {
      w.seed({ settings: sanitize({ brightness: 40 }), profiles: site ? { [site]: {} } : {} });
      const { store, close } = await w.page();
      store.target = site;
      void store.startCompare(); void store.change({ brightness: 90 });
      await store.saved;
      void store.endCompare('b'); close();
      await w.idle();
      const kept = site ? sanitize({ ...(w.data.settings as object), ...(w.data.profiles as Record<string, object>)[site] }) : sanitize(w.data.settings);
      assert.equal(kept.brightness, 90, `${site || 'global'}: B is stored`); assert.ok(!('compare' in w.data), `${site || 'global'}: and the comparison is ended with it`);
      if (site) assert.equal(sanitize(w.data.settings).brightness, 40, 'B went to the profile, not the global settings');
    } finally { w.done(); }
  }
});

test('restoring during an A/B comparison ends it: keeping B afterwards cannot write over what was restored', async () => {
  const w = world();
  try {
    w.seed({ settings: sanitize({ brightness: 40 }) });
    const { store } = await w.page('options.html');
    void store.startCompare(); void store.change({ brightness: 90 });
    await store.saved;
    assert.equal(store.settings.brightness, 90); assert.ok(w.data.compare, 'the comparison is stored');
    const restored = store.restore(sanitize({ brightness: 25 }), { 'www.youtube.com': { mode: 'ambient' } }, {});
    assert.equal(store.compare, null); assert.ok(!store.comparing, "nothing is compared"); assert.equal(store.settings.brightness, 25, 'the old B is no longer shown');
    assert.ok((await restored).ok); await w.idle();
    assert.ok(!('compare' in w.data), 'the restore itself ends the stored comparison');
    const ended = await store.endCompare('b');
    assert.ok(ended.ok); assert.deepEqual(ended.written, [], 'there is no B left to keep');
    await w.idle();
    assert.equal(sanitize(w.data.settings).brightness, 25); assert.equal(store.global.brightness, 25);
  } finally { w.done(); }
});

test('the A/B shortcut cannot bring back a comparison that a restore ended while it was switching', async () => {
  const w = world();
  try {
    w.seed({ settings: sanitize({ brightness: 40 }) });
    const { store } = await w.page();
    void store.startCompare(); void store.change({ brightness: 90, flashLimiter: false });
    await store.saved;
    const release = w.hold();
    const flip = command('compare-switch');
    await new Promise(resolve => setTimeout(resolve, 0));
    const restored = store.restore(sanitize({ brightness: 25 }), {}, {});
    release(); assert.ok((await flip)?.ok); assert.ok((await restored).ok); await w.idle();
    assert.ok(!('compare' in w.data), 'the switch read the comparison before the restore and wrote it first; the restore ended it after');
    assert.equal(sanitize(w.data.settings).brightness, 25);
    assert.ok((await command('compare-switch'))?.ok); await w.idle();
    assert.ok(!('compare' in w.data), 'a switch after the restore has nothing to switch');
  } finally { w.done(); }
});

test('a backup restored while B shows the Flash Limiter on keeps it on, and ends the comparison', async () => {
  const w = world();
  try {
    w.seed({ settings: sanitize({ flashLimiter: false }) });
    const { store } = await w.page('options.html');
    void store.startCompare(); void store.change(applyPreset(store.settings, { ...BUILT_IN[0].look, flashLimiter: true }));
    assert.equal(store.settings.flashLimiter, true); assert.equal(store.global.flashLimiter, false);
    // The backup as it was read: the guard is laid on by the restore itself, against what is stored and showing then.
    const restored = store.restore(sanitize({ flashLimiter: false, brightness: 30 }), {}, {});
    assert.equal(store.settings.flashLimiter, true); assert.equal(store.settings.brightness, 30); assert.equal(store.compare, null);
    const result = await restored;
    assert.ok(result.ok && result.limiter && result.compared, 'it says so'); await w.idle();
    assert.equal(sanitize(w.data.settings).flashLimiter, true); assert.ok(!('compare' in w.data), 'the comparison is ended in storage too');
  } finally { w.done(); }
});

test('a preset compared as B is laid over A the way applying it would be', async () => {
  const loud = { ...BUILT_IN.find(p => p.name === 'Overkill')!.look, flashLimiter: false, pulse: { ...PULSE, depth: 90 } };
  let w = world();
  try {
    w.seed({ settings: sanitize({ flashLimiter: true, pulse: { ...PULSE, enabled: true } }) });
    const { store } = await w.page();
    void store.startCompare(loud);
    assert.equal(store.compare!.b.flashLimiter, true, 'the Flash Limiter stays on'); assert.equal(store.compare!.b.pulse!.enabled, true, 'listening stays as it is');
    assert.equal(store.compare!.b.pulse!.depth, 90); assert.equal(store.compare!.b.brightness, 100);
    const kept = await store.endCompare('b');
    assert.ok(kept.ok && !kept.written!.includes('flashLimiter'), "keeping B leaves the Flash Limiter on"); assert.equal(store.global.flashLimiter, true);
  } finally { w.done(); }
  w = world();
  try {
    w.seed({ settings: sanitize({ flashLimiter: false, pulse: PULSE }) });
    const { store } = await w.page();
    void store.startCompare({ ...loud, pulse: { ...PULSE, enabled: true } });
    assert.equal(store.compare!.b.flashLimiter, false, 'off here: the preset decides'); assert.equal(store.compare!.b.pulse!.enabled, false, 'a preset never switches listening on');
    await store.saved; await w.idle();
    assert.deepEqual((w.data.compare as { b: unknown }).b, store.compare!.b, 'B is stored as it is shown');
  } finally { w.done(); }
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
  // The store, with messages and storage carrying what Chrome would (JSON), through the real background.
  const w = world();
  try {
    const { store, failures } = await w.page('options.html');
    for (const name of names) assert.ok((await store.setPreset(name, look)).ok, name);
    for (const name of names) assert.ok(Object.hasOwn(store.presets, name) && store.presets[name].mode === 'vivid', name);
    assert.equal(freePresetName('__proto__', store.presets), '__proto__ (2)');
    assert.equal(freePresetName('constructor', store.presets), 'constructor (2)');
    void store.setPreset('__proto__', null); void store.setPreset('toString', null);
    assert.deepEqual(Object.keys(store.presets).sort(), ['constructor', 'hasOwnProperty']);
    await store.saved; await w.idle();
    assert.deepEqual(Object.keys(sanitizePresets(w.data.presets)).sort(), ['constructor', 'hasOwnProperty']);
    void store.restore(DEFAULTS, {}, clean);
    assert.deepEqual(Object.keys(store.presets).sort(), [...names].sort());
    await store.saved; await w.idle();
    assert.deepEqual(sanitizePresets(w.data.presets), clean, 'a restored backup is written whole');
    assert.deepEqual(Object.keys(store.presets).sort(), [...names].sort()); assert.deepEqual(failures, []);
  } finally { w.done(); }
});
