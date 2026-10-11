import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { serve } from './serve.mjs';
import { openPopup } from './cdp-popup.mjs';
import { quiet } from './browser.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [], errors = [], performanceSamples = [];
await mkdir('artifacts', { recursive: true });
const server = await serve();
const context = await chromium.launchPersistentContext('', await quiet({
  channel: 'chromium', headless: process.env.HEADED !== '1', viewport: { width: 1280, height: 900 },
  args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`,
    // Only inside this throwaway browser: the streaming host names resolve to the local Lab. Nothing reaches those services.
    '--host-resolver-rules=MAP www.netflix.com 127.0.0.1, MAP www.primevideo.com 127.0.0.1']
}));
let page, sw, cdp, id, tabId, popup;
const until = async (fn, label, timeout = 10000) => {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(120); }
  throw new Error(`Timed out: ${label}; last=${JSON.stringify(last)}`);
};
const record = (name, detail = '') => { results.push({ name, result: 'PASS', detail }); console.log('PASS', name, detail); };
const status = () => sw.evaluate(id => chrome.tabs.sendMessage(id, { target: 'content', type: 'status' }), tabId);
const set = changes => sw.evaluate(async changes => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, ...changes } });
}, changes);
const expectState = async wanted => until(async () => { const s = await status().catch(() => null); return s?.state === wanted ? s : false; }, wanted);
const screenshot = name => page.screenshot({ path: `artifacts/${name}.png` });
const popupAction = async code => {
  await page.bringToFront(); popup = await openPopup(cdp, id, page.url()); await sleep(300);
  return popup.evaluate(code);
};
const bands = () => page.evaluate(() => {
  const root = document.querySelector('#eclirim-lighting')?.shadowRoot;
  return root ? Array.from(root.querySelectorAll('canvas')).map((c, i) => {
    const x = i < 2 ? Math.floor(c.width/2) : (i === 2 ? 1 : c.width-2);
    const y = i < 2 ? (i === 0 ? 1 : c.height-2) : Math.floor(c.height/2);
    return Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data);
  }) : [];
});
// The CSS path lights an edge only where it faces the picture, and clicking Lab buttons scrolls the page:
// the row to sample is the middle of whatever part of the video is on screen, not a fixed one.
const facingRow = async () => { const box = await page.locator('#player video').boundingBox(); return Math.round((Math.max(0, box.y) + Math.min(900, box.y + box.height)) / 2); };
function pixel(buffer, x, y) { const png = PNG.sync.read(buffer); const i = (Math.round(y) * png.width + Math.round(x)) * 4; return [...png.data.subarray(i, i + 3)]; }
try {
  sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); id = sw.url().split('/')[2];
  // The Chrome UI requires developer mode for unpacked reloads. The CLI can load
  // once without it, but runtime.reload then disables the unpacked extension.
  const extensionManager = await context.newPage(); await extensionManager.goto('chrome://extensions');
  if (!await extensionManager.locator('#devMode').evaluate(el => el.checked)) await extensionManager.locator('#devMode').click();
  await extensionManager.close();
  cdp = await context.browser().newBrowserCDPSession(); page = await context.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto('http://localhost:4173'); await page.locator('#play').waitFor();
  const before = await page.locator('video').evaluate(v => ({ muted: v.muted, volume: v.volume, playbackRate: v.playbackRate, style: v.getAttribute('style') }));
  await popupAction('document.querySelector("#start").click()');
  tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
  await expectState('Active'); await set({ zoneMode: 'manual', zoneCount: 64 });
  await until(async () => (await status()).zoneCount === 64, '64 zones');
  await sleep(1700);
  const colors = await bands(); assert.ok(colors[2][2] > colors[2][0] * 2); assert.ok(colors[3][0] > colors[3][2] * 2);
  // Light, not paint: every lit edge shows its hue at full strength, and brightness is carried by opacity alone.
  for (const c of colors) { assert.ok(Math.max(...c.slice(0, 3)) > 200, `full-strength hue ${c}`); assert.ok(c[3] > 40, `lit edge ${c}`); }
  assert.ok(colors[2][3] > 150 && colors[3][3] > 150, 'bright picture edges drive a bright strip');
  assert.equal(await page.locator('#eclirim-lighting').evaluate(el => getComputedStyle(el).pointerEvents), 'none');
  assert.deepEqual(await page.locator('video').evaluate(v => ({ muted: v.muted, volume: v.volume, playbackRate: v.playbackRate, style: v.getAttribute('style') })), before);
  await screenshot('01-direct-64-zones');
  const popupPNG = await popup.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile('artifacts/02-popup.png', Buffer.from(popupPNG.data, 'base64'));
  record('Production MV3 manifest, action grant, popup start, 64 local zones, pointer pass-through, unchanged video settings', { colors });
  await popup.close();

  for (const mode of ['vivid', 'ambient', 'cinema']) { await set({ mode }); await sleep(140); assert.equal(await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings.mode), mode); }
  await popupAction('document.querySelector("details").open = true');
  assert.equal(await popup.evaluate('document.querySelector("#zoneCount").value'), '64');
  await popup.close(); record('All modes and saved settings survive popup close/reopen');

  await page.locator('#fullscreen').click();
  await until(() => page.evaluate(() => document.fullscreenElement?.id === 'player' && document.querySelector('#eclirim-lighting')?.parentElement?.id === 'player'), 'container fullscreen');
  await screenshot('03-fullscreen');
  await page.locator('video').evaluate(v => v.pause()); await expectState('Paused'); await sleep(1500);
  assert.ok((await bands()).some(c => c[3] > 150), 'a paused picture keeps its light');
  await page.locator('video').evaluate(v => v.play()); await expectState('Active');
  await page.evaluate(() => document.exitFullscreen());
  await page.locator('#native-fullscreen').click(); await expectState('Fullscreen Unsupported');
  await page.evaluate(() => document.exitFullscreen()); await expectState('Active');
  record('Container fullscreen, light held while paused, resume, native video fullscreen limitation, exit restoration');

  await page.locator('[data-scene="dark"]').click();
  await until(async () => (await bands()).every(c => c[3] === 0), 'blackout fade', 6000);
  await page.locator('[data-scene="split"]').click(); await expectState('Active'); record('Blackout fades every zone to fully transparent, leaving the page untouched');
  await page.locator('[data-scene="file"]').click();
  await until(() => page.locator('video').evaluate(v => v.readyState >= 2 && !v.paused), 'file playback');
  await page.locator('video').evaluate(v => { v.currentTime = 8; }); await expectState('Active');
  await page.locator('video').evaluate(v => { v.currentTime = v.duration - .12; }); await expectState('Paused');
  await page.locator('#replace').click(); await expectState('Active'); record('Seek, ended, SPA history and video-element replacement');

  await page.evaluate(() => { const v = document.createElement('video'); v.id = 'secondary'; v.muted = true; v.style.cssText = 'position:fixed;right:30px;top:30px;width:100px;height:60px'; v.srcObject = document.querySelector('video').srcObject; document.body.append(v); v.play(); });
  await sleep(1800);
  const selected = await sw.evaluate(id => chrome.tabs.sendMessage(id, { target: 'content', type: 'context' }), tabId);
  assert.ok(selected.context.rect.width > 500); await page.locator('#secondary').evaluate(v => v.remove());
  for (const [width, height] of [[1280, 800], [1680, 720], [1280, 720]]) {
    await page.setViewportSize({ width, height }); await sleep(250);
    const rect = await page.locator('#eclirim-lighting').boundingBox(); assert.equal(rect.width, width); assert.equal(rect.height, height);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  record('Largest video selection; resize at 16:10, 21:9 and 16:9');
  await set({ zoneMode: 'auto' }); await sleep(400);
  const autoBefore = (await status()).zoneCount;
  await sw.evaluate(id => chrome.tabs.setZoom(id, 1.5), tabId); await sleep(700);
  assert.equal((await status()).zoneCount, autoBefore, 'Page zoom must not change monitor zone budget');
  await sw.evaluate(id => chrome.tabs.setZoom(id, 1), tabId);
  const emulation = await context.newCDPSession(page);
  await emulation.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false, screenWidth: 1920, screenHeight: 1080 });
  await until(async () => (await status()).zoneCount === 128, 'Retina / 4K auto zone count');
  await emulation.send('Emulation.clearDeviceMetricsOverride'); await page.setViewportSize({ width: 1280, height: 900 });
  await set({ zoneMode: 'manual', zoneCount: 64 }); record('Automatic monitor zones change to 128 at 4K estimate; browser zoom excluded');

  await page.locator('[data-scene="cors"]').click();
  await page.locator('video').evaluate(v => { v.loop = true; });
  await expectState('Capture Required'); record('Cross-origin readback is reported without mislabeling DRM');
  await popupAction('document.querySelector("#capture").click()');
  const captureStatus = await until(async () => { const s = await status(); return s.source === 'capture' && s.state === 'Active' ? s : false; }, 'real tabCapture');
  const offscreen = await sw.evaluate(() => chrome.runtime.sendMessage({ target: 'offscreen', type: 'status' }));
  assert.equal(offscreen.audioTracks, 0); assert.equal(offscreen.active, true);
  await popup.close(); await screenshot('04-tab-capture'); record('Real getMediaStreamId + Offscreen video-only capture', { captureStatus, offscreen });
  const other = await context.newPage(); await other.goto('about:blank');
  await until(async () => (await sw.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }))).length === 0, 'capture resources released');
  await other.close(); await page.bringToFront(); record('Tab switching releases stream and closes Offscreen document');

  // CSS-only path is tested against a CORS-tainted video. Screenshot readback is QA only.
  await set({ source: 'compatibility', mode: 'vivid', brightness: 90 });
  await page.locator('video').evaluate(v => { v.pause(); v.currentTime = 2; });
  await page.locator('video').evaluate(v => v.play()); await expectState('Compatibility Mode');
  await page.locator('video').evaluate(v => { v.pause(); });
  // Slow playback keeps one frame on screen long enough to compare screenshots with and without the layer.
  await page.locator('video').evaluate(v => { v.playbackRate = .0625; v.play(); });
  await expectState('Compatibility Mode'); await sleep(900);
  assert.equal(await page.locator('#eclirim-lighting').count(), 0);
  const hasReadbackError = await page.locator('video').evaluate(v => { const c = document.createElement('canvas'); c.width = 8; c.height = 8; const ctx = c.getContext('2d'); ctx.drawImage(v, 0, 0, 8, 8); try { ctx.getImageData(0, 0, 1, 1); return false; } catch (e) { return e.name === 'SecurityError'; } });
  assert.ok(hasReadbackError);
  const withCSS = await screenshot('05-compatibility-cors');
  await page.locator('#eclirim-compatibility').evaluate(el => { el.style.setProperty('display', 'none', 'important'); });
  const withoutCSS = await page.screenshot();
  const delta = [10, 400, 890].map(y => pixel(withCSS, 4, y).map((v, i) => v - pixel(withoutCSS, 4, y)[i]));
  assert.ok(delta.some(rgb => rgb.some(v => v > 2)), 'CSS compositor contributes color at outer edge');
  await page.locator('#eclirim-compatibility').evaluate(el => { el.style.setProperty('display', 'block', 'important'); });
  record('CSS-only compatibility colors viewport edge despite Canvas SecurityError; no analysis canvas', { edgeDelta: delta });

  // Streaming films carry their black bars inside the picture, where the CSS path cannot detect them (no pixel is read).
  // The light must still reach all four screen edges, in the right colours, and leave the picture itself alone.
  await page.locator('[data-scene="bars"]').click(); await page.locator('#fullscreen').click();
  await until(() => page.evaluate(() => document.fullscreenElement?.id === 'player' && document.querySelector('#eclirim-compatibility')?.parentElement?.id === 'player'), 'compatibility layer follows fullscreen');
  await expectState('Compatibility Mode'); await sleep(1500);
  const barsLit = await page.screenshot();
  await page.locator('#eclirim-compatibility').evaluate(el => el.style.setProperty('display', 'none', 'important'));
  const barsPlain = await page.screenshot();
  await page.locator('#eclirim-compatibility').evaluate(el => el.style.setProperty('display', 'block', 'important'));
  const at = (x, y) => ({ lit: pixel(barsLit, x, y), plain: pixel(barsPlain, x, y) });
  const letterbox = { topLeft: at(320, 2), topRight: at(960, 2), bottomLeft: at(320, 897), bottomRight: at(960, 897), left: at(2, 450), right: at(1277, 450), corner: at(3, 3), centre: at(640, 450) };
  for (const name of ['topLeft', 'topRight', 'bottomLeft', 'bottomRight', 'corner']) {
    assert.ok(Math.max(...letterbox[name].plain) < 8, `${name} sits in a black bar`);
    assert.ok(Math.max(...letterbox[name].lit) > 60, `${name} is lit across the bar: ${letterbox[name].lit}`);
  }
  assert.ok(letterbox.topLeft.lit[2] > letterbox.topLeft.lit[0] * 2 && letterbox.left.lit[2] > letterbox.left.lit[0] * 2, 'blue stays on the left');
  assert.ok(letterbox.topRight.lit[0] > letterbox.topRight.lit[2] * 2 && letterbox.right.lit[0] > letterbox.right.lit[2] * 2, 'orange stays on the right');
  assert.deepEqual(letterbox.centre.lit, letterbox.centre.plain, 'the picture itself is untouched');
  await page.evaluate(() => document.exitFullscreen());
  record('CSS-only compatibility lights all four edges across letterbox bars baked into the picture, colours in place, picture untouched', letterbox);

  await page.locator('video').evaluate(v => { v.playbackRate = 1; });
  await page.locator('#eme-test').click();
  await until(() => page.locator('#player video').evaluate(v => v.mediaKeys && v.currentTime > .1), 'ClearKey EME playback', 15000);
  await set({ source: 'video' });
  // Chrome on macOS keeps protected video in a layer no page effect can see (confirmed on a real display with Widevine).
  // There the extension must not claim anything: it says so and stays dark, unless the user chose a fixed light for this case.
  // NOTE: screenshots taken here cannot show that limit. Capturing makes Chrome composite differently than it does on screen.
  const onMac = await page.evaluate(() => /mac/i.test(navigator.userAgentData?.platform || navigator.platform));
  if (onMac) {
    const honest = await until(async () => { const v = await status().catch(() => null); return v?.state === 'Protected Content' && v.source === 'none' ? v : false; }, 'protected video on macOS is reported, with no light by default');
    assert.match(honest.detail, /色を取り出せません/); assert.match(honest.detail, /照明は表示していません/);
    assert.equal(await page.locator('#eclirim-compatibility').count(), 0); assert.equal(await page.locator('#eclirim-lighting').count(), 1);
    await until(async () => { const c = await bands(); return c.length === 4 && c.every(v => v[3] === 0); }, 'no light by default');
    assert.equal(await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings.source), 'video', 'the saved choice is not rewritten');
    const told = await popupAction(`(async () => { for (let i = 0; i < 30 && document.querySelector('#state').textContent !== 'Protected Content'; i++) await new Promise(r => setTimeout(r, 100)); return { state: document.querySelector('#state').textContent, note: document.querySelector('#source-note').textContent, light: document.querySelector('#protectedLight').value, first: document.querySelector('#protectedLight').options[0].value, capture: document.querySelector('#capture').hidden, limiter: document.querySelector('#flashLimiter').disabled, preset: !document.querySelector('#preset-row').hidden }; })()`);
    assert.deepEqual({ ...told, note: /色を取り出せません/.test(told.note) }, { state: 'Protected Content', note: true, light: 'off', first: 'off', capture: true, limiter: true, preset: false });
    await popup.close();
    await set({ protectedLight: 'preset' });
    const chosen = await until(async () => { const v = await status(); return v.source === 'fallback' && /映像には連動しません/.test(v.detail) ? v : false; }, 'a fixed light the user chose is reported as fixed');
    const fixed = await until(async () => { const c = await bands(); return c.length === 4 && c.every(v => v[3] > 150) ? c : false; }, 'the chosen fixed light is on');
    for (const c of fixed) assert.ok(c[0] > c[1] && c[1] > c[2], `the Cinema preset, not the picture: ${c}`);
    await set({ protectedLight: 'off' });
    await until(async () => (await status()).source === 'none' && (await bands()).every(c => c[3] === 0), 'and it can be switched off again');
    record('macOS: protected video gets an honest status and no light by default; a fixed light shows only when the user chooses one, and nothing claims to follow the picture', { state: honest.state, detail: honest.detail, chosen: chosen.detail, fixed, popup: told });
  }
  // Elsewhere the encrypted stream alone moves "follow the video" to the CSS path. On a Mac that platform is emulated here.
  const elsewhere = onMac ? await context.newCDPSession(page) : null;
  if (elsewhere) await elsewhere.send('Emulation.setUserAgentOverride', { userAgent: await page.evaluate(() => navigator.userAgent), platform: 'Win32',
    userAgentMetadata: { platform: 'Windows', platformVersion: '15.0.0', architecture: 'x86', model: '', mobile: false } });
  const switched = await until(async () => { const s = await status().catch(() => null); return s?.source === 'compatibility' && /自動/.test(s.detail) ? s : false; }, 'automatic compatibility on encrypted media');
  assert.equal(switched.state, 'Compatibility Mode');
  assert.equal(await page.locator('#eclirim-compatibility').count(), 1); assert.equal(await page.locator('#eclirim-lighting').count(), 0);
  assert.equal(await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings.source), 'video', 'the saved choice is not rewritten');
  await sleep(900);
  const autoCSS = await page.screenshot();
  await page.locator('#eclirim-compatibility').evaluate(el => el.style.setProperty('display', 'none', 'important'));
  const autoPlain = await page.screenshot();
  await page.locator('#eclirim-compatibility').evaluate(el => el.style.setProperty('display', 'block', 'important'));
  const autoRow = await facingRow(), autoEdgeDelta = pixel(autoCSS, 4, autoRow).map((v, i) => v - pixel(autoPlain, 4, autoRow)[i]);
  assert.ok(autoEdgeDelta.some(v => v > 2), 'the automatic path visibly lights the outer perimeter');
  const rejected = await popupAction('(async () => { const [t] = await chrome.tabs.query({active:true,currentWindow:true}); return chrome.runtime.sendMessage({target:"background",type:"capture",tabId:t.id}); })()');
  assert.equal(rejected.ok, false); assert.match(rejected.error, /暗号化動画/);
  const shown = await popup.evaluate('new Promise(done => { const read = () => ({ select: document.querySelector("#source").value, note: document.querySelector("#source-note").textContent, state: document.querySelector("#state").textContent, capture: document.querySelector("#capture").hidden, limiter: document.querySelector("#flashLimiter").disabled }); const end = Date.now() + 3000; const poll = () => { const v = read(); /自動/.test(v.note) || Date.now() > end ? done(v) : setTimeout(poll, 100); }; poll(); })');
  assert.equal(shown.select, 'video'); assert.match(shown.note, /自動でDRM互換描画/); assert.equal(shown.state, 'Compatibility Mode');
  assert.equal(shown.capture, true, 'tab capture is not offered'); assert.equal(shown.limiter, true, 'analysis-only controls are locked');
  assert.equal((await sw.evaluate(() => chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}))).length, 0);
  await popup.close(); record('Off macOS (emulated here): encrypted media switches "follow the video" to CSS compatibility by itself; popup says so; capture is rejected before stream creation', { state: switched.state, detail: switched.detail, autoEdgeDelta, popup: shown });
  await set({ source: 'compatibility' }); await expectState('Compatibility Mode');
  await sleep(900);
  const encryptedCSS = await screenshot('06-compatibility-eme-clearkey');
  await page.locator('#eclirim-compatibility').evaluate(el => el.style.setProperty('display', 'none', 'important'));
  const encryptedPlain = await page.screenshot();
  const emeRow = await facingRow(), emeEdgeDelta = pixel(encryptedCSS, 4, emeRow).map((v, i) => v - pixel(encryptedPlain, 4, emeRow)[i]);
  assert.ok(emeEdgeDelta.some(v => v > 2), 'EME compositor visibly colors outer perimeter');
  await page.locator('#eclirim-compatibility').evaluate(el => el.style.setProperty('display', 'block', 'important'));
  await page.locator('#fullscreen').click(); await sleep(1300); await screenshot('06-compatibility-eme-clearkey');
  const eme = await page.locator('#player video').evaluate(v => ({ hasMediaKeys: !!v.mediaKeys, time: v.currentTime, width: v.videoWidth, error: v.error?.message || null }));
  assert.equal(eme.error, null); assert.ok(eme.time > .1); await page.evaluate(() => document.exitFullscreen());
  record('Standard EME ClearKey owned fixture, CSS compatibility on a platform that composites protected video (not Widevine; pipeline only, not an on-screen check)', { ...eme, emeEdgeDelta });
  if (elsewhere) await elsewhere.detach();

  // Netflix and Prime Video are recognised by host, so even this unencrypted Lab video must get the CSS path there.
  await set({ source: 'video' });
  for (const [host, service] of [['www.netflix.com', 'Netflix'], ['www.primevideo.com', 'Prime Video']]) {
    const streaming = await context.newPage(); await streaming.goto(`http://${host}:4173/`); await streaming.locator('#play').waitFor();
    await streaming.bringToFront(); popup = await openPopup(cdp, id, streaming.url()); await sleep(300);
    await popup.evaluate('document.querySelector("#start").click()');
    const streamingTab = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
    const s = await until(async () => {
      const v = await sw.evaluate(id => chrome.tabs.sendMessage(id, { target: 'content', type: 'status' }), streamingTab).catch(() => null);
      return v?.source === 'compatibility' ? v : false;
    }, `${service} automatic compatibility`);
    assert.equal(s.service, service); assert.equal(s.state, 'Compatibility Mode'); assert.match(s.detail, /自動でDRM互換描画/);
    assert.equal(await streaming.locator('video').evaluate(v => !!v.mediaKeys), false, 'chosen by host, not by detected encryption');
    assert.equal(await streaming.locator('#eclirim-compatibility').count(), 1); assert.equal(await streaming.locator('#eclirim-lighting').count(), 0);
    assert.equal(await popup.evaluate('document.querySelector("#capture").hidden'), true);
    await popup.close(); await streaming.close();
  }
  assert.equal(await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings.source), 'video');
  await page.bringToFront();
  record('Netflix and Prime Video hosts (resolved to the local Lab inside the test browser) use CSS compatibility with no manual choice');

  await page.reload(); await popupAction('document.querySelector("#start").click()'); await popup.close();
  await set({ source: 'video', mode: 'cinema', brightness: 65, zoneMode: 'manual', zoneCount: 64 });
  await expectState('Active');
  const perf = await context.newCDPSession(page); await perf.send('Performance.enable');
  const first = (await perf.send('Performance.getMetrics')).metrics;
  const durationSeconds = Number(process.env.SOAK_SECONDS || 20);
  for (let i = 0; i < durationSeconds; i++) {
    performanceSamples.push(await status()); await sleep(1000);
    if (i && i % 60 === 0) console.log(`SOAK ${i}/${durationSeconds}s`);
  }
  const last = (await perf.send('Performance.getMetrics')).metrics;
  const value = (a, name) => a.find(m => m.name === name)?.value;
  const measurements = { durationSeconds, lastStatus: await status(), sampleMeanMs: performanceSamples.reduce((n, s) => n + s.sampleMs, 0) / performanceSamples.length,
    rendererTaskSeconds: value(last, 'TaskDuration') - value(first, 'TaskDuration'), heapStartBytes: value(first, 'JSHeapUsedSize'), heapEndBytes: value(last, 'JSHeapUsedSize'),
    note: 'Includes synthetic video generation, page script and extension; not whole-system/GPU CPU. Does not establish hours-long stability.' };
  record(`Measured ${durationSeconds}-second direct-analysis run`, measurements);

  // "Always light this site" is offered for the page's own host and asks Chrome for exactly that host, nothing wider.
  // Chrome's permission dialog cannot be driven from a test, so the request is observed and declined here.
  const always = await popupAction(`(async () => {
    for (let i = 0; i < 40 && document.querySelector('#always-row').hidden; i++) await new Promise(r => setTimeout(r, 50));
    const box = document.querySelector('#always'), before = { shown: !document.querySelector('#always-row').hidden, site: document.querySelector('#always-site').textContent, checked: box.checked };
    let asked = null; chrome.permissions.request = async p => { asked = p; return false; };
    box.click(); await new Promise(r => setTimeout(r, 400));
    return { before, asked, checked: box.checked, note: document.querySelector('#always-note').textContent };
  })()`);
  assert.equal(always.before.shown, true); assert.match(always.before.site, /^localhost · /); assert.equal(always.before.checked, false);
  assert.deepEqual(always.asked, { origins: ['http://localhost/*'] }); assert.equal(always.checked, false); assert.match(always.note, /許可が得られなかった/);
  assert.deepEqual(await sw.evaluate(async () => (await chrome.permissions.getAll()).origins), [], 'no site access unless the user grants it');
  await popup.close(); record('"Always light this site" asks Chrome for the page host only; a declined request leaves it off', always);

  // Chrome keeps the activeTab grant while the tab stays on this site, so lighting returns without a click.
  const lit = () => sw.evaluate(async () => (await chrome.storage.session.get('litTabs')).litTabs || []);
  const arrive = async url => { await (url ? page.goto(url) : page.reload()); await page.locator('#play').waitFor(); };
  await arrive(); await expectState('Active');
  await arrive('http://localhost:4173/?page=2'); await expectState('Active');
  await arrive('http://localhost:4173/index.html'); await expectState('Active');
  await page.goBack(); await page.locator('#play').waitFor(); await expectState('Active');
  assert.equal(await page.locator('#eclirim-lighting').count(), 1); assert.deepEqual(await lit(), [tabId]);
  // Tab capture needs the user's own click every time: a reload brings back lighting only.
  await page.locator('[data-scene="cors"]').click(); await page.locator('video').evaluate(v => { v.loop = true; }); await expectState('Capture Required');
  await popupAction('document.querySelector("#capture").click()');
  await until(async () => { const s = await status(); return s.source === 'capture' && s.state === 'Active'; }, 'capture before reload'); await popup.close();
  await arrive(); await expectState('Active');
  assert.equal((await status()).source, 'direct');
  assert.equal((await sw.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }))).length, 0, 'capture is not restarted');
  // Another site: Chrome withdraws the grant, so the tab waits for the user again, also after coming back.
  await arrive('http://127.0.0.1:4173/'); await until(async () => (await lit()).length === 0, 'forgotten after leaving the site');
  assert.equal(await page.locator('#eclirim-lighting').count(), 0);
  await arrive('http://localhost:4173/'); await sleep(1500);
  assert.equal(await page.locator('#eclirim-lighting').count(), 0);
  await popupAction('document.querySelector("#start").click()'); await expectState('Active'); await popup.close();
  record('Reload, same-site navigation and back relight with no click; capture is not restarted; another site needs a new click');

  await set({ enabled: false }); await until(async () => await page.locator('#eclirim-lighting').count() === 0, 'off removes overlay');
  await expectState('Disabled');
  // Off stays off: a reload must not bring the light, or even the content script, back.
  await arrive(); await sleep(1500);
  assert.equal(await page.locator('#eclirim-lighting').count(), 0); assert.equal(await status().catch(() => null), null);
  await popupAction('document.querySelector("#start").click()'); await expectState('Active'); await popup.close();
  assert.equal(await page.locator('#eclirim-lighting').count(), 1); record('Enable OFF/ON cleans and restores a single overlay; OFF survives a reload');
  const oldWorker = sw;
  await sw.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 100); });
  await sleep(600);
  await popupAction('document.querySelector("#start").click()');
  sw = await until(() => context.serviceWorkers().find(w => w !== oldWorker && w.url().includes(id)), 'reloaded service worker');
  await expectState('Active'); await popup.close();
  await until(async () => await page.locator('#eclirim-lighting').count() === 1, 'single overlay after extension reload');
  record('Extension reload recovers without duplicate overlay or stale content instance');

  // A site the user approved holds a host permission. The dialog itself cannot be automated, so a throwaway copy of
  // this build with localhost already granted stands in for it. Everything else is the production build.
  const copy = await mkdtemp(join(tmpdir(), 'eclirim-granted-'));
  await cp('dist', copy, { recursive: true });
  const built = { ...JSON.parse(await readFile('dist/manifest.json', 'utf8')), host_permissions: ['http://localhost/*'] };
  await writeFile(join(copy, 'manifest.json'), JSON.stringify({ ...built, version: '0.7.0' }));
  const granted = await chromium.launchPersistentContext('', await quiet({
    channel: 'chromium', headless: process.env.HEADED !== '1', viewport: { width: 1280, height: 900 },
    args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${copy}`, `--load-extension=${copy}`]
  }));
  try {
    const worker = granted.serviceWorkers()[0] || await granted.waitForEvent('serviceworker');
    const open = async url => { const tab = await granted.newPage(); tab.on('pageerror', e => errors.push(String(e))); await tab.goto(url); await tab.locator('#play').waitFor(); await tab.bringToFront(); return tab; };
    const layer = tab => tab.locator('#eclirim-lighting').count();
    const first = await open('http://localhost:4173/');
    await until(async () => await layer(first) === 1, 'a new tab on an approved site lights with no click');
    const grantedCDP = await granted.browser().newBrowserCDPSession();
    popup = await openPopup(grantedCDP, worker.url().split('/')[2], first.url());
    const shown = await popup.evaluate(`(async () => { for (let i = 0; i < 40 && document.querySelector('#state').textContent !== 'Active'; i++) await new Promise(r => setTimeout(r, 100)); return { always: document.querySelector('#always').checked, state: document.querySelector('#state').textContent }; })()`);
    assert.deepEqual(shown, { always: true, state: 'Active' }); await popup.close();
    const second = await open('http://localhost:4173/?tab=2');
    await until(async () => await layer(second) === 1, 'every further tab on that site lights too');
    await second.goto('http://localhost:4173/?tab=2&page=2'); await second.locator('#play').waitFor();
    await until(async () => await layer(second) === 1, 'and stays lit across navigation');
    const elsewhere = await open('http://127.0.0.1:4173/'); await sleep(2000);
    assert.equal(await layer(elsewhere), 0, 'a site that was not approved is left alone');
    await worker.evaluate(async () => { const { settings = {} } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, enabled: false } }); });
    const off = await open('http://localhost:4173/?off=1'); await sleep(2000);
    assert.equal(await layer(off), 0, 'lighting switched off stays off on approved sites');
    assert.equal(await layer(first), 0);
    // Back on: the tabs already open on the approved site light again with no reload (the path a fresh grant also takes).
    await worker.evaluate(async () => { const { settings = {} } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, enabled: true } }); });
    await off.bringToFront(); await until(async () => await layer(off) === 1 && await layer(first) === 1 && await layer(second) === 1, 'open tabs relight when lighting is switched back on');
    assert.equal(await layer(elsewhere), 0);
    assert.equal((await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }))).length, 0, 'approved sites never start tab capture');
    record('Approved site (build copy with localhost pre-granted): new tabs light with no click, other sites do not, OFF stays off and ON relights open tabs, no capture');
    // Updating from 0.7.0: its default for protected video (Cinema preset) follows the new default, a light the user picked does not.
    const manager = await granted.newPage(); await manager.goto('chrome://extensions');
    if (!await manager.locator('#devMode').evaluate(el => el.checked)) await manager.locator('#devMode').click();
    await manager.close();
    const update = async (protectedLight, to) => {
      const old = granted.serviceWorkers().find(w => w.url().includes(worker.url().split('/')[2]));
      await old.evaluate(async protectedLight => { const { settings = {} } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, protectedLight } }); }, protectedLight);
      await writeFile(join(copy, 'manifest.json'), JSON.stringify({ ...built, version: to }));
      await old.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 100); });
      const next = await until(() => granted.serviceWorkers().find(w => w !== old && w.url().includes(worker.url().split('/')[2])), 'updated service worker');
      await until(() => next.evaluate(() => chrome.runtime.getManifest().version).then(v => v === to, () => false), `running ${to}`);
      await sleep(1500);
      return next.evaluate(async () => (await chrome.storage.local.get('settings')).settings.protectedLight);
    };
    assert.equal(await update('preset', built.version), 'off', 'the old default follows the new one');
    await writeFile(join(copy, 'manifest.json'), JSON.stringify({ ...built, version: '0.7.0' }));
    assert.equal(await update('drift', '0.7.0'), 'drift');
    assert.equal(await update('drift', built.version), 'drift', 'a light the user picked is kept');
    assert.equal(await update('preset', `${built.version}.1`), 'preset', 'and only the step from 0.7.0 changes anything');
    record('Update from 0.7.0: the saved default for protected video becomes "no light"; a chosen light, and later updates, are left alone');
  } finally { await granted.close(); await rm(copy, { recursive: true, force: true }); }
  assert.equal(errors.length, 0, errors.join('\n'));
} catch (e) {
  results.push({ name: 'Failure', result: 'FAIL', detail: String(e.stack || e) }); console.error(e);
  if (popup) console.error('Popup diagnostic:', await popup.evaluate('document.body.innerText').catch(() => 'closed'));
  if (page) await page.screenshot({ path: 'artifacts/failure.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile('artifacts/e2e-results.json', JSON.stringify({ date: '2026-10-09', browser: context.browser()?.version(), platform: process.platform, results, errors }, null, 2));
  await context.close(); await server.close();
}
