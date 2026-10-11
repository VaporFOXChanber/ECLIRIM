// Disposable extension profile. Every submission is intercepted; this test never sends real mail.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serve } from './serve.mjs';
import { openPopup } from './cdp-popup.mjs';
import { quiet } from './browser.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms)), results = [], errors = [], sent = [];
const record = (name, detail = {}) => { results.push({ name, result: 'PASS', detail }); console.log('PASS', name, detail); };
const until = async (read, label) => { const end = Date.now() + 12000; while (Date.now() < end) { const value = await read(); if (value) return value; await sleep(50); } throw Error(label); };
await mkdir('artifacts', { recursive: true });
const server = await serve(4188), context = await chromium.launchPersistentContext('', await quiet({ channel: 'chromium', headless: true,
  viewport: { width: 1280, height: 900 }, args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`] }));
let page, popup, version, mode = 'success';
try {
  await context.route('https://script.google.com/**', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify(mode === 'old-receiver' ? { ok: true } : { ok: true, schema: 2 }) }); return;
    }
    const body = route.request().postDataJSON(); sent.push(body);
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(mode === 'failure' ? { ok: false, code: 'BUSY' } : { ok: true, id: body.id }) });
  });
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), id = sw.url().split('/')[2];
  version = await sw.evaluate(() => chrome.runtime.getManifest().version);
  const video = await context.newPage(); await video.goto('http://localhost:4188');
  popup = await openPopup(await context.browser().newBrowserCDPSession(), id, video.url());
  await popup.evaluate('document.querySelector("#start").click()');
  await until(() => popup.evaluate('document.querySelector("#state").textContent === "Active"'), 'lit video'); await popup.close();
  page = await context.newPage(); page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`chrome-extension://${id}/options.html#feedback`); await page.waitForFunction(() => !document.querySelector('#feedback-fields').disabled);
  const fields = ['settings', 'profiles', 'presets'], before = await sw.evaluate(keys => chrome.storage.local.get(keys), fields);
  const attach = page.locator('#feedback-diagnostics-confirm'), summary = page.locator('#feedback-diagnostics-preview');
  const preview = () => page.locator('#feedback-preview').inputValue();
  const load = async () => { await page.locator('#feedback-diagnostics-load').click(); await until(() => page.locator('#feedback-diagnostics-load').isEnabled(), 'diagnostics read finished'); };
  const send = async () => { const count = sent.length; await page.locator('#feedback-send').click(); await until(() => sent.length > count, 'submission'); await until(() => page.locator('#feedback-send').isEnabled(), 'submission finished'); return sent.at(-1); };
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime); window.__originalSend = original; window.__reads = 0;
    chrome.runtime.sendMessage = (message, ...args) => { if (message.type === 'tabs') window.__reads++; return original(message, ...args); };
  });
  await page.locator('#feedback-problem').fill('診断を確認して、必要な場合だけ添付したい。');
  assert.equal(await page.evaluate(() => window.__reads), 0); assert.equal(await attach.isChecked(), false);
  assert.equal(Object.hasOwn(await send(), 'diagnostics'), false);
  record('Opening feedback and sending ordinary feedback never gathers or automatically includes Diagnostics');

  await load(); assert.ok((await summary.inputValue()).includes('状態:'));
  assert.equal(await page.evaluate(() => window.__reads), 1); assert.equal(await attach.isChecked(), false);
  assert.ok(!(await preview()).includes('Diagnostics')); assert.equal(Object.hasOwn(await send(), 'diagnostics'), false);
  record('The explicit create button reads the real lit tab through the production background; an unconfirmed summary is omitted', { source: 'real extension status' });

  const secret = 'DO_NOT_SEND_TAB_METADATA';
  const rows = [1, 2].map(n => ({ tabId: n, title: `${secret}-${n}`, url: `https://private.example/${secret}?n=${n}`,
    status: { state: 'Active', source: n === 1 ? 'direct' : 'capture', detail: secret, service: secret, profile: secret,
      perf: { analysisFps: n * 11.23, renderFps: 30, analysisMs: 4.52, readMs: 3.8, renderMs: 0.45, zones: 64, activeZones: 60, quality: 0, reader: 'gpu', director: 'active' },
      audio: { state: 'off' }, color: { engine: 'v2', space: 'srgb' }, guard: { state: 'active' }, exposure: { state: 'off' } } }));
  const stub = async value => page.evaluate(value => {
    window.__rows = value; window.__reads = 0;
    chrome.runtime.sendMessage = (message, ...args) => { if (message.type !== 'tabs') return window.__originalSend(message, ...args); window.__reads++; return Promise.resolve(window.__rows); };
  }, value);
  await stub(rows); await load(); const reviewedText = await summary.inputValue();
  assert.ok(!reviewedText.includes(secret)); await attach.check(); const combined = await preview();
  assert.ok(combined.endsWith(reviewedText)); await page.evaluate(() => { window.__rows[0].status.perf.analysisFps = 99; });
  const attached = await send(); assert.equal(attached.diagnostics.analysisFps, 11.23); assert.equal(await page.evaluate(() => window.__reads), 1);
  assert.equal(await preview(), combined); assert.ok(!JSON.stringify(attached).includes(secret));
  assert.ok(!JSON.stringify(attached).includes('private.example'));
  record('Confirmation includes only the allowlisted frozen snapshot; changing live values cannot change the reviewed submission', { fields: Object.keys(attached.diagnostics), metadataLeaked: false });

  await page.locator('#feedback-diagnostics-tab').selectOption('2'); assert.equal(await attach.isChecked(), false);
  assert.ok(!(await preview()).includes('Diagnostics')); await attach.focus(); await page.keyboard.press('Space');
  assert.equal((await send()).diagnostics.source, 'capture');
  await load(); assert.equal(await attach.isChecked(), false); assert.ok(!(await preview()).includes('Diagnostics'));
  record('Changing the tab or refreshing a summary revokes confirmation; the checkbox works with the keyboard');

  await attach.check(); await until(() => sw.evaluate(async () => !!(await chrome.storage.local.get('feedbackDraft')).feedbackDraft?.problem), 'draft saved');
  await page.reload(); await page.waitForFunction(() => !document.querySelector('#feedback-fields').disabled);
  assert.ok((await preview()).includes('診断を確認')); assert.ok(!(await preview()).includes('Diagnostics'));
  assert.equal(await attach.isChecked(), false); assert.ok(await page.locator('#feedback-diagnostics-review').isHidden());
  const stored = await sw.evaluate(() => chrome.storage.local.get('feedbackDraft'));
  assert.ok(!JSON.stringify(stored).includes('diagnostics')); assert.ok(!JSON.stringify(stored).includes(secret));
  record('Reload keeps the written feedback but never restores a diagnostic snapshot or an earlier confirmation');

  await page.evaluate(() => { window.__originalSend = chrome.runtime.sendMessage.bind(chrome.runtime); chrome.runtime.sendMessage = (m, ...args) => m.type === 'tabs' ? Promise.reject(new Error('DO_NOT_SEND_TAB_METADATA')) : window.__originalSend(m, ...args); });
  await load(); assert.match(await page.locator('#feedback-diagnostics-status').textContent(), /取得できません/);
  assert.ok(!(await page.locator('#feedback-diagnostics-status').textContent()).includes(secret)); assert.equal(Object.hasOwn(await send(), 'diagnostics'), false);
  await stub([]); await load(); assert.match(await page.locator('#feedback-diagnostics-status').textContent(), /診断できるタブがありません/);
  await page.evaluate(() => { chrome.runtime.sendMessage = (m, ...args) => m.type === 'tabs' ? new Promise(resolve => { window.__releaseDiagnostics = resolve; }) : window.__originalSend(m, ...args); });
  await page.locator('#feedback-diagnostics-load').click(); await until(() => page.evaluate(() => !!window.__releaseDiagnostics), 'pending diagnostics');
  assert.ok(await page.locator('#feedback-send').isDisabled());
  await page.locator('#feedback-clear').click(); await page.locator('#feedback-clear').click();
  await page.evaluate(rows => window.__releaseDiagnostics(rows), rows); await sleep(150);
  assert.equal(await preview(), ''); assert.ok(await page.locator('#feedback-diagnostics-review').isHidden()); assert.equal(await attach.isChecked(), false);
  record('Empty and failed reads allow feedback without diagnostics; clearing ignores a late diagnostic result');

  rows.forEach((row, i) => { row.title = `テスト用の動画 ${i + 1}`; }); await stub(rows);
  await page.locator('#feedback-kind').selectOption('bug'); await page.locator('#feedback-problem').fill('設定を変更したあと、光が戻らなくなった。'); await load(); await attach.check();
  const layouts = [];
  for (const width of [1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 }); await page.evaluate(() => window.scrollTo(0, 0)); await sleep(150);
    const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(layout.scrollWidth <= width); layouts.push(layout);
    await page.screenshot({ path: `artifacts/feedback-diagnostics-${width}.png`, fullPage: true });
  }
  record('The reviewed summary, consent checkbox and combined preview render without overflow at 1280, 768, 390 and 320px', layouts);

  const textBeforeFailure = await preview(), postsBefore = sent.length; mode = 'old-receiver';
  await page.locator('#feedback-send').click();
  await until(() => page.locator('#feedback-status').textContent().then(t => t.includes('添付をいまは受け付けられません')), 'old receiver rejected before POST');
  assert.equal(sent.length, postsBefore); assert.equal(await preview(), textBeforeFailure); assert.equal(await attach.isChecked(), true);
  mode = 'failure'; const failed = await send();
  assert.match(await page.locator('#feedback-status').textContent(), /混み合っています/); assert.equal(await preview(), textBeforeFailure); assert.equal(await attach.isChecked(), true);
  mode = 'success'; const retried = await send(); assert.equal(retried.id, failed.id); assert.deepEqual(retried.diagnostics, failed.diagnostics);
  await attach.uncheck(); const ordinary = await send(); assert.equal(Object.hasOwn(ordinary, 'diagnostics'), false); assert.notEqual(ordinary.id, retried.id);
  assert.deepEqual(await sw.evaluate(keys => chrome.storage.local.get(keys), fields), before); assert.deepEqual(errors, []);
  record('An old receiver cannot drop an attachment; failures retain the reviewed snapshot and retry ID, unchecking removes it, settings stay unchanged', { transport: 'intercepted; no email sent' });
} catch (error) {
  results.push({ name: 'Failure', result: 'FAIL', detail: String(error.stack || error) }); console.error(error); process.exitCode = 1;
  if (page) await page.screenshot({ path: 'artifacts/failure-feedback-diagnostics.png' }).catch(() => {});
} finally {
  await writeFile('artifacts/e2e-feedback-diagnostics-results.json', JSON.stringify({ date: '2026-10-11', version, browser: context.browser()?.version(), results, errors }, null, 2));
  await context.close(); await server.close();
}
