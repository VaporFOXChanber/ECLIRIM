import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PULSE, sanitize } from '../src/shared/settings.ts';
import { command, handleMessage } from '../src/service.ts';
import { BackupOffer, SLIDE_MS } from '../src/ui/store.ts';
import type { Message, SaveOp } from '../src/shared/types.ts';
import { ID, url, world } from './world.ts';

const stored = (data: Record<string, unknown>) => sanitize(data.settings);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// What this shows: changes that reached the background are stored, in order, whatever earlier save was still being
// written and whether or not the page is still there to hear back. That a closing popup's last messages reach the
// background at all (pagehide, Chrome's delivery) is shown by the browser test in scripts/e2e-identity.mjs.
test('changes that reached the background are stored behind an earlier save still being written, with no page left to answer: keeping B, a restore, the last slider move', async () => {
  // Keeping B, with a change and a slider move before it that the background has not written yet.
  let w = world();
  try {
    w.seed({ settings: sanitize({ brightness: 40 }) });
    const { store, close } = await w.page();
    assert.ok((await store.startCompare()).ok);
    const release = w.hold();
    void store.change({ mode: 'vivid' }); store.slide({ brightness: 70 }); store.slide({ brightness: 90 });
    void store.endCompare('b'); close();
    release(); await w.idle();
    assert.deepEqual([stored(w.data).brightness, stored(w.data).mode], [90, 'vivid'], 'B, with the last slider move in it, is stored');
    assert.ok(!('compare' in w.data), 'and the comparison is ended');
  } finally { w.done(); }
  // A restore, behind an earlier change.
  w = world();
  try {
    w.seed({ settings: sanitize({ brightness: 40 }) });
    const { store, close } = await w.page('options.html');
    const release = w.hold();
    void store.change({ hud: true });
    void store.restore(sanitize({ brightness: 25 }), { 'www.youtube.com': { mode: 'ambient' } }, { Mine: { mode: 'vivid' } }); close();
    release(); await w.idle();
    assert.equal(stored(w.data).brightness, 25); assert.equal(stored(w.data).hud, false, 'the restore came last and replaced everything');
    assert.deepEqual([Object.keys(w.data.profiles as object), Object.keys(w.data.presets as object)], [['www.youtube.com'], ['Mine']]);
  } finally { w.done(); }
  // The last slider move, sent by the flush a closing page makes (pagehide), behind an earlier change. The moves were gathered into one write.
  w = world();
  try {
    w.seed({ settings: sanitize({ brightness: 40 }) });
    const { store, close } = await w.page();
    const release = w.hold();
    void store.change({ mode: 'ambient' });
    for (const brightness of [41, 50, 63, 12]) store.slide({ brightness });
    assert.equal(store.settings.brightness, 12, 'shown at once');
    close();
    release(); await w.idle();
    assert.deepEqual([stored(w.data).brightness, stored(w.data).mode], [12, 'ambient']);
    assert.equal(w.io.writes, 2, 'one write for the change, one for all the slider moves');
  } finally { w.done(); }
});

test('slider moves go out while the slider is dragged, at most every SLIDE_MS, and the last one always', async () => {
  const w = world();
  try {
    w.seed({ settings: sanitize({ brightness: 40 }) });
    const { store } = await w.page();
    store.slide({ brightness: 50 }); store.slide({ brightness: 55 });
    assert.equal(w.io.writes, 0, 'nothing yet');
    await sleep(SLIDE_MS + 30); await w.idle();
    assert.equal(stored(w.data).brightness, 55); assert.equal(w.io.writes, 1);
    store.slide({ pulse: { ...store.settings.pulse, depth: 70 } }); store.slide({ pulse: { ...store.settings.pulse, bloom: 20 } });
    void store.change({ mode: 'vivid' }); await w.idle();
    assert.deepEqual([stored(w.data).pulse.depth, stored(w.data).pulse.bloom, stored(w.data).mode], [70, 20, 'vivid'], 'another change sends the moves before it');
    assert.equal(w.io.writes, 3);
  } finally { w.done(); }
});

