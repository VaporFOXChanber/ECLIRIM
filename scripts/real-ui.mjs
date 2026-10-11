// UI Guard and Adaptive Brightness on a real site: plays a public video page in the test browser and reports what the guard
// finds under the light, what looking for it costs, and how opaque the light is over the page's own controls with the
// guard on and off. Needs the network, so it is not part of `npm run test:e2e`. Nothing is logged in, saved or sent.
//   node scripts/real-ui.mjs "https://www.youtube.com/watch?v=aqz-KE-bpKQ" [folder for screenshots]
// The figures are measured in a headless test browser. They say what the extension painted, not how it looks.
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { openPopup } from './cdp-popup.mjs';
import { quiet } from './browser.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const url = process.argv[2], shots = process.argv[3];
if (!url) { console.error('usage: node scripts/real-ui.mjs <video page URL> [folder for screenshots]'); process.exit(2); }
const context = await chromium.launchPersistentContext('', await quiet({ channel: 'chromium', headless: process.env.HEADED !== '1', viewport: { width: 1440, height: 900 },
  args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'] }));
// A page that never finishes loading must not leave a browser running.
const watchdog = setTimeout(() => { console.error('gave up after 4 minutes'); context.close().finally(() => process.exit(3)); }, 240000);
try {
  let sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); const id = sw.url().split('/')[2];
  const cdp = await context.browser().newBrowserCDPSession(), page = await context.newPage();
  const set = changes => sw.evaluate(async changes => { const { settings = {} } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, ...changes } }); }, changes);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.locator('video').first().waitFor({ state: 'attached', timeout: 30000 });
  for (let i = 0; i < 60; i++) { if (await page.evaluate(() => { const v = document.querySelector('video'); return !!v && !document.querySelector('.ad-showing') && v.readyState >= 3 && v.currentTime > 1; }).catch(() => false)) break; await sleep(500); }
  const popup = await openPopup(cdp, id, page.url()); await sleep(400);
  await popup.evaluate('document.querySelector("#start").click()'); await sleep(1500);
  // A slow page load can outlast the extension's service worker: opening the popup has started it again, possibly as a new one.
  sw = context.serviceWorkers().find(w => w.url().includes(id)) || await context.waitForEvent('serviceworker');
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id); await popup.close();
  const status = () => sw.evaluate(id => chrome.tabs.sendMessage(id, { target: 'content', type: 'status' }), tabId).catch(() => null);
  const alphaAt = (x, y) => page.evaluate(([x, y]) => {
    const root = document.querySelector('#eclirim-lighting')?.shadowRoot; let best = 0;
    for (const c of root ? root.querySelectorAll('canvas') : []) { const r = c.getBoundingClientRect(); if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) continue;
      best = Math.max(best, c.getContext('2d').getImageData(Math.floor((x - r.left) / r.width * c.width), Math.floor((y - r.top) / r.height * c.height), 1, 1).data[3]); }
    return best;
  }, [x, y]);
  const centre = selector => page.evaluate(selector => { const el = document.querySelector(selector), r = el?.getBoundingClientRect(); return r && r.width ? [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] : null; }, selector);
  const watch = async (label, seconds = 6) => {
    const seen = [];
    for (let i = 0; i < seconds * 2; i++) { const s = await status(); if (s?.guard) seen.push(s); await sleep(500); }
    const last = seen.at(-1), mean = values => values.reduce((n, v) => n + v, 0) / Math.max(1, values.length), of = pick => seen.map(pick);
    console.log(`${label}: ${last?.state} · guard ${last?.guard.state}, found ${Math.max(...of(s => s.guard.regions))}, held back ${Math.max(...of(s => s.guard.held))}, one tick ${mean(of(s => s.guard.ms)).toFixed(2)} ms on average, ${Math.max(...of(s => s.guard.ms)).toFixed(2)} ms at most (every 110 ms)` +
      ` · adaptive ${last?.exposure?.state}, key ${Math.min(...of(s => s.exposure.key)).toFixed(2)}–${Math.max(...of(s => s.exposure.key)).toFixed(2)}, level ×${Math.min(...of(s => s.exposure.level)).toFixed(2)}–${Math.max(...of(s => s.exposure.level)).toFixed(2)}` +
      ` · analysis ${mean(of(s => s.perf.analysisMs)).toFixed(2)} ms at ${mean(of(s => s.perf.analysisFps)).toFixed(1)} fps, render ${mean(of(s => s.perf.renderMs)).toFixed(2)} ms at ${mean(of(s => s.perf.renderFps)).toFixed(1)} fps, quality ${Math.max(...of(s => s.perf.quality))}, over budget ${last?.perf.overBudget}, skipped ${last?.perf.skippedRender}`);
    return last;
  };
  // On one paused frame, so the two readings differ by the guard alone.
  const compare = async (label, points) => {
    const read = async () => Object.fromEntries(await Promise.all(Object.entries(points).filter(([, p]) => p).map(async ([name, [x, y]]) => [name, await alphaAt(x, y)])));
    await page.evaluate(() => document.querySelector('video').pause());
    await set({ guard: { enabled: false, strength: 60, pointer: true } }); await sleep(3500); const off = await read();
    await set({ guard: { enabled: true, strength: 60, pointer: true } }); await sleep(3500); const on = await read();
    await page.evaluate(() => { void document.querySelector('video').play().catch(() => {}); });
    console.log(`${label}: opacity of the light (0–255), guard off → on: ${Object.keys(off).map(name => `${name} ${off[name]} → ${on[name]}`).join(' · ')}   (limit ${Math.round(.312 * 255)})`);
  };
  await set({ zoneMode: 'manual', zoneCount: 64 }); await sleep(3000);
  // A video site may stop playback in an automated browser after a while, so every part starts on a freshly loaded page.
  // The tab stays lit across the reload: it is the same site.
  const fresh = async () => {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    for (let i = 0; i < 60; i++) { if (await page.evaluate(() => { const v = document.querySelector('video'); return !!v && !document.querySelector('.ad-showing') && v.readyState >= 3 && v.currentTime > 1 && !v.paused; }).catch(() => false)) break; await sleep(500); }
    for (let i = 0; i < 30; i++) { if ((await status())?.state === 'Active') break; await sleep(400); }
    await page.mouse.move(700, 500); await sleep(2500);
  };
  // The same ten seconds with the guard off, to see what it adds.
  await set({ guard: { enabled: false, strength: 60, pointer: true } }); await fresh(); await watch('watch page, UI Guard off', 10);
  await set({ guard: { enabled: true, strength: 60, pointer: true } }); await fresh(); await watch('watch page, UI Guard on, page left alone', 10);
  await fresh();
  { const end = Date.now() + 10000; let i = 0; const moving = (async () => { while (Date.now() < end) { await page.mouse.move(300 + (i++ % 40) * 20, 20 + (i % 7) * 8); await sleep(80); } })(); await watch('watch page, UI Guard on, pointer moving along the top', 10); await moving; }
  await fresh();
  // The watch page as it loads: the site's own header runs along the top edge.
  await page.mouse.move(700, 500);
  await watch('watch page, default look');
  const header = { logo: await centre('ytd-masthead a#logo, a#logo'), search: await centre('ytd-masthead input, input#search, input[name="search_query"]'), emptyTop: [1000, 28] };
  await compare('watch page, default look', header);
  if (shots) await page.screenshot({ path: `${shots}/real-ui-default.png` });
  await set({ mode: 'vivid', brightness: 100, glowWidth: 18, intensity: 100, saturation: 150 }); await fresh();
  await watch('watch page, Overkill values');
  await compare('watch page, Overkill values', header);
  if (shots) await page.screenshot({ path: `${shots}/real-ui-overkill.png` });
  // The player's own controls: shown while the pointer moves over the player, hidden again by the player after a few seconds.
  await fresh();
  const player = await centre('#movie_player, .html5-video-player');
  if (player) {
    for (let i = 0; i < 8; i++) { await page.mouse.move(player[0] + i * 6, player[1] + 120 + i * 3); await sleep(120); }
    const controls = { play: await centre('.ytp-play-button'), time: await centre('.ytp-time-display'), settings: await centre('.ytp-settings-button') };
    console.log('player controls at', JSON.stringify(controls));
  }
  await page.keyboard.press('f'); await sleep(2500);
  const full = await page.evaluate(() => !!document.fullscreenElement);
  console.log('fullscreen:', full);
  if (full) {
    for (let i = 0; i < 10; i++) { await page.mouse.move(600 + i * 8, 700 + i * 4); await sleep(120); }
    const shown = await status(), controls = { play: await centre('.ytp-play-button'), progress: await centre('.ytp-progress-bar'), time: await centre('.ytp-time-display'), fullscreenButton: await centre('.ytp-fullscreen-button'), title: await centre('.ytp-title-link') };
    console.log(`fullscreen, controls showing: guard found ${shown?.guard.regions}, held back ${shown?.guard.held}; controls at ${JSON.stringify(controls)}`);
    const keepMoving = async ms => { const end = Date.now() + ms; let i = 0; while (Date.now() < end) { await page.mouse.move(600 + (i++ % 10) * 8, 700 + (i % 10) * 4); await sleep(150); } };
    const read = async () => Object.fromEntries(await Promise.all(Object.entries(controls).filter(([, p]) => p).map(async ([name, [x, y]]) => [name, await alphaAt(x, y)])));
    await set({ guard: { enabled: false, strength: 60, pointer: false } }); await keepMoving(2500); const off = await read();
    await set({ guard: { enabled: true, strength: 60, pointer: false } }); await keepMoving(3000); const on = await read(), during = await status();
    if (shots) await page.screenshot({ path: `${shots}/real-ui-fullscreen.png` });
    console.log(`fullscreen, Overkill values, pointer option off: guard off → on: ${Object.keys(off).map(name => `${name} ${off[name]} → ${on[name]}`).join(' · ')}   (found ${during?.guard.regions}, held ${during?.guard.held}, one look ${during?.guard.ms.toFixed(2)} ms)`);
    await page.mouse.move(720, 300); await sleep(6000);
    const hidden = await status(), after = await read();
    console.log(`fullscreen, 6 s after the pointer stopped: controls ${await page.evaluate(() => document.querySelector('.html5-video-player')?.classList.contains('ytp-autohide') ? 'hidden by the player' : 'still showing')}, guard found ${hidden?.guard.regions}, held ${hidden?.guard.held}; ${Object.keys(after).map(name => `${name} ${after[name]}`).join(' · ')}`);
    if (shots) await page.screenshot({ path: `${shots}/real-ui-fullscreen-hidden.png` });
  }
} finally { clearTimeout(watchdog); await context.close(); }
