import { captured, command, handleMessage, installed, lightGranted, relight, serial, setLit, startup, stopCapture, storageChanged } from './service';
import type { Message } from './shared/types';
// Chrome's events, handed to what the background does (service.ts).
chrome.runtime.onMessage.addListener((m: Message, sender, reply) => {
  const job = handleMessage(m, sender);
  if (job) { void job.then(reply); return true; }
});
chrome.tabs.onActivated.addListener(({ tabId }) => { void serial(async () => {
  const active = await captured(); if (active !== undefined && active !== tabId) await stopCapture('タブの切り替えにより取得を停止しました。');
}); });
chrome.tabs.onRemoved.addListener(tabId => { void serial(async () => { await setLit(tabId, false); if (await captured() === tabId) await stopCapture(); }); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') void serial(async () => { if (await captured() === tabId) await stopCapture('ページ移動により取得を停止しました。'); });
  // Not queued behind `serial`: injection waits for the new document, and a slow page must not hold up the popup.
  // Lighting only. Tab capture is never restarted without the user's own click.
  if (change.url || change.status === 'complete') void relight(tabId);
});
chrome.permissions.onAdded.addListener(({ origins }) => { void lightGranted(origins); });
chrome.runtime.onInstalled.addListener(({ previousVersion }) => { void installed(previousVersion); });
chrome.runtime.onStartup.addListener(() => { void startup(); });
chrome.commands.onCommand.addListener(name => { void command(name); });
chrome.tabs.onZoomChange.addListener(({ tabId, newZoomFactor }) => {
  void chrome.tabs.sendMessage(tabId, { target: 'content', type: 'zoom', factor: newZoomFactor }).catch(() => undefined);
});
chrome.storage.onChanged.addListener(storageChanged);