test('a page that is behind cannot bring back a comparison that a restore ended elsewhere, nor change an earlier one', async () => {
  const w = world();
  try {
    w.seed({ settings: sanitize({ brightness: 40 }) });
    const popup = await w.page();
    assert.ok((await popup.store.startCompare()).ok); assert.ok((await popup.store.change({ brightness: 90 })).ok);
    const old = popup.store.compare!.id;
    // Settings pages opened during the comparison, that from now on hear nothing of what the popup does.
    const stale = [await w.page('options.html'), await w.page('options.html'), await w.page('options.html')];
    for (const page of stale) { assert.equal(page.store.compare?.id, old); page.state.deaf = true; }
    const restored = await popup.store.restore(sanitize({ brightness: 25 }), {}, {});
    assert.ok(restored.ok && restored.compared, 'the restore says it ended the comparison');
    const late = [() => stale[0].store.change({ brightness: 70 }), () => stale[1].store.showSide('a'), () => stale[2].store.endCompare('b')];
    for (const [i, { store, failures }] of stale.entries()) {
      assert.ok(store.comparing, 'the page still shows it');
      const result = await late[i]();
      assert.ok(!result.ok && /終わっています/.test(result.error), 'refused');
      // Refused: the page reads storage again and shows it.
      assert.equal(store.compare, null); assert.equal(store.settings.brightness, 25);
      assert.equal(failures.length, 1); assert.match(failures[0], /設定を保存できませんでした/);
      assert.ok(!('compare' in w.data), 'nothing brought it back'); assert.equal(stored(w.data).brightness, 25, 'nothing kept from it');
    }
    assert.ok((await popup.store.startCompare()).ok);
    // A comparison started since: changes meant for the earlier one are refused, and leave the new one as it is.
    await w.idle();
    const now = w.data.compare as { id: string };
    assert.ok(now && now.id !== old, 'a new comparison runs');
    for (const op of [{ kind: 'change', site: '', patch: { brightness: 5 }, compare: { id: old, side: 'b' } }, { kind: 'show', id: old, side: 'a' }, { kind: 'end', id: old, adopt: 'b' }] as SaveOp[]) {
      const result = await handleMessage({ target: 'background', type: 'save', op }, popup.sender) as { ok: boolean; error?: string };
      assert.ok(!result.ok && /終わっています/.test(result.error!), op.kind);
    }
    assert.deepEqual(w.data.compare, now, 'the comparison running now is untouched');
  } finally { w.done(); }
});

test('two pages changing different settings at once keep both, and each shows both', async () => {
  const w = world();
  try {
    w.seed({ settings: sanitize({ brightness: 40 }), profiles: { 'site.example': { mode: 'ambient' } } });
    const popup = await w.page(), options = await w.page('options.html');
    const release = w.hold();
    popup.store.slide({ brightness: 33 });
    void options.store.change({ mode: 'vivid' }); void options.store.change({ pulse: { ...options.store.settings.pulse, depth: 80 } });
    void popup.store.change({ pulse: { ...popup.store.settings.pulse, enabled: true } });
    void options.store.setPreset('Mine', { mode: 'vivid' }); void popup.store.setPreset('Yours', { mode: 'ambient' });
    options.store.target = 'site.example'; void options.store.change({ glowWidth: 15 });
    popup.close();
    release(); await w.idle();
    const s = stored(w.data);
    assert.deepEqual([s.brightness, s.mode, s.pulse.depth, s.pulse.enabled, s.glowWidth], [33, 'vivid', 80, true, 10], 'every change is stored, none over another');
    assert.deepEqual(w.data.profiles, { 'site.example': { mode: 'ambient', glowWidth: 15 } });
    assert.deepEqual(Object.keys(w.data.presets as object).sort(), ['Mine', 'Yours']);
    options.store.target = '';
    assert.deepEqual(options.store.settings, s, 'the page that stayed open shows what is stored');
    assert.deepEqual(Object.keys(options.store.presets).sort(), ['Mine', 'Yours']);
  } finally { w.done(); }
});

