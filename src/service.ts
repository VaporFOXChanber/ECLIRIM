import { loadSettings, migrate, sanitize } from './shared/settings';
import { SAVED_KEYS, applyOp, readSaved } from './shared/save';
import { captureBlockReason } from './shared/capture-policy';
import { sitePattern } from './shared/site';
import type { Message, SaveOp, SaveResult, Settings, VideoContext } from './shared/types';
/**
 * What the background does. Nothing here runs or listens on import: background.ts hands Chrome's events to these, and the
 * tests call them with a stand-in for chrome.
 */
const offscreenURL = () => chrome.runtime.getURL('offscreen.html');
/** One step at a time for everything about tabs and capture. */
let queue: Promise<unknown> = Promise.resolve();
export function serial<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job); queue = next.catch(() => undefined); return next;
}
/** One write at a time for the settings, apart from `serial`: a slow tab or capture never holds a save back. */
let saves: Promise<unknown> = Promise.resolve();
export function saving<T>(job: () => Promise<T>): Promise<T> {
  const next = saves.then(job, job); saves = next.catch(() => undefined); return next;
}
/**
 * Stores one change from the popup or the settings page, or the A/B shortcut. It is laid over what is stored at the moment
 * of writing (`applyOp`), in the order the changes arrived, and written in one step with the revision that holds it. It
 * happens whether or not the page that sent it is still open. A change that is refused writes nothing.
 */
