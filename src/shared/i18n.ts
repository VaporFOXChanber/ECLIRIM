import catalog from './messages.json';

export type Language = 'ja' | 'en';
export type LanguagePreference = 'auto' | Language;
/** Deliberately separate from settings/profiles/presets, and from their backup schema. */
export const LANGUAGE_KEY = 'language';
const bySource = new Map(catalog.map(message => [message.ja, message]));
const byId = new Map(catalog.map(message => [message.id, message]));
export const normalizePreference = (raw: unknown): LanguagePreference => raw === 'ja' || raw === 'en' ? raw : 'auto';
export const resolveLanguage = (preference: unknown, uiLanguage: string): Language => {
  const choice = normalizePreference(preference);
  return choice === 'auto' ? /^ja(?:[-_]|$)/i.test(uiLanguage) ? 'ja' : 'en' : choice;
};
const browserLanguage = (): string => {
  try { return chrome.i18n.getUILanguage(); } catch { return typeof navigator === 'undefined' ? 'en' : navigator.language; }
};
const uiLanguage = browserLanguage();
let preference: LanguagePreference = 'auto';
let language: Language = resolveLanguage(preference, uiLanguage);
let initialized: Promise<void> | undefined;
export const getLanguage = (): Language => language;
export const getLanguagePreference = (): LanguagePreference => preference;
/** Also useful in isolated tests; does not write storage or affect lighting. */
export function useLanguage(value: unknown, uiLanguage = browserLanguage()): void {
  preference = normalizePreference(value); language = resolveLanguage(preference, uiLanguage);
}
export function formatMessage(message: string, substitutions: readonly unknown[] = []): string {
  // A callback keeps $&, dollar signs, braces, and user-authored text literal.
  return message.replace(/\{(\d+)\}/g, (token, index: string) => Number(index) < substitutions.length ? String(substitutions[Number(index)]) : token);
}
export function t(source: string, substitutions: readonly unknown[] = []): string {
  const entry = bySource.get(source) || byId.get(source);
  if (!entry) return formatMessage(source, substitutions);
  let text = entry[language] || entry.en || entry.ja;
  // Chrome resolves regional locales and the manifest. Manual overrides use the same bundled catalog.
  if (language === resolveLanguage('auto', uiLanguage)) {
    try { text = chrome.i18n.getMessage(entry.id) || text; } catch { /* Unit tests / unavailable API: bundled fallback. */ }
  }
  return formatMessage(text, substitutions);
}
export function initI18n(): Promise<void> {
  if (initialized) return initialized;
  // Register before reading to avoid losing a concurrent preference change during startup.
  let revision = 0;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[LANGUAGE_KEY]) return;
    revision++;
    useLanguage(changes[LANGUAGE_KEY].newValue);
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('eclirim-language'));
  });
  const initial = revision;
  initialized = chrome.storage.local.get(LANGUAGE_KEY).then(stored => {
    if (revision === initial) useLanguage(stored[LANGUAGE_KEY]);
  }).catch(() => { /* Storage unavailable: keep automatic language; never write defaults. */ });
  return initialized;
}
export async function setLanguagePreference(value: unknown): Promise<void> {
  const next = normalizePreference(value);
  await chrome.storage.local.set({ [LANGUAGE_KEY]: next });
}
/** Only trusted, annotated extension UI is translated. No page text or user input is traversed. */
export function localizeDocument(root: Document = document): void {
  root.documentElement.lang = language;
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n!); });
  // Japanese joins inline emphasis without spaces. English needs a word/sentence boundary,
  // but must not gain a space before punctuation (for example a translated final period).
  if (language === 'en') root.querySelectorAll<HTMLElement>('span[data-i18n]').forEach(el => {
    const next = el.nextSibling || (/^(B|STRONG|EM)$/.test(el.parentElement?.tagName || '') ? el.parentElement?.nextSibling : null);
    if (/[A-Za-z0-9.)]$/.test(el.textContent || '') && /^[A-Za-z0-9]/.test(next?.textContent || '')) el.append(' ');
  });
  for (const attribute of ['title', 'placeholder', 'aria-label', 'label']) {
    root.querySelectorAll<HTMLElement>(`[data-i18n-${attribute}]`).forEach(el => {
      el.setAttribute(attribute, t(el.getAttribute(`data-i18n-${attribute}`)!));
    });
  }
  root.documentElement.removeAttribute('data-i18n-pending');
}
// Status/error messages retain their original wire representation. Translate only at the UI boundary,
// including parameterized legacy messages. User preset names and feedback input never pass this function.
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const templates = catalog.filter(entry => /\{\d+\}/.test(entry.ja)).map(entry => ({ entry,
  pattern: new RegExp('^' + entry.ja.split(/\{\d+\}/).map(escape).join('([\\s\\S]*?)') + '$'),
  indices: [...entry.ja.matchAll(/\{(\d+)\}/g)].map(m => Number(m[1]))
})).sort((a, b) => b.entry.ja.replace(/\{\d+\}/g, '').length - a.entry.ja.replace(/\{\d+\}/g, '').length);
export function localizeText(text: string, depth = 0): string {
  if (language === 'ja' || !text || depth > 5) return text;
  if (bySource.has(text)) return t(text);
  if (text.startsWith('Error: ')) return 'Error: ' + localizeText(text.slice(7), depth + 1);
  for (const { entry, pattern, indices } of templates) {
    const match = pattern.exec(text);
    if (!match) continue;
    const args: string[] = [];
    indices.forEach((index, position) => { args[index] = localizeText(match[position + 1], depth + 1); });
    return t(entry.ja, args);
  }
  return text;
}