test('a page shows changes made elsewhere at once, with its own changes not stored yet still laid over them', async () => {
  const w = world();
  try {
    w.seed({ settings: sanitize({ brightness: 40 }), revision: 7 });
    const { store } = await w.page();
    const release = w.hold();
    const mine = store.change({ brightness: 10 });
    // Another context writes while the popup's own change waits.
    w.write({ settings: sanitize({ brightness: 40, mode: 'ambient' }) }); await sleep(5);
    assert.deepEqual([store.settings.mode, store.settings.brightness], ['ambient', 10], 'taken over, and its own change kept');
    release();
    const result = await mine; assert.ok(result.ok); assert.equal(result.rev, 8);
    await w.idle();
    assert.deepEqual([stored(w.data).mode, stored(w.data).brightness], ['ambient', 10], 'stored over what was there, not over what the popup had seen');
    assert.equal(w.data.revision, 8);
  } finally { w.done(); }
});

test('a save that cannot be written is reported as failed, claims nothing, and the page shows what is stored', async () => {
  const w = world();
  try {
    w.seed({ settings: sanitize({ brightness: 40 }), presets: { Old: { mode: 'vivid' } } });
    const { store, failures } = await w.page('options.html');
    void store.startCompare(); await store.saved; await w.idle();
    const comparing = w.data.compare;
    w.io.fail = 'QUOTA_BYTES quota exceeded';
    const restore = store.restore(sanitize({ brightness: 25 }), {}, {});
    assert.equal(store.compare, null, 'shown at once as it is meant to be stored');
    const result = await restore;
    assert.ok(!result.ok && /QUOTA_BYTES/.test(result.error)); assert.ok(!('compared' in result) && !('limiter' in result), 'nothing to say it was read');
    assert.deepEqual(store.compare, comparing, 'the page shows storage again: the comparison runs on');
    assert.equal(store.global.brightness, 40); assert.deepEqual(Object.keys(store.presets), ['Old']);
    assert.deepEqual(w.data.compare, comparing); assert.equal(stored(w.data).brightness, 40);
    assert.equal(failures.length, 1); assert.match(failures[0], /設定を保存できませんでした: .*QUOTA_BYTES/);
    w.io.fail = 'disk';
    const preset = await store.setPreset('New', { mode: 'ambient' });
    assert.ok(!preset.ok); assert.deepEqual(Object.keys(store.presets), ['Old']);
    assert.ok((await store.setPreset('New', { mode: 'ambient' })).ok, 'the next try is written'); await w.idle();
    assert.deepEqual(Object.keys(w.data.presets as object).sort(), ['New', 'Old']);
  } finally { w.done(); }
});

test('the A/B shortcut goes through the same queue: a page change for a side lands on that side, and nothing comes back after the end', async () => {
  const w = world();
  try {
    w.seed({ settings: sanitize({ brightness: 40 }) });
    const { store } = await w.page();
    assert.ok((await store.startCompare()).ok);
    let release = w.hold();
    store.slide({ brightness: 90 }); store.flush();
    const flips = [command('compare-switch')];
    // The popup still shows B: its change goes to B, although the shortcut has switched to A by the time it is written.
    void store.change({ mode: 'ambient' });
    flips.push(command('compare-switch'));
    release();
    for (const flip of flips) assert.ok((await flip)?.ok);
    await w.idle();
    const compare = w.data.compare as { active: string; a: { brightness: number; mode: string }; b: { brightness: number; mode: string } };
    assert.equal(compare.active, 'b', 'switched twice');
    assert.deepEqual([compare.b.brightness, compare.b.mode, compare.a.brightness, compare.a.mode], [90, 'ambient', 40, 'cinema']);
    assert.deepEqual([store.compare!.active, store.settings.brightness], ['b', 90]);
    // Switched to A by the shortcut just before B is kept: B is still what is kept.
    release = w.hold();
    const flip = command('compare-switch'), kept = store.endCompare('b'), late = command('compare-switch');
    release();
    assert.ok((await flip)?.ok); const result = await kept; assert.ok(result.ok); assert.deepEqual(result.written!.sort(), ['brightness', 'mode']);
    assert.ok((await late)?.ok); await w.idle();
    assert.ok(!('compare' in w.data), 'a switch after the end brings nothing back');
    assert.deepEqual([stored(w.data).brightness, stored(w.data).mode], [90, 'ambient']);
    assert.equal(store.compare, null);
  } finally { w.done(); }
});

