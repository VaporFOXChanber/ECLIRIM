import test from 'node:test';
import assert from 'node:assert/strict';
import { feedbackContent, feedbackDraft, feedbackText, hasFeedback, postFeedback } from '../src/shared/feedback.ts';

test('feedback drafts accept only bounded text, a known kind and an optional whole rating', () => {
  const draft = feedbackDraft({ kind: 'bad', rating: { value: 5 }, context: 'x'.repeat(500), good: 'a\r\nb', problem: 'p'.repeat(3000), idea: false, steps: null, settings: { enabled: false } });
  assert.equal(draft.kind, 'review'); assert.equal(draft.rating, 0); assert.equal(draft.context.length, 160);
  assert.equal(draft.good, 'a\nb'); assert.equal(draft.problem.length, 2000); assert.equal(draft.idea, ''); assert.equal(draft.steps, '');
  assert.deepEqual(Object.keys(draft).sort(), ['context', 'good', 'idea', 'kind', 'problem', 'rating', 'steps']);
  assert.equal(feedbackDraft({ rating: '4' }).rating, 4); assert.equal(feedbackDraft({ rating: 1.5 }).rating, 0);
});
test('relay requests contain only the chosen draft and version, with no cookies or referrer', async () => {
  const submission = { id: '3cf3360e-e5dc-489a-b0a1-c34cc5edbdec', version: '0.9.7', draft: feedbackDraft({ idea: '改善案' }) };
  let captured: RequestInit | undefined;
  await postFeedback('https://relay.example.test/feedback', submission, new AbortController().signal, (async (_url, init) => {
    captured = init; return new Response(JSON.stringify({ ok: true, id: submission.id }), { status: 200 });
  }) as typeof fetch);
  assert.deepEqual(JSON.parse(String(captured!.body)), submission); assert.equal(captured!.credentials, 'omit');
  assert.equal(captured!.referrerPolicy, 'no-referrer'); assert.equal(captured!.method, 'POST');
});
test('a wrong acknowledgement or a provider failure is never reported as a successful submission', async () => {
  const submission = { id: '3cf3360e-e5dc-489a-b0a1-c34cc5edbdec', version: '0.9.7', draft: feedbackDraft({ rating: 4 }) };
  for (const result of [{ ok: true, id: 'wrong-id' }, { ok: false, code: 'RATE_LIMITED' }, { status: 'ok' }])
    await assert.rejects(postFeedback('https://relay.example.test/feedback', submission, new AbortController().signal,
      (async () => new Response(JSON.stringify(result))) as typeof fetch));
});
test('an unconfigured or insecure relay cannot send feedback anywhere', async () => {
  let called = false;
  for (const endpoint of ['', 'http://relay.example.test']) await assert.rejects(postFeedback(endpoint,
    { id: '3cf3360e-e5dc-489a-b0a1-c34cc5edbdec', version: '0.9.7', draft: feedbackDraft({ rating: 5 }) }, new AbortController().signal,
    (async () => { called = true; return new Response(); }) as typeof fetch), /UNAVAILABLE/);
  assert.equal(called, false);
});
test('empty feedback and context alone do not create an empty report; a rating alone is useful', () => {
  assert.equal(hasFeedback(feedbackDraft({ context: 'YouTube' })), false);
  assert.equal(feedbackText(feedbackDraft(), '0.9.7'), '');
  assert.match(feedbackText(feedbackDraft({ rating: 5 }), '0.9.7'), /満足度: 5 \/ 5/);
});
test('submission includes only previewed fields and treats invisible surrounding whitespace consistently', () => {
  const draft = feedbackDraft({ kind: 'review', rating: 4, good: ' 感想 \n', steps: '切り替える前の非表示の手順' });
  const content = feedbackContent(draft);
  assert.equal(content.steps, ''); assert.equal(content.good, '感想');
  assert.equal(draft.steps, '切り替える前の非表示の手順', 'the local draft is retained');
  assert.equal(feedbackText(draft, '0.9.7'), feedbackText(content, '0.9.7'));
  assert.deepEqual(feedbackContent(feedbackDraft({ kind: 'review', rating: 4, good: '感想' })), content);
});
test('the report contains exactly entered feedback and version, without empty sections or automatic diagnostics', () => {
  const text = feedbackText(feedbackDraft({ kind: 'bug', context: 'YouTube', good: 'よい色', problem: '光が消える', steps: '1. 開く\n2. 切り替える' }), '0.9.7');
  assert.equal(text, 'ECLIRIM フィードバック\nバージョン: 0.9.7\n種類: 不具合\n使ったサイト・場面: YouTube\n\nよかったところ\nよい色\n\n困ったこと・起きたこと\n光が消える\n\n再現手順\n1. 開く\n2. 切り替える');
  assert.ok(!text.includes('改善してほしいこと')); assert.ok(!text.includes('http')); assert.ok(!text.includes('settings'));
  assert.ok(!feedbackText(feedbackDraft({ kind: 'review', good: '感想', steps: '隠した手順' }), '0.9.7').includes('隠した手順'));
});