export function save(op: SaveOp): Promise<SaveResult> {
  return saving(async (): Promise<SaveResult> => {
    const stored = readSaved(await chrome.storage.local.get([...SAVED_KEYS, 'revision']));
    const { written, name, quieted, limiter, compared, ...next } = applyOp(stored, op), items: Record<string, unknown> = {};
    for (const key of SAVED_KEYS) if (JSON.stringify(next[key]) !== JSON.stringify(stored[key])) items[key] = next[key];
    const done = { written, name, quieted, limiter, compared };
    if (!Object.keys(items).length) return { ok: true, rev: stored.rev, ...done };
    const rev = stored.rev + 1;
    await chrome.storage.local.set({ ...items, revision: rev });
    // An ended comparison is written as null in that same write, then its key goes. If only that fails, it has still ended.
    if ('compare' in items && !next.compare) await chrome.storage.local.remove('compare').catch(() => undefined);
    return { ok: true, rev, ...done };
  }).catch(e => ({ ok: false, error: String(e?.message || e) }));
}
export async function captured(): Promise<number | undefined> {
  const id = (await chrome.storage.session.get('captureTab')).captureTab;
  return typeof id === 'number' ? id : undefined;
}
async function hasOffscreen(): Promise<boolean> {
  return (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [offscreenURL()] })).length > 0;
}
export async function stopCapture(detail = 'タブ取得を停止しました。再開にはもう一度ボタンを押してください。'): Promise<void> {
  const tabId = await captured();
  if (await hasOffscreen()) {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => undefined);
    await chrome.offscreen.closeDocument().catch(() => undefined);
  }
  await chrome.storage.session.remove('captureTab');
  if (tabId !== undefined) await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'capture-ended', detail }).catch(() => undefined);
}
async function initialize(tabId: number): Promise<unknown> {
  const tab = await chrome.tabs.get(tabId);
  if (!/^(https?|file):/.test(tab.url || '')) throw new Error('このページには照明を追加できません。通常の動画ページで開いてください。');
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  return chrome.tabs.sendMessage(tabId, { target: 'content', type: 'start' });
}
// Tabs the user lit. Chrome keeps the activeTab grant while such a tab stays on the same site,
// so a reload or a move to another page there can be lit again without a new click.
export async function litTabs(): Promise<number[]> {
  const tabs = (await chrome.storage.session.get('litTabs')).litTabs;
  return Array.isArray(tabs) ? tabs : [];
}
export async function setLit(tabId: number, lit: boolean): Promise<void> {
  const tabs = (await litTabs()).filter(id => id !== tabId);
  await chrome.storage.session.set({ litTabs: lit ? [...tabs, tabId] : tabs });
}
// A site the user chose to always light holds a host permission, so its pages need no click at all.
async function alwaysLit(tabId: number): Promise<boolean> {
  const site = sitePattern((await chrome.tabs.get(tabId).catch(() => undefined))?.url);
  return !!site && chrome.permissions.contains({ origins: [site] });
}
export async function relight(tabId: number): Promise<void> {
  if (!(await loadSettings()).enabled) return;
  const lit = (await litTabs()).includes(tabId);
  if (!lit && !(await alwaysLit(tabId))) return;
  try { await initialize(tabId); } catch (error) {
    // Leaving the site ends the grant: forget the tab and wait for the user. Anything else may be a page still loading.
    if (lit && /cannot access|permission|追加できません/i.test(String(error))) await serial(() => setLit(tabId, false));
  }
}
/** Lights the tabs already open on always-lit sites: right after the user grants one, and after the extension restarts. */
export async function lightGranted(origins?: string[]): Promise<void> {
  const sites = origins || (await chrome.permissions.getAll()).origins || [];
  if (!sites.length || !(await loadSettings()).enabled) return;
  for (const tab of await chrome.tabs.query({ url: sites })) if (tab.id !== undefined) void initialize(tab.id).catch(() => undefined);
}
async function startCapture(tabId: number): Promise<{ ok: boolean }> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) throw new Error('取得したいタブを表示してから、もう一度開始してください。');
  await stopCapture();
  await initialize(tabId);
  const { context, settings } = await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'context' }) as { context: VideoContext; settings: Settings };
  if (!settings.enabled || settings.source !== 'video') throw new Error('照明をオンにして「映像に連動」を選択してください。');
  const blocked = captureBlockReason(context, tab.url || '');
  if (blocked) throw new Error(blocked);
  if (!context.rect) throw new Error('解析する動画が見つかりません。埋め込み動画は元サイトで開いてください。');
  if (context.paused) throw new Error('動画を再生してから、もう一度タブ取得を開始してください。');
  if (context.fullscreenUnsupported) throw new Error('動画要素単体の全画面を解除してから開始してください。');
  try {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: [chrome.offscreen.Reason.USER_MEDIA], justification: '映像のみを端末内で縮小解析し、外周照明の色を算出します。録画・保存・音声取得は行いません。' });
    // This path is reachable only from an explicit popup button. No auto capture.
    if (!(await chrome.tabs.get(tabId)).active) throw new Error('タブが切り替わったため開始を取り消しました。');
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await chrome.storage.session.set({ captureTab: tabId });
    await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'capture-started' });
    const result = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', tabId, streamId, context, settings });
    if (!result?.ok) throw new Error(result?.error || '映像取得を開始できませんでした。');
    return { ok: true };
  } catch (error) {
    await stopCapture('映像を取得できませんでした。互換描画または固定照明をお試しください。');
    throw error;
  }
}
/**
 * A message to the background: the answer to send back, or undefined when it is not one for the background, or not from a
 * sender allowed to ask it (then nothing is answered and nothing is done). The answer never fails: an error is `{ ok: false, error }`.
 */