test('only the popup and the settings page can change settings; anything else gets no answer and changes nothing', async () => {
  const w = world();
  try {
    w.seed({ settings: sanitize({ brightness: 40 }), revision: 1 });
    const before = JSON.stringify(w.data);
    const save: Message = { target: 'background', type: 'save', op: { kind: 'change', site: '', patch: { brightness: 100, flashLimiter: false } } };
    for (const sender of [
      { id: 'another-extension', url: `chrome-extension://another-extension/popup.html` },
      { id: ID, url: 'https://video.example/watch', tab: { id: 4 } as chrome.tabs.Tab, frameId: 0 },
      { id: ID, url: url('offscreen.html') },
      { id: ID, url: url('popup.html.evil') },
      { url: url('options.html') }
    ]) assert.equal(handleMessage(save, sender), undefined, JSON.stringify(sender));
    assert.equal(handleMessage({ ...save, target: 'content' } as unknown as Message, { id: ID, url: url('popup.html') }), undefined, 'not for the background');
    await w.idle();
    assert.equal(JSON.stringify(w.data), before); assert.equal(w.io.writes, 0);
    // A page that is not let in hears nothing back, and says the change was not stored.
    const outsider = await w.page('feedback.html');
    const result = await outsider.store.change({ brightness: 100 });
    assert.ok(!result.ok); assert.equal(outsider.store.settings.brightness, 40); assert.equal(outsider.failures.length, 1);
    // Something that is not a change, from a page that is let in: refused, nothing written.
    for (const op of [{ kind: 'drop-everything' }, { kind: 'preset', name: '<>', preset: {} }, { kind: 'profile', site: '__proto__', profile: {} }, { kind: 'start', id: '', site: '' }] as unknown as SaveOp[])
      assert.equal((await handleMessage({ target: 'background', type: 'save', op }, { id: ID, url: url('options.html?site=x#presets') }) as { ok: boolean }).ok, false, JSON.stringify(op));
    assert.equal(JSON.stringify(w.data), before);
    // The settings page with a query and a hash, and the popup, are let in.
    for (const path of ['options.html?site=www.youtube.com#lighting', 'popup.html']) {
      const result = await handleMessage({ target: 'background', type: 'save', op: { kind: 'change', site: '', patch: { pulse: { depth: 77 } } } }, { id: ID, url: url(path) }) as { ok: boolean };
      assert.ok(result.ok, path);
    }
    await w.idle();
    assert.deepEqual(stored(w.data).pulse, { ...PULSE, depth: 77 }, 'a part of a group changes only that part');
  } finally { w.done(); }
});

