// Real 2D context loss on the production extension: an unchanged cached mask must survive recovery.
// The GPU restart affects this disposable test browser only. No user's Chrome profile is opened.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serve } from './serve.mjs';
import { openPopup } from './cdp-popup.mjs';
import { quiet } from './browser.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const reportDir = resolve(process.env.ECLIRIM_REPORT_DIR || 'artifacts');
const buildDir = resolve(process.env.ECLIRIM_BUILD || 'dist');
const port = Number(process.env.ECLIRIM_TEST_PORT || 4173);
await mkdir(reportDir, { recursive: true });
const server = await serve(port);
const context = await chromium.launchPersistentContext('', await quiet({
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
  args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${buildDir}`, `--load-extension=${buildDir}`]
}));
const results = [], errors = [];
let sw, page, cdp, tabId, version;
const until = async (fn, label, timeout = 10000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
};
const state = () => sw.evaluate(id => chrome.tabs.sendMessage(id, { target: 'content', type: 'status' }), tabId);
const probe = () => sw.evaluate(id => chrome.tabs.sendMessage(id, { target: 'content', type: 'probe' }), tabId);
const set = changes => sw.evaluate(async changes => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, ...changes } });
}, changes);
const peaks = () => page.evaluate(() => Array.from(document.querySelector('#eclirim-lighting').shadowRoot.querySelectorAll('canvas')).map(canvas => {
  const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let max = 0; for (let i = 3; i < pixels.length; i += 4) max = Math.max(max, pixels[i]);
  return max;
}));
const record = (name, detail) => { results.push({ name, result: 'PASS', detail }); console.log('PASS', name, detail); };
async function restart(label) {
  const before = { state: await state(), inside: await probe(), peaks: await peaks() };
  assert.ok(before.peaks.every(n => n > 20), `${label}: initial light ${before.peaks}`);
  await cdp.send('Browser.crashGpuProcess');
  await sleep(2200);
  const after = { state: await state(), inside: await probe(), peaks: await peaks() };
  assert.ok(after.peaks.every(n => n > 20), `${label}: context restored but light is dark: ${JSON.stringify(after)}`);
  assert.ok(after.inside.light.restored?.mask >= (before.inside.light.restored?.mask || 0) + 4, 'Actual mask contexts were restored');
  assert.deepEqual(after.inside.light.base, before.inside.light.base, 'The unchanged cached shape is preserved');
  assert.ok(after.inside.light.colours.now > .1 && after.inside.light.colours.notNumbers === 0, 'Scene colours remain valid');
  assert.equal(after.state.state, before.state.state);
  if (before.state.state === 'Paused') after.peaks.forEach((value, side) => assert.ok(Math.abs(value - before.peaks[side]) <= 1, 'The held light keeps its brightness'));
  record(label, { before: before.peaks, after: after.peaks, state: after.state.state, restored: after.inside.light.restored });
}
try {
  sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2]; version = await sw.evaluate(() => chrome.runtime.getManifest().version);
  cdp = await context.browser().newBrowserCDPSession();
  page = await context.newPage(); page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`http://localhost:${port}`);
  const popup = await openPopup(cdp, id, page.url()); await sleep(350);
  await popup.evaluate('document.querySelector("#start").click()');
  tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
  await until(async () => (await state().catch(() => null))?.state === 'Active', 'active video');
  await popup.close();
  // UI Guard is off: a moving guard must not accidentally repaint the missing cached mask and hide this defect.
  await set({ zoneMode: 'manual', zoneCount: 64, director: { enabled: false }, guard: { enabled: false }, exposure: { enabled: false },
    glow: { style: 'halo', thickness: 40, curve: 55, falloff: 45, softness: 70 } });
  await sleep(2500);
  await restart('Active video restores all four cached masks after settings change and context loss');
  await page.locator('video').evaluate(video => video.pause());
  await until(async () => (await state()).state === 'Paused', 'held picture');
  await sleep(5000);
  await until(async () => !(await probe()).light.looping, 'paint loop has slept');
  await restart('A paused picture wakes and redraws after context recovery without needing another video frame');
  // Also go through Chrome's decoded-video path, rather than only the Lab's live Canvas stream.
  await page.locator('[data-scene="file"]').click();
  await page.locator('video').evaluate(video => { video.loop = true; });
  await until(async () => (await state()).state === 'Active' && await page.locator('video').evaluate(video => video.currentSrc.endsWith('/fixture.webm') && video.currentTime > .2), 'decoded video');
  await set({ glow: { style: 'edge', thickness: 50, curve: 50, falloff: 50, softness: 50 } });
  await sleep(2500);
  await restart('A decoded WebM video keeps analysis and edge lighting after context recovery');
  await set({ enabled: false });
  await until(async () => (await state()).state === 'Disabled', 'disabled');
  await cdp.send('Browser.crashGpuProcess'); await sleep(1600);
  assert.equal(await page.locator('#eclirim-lighting').count(), 0, 'Recovery does not turn disabled lighting back on');
  assert.equal((await probe()).light.looping, false);
  record('Context recovery preserves the disabled state and creates no extra light layer', { state: (await state()).state });
  assert.deepEqual(errors, []);
} catch (error) {
  results.push({ name: 'Failure', result: 'FAIL', detail: String(error.stack || error) });
  console.error(error); process.exitCode = 1;
} finally {
  await writeFile(resolve(reportDir, 'e2e-recovery-results.json'), JSON.stringify({ date: '2026-10-11', version, browser: context.browser()?.version(), results, errors }, null, 2));
  await context.close(); await server.close();
}
