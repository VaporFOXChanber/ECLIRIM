// Actual extension UI in a disposable Chrome profile. Delivery and clipboard APIs are intercepted here;
// live delivery is verified separately, so UI regression never emails a user or changes the OS clipboard.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serve } from './serve.mjs';
import { openPopup } from './cdp-popup.mjs';
import { quiet } from './browser.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [], errors = [], sent = [];
const draftOnly = process.env.ECLIRIM_UI_DRAFT_ONLY === '1';
await mkdir('artifacts', { recursive: true });
const server = await serve(4187), context = await chromium.launchPersistentContext('', await quiet({
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
  args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`]
}));
let popup, options, version;
const until = async (read, label) => { const end = Date.now() + 10000; while (Date.now() < end) { const value = await read(); if (value) return value; await sleep(80); } throw new Error(label); };
const record = (name, detail) => { results.push({ name, result: 'PASS', detail }); console.log('PASS', name, detail); };
try {
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), id = sw.url().split('/')[2];
  version = await sw.evaluate(() => chrome.runtime.getManifest().version);
  const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.name, 'ECLIRIM'); assert.ok(!manifest.description.includes('旧名'));
  const video = await context.newPage(); await video.goto('http://localhost:4187');
  const cdp = await context.browser().newBrowserCDPSession(); popup = await openPopup(cdp, id, video.url());
  await popup.evaluate('document.querySelector("#start").click()');
  await until(() => popup.evaluate('document.querySelector("#state").textContent === "Active"'), 'active popup');
  const geometry = await popup.evaluate('(() => { const r=document.querySelector("#brightness").getBoundingClientRect(),m=document.querySelector("main").getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:innerHeight,mainBottom:m.bottom,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.id,scrollHeight:document.querySelector("main").scrollHeight}; })()');
  assert.ok(geometry.top < 400 && geometry.bottom <= geometry.mainBottom && geometry.bottom <= geometry.height, JSON.stringify(geometry));
  assert.equal(geometry.hit, 'brightness', 'utility buttons do not cover the brightness control');
  await popup.evaluate('(() => {const e=document.querySelector("#brightness");e.value="42";e.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await until(() => sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings.brightness === 42), 'brightness saved');
  const shot = await popup.send('Page.captureScreenshot', { format: 'png' }); await writeFile('artifacts/24-popup-organized.png', Buffer.from(shot.data, 'base64'));
  await popup.evaluate('document.querySelector("#pulse").click()');
  await until(() => popup.evaluate('!document.querySelector("#pulse-depth-row").hidden && !document.querySelector("#pulse-bloom-row").hidden'), 'pulse controls shown');
  await until(() => sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings.pulse.enabled), 'pulse enabled');
  await popup.evaluate('document.querySelector("#pulse").scrollIntoView({block:"start"})');
  const pulseShot = await popup.send('Page.captureScreenshot', { format: 'png' }); await writeFile('artifacts/26-popup-pulse.png', Buffer.from(pulseShot.data, 'base64'));
  await popup.evaluate('document.querySelector("#pulse").click()');
  await until(() => popup.evaluate('document.querySelector("#pulse-depth-row").hidden && document.querySelector("#pulse-bloom-row").hidden'), 'pulse controls hidden');
  await popup.close(); await video.locator('#eme-test').click();
  await until(() => video.locator('#player video').evaluate(v => !!v.mediaKeys && v.currentTime > .1), 'owned ClearKey fixture playing');
  popup = await openPopup(cdp, id, video.url());
  const protectedState = process.platform === 'darwin' ? 'Protected Content' : 'Compatibility Mode';
  await until(() => popup.evaluate(`document.querySelector("#state").textContent === ${JSON.stringify(protectedState)}`), 'protected popup state');
  assert.equal(await popup.evaluate('document.querySelector("#source-details").open'), true, 'source guidance opens on a protected-video state');
  await popup.evaluate('document.querySelector("#source-details").open = false'); await sleep(1200);
  assert.equal(await popup.evaluate('document.querySelector("#source-details").open'), false, 'refresh does not reopen a source panel the user closed');
  await popup.evaluate('document.querySelector("#source-details").open = true; document.querySelector("#source-details").scrollIntoView({block:"start"})');
  const protectedShot = await popup.send('Page.captureScreenshot', { format: 'png' }); await writeFile('artifacts/27-popup-protected.png', Buffer.from(protectedShot.data, 'base64'));
  record('The real action popup shows usable brightness, toggles Pulse controls and opens protected-video guidance only on a state change', { ...geometry, pulseToggle: 'PASS', protectedState, guidance: 'PASS' });
  const opened = context.waitForEvent('page'); await popup.evaluate('document.querySelector("#feedback").click()'); options = await opened;
  await options.waitForLoadState('domcontentloaded'); assert.equal(new URL(options.url()).hash, '#feedback');
  options.on('pageerror', error => errors.push(String(error)));
  await options.waitForFunction(() => !document.querySelector('#feedback-fields').disabled);
  assert.ok(await options.locator('#tab-feedback').isVisible()); assert.equal(await options.locator('#feedback-send').isDisabled(), true);
  const protectedBefore = await sw.evaluate(() => chrome.storage.local.get(['settings', 'profiles', 'presets']));
  let mode = 'success', pending;
  await options.route('https://script.google.com/**', async route => {
    const body = route.request().postDataJSON(); sent.push(body);
    if (mode === 'hold') await new Promise(r => { pending = r; });
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(mode === 'failure' ? { ok: false, code: 'BUSY' } : { ok: true, id: body.id }) });
  });
  await options.locator('#feedback-kind').selectOption('bug'); await options.locator('#feedback-rating').selectOption('4');
  await options.locator('#feedback-context').fill('YouTube · 音楽動画'); await options.locator('#feedback-good').fill('ビートの広がりがよかった。');
  await options.locator('#feedback-problem').fill('設定変更後に光が消えた。'); await options.locator('#feedback-steps').fill('1. 動画を開く\n2. 設定を変える');
  await options.locator('#feedback-idea').fill('よく使う項目へ、少ない操作で移動したい。');
  const expected = await options.locator('#feedback-preview').inputValue(); assert.ok(expected.includes(version)); assert.ok(expected.includes('再現手順'));
  await until(() => sw.evaluate(async () => (await chrome.storage.local.get('feedbackDraft')).feedbackDraft?.idea.endsWith('移動したい。')), 'draft saved');
  await options.reload(); await options.waitForFunction(() => !document.querySelector('#feedback-fields').disabled);
  assert.equal(await options.locator('#feedback-preview').inputValue(), expected);
  assert.deepEqual(await sw.evaluate(() => chrome.storage.local.get(['settings', 'profiles', 'presets'])), protectedBefore);
  record('Feedback restores its draft on reload and never changes lighting settings, profiles or presets', { version, kind: 'bug', rating: 4 });
  await options.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => { window.__copiedFeedback = text; } }));
  await options.locator('#feedback-copy').click(); await until(() => options.locator('#feedback-status').textContent().then(t => t.includes('コピーしました')), 'copied feedback');
  assert.equal(await options.evaluate(() => window.__copiedFeedback), expected);
  await options.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => { throw new Error('denied'); } }));
  await options.locator('#feedback-copy').click(); await until(() => options.locator('#feedback-status').textContent().then(t => t.includes('選択した')), 'copy fallback');
  const selected = await options.locator('#feedback-preview').evaluate(e => ({ start: e.selectionStart, end: e.selectionEnd, focused: document.activeElement === e }));
  assert.deepEqual(selected, { start: 0, end: expected.length, focused: true });
  record('Copy uses the exact visible report; a denied clipboard selects the intact report for manual copying', { characters: expected.length, clipboard: 'API intercepted; OS clipboard untouched' });
  if (!draftOnly) {
  mode = 'hold'; await options.locator('#feedback-send').click(); await until(() => sent.length === 1 && !!pending, 'submission in flight');
  assert.ok(await options.locator('#feedback-send').isDisabled());
  assert.equal(await options.locator('#feedback-fields').getAttribute('disabled'), '');
  assert.ok(await options.locator('#feedback-good').isDisabled(), 'the fieldset disables actual form inputs during submission');
  assert.ok(await options.locator('#feedback-clear').isDisabled()); pending(); mode = 'success';
  await until(() => options.locator('#feedback-status').textContent().then(t => t.includes('受け付けました')), 'accepted response');
  const requestId = sent[0].id; assert.equal(sent[0].draft.problem, '設定変更後に光が消えた。');
  await options.locator('#feedback-send').click(); await until(() => sent.length === 2, 'explicit retry'); assert.equal(sent[1].id, requestId);
  mode = 'failure'; await options.locator('#feedback-send').click(); await until(() => options.locator('#feedback-status').textContent().then(t => t.includes('混み合っています')), 'failure state');
  assert.equal(await options.locator('#feedback-preview').inputValue(), expected);
  record('Sending locks inputs, validates the acknowledgement, reuses the request ID and keeps drafts on failure', { requests: sent.length, relay: 'intercepted; no real email sent' });
  } else results.push({name:'Live relay configured: UI sending flow',result:'NOT_RUN',detail:'Draft-only check while relay publication is awaiting approval.'});
  await options.locator('#feedback-context').fill('YouTube · 音楽動画 ');
  await options.locator('#feedback-preview').evaluate(e => e.setSelectionRange(0, 0));
  await options.locator('[data-tab="lighting"]').click(); await options.locator('[data-tab="lighting"]').focus(); await options.keyboard.press('ArrowRight');
  assert.equal(new URL(options.url()).hash, '#glow'); assert.equal(await options.locator('[role=tab][tabindex="0"]').count(), 1);
  await options.keyboard.press('End'); assert.equal(new URL(options.url()).hash, '#feedback');
  assert.equal(await options.locator('[data-tab="feedback"]').getAttribute('aria-controls'), 'tab-feedback');
  const outlines = await options.locator('[data-tab="feedback"]').evaluate(e => getComputedStyle(e).outlineStyle); assert.equal(outlines, 'solid');
  const layouts = [];
  for (const width of [1280, 768, 390, 320]) {
    await options.setViewportSize({ width, height: 900 }); await options.evaluate(() => window.scrollTo(0, 0)); await sleep(160);
    const layout = await options.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, form: document.querySelector('#feedback-form').getBoundingClientRect().width }));
    assert.ok(layout.scrollWidth <= width, JSON.stringify(layout)); layouts.push(layout);
    await options.screenshot({ path: `artifacts/feedback-${width}.png`, fullPage: true });
    if (width <= 600) { await options.locator('#section-select').selectOption('lighting'); assert.ok(await options.locator('#tab-lighting').isVisible()); await options.locator('#section-select').selectOption('feedback'); }
  }
  record('Keyboard tabs and the narrow-screen section selector work at 1280, 768, 390 and 320px without horizontal overflow', layouts);
  await options.setViewportSize({ width: 1280, height: 900 }); await options.locator('[data-tab="lighting"]').click(); await options.screenshot({ path: 'artifacts/25-settings-organized.png', fullPage: true });
  await options.locator('[data-tab="feedback"]').click();
  await options.locator('#feedback-clear').click(); assert.equal(await options.locator('#feedback-preview').inputValue(), expected);
  await options.locator('#feedback-idea').fill('入力を続ける'); assert.equal(await options.locator('#feedback-clear').textContent(), '下書きを消す');
  await options.locator('#feedback-clear').click(); await options.locator('#feedback-clear').click();
  await until(() => sw.evaluate(async () => !(await chrome.storage.local.get('feedbackDraft')).feedbackDraft?.good), 'ordered clear saved');
  await options.reload(); await options.waitForFunction(() => !document.querySelector('#feedback-fields').disabled);
  assert.equal(await options.locator('#feedback-preview').inputValue(), ''); assert.ok(await options.locator('#feedback-send').isDisabled());
  assert.deepEqual(await sw.evaluate(() => chrome.storage.local.get(['settings', 'profiles', 'presets'])), protectedBefore);
  record('Clearing requires a second click, editing cancels that confirmation, and older writes cannot restore the cleared draft', {});
  const built = await readFile('dist/options.js', 'utf8'); assert.ok(!/mailto:|@gmail\.com/.test(built));
  assert.deepEqual(errors, []); record('The distributed UI has no owner email or mailto link, and no page errors', { name: manifest.name, description: manifest.description });
} catch (error) {
  results.push({ name: 'Failure', result: 'FAIL', detail: String(error.stack || error) }); console.error(error); process.exitCode = 1;
  if (options) await options.screenshot({ path: 'artifacts/failure-ui.png' }).catch(() => {});
} finally {
  await writeFile('artifacts/e2e-ui-results.json', JSON.stringify({ date: '2026-10-11', version, browser: context.browser()?.version(), results, errors }, null, 2));
  await context.close(); await server.close();
}