test('an answer that comes after storage has told of the change still leaves the page showing what is stored, in either order', async () => {
  // Storage tells first: the popup's switch to A is written, then the shortcut switches to B, and only then the answer comes.
  let w = world();
  try {
    w.seed({ settings: sanitize({ brightness: 40 }) });
    const { store, state, holdAnswers } = await w.page();
    assert.ok((await store.startCompare()).ok); await w.idle();
    const release = holdAnswers(), shown = store.showSide('a');
    await w.idle(); assert.equal((w.data.compare as { active: string }).active, 'a');
    assert.ok((await command('compare-switch'))?.ok); await w.idle();
    const renders = state.renders;
    release(); assert.ok((await shown).ok);
    assert.equal((w.data.compare as { active: string }).active, 'b');
    assert.equal(store.compare!.active, 'b', 'the page shows B, as stored'); assert.ok(state.renders > renders, 'and is told to show it again');
  } finally { w.done(); }
  // Storage tells first: a comparison started here is ended by a restore on another page before the answer to its start comes.
  w = world();
  try {
    w.seed({ settings: sanitize({ brightness: 40 }) });
    const popup = await w.page(), options = await w.page('options.html');
    const release = popup.holdAnswers(), started = popup.store.startCompare();
    await w.idle(); assert.ok(options.store.compare, 'the settings page sees it');
    assert.ok((await options.store.restore(sanitize({ brightness: 25 }), {}, {})).ok); await w.idle();
    release(); assert.ok((await started).ok);
    assert.equal(popup.store.compare, null, 'the ended comparison is not shown'); assert.equal(popup.store.settings.brightness, 25);
  } finally { w.done(); }
  // The answer comes first, and what storage tells after it.
  w = world();
  try {
    w.seed({ settings: sanitize({ brightness: 40 }) });
    const { store, holdNotices } = await w.page();
    assert.ok((await store.startCompare()).ok); await w.idle();
    const tell = holdNotices();
    assert.ok((await store.showSide('a')).ok);
    assert.equal(store.compare!.active, 'a', 'its own change is shown before storage has told of it');
    assert.ok((await command('compare-switch'))?.ok); await w.idle();
    tell();
    assert.equal(store.compare!.active, 'b', 'once told, the page shows what is stored');
  } finally { w.done(); }
});

test('a restore that fails offers its backup again, unless another file has been read in the meantime', async () => {
  const w = world();
  try {
    w.seed({ settings: sanitize({ brightness: 40 }) });
    const { store } = await w.page('options.html'), offered = new BackupOffer();
    const first = { settings: sanitize({ brightness: 25 }), profiles: {}, presets: {} }, second = { settings: sanitize({ brightness: 77 }), profiles: {}, presets: { Theirs: { mode: 'vivid' as const } } };
    offered.offer(first);
    const release = w.hold(); w.io.fail = 'disk';
    const confirming = offered.confirm(store);
    offered.offer(second);
    release();
    assert.equal(await confirming, null, 'the answer no longer speaks for what is shown');
    assert.equal(offered.backup, second, 'what is offered is still the file read last');
    const result = await offered.confirm(store);
    assert.ok(result?.ok); await w.idle();
    assert.equal(stored(w.data).brightness, 77, 'the next press restores the file that was shown'); assert.deepEqual(Object.keys(w.data.presets as object), ['Theirs']);
    // With nothing read in between, a failed restore is offered again as it was.
    offered.offer(first); w.io.fail = 'disk';
    const failed = await offered.confirm(store);
    assert.ok(failed && !failed.ok); assert.equal(offered.backup, first);
    assert.equal(await new BackupOffer().confirm(store), null, 'nothing offered, nothing restored');
  } finally { w.done(); }
});

