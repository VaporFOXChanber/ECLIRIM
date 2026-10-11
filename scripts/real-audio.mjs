// Pulse Engine on a real site: plays a public video in the test browser and reports what the extension hears, and whether
// the video keeps playing as before. Needs the network, so it is not part of `npm run test:e2e`. Nothing is logged in,
// saved or sent, and the test browser's own sound output is muted (the extension still gets its copy of the sound).
//   node scripts/real-audio.mjs "https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=60s"
// Keep it short: after roughly 40 seconds YouTube stops playback in an automated browser by itself, Pulse Engine or not.
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { openPopup } from './cdp-popup.mjs';
import { quiet } from './browser.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const url = process.argv[2];
if (!url) { console.error('usage: node scripts/real-audio.mjs <video page URL>'); process.exit(2); }
const context = await chromium.launchPersistentContext('', await quiet({ channel: 'chromium', headless: process.env.HEADED !== '1', viewport: { width: 1440, height: 900 },
  args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'] }));
try {
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), id = sw.url().split('/')[2];
  const cdp = await context.browser().newBrowserCDPSession(), page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.locator('video').first().waitFor({ state: 'attached', timeout: 30000 }); await sleep(4000);
  const player = () => page.evaluate(() => { const v = document.querySelector('video'), q = v.getVideoPlaybackQuality(); return { paused: v.paused, muted: v.muted, volume: +v.volume.toFixed(2), rate: v.playbackRate, time: v.currentTime, frames: q.totalVideoFrames, dropped: q.droppedVideoFrames }; });
  const popup = await openPopup(cdp, id, page.url()); await sleep(400);
  await popup.evaluate('document.querySelector("#start").click()'); await sleep(1500);
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id); await popup.close();
  const status = () => sw.evaluate(id => chrome.tabs.sendMessage(id, { target: 'content', type: 'status' }), tabId);
  const set = changes => sw.evaluate(async changes => { const { settings = {} } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, ...changes } }); }, changes);
  const mean = values => values.length ? values.reduce((n, v) => n + v, 0) / values.length : 0;
  for (const on of [false, true, false]) {
    await set({ pulse: { enabled: on, depth: 40, bass: 100, mid: 50, treble: 35, sensitivity: 50 } }); await sleep(2000);
    const before = await player(), first = await status(), seen = [];
    for (let i = 0; i < 8; i++) { seen.push(await status()); await sleep(1000); }
    const after = await player(), last = seen.at(-1);
    console.log(`Pulse Engine ${on ? 'ON ' : 'off'} · hears: ${last.audio.state}${on ? `, ${last.audio.beats - first.audio.beats} beats in 8 s, bands low ${mean(seen.map(s => s.audio.low)).toFixed(2)} mid ${mean(seen.map(s => s.audio.mid)).toFixed(2)} high ${mean(seen.map(s => s.audio.high)).toFixed(2)}` : ''}`
      + ` · video advanced ${(after.time - before.time).toFixed(1)} s, ${after.frames - before.frames} frames, ${after.dropped - before.dropped} dropped, muted ${after.muted}, volume ${after.volume}, speed ${after.rate}, paused ${after.paused}`
      + ` · analysis ${mean(seen.map(s => s.perf.analysisMs)).toFixed(2)} ms, render ${mean(seen.map(s => s.perf.renderMs)).toFixed(2)} ms, quality ${Math.max(...seen.map(s => s.perf.quality))}`);
  }
} finally { await context.close(); }
