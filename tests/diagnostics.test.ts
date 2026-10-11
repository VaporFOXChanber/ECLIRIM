import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticsFromStatus, diagnosticsSummary, diagnosticsText } from '../src/shared/diagnostics.ts';
import { feedbackDraft, feedbackText, postFeedback } from '../src/shared/feedback.ts';
import type { Status } from '../src/shared/types.ts';

test('diagnostic snapshots select technical fields and never retain tab metadata, profiles or free-form status text', () => {
  const status = { state: 'Paused', source: 'direct', detail: 'private detail', service: 'private service', profile: 'private.example',
    title: 'private title', url: 'https://private.example/watch?token=secret',
    perf: { analysisFps: 11.23456, renderFps: 0, analysisMs: 4.56, readMs: 3.9, renderMs: 0.2, zones: 64, activeZones: 32,
      reader: 'gpu', quality: 0, director: 'active', stats: { title: 'secret' } },
    audio: { state: 'muted', low: 0.5, mid: 0.6, high: 0.7, beats: 123 }, color: { engine: 'v2', space: 'srgb', transfer: 'private value' },
    guard: { state: 'active', regions: 7 }, exposure: { state: 'off' } };
  const snapshot = diagnosticsFromStatus(status as unknown as Status)!;
  assert.equal(snapshot.analysisFps, 11.23); assert.equal(snapshot.renderFps, 0); assert.equal(snapshot.quality, 0);
  assert.equal(snapshot.pulse, 'muted'); assert.equal(snapshot.reader, 'gpu');
  assert.ok(!/private|secret|title|profile|low|beats|transfer/.test(JSON.stringify(snapshot)));
  status.perf.analysisFps = 99; status.state = 'Active';
  assert.equal(snapshot.analysisFps, 11.23); assert.equal(snapshot.state, 'Paused', 'a snapshot cannot change behind a reviewed preview');
});
test('diagnostics keep only finite bounded metrics, whole counts and known enums', () => {
  const snapshot = diagnosticsSummary({ state: 'Active', source: 'direct', analysisFps: Infinity, analysisMs: -1, renderMs: NaN,
    renderFps: 1001, readMs: 0, quality: 1.5, zones: 64, activeZones: '32', reader: 'https://private.example', pulse: 'active',
    profile: 'secret', diagnostics: { hidden: 'secret' } });
  assert.deepEqual(snapshot, { state: 'Active', source: 'direct', pulse: 'active', readMs: 0, zones: 64 });
  assert.equal(diagnosticsSummary({ state: 'private state', source: 'direct' }), undefined);
  assert.equal(diagnosticsSummary({ state: 'Active', source: 'private path' }), undefined);
  assert.equal(diagnosticsSummary([]), undefined);
});
test('diagnostics are appended to the exact feedback preview only when explicitly supplied', () => {
  const draft = feedbackDraft({ problem: '光が消えた' }), snapshot = diagnosticsSummary({ state: 'Paused', source: 'direct', analysisFps: 0, renderMs: 0.25, quality: 0 })!;
  const ordinary = feedbackText(draft, '0.9.8'), attached = feedbackText(draft, '0.9.8', snapshot);
  assert.ok(!ordinary.includes('Diagnostics'));
  assert.equal(attached, ordinary + '\n\nDiagnostics の要約\n状態: Paused\n描画方式: direct\n解析FPS: 0 fps\n描画時間: 0.25 ms\n品質の段階: 0');
  assert.ok(diagnosticsText(snapshot).includes('解析FPS: 0 fps'), 'an observed zero is not hidden as missing data');
});
test('the network boundary strips extra diagnostic fields and omits unselected diagnostics entirely', async () => {
  const submission = { id: '3cf3360e-e5dc-489a-b0a1-c34cc5edbdec', version: '0.9.8', draft: feedbackDraft({ rating: 4 }) };
  const captured: Record<string, unknown>[] = [];
  const request = (async (_url: unknown, init: RequestInit) => {
    if (init.method === 'GET') return new Response(JSON.stringify({ ok: true, schema: 2 }));
    captured.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ ok: true, id: submission.id }));
  }) as typeof fetch;
  await postFeedback('https://relay.example.test', submission, new AbortController().signal, request);
  await postFeedback('https://relay.example.test', { ...submission, diagnostics: { state: 'Active', source: 'direct', url: 'private', profile: 'private', renderMs: 0.5 } as unknown as NonNullable<ReturnType<typeof diagnosticsSummary>> }, new AbortController().signal, request);
  assert.equal(Object.hasOwn(captured[0], 'diagnostics'), false);
  assert.deepEqual(captured[1].diagnostics, { state: 'Active', source: 'direct', renderMs: 0.5 });
  assert.ok(!JSON.stringify(captured).includes('private'));
});
test('an old receiver cannot silently discard a confirmed diagnostic attachment: no POST is made', async () => {
  const methods: string[] = [];
  await assert.rejects(postFeedback('https://relay.example.test', {
    id: '3cf3360e-e5dc-489a-b0a1-c34cc5edbdec', version: '0.9.8', draft: feedbackDraft({ rating: 4 }),
    diagnostics: { state: 'Active', source: 'direct' }
  }, new AbortController().signal, (async (_url: unknown, init: RequestInit) => {
    methods.push(init.method!); assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer');
    return new Response(JSON.stringify({ ok: true, service: 'ECLIRIM feedback' }));
  }) as typeof fetch), /DIAGNOSTICS_UNAVAILABLE/);
  assert.deepEqual(methods, ['GET']);
});