export function handleMessage(m: Message, sender: chrome.runtime.MessageSender): Promise<unknown> | undefined {
  if (m?.target !== 'background' || sender.id !== chrome.runtime.id) return;
  const popup = sender.url === chrome.runtime.getURL('popup.html');
  const options = sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL('options.html');
  const offscreen = sender.url === offscreenURL();
  let job: Promise<unknown> | undefined;
  // Diagnostics on the settings page: what every lit tab measures. Only tabs the user lit or approved are asked.
  if (m.type === 'tabs' && options) job = (async () => {
    const granted = (await chrome.permissions.getAll()).origins || [];
    const ids = new Set([...await litTabs(), ...(granted.length ? await chrome.tabs.query({ url: granted }) : []).map(tab => tab.id!)]);
    const tabs = await Promise.all([...ids].map(async tabId => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const status = await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'status' }).catch(() => null);
      return tab && status ? { tabId, title: tab.title || '', url: tab.url || '', status } : null;
    }));
    return tabs.filter(Boolean);
  })();
  if ('tabId' in m && ['start', 'capture', 'stop', 'status', 'stop-capture'].includes(m.type) && popup) {
    if (m.type === 'start') job = serial(async () => { const started = await initialize(m.tabId); await setLit(m.tabId, true); return started; });
    if (m.type === 'capture') job = serial(async () => { const started = await startCapture(m.tabId); await setLit(m.tabId, true); return started; });
    if (m.type === 'stop-capture') job = serial(async () => { if (await captured() === m.tabId) await stopCapture(); });
    if (m.type === 'stop') job = serial(async () => {
      await setLit(m.tabId, false);
      if (await captured() === m.tabId) await stopCapture();
      return chrome.tabs.sendMessage(m.tabId, { target: 'content', type: 'stop' }).catch(() => undefined);
    });
    if (m.type === 'status') job = chrome.tabs.sendMessage(m.tabId, { target: 'content', type: 'status' }).catch(() => null);
  } else if (m.type === 'save' && (popup || options)) {
    job = save(m.op);
  } else if (m.type === 'context' && sender.tab?.id !== undefined && sender.frameId === 0) {
    job = captured().then(id => id === sender.tab!.id ? chrome.runtime.sendMessage({ ...m, target: 'offscreen', tabId: id }) : undefined);
  } else if (m.type === 'release' && sender.tab?.id !== undefined) {
    job = serial(async () => { if (await captured() === sender.tab!.id) await stopCapture(); });
  } else if (m.type === 'relay' && offscreen && m.message.target === 'content') {
    job = chrome.tabs.sendMessage(m.tabId, m.message).catch(() => { void serial(() => stopCapture()); });
  } else if (m.type === 'capture-closed' && offscreen) {
    job = serial(async () => { if (await captured() === m.tabId) await stopCapture(m.detail); });
  } else if (m.type === 'heartbeat' && sender.tab) {
    job = chrome.tabs.getZoom(sender.tab.id!).then(zoom => ({ ok: true, zoom }));
  }
  return job?.then(v => v === undefined ? { ok: true } : v, e => ({ ok: false, error: String(e?.message || e) }));
}
/** A keyboard command. A/B Comparison from the keyboard, so the two looks can be flipped while the video fills the screen. */
export function command(name: string): Promise<SaveResult> | undefined {
  if (name === 'compare-switch') return save({ kind: 'flip' });
}
export function installed(previousVersion?: string): Promise<void> {
  return (async () => {
    await saving(async () => {
      // Bring what earlier versions stored to this one before anything reads it. Existing values are kept (see `migrate`).
      const stored = await chrome.storage.local.get(['settings', 'profiles', 'presets', 'schema']), next = migrate(stored, previousVersion);
      if (JSON.stringify(stored) !== JSON.stringify(next)) await chrome.storage.local.set(next);
      // A comparison left open belongs to the session it was started in. The saved settings were never touched by it.
      await chrome.storage.local.remove('compare');
    });
    await lightGranted();
  })();
}
export const startup = (): Promise<void> => saving(() => chrome.storage.local.remove('compare'));
export function storageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string): void {
  if (area !== 'local' || !changes.settings) return;
  void serial(async () => {
    const s = await loadSettings(); if (!s.enabled || s.source !== 'video') await stopCapture();
  });
  // The switch is global: turning it back on lights every tab that may be lit, not only the one showing the popup.
  if (changes.settings.oldValue && !sanitize(changes.settings.oldValue).enabled && sanitize(changes.settings.newValue).enabled)
    void (async () => { void lightGranted(); for (const tabId of await litTabs()) void relight(tabId); })();
}
