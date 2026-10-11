import { t as translate, formatMessage } from './i18n';
import { diagnosticsSummary, diagnosticsText, type DiagnosticsSummary } from './diagnostics';

/** A local draft, separate from lighting settings, site profiles and backups. */
export interface FeedbackDraft {
  kind: 'review' | 'bug' | 'idea'; rating: number; context: string;
  good: string; problem: string; idea: string; steps: string;
}
export const FEEDBACK_KEY = 'feedbackDraft';
// Only the public relay URL belongs in the extension. The recipient stays in server-side Script Properties.
export const FEEDBACK_ENDPOINT = 'https://script.google.com/macros/s/AKfycbyhukVliEcfHfmVUcBMzFAG96m4fHfKEg3yMqbLIYuRJfgyqqPYOCKnH58vd_rzF9-RtQ/exec';
export function feedbackDraft(raw: unknown = {}): FeedbackDraft {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const text = (key: string, max = 2000) => typeof input[key] === 'string' ? input[key].replace(/\r\n?/g, '\n').slice(0, max) : '';
  const rating = typeof input.rating === 'number' || typeof input.rating === 'string' ? Number(input.rating) : 0;
  return { kind: input.kind === 'bug' || input.kind === 'idea' ? input.kind : 'review',
    rating: [1, 2, 3, 4, 5].includes(rating) ? rating : 0,
    context: text('context', 160), good: text('good'), problem: text('problem'), idea: text('idea'), steps: text('steps') };
}
export function hasFeedback(draft: FeedbackDraft): boolean {
  return !!(draft.rating || draft.good.trim() || draft.problem.trim() || draft.idea.trim() || draft.kind === 'bug' && draft.steps.trim());
}
/** Submit only what the current preview includes; keep hidden reproduction steps in the local draft only. */
export function feedbackContent(draft: FeedbackDraft): FeedbackDraft {
  const content = feedbackDraft(draft);
  for (const key of ['context', 'good', 'problem', 'idea', 'steps'] as const) content[key] = content[key].trim();
  if (content.kind !== 'bug') content.steps = '';
  return content;
}
/** Diagnostics are supplied only after the user reviews a fixed snapshot. */
export function feedbackText(draft: FeedbackDraft, version: string, diagnostics?: DiagnosticsSummary, localized = false): string {
  const t = localized ? translate : formatMessage;
  if (!hasFeedback(draft)) return '';
  const kinds = { review: t("感想・評価"), bug: t("不具合"), idea: t("改善案") };
  const lines = [t("ECLIRIM フィードバック"), t("バージョン: {0}", [version]), t("種類: {0}", [kinds[draft.kind]])];
  if (draft.rating) lines.push(t("満足度: {0} / 5", [draft.rating]));
  if (draft.context.trim()) lines.push(t("使ったサイト・場面: {0}", [draft.context.trim()]));
  for (const [label, value] of [[t("よかったところ"), draft.good], [t("困ったこと・起きたこと"), draft.problem],
    [t("改善してほしいこと"), draft.idea], ...(draft.kind === 'bug' ? [[t("再現手順"), draft.steps]] : [])])
    if (value.trim()) lines.push('', label, value.trim());
  if (diagnostics) lines.push('', diagnosticsText(diagnostics, localized));
  return lines.join('\n');
}
export interface FeedbackSubmission { id: string; version: string; draft: FeedbackDraft; diagnostics?: DiagnosticsSummary }
export async function postFeedback(endpoint: string, submission: FeedbackSubmission, signal: AbortSignal, request: typeof fetch = fetch): Promise<void> {
  if (!endpoint.startsWith('https://')) throw new Error('UNAVAILABLE');
  const diagnostics = diagnosticsSummary(submission.diagnostics);
  if (submission.diagnostics !== undefined && !diagnostics) throw new Error('INVALID');
  if (diagnostics) {
    // An older receiver silently ignores extra fields. Check before posting so a reviewed attachment cannot be lost.
    const health = await request(endpoint, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow', cache: 'no-store', signal });
    if (!health.ok) throw new Error('NETWORK');
    const capability: unknown = await health.json();
    if (!capability || typeof capability !== 'object' || (capability as Record<string, unknown>).ok !== true
      || (capability as Record<string, unknown>).schema !== 2) throw new Error('DIAGNOSTICS_UNAVAILABLE');
  }
  const body: FeedbackSubmission = { id: submission.id, version: submission.version, draft: feedbackContent(submission.draft), ...(diagnostics ? { diagnostics } : {}) };
  const response = await request(endpoint, { method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow', signal,
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error('NETWORK');
  const result: unknown = await response.json();
  if (result && typeof result === 'object') {
    const value = result as Record<string, unknown>;
    if (value.ok === true && value.id === submission.id) return;
    if (value.ok === false && typeof value.code === 'string') throw new Error(value.code);
  }
  throw new Error('RESPONSE');
}
