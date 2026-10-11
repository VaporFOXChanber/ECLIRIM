import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import catalog from '../src/shared/messages.json';
import { formatMessage, getLanguage, getLanguagePreference, initI18n, localizeText, normalizePreference, resolveLanguage, setLanguagePreference, t, useLanguage } from '../src/shared/i18n.ts';
import { feedbackContent, feedbackDraft, feedbackText, postFeedback } from '../src/shared/feedback.ts';
import { diagnosticsSummary } from '../src/shared/diagnostics.ts';
import { DEFAULTS, migrate } from '../src/shared/settings.ts';
import { BUILT_IN, exportBackup, exportPreset, importJSON } from '../src/shared/presets.ts';

test('automatic language follows Chrome UI language; every non-Japanese locale falls back to English', () => {
  for (const ui of ['ja', 'ja-JP', 'JA_jp']) assert.equal(resolveLanguage('auto', ui), 'ja');
  for (const ui of ['en', 'en-GB', 'fr-FR', 'zh-CN', '', 'javanese']) assert.equal(resolveLanguage('auto', ui), 'en');
  assert.equal(resolveLanguage('ja', 'en-US'), 'ja'); assert.equal(resolveLanguage('en', 'ja-JP'), 'en');
  for (const input of [null, undefined, {}, 'fr', 1]) assert.equal(normalizePreference(input), 'auto');
});
test('every catalog message has both translations, a unique stable ID, and matching placeholders', () => {
  assert.ok(catalog.length >= 640);
  assert.equal(new Set(catalog.map(m => m.id)).size, catalog.length);
  assert.equal(new Set(catalog.map(m => m.ja)).size, catalog.length);
  const tokens = (s: string) => [...s.matchAll(/\{\d+\}/g)].map(m => m[0]).sort();
  for (const m of catalog) { assert.ok(m.ja && m.en, m.id); assert.deepEqual(tokens(m.ja), tokens(m.en), m.id); assert.ok(!/[ぁ-んァ-ヶ一-龯。、]/.test(m.en), m.en); }
});
test('static HTML annotations and literal translation calls all resolve in the catalog', async () => {
  const ids = new Set(catalog.map(m => m.id)), sources = new Set(catalog.map(m => m.ja));
  for (const f of ['public/options.html', 'public/popup.html']) {
    const text = await readFile(f, 'utf8');
    for (const m of text.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)) assert.ok(ids.has(m[1]), `${f}: ${m[1]}`);
  }
  for (const f of ['src/options.ts', 'src/popup.ts', 'src/ui/feedback.ts']) {
    for (const m of (await readFile(f, 'utf8')).matchAll(/\bt\(("(?:[^"\\]|\\.)*")/g)) assert.ok(sources.has(JSON.parse(m[1])), `${f}: ${m[1]}`);
  }
});
test('native lookup failure falls back to the bundled catalog and formatting never reinterprets user text', () => {
  useLanguage('en'); assert.equal(t('明るさ'), 'Brightness');
  assert.equal(formatMessage('{0} / {1}', ['$& {1} <b>x</b>', 12]), '$& {1} <b>x</b> / 12');
  assert.equal(t('Unknown English fallback'), 'Unknown English fallback');
  assert.equal(localizeText('Error: このページには照明を追加できません。通常の動画ページで開いてください。'), 'Error: Lighting is unavailable on this page. Open a regular video page.');
  assert.equal(localizeText('代わりに「固定カラー」の照明を表示しています。映像には連動しません。'), 'Using “Fixed color” lighting instead. It does not follow the video.');
  useLanguage('ja'); assert.equal(t('明るさ'), '明るさ');
});
test('localized feedback is readable in English while submission schema, user text and privacy stay intact', async () => {
  useLanguage('en');
  const draft = feedbackDraft({ kind: 'bug', rating: 4, problem: 'My $& {0} <script> sample', steps: 'Start\nChange setting' });
  const summary = diagnosticsSummary({ state: 'Active', source: 'direct', analysisFps: 12, url: 'private', title: 'private' })!;
  const preview = feedbackText(draft, '0.9.9', summary, true);
  assert.match(preview, /^ECLIRIM feedback/); assert.match(preview, /Diagnostics summary/); assert.ok(preview.includes(draft.problem)); assert.ok(!/[ぁ-んァ-ヶ一-龯。、]/.test(preview));
  assert.match(feedbackText(draft, '0.9.9', summary), /^ECLIRIM フィードバック/);
  let body: any;
  await postFeedback('https://example.test', { id: 'test', version: '0.9.9', draft, diagnostics: summary }, new AbortController().signal, (async (_url, options) => {
    if (options?.method === 'GET') return new Response(JSON.stringify({ ok: true, schema: 2 }));
    body = JSON.parse(String(options?.body)); return new Response(JSON.stringify({ ok: true, id: 'test' }));
  }) as typeof fetch);
  assert.deepEqual(Object.keys(body).sort(), ['diagnostics', 'draft', 'id', 'version']);
  assert.deepEqual(body.draft, feedbackContent(draft)); assert.ok(!JSON.stringify(body).includes('private'));
});
test('legacy settings and CineGlow JSON remain compatible and independent of language', () => {
  const before = { settings: { ...DEFAULTS, brightness: 37 }, profiles: { 'example.com': { brightness: 21 } }, presets: { '自作': { brightness: 13 } }, schema: 4 };
  const original = JSON.stringify(before);
  for (const lang of ['ja', 'en']) {
    useLanguage(lang); assert.deepEqual(migrate(before, '0.9.8'), before);
    const backup = exportBackup(before.settings, before.profiles, before.presets); assert.equal(importJSON(backup).kind, 'backup');
    assert.equal(importJSON(backup.replace('ECLIRIM', 'CineGlow')).kind, 'backup');
    assert.equal(importJSON(exportPreset('古い名前', BUILT_IN[0].look).replace('ECLIRIM', 'CineGlow')).kind, 'preset');
    assert.ok(!backup.includes('language'));
  }
  assert.equal(JSON.stringify(before), original);
});
test('loading and changing language writes only the language key, including after a storage change', async () => {
  const data: Record<string, unknown> = { language: 'ja', settings: { brightness: 37 }, profiles: { site: {} }, presets: { user: {} }, compare: { active: 'b' } };
  const before = JSON.stringify(data); const listeners: Array<(changes: any, area: string) => void> = []; const writes: unknown[] = [];
  (globalThis as any).chrome = { i18n: { getUILanguage: () => 'en-US', getMessage: () => '' }, storage: { onChanged: { addListener: (fn: any) => listeners.push(fn) }, local: {
    get: async () => ({ ...data }), set: async (patch: any) => { writes.push(patch); const old = data.language; Object.assign(data, patch); listeners.forEach(fn => fn({ language: { oldValue: old, newValue: data.language } }, 'local')); }
  } } };
  await initI18n(); assert.equal(getLanguage(), 'ja'); assert.equal(JSON.stringify(data), before); assert.equal(writes.length, 0);
  await setLanguagePreference('en'); assert.equal(getLanguagePreference(), 'en'); assert.equal(getLanguage(), 'en'); assert.deepEqual(writes, [{ language: 'en' }]);
  assert.deepEqual(data.settings, { brightness: 37 }); assert.deepEqual(data.compare, { active: 'b' });
  delete (globalThis as any).chrome;
});
