// Chrome action popups are separate targets that Playwright does not auto-attach.
// Test-only CDP wrapper. Production permissions and popup code are unchanged.
export async function openPopup(browserCDP, extensionId, pageURL) {
  const { targetInfos: tabs } = await browserCDP.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  const tab = tabs.find(t => t.url === pageURL);
  if (!tab) throw new Error('Test tab target not found');
  await browserCDP.send('Extensions.triggerAction', { id: extensionId, targetId: tab.targetId });
  let target;
  for (let i = 0; i < 30; i++) {
    const { targetInfos } = await browserCDP.send('Target.getTargets');
    target = targetInfos.find(t => t.url === `chrome-extension://${extensionId}/popup.html`);
    if (target) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (!target) throw new Error('Action popup did not open');
  const { sessionId } = await browserCDP.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  let id = 0; const pending = new Map();
  const listener = event => {
    if (event.sessionId !== sessionId) return;
    const response = JSON.parse(event.message), callback = pending.get(response.id);
    if (callback) { pending.delete(response.id); response.error ? callback.reject(new Error(response.error.message)) : callback.resolve(response.result); }
  };
  browserCDP.on('Target.receivedMessageFromTarget', listener);
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    const timeout = setTimeout(() => { pending.delete(key); reject(new Error(`Popup ${method} timed out`)); }, 10000);
    pending.set(key, { resolve: r => { clearTimeout(timeout); resolve(r); }, reject: e => { clearTimeout(timeout); reject(e); } });
    browserCDP.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: key, method, params }) }).catch(reject);
  });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  };
  await send('Runtime.enable');
  return { evaluate, send, close: async () => {
    await evaluate('window.close()').catch(() => undefined);
    browserCDP.off('Target.receivedMessageFromTarget', listener);
  } };
}