test('every import is a preset of its own, named by the background alone; a page never shows one under a name it was not stored under', async () => {
  const names = (presets: object, start: string) => Object.keys(presets).filter(name => name.startsWith(start)).sort();
  const w = world();
  try {
    const popup = await w.page(), options = await w.page('options.html');
    // Two pages at once, the same name: different looks, and the very same file. Each is kept, as one page importing twice keeps two.
    const release = w.hold();
    const imports = [popup.store.importPreset('Shared', { mode: 'vivid' }), options.store.importPreset('Shared', { mode: 'ambient' }),
      popup.store.importPreset('Same', { mode: 'vivid' }), options.store.importPreset('Same', { mode: 'vivid' })];
    assert.deepEqual([names(popup.store.presets, 'S'), names(options.store.presets, 'S')], [[], []], 'not shown before the background has named it');
    release();
    const answers = await Promise.all(imports);
    assert.deepEqual(answers.map(answer => answer.ok && answer.name), ['Shared', 'Shared (2)', 'Same', 'Same (2)']);
    await w.idle();
    assert.deepEqual(w.data.presets, { Shared: { mode: 'vivid' }, 'Shared (2)': { mode: 'ambient' }, Same: { mode: 'vivid' }, 'Same (2)': { mode: 'vivid' } }, 'none replaced or swallowed another');
    for (const { store } of [popup, options]) assert.deepEqual(names(store.presets, 'S'), ['Same', 'Same (2)', 'Shared', 'Shared (2)']);
    const single = await options.store.importPreset('overkill', { mode: 'vivid' });
    assert.ok(single.ok); assert.equal(single.name, 'overkill (2)', 'a standard name is numbered, as before');
    // Storage tells of a numbered import before its answer comes: the page shows the stored name once, and no other.
    const late = options.holdAnswers(), added = options.store.importPreset('Shared', { mode: 'cinema' });
    await w.idle();
    assert.deepEqual(names(options.store.presets, 'Shared'), ['Shared', 'Shared (2)', 'Shared (3)']);
    late(); const answer = await added; assert.equal(answer.ok && answer.name, 'Shared (3)');
    assert.deepEqual(names(options.store.presets, 'Shared'), ['Shared', 'Shared (2)', 'Shared (3)'], 'no row for a name nothing is stored under');
    // The answer comes first: shown under the name it gives, and once more nothing else when storage tells.
    const tell = options.holdNotices(), first = await options.store.importPreset('Shared', { mode: 'ambient' });
    assert.ok(first.ok); assert.equal(first.name, 'Shared (4)');
    assert.deepEqual(names(options.store.presets, 'Shared'), ['Shared', 'Shared (2)', 'Shared (3)', 'Shared (4)']);
    tell(); assert.deepEqual(names(options.store.presets, 'Shared'), ['Shared', 'Shared (2)', 'Shared (3)', 'Shared (4)']);
    // What is shown is what is stored: removing a row removes the preset.
    assert.ok((await options.store.setPreset('Shared (3)', null)).ok); await w.idle();
    assert.deepEqual(names(w.data.presets as object, 'Shared'), ['Shared', 'Shared (2)', 'Shared (4)']); assert.deepEqual(names(options.store.presets, 'Shared'), ['Shared', 'Shared (2)', 'Shared (4)']);
  } finally { w.done(); }
});

test('the wizard\'s "compare" sends the end of one comparison and the start of the next at once, and each answers for itself', async () => {
  const w = world();
  try {
    w.seed({ settings: sanitize({ brightness: 40 }) });
    const options = await w.page('options.html');
    assert.ok((await options.store.startCompare()).ok);
    const first = options.store.compare!.id, release = w.hold();
    const steps = [options.store.endCompare(null), options.store.startCompare({ brightness: 90 })];
    release();
    assert.ok((await Promise.all(steps)).every(result => result.ok)); await w.idle();
    const compare = w.data.compare as { id: string; a: { brightness: number }; b: { brightness: number } };
    assert.notEqual(compare.id, first); assert.deepEqual([compare.a.brightness, compare.b.brightness], [40, 90]);
    // A page that has not heard of a comparison started elsewhere: its start is refused, so it says nothing of a start.
    const behind = await w.page('options.html'); behind.state.deaf = true;
    const popup = await w.page();
    assert.ok((await popup.store.endCompare(null)).ok); assert.ok((await popup.store.startCompare()).ok);
    const refused = await Promise.all([behind.store.endCompare(null), behind.store.startCompare({ brightness: 10 })]);
    assert.ok(!refused.every(result => result.ok)); await w.idle();
    assert.equal((w.data.compare as { b: { brightness: number } }).b.brightness, 40, 'the comparison started elsewhere is untouched');
  } finally { w.done(); }
});
