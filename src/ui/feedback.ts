import { t } from '../shared/i18n';
import { FEEDBACK_ENDPOINT, FEEDBACK_KEY, type FeedbackDraft, feedbackContent, feedbackDraft, feedbackText, hasFeedback, postFeedback } from '../shared/feedback';
import { diagnosticsSummary, diagnosticsText, type DiagnosticsSummary } from '../shared/diagnostics';

import type { Message } from '../shared/types';
/** Draft changes sent from this page and not yet answered. */
const inflight = new Set<Promise<void>>();
/** Resolves once every draft change made so far on this page has been answered (before the page reloads itself). */
export const feedbackSaved = (): Promise<void> => Promise.all([...inflight]).then(() => undefined);

export interface DiagnosticsChoice { id: string; label: string; summary: DiagnosticsSummary }

/** Compose a local draft and submit it only on an explicit click; lighting settings stay separate. */
export async function setupFeedback(loadDiagnostics: () => Promise<DiagnosticsChoice[]>): Promise<void> {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;
  const form = $<HTMLFormElement>('feedback-form'), fields = $<HTMLFieldSetElement>('feedback-fields');
  const preview = $<HTMLTextAreaElement>('feedback-preview'), copy = $<HTMLButtonElement>('feedback-copy');
  const send = $<HTMLButtonElement>('feedback-send');
  const clear = $<HTMLButtonElement>('feedback-clear'), status = $('feedback-status');
  const diagnosticsLoad = $<HTMLButtonElement>('feedback-diagnostics-load');
  const diagnosticsTab = $<HTMLSelectElement>('feedback-diagnostics-tab');
  const diagnosticsPreview = $<HTMLTextAreaElement>('feedback-diagnostics-preview');
  const diagnosticsConfirm = $<HTMLInputElement>('feedback-diagnostics-confirm');
  const version = chrome.runtime.getManifest().version;
  const keys = ['kind', 'rating', 'context', 'good', 'problem', 'idea', 'steps'] as const;
  let draft = feedbackDraft(), clearing = 0, sending = false;
  // A reviewed snapshot is deliberately session-only. Reopening the page requires a new review.
  let choices: DiagnosticsChoice[] = [], snapshot: DiagnosticsSummary | undefined, reviewed = false, loading = false, reading = 0;
  const say = (text: string) => { status.textContent = text; };
  const cancelClear = () => { clearTimeout(clearing); clearing = 0; clear.textContent = t("下書きを消す"); };
  const render = () => {
    preview.value = feedbackText(draft, version, reviewed ? snapshot : undefined, true); copy.disabled = !hasFeedback(draft) || sending;
    send.disabled = !hasFeedback(draft) || !FEEDBACK_ENDPOINT || sending || loading;
    send.textContent = sending ? t("送信中…") : t("フィードバックを送る"); fields.disabled = sending;
    send.setAttribute('aria-busy', String(sending));
    $('feedback-steps-row').hidden = draft.kind !== 'bug';
    clear.disabled = sending || !snapshot && !loading && !draft.rating && ![draft.context, draft.good, draft.problem, draft.idea, draft.steps].some(s => s.length);
    diagnosticsLoad.disabled = sending || loading; diagnosticsLoad.textContent = loading ? t("読み込み中…") : snapshot ? t("要約を更新する") : t("要約を作る");
    diagnosticsTab.disabled = sending || loading; diagnosticsConfirm.disabled = sending || loading || !snapshot;
    diagnosticsConfirm.checked = reviewed; $('feedback-diagnostics-review').hidden = !snapshot;
  };
  const selectDiagnostics = () => {
    snapshot = diagnosticsSummary(choices.find(choice => choice.id === diagnosticsTab.value)?.summary);
    reviewed = false; diagnosticsPreview.value = snapshot ? diagnosticsText(snapshot, true) : ''; render();
  };
  const clearDiagnostics = () => {
    reading++; loading = false; choices = []; snapshot = undefined; reviewed = false;
    diagnosticsTab.replaceChildren(); diagnosticsPreview.value = ''; $('feedback-diagnostics-status').textContent = '';
  };
  const fill = () => { for (const key of keys) $<HTMLInputElement>(`feedback-${key}`).value = String(draft[key]); render(); };
  // Every change goes to the background as the fields it changes (a clear as all of them), and the background lays it over
  // the draft as it is stored then, one change at a time: two settings pages editing different fields keep both, and an
  // older change can never put a cleared draft back. `pending` counts, per field, the changes sent from here and not yet
  // answered: until then this page's value of that field stands, whatever storage says.
  type Key = typeof keys[number];
  const pending = new Map<Key, number>();
  let deferred = false;
  /** Shows the draft as stored, except the fields this page has changes on their way for. Fields already showing it are left alone. */
  const take = (incoming: FeedbackDraft) => {
    const next = feedbackDraft({ ...incoming, ...Object.fromEntries(keys.filter(key => pending.get(key)).map(key => [key, draft[key]])) });
    if (JSON.stringify(next) === JSON.stringify(draft)) return;
    draft = next;
    for (const key of keys) { const field = $<HTMLInputElement>(`feedback-${key}`); if (field.value !== String(draft[key])) field.value = String(draft[key]); }
    render();
  };
  const save = (changed: readonly Key[] | null) => {
    for (const key of changed || keys) pending.set(key, (pending.get(key) || 0) + 1);
    const patch = changed ? Object.fromEntries(changed.map(key => [key, draft[key]])) : null;
    const release = () => { for (const key of changed || keys) pending.set(key, (pending.get(key) || 1) - 1); };
    const done: Promise<void> = chrome.runtime.sendMessage({ target: 'background', type: 'draft', patch } satisfies Message).then((reply: { ok?: boolean; draft?: unknown } | undefined) => {
      release();
      if (!reply?.ok) throw new Error('draft');
      if (!sending) take(feedbackDraft(reply.draft));
    }, error => { release(); throw error; }).catch(() => {
      say(t("下書きを保存できませんでした。入力内容は、この画面からコピーできます。"));
    }).finally(() => inflight.delete(done));
    inflight.add(done);
  };
  try { draft = feedbackDraft((await chrome.storage.local.get(FEEDBACK_KEY))[FEEDBACK_KEY]); }
  catch { say(t("下書きを読み込めませんでした。新しく入力してコピーできます。")); }
  fill(); fields.disabled = false;
  form.addEventListener('input', event => {
    if ((event.target as HTMLElement).closest('#feedback-diagnostics')) return;
    const before = draft;
    draft = feedbackDraft(Object.fromEntries(keys.map(key => [key, $<HTMLInputElement>(`feedback-${key}`).value])));
    const changed = keys.filter(key => draft[key] !== before[key]);
    cancelClear(); say(''); render(); if (changed.length) save(changed);
  });
  form.addEventListener('submit', event => event.preventDefault());
  // Another settings page writing the same draft: this form shows what it wrote. While a report is being sent, what is
  // shown stays as it is, and catches up once sending has finished.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[FEEDBACK_KEY]) return;
    if (sending) { deferred = true; return; }
    take(feedbackDraft(changes[FEEDBACK_KEY].newValue));
  });
  diagnosticsLoad.addEventListener('click', () => {
    const current = ++reading, selected = diagnosticsTab.value;
    cancelClear();
    loading = true; reviewed = false; snapshot = undefined; diagnosticsPreview.value = ''; render(); say('');
    $('feedback-diagnostics-status').textContent = t("点灯中のタブから要約を作っています…");
    void (async () => {
      let timer = 0;
      try {
        const result = await Promise.race([loadDiagnostics(), new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error('timeout')), 8000); })]);
        if (current !== reading) return;
        choices = result.flatMap(choice => {
          const summary = diagnosticsSummary(choice.summary);
          return summary ? [{ id: choice.id, label: choice.label, summary }] : [];
        });
        diagnosticsTab.replaceChildren(...choices.map(choice => { const option = document.createElement('option'); option.value = choice.id; option.textContent = choice.label; return option; }));
        if (choices.some(choice => choice.id === selected)) diagnosticsTab.value = selected;
        selectDiagnostics();
        $('feedback-diagnostics-status').textContent = choices.length ? t("要約を確認して、添付する場合はチェックしてください。")
          : t("診断できるタブがありません。動画のタブで照明を開始してから、もう一度お試しください。");
      } catch {
        if (current === reading) $('feedback-diagnostics-status').textContent = t("要約を取得できませんでした。添付せず送信することもできます。");
      } finally { clearTimeout(timer); if (current === reading) { loading = false; render(); } }
    })();
  });
  diagnosticsTab.addEventListener('change', () => { cancelClear(); selectDiagnostics(); say(''); });
  diagnosticsConfirm.addEventListener('change', () => { cancelClear(); reviewed = !!snapshot && diagnosticsConfirm.checked; say(''); render(); });
  copy.addEventListener('click', () => {
    if (!hasFeedback(draft)) return;
    // Called directly from the user's gesture, with the exact visible preview.
    void navigator.clipboard.writeText(preview.value).then(() => say(t("コピーしました。共有したい場所に貼り付けてください。")), () => {
      preview.focus(); preview.select(); say(t("コピーできませんでした。内容を選択したので、コピーのショートカットを使ってください。"));
    });
  });
  send.addEventListener('click', () => {
    if (!hasFeedback(draft) || sending || loading || !FEEDBACK_ENDPOINT) return;
    const content = feedbackContent(draft), diagnostics = reviewed ? diagnosticsSummary(snapshot) : undefined;
    const text = feedbackText(content, version, diagnostics);
    sending = true; render(); say(t("フィードバックを送信しています…"));
    void (async () => {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      const hash = Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
      const stored = (await chrome.storage.local.get('feedbackSubmission')).feedbackSubmission;
      const previous = stored && typeof stored === 'object' ? stored as Record<string, unknown> : {};
      const id = previous.hash === hash && typeof previous.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(previous.id) ? previous.id : crypto.randomUUID();
      await chrome.storage.local.set({ feedbackSubmission: { hash, id } });
      const controller = new AbortController(), timeout = window.setTimeout(() => controller.abort(), 20000);
      try { await postFeedback(FEEDBACK_ENDPOINT, { id, version, draft: content, ...(diagnostics ? { diagnostics } : {}) }, controller.signal); }
      finally { clearTimeout(timeout); }
      say(t("フィードバックを受け付けました。下書きは、この端末に残しています。"));
    })().catch(error => {
      const code = error instanceof Error ? error.message : '';
      say(code === 'DIAGNOSTICS_UNAVAILABLE' ? t("診断要約の添付をいまは受け付けられません。添付のチェックを外すか、あとでお試しください。")
        : code === 'RATE_LIMITED' || code === 'BUSY' ? t("いまは送信が混み合っています。時間を置いて、もう一度お試しください。")
        : t("送信結果を確認できませんでした。下書きは残っています。接続を確認して、もう一度お試しください。"));
    }).finally(() => {
      sending = false; render();
      if (deferred) { deferred = false; void chrome.storage.local.get(FEEDBACK_KEY).then(stored => take(feedbackDraft(stored[FEEDBACK_KEY]))).catch(() => undefined); }
    });
  });
  clear.addEventListener('click', () => {
    if (!clearing) {
      clear.textContent = t("もう一度押すと消去");
      clearing = window.setTimeout(() => { clearing = 0; clear.textContent = t("下書きを消す"); }, 4000);
      return;
    }
    clearTimeout(clearing); clearing = 0; draft = feedbackDraft(); clearDiagnostics(); fill(); save(null);
    clear.textContent = t("下書きを消す"); say(t("下書きを消しました。")); $<HTMLSelectElement>('feedback-kind').focus();
  });
}
