// Pulse Engine on real music: plays a public video in the test browser, with one or more builds, and reports how much
// the light at the bottom centre and the top centre moves with the Pulse Engine off and on, over the same nine seconds.
// Needs the network, so it is not part of `npm run test:e2e`. Nothing is logged in, saved or sent; the browser is muted.
//   node scripts/real-pulse.mjs "<video page URL>&t=43s" <folder of an earlier build> dist
// perFrame: mean change of opacity (0–255) from one painted frame to the next. halfSecondSwing: mean of highest minus
// lowest within half a second. The picture moves the light too: that is what the "pulseOff" figures show.
// reach: how far in from the bottom edge the light is at least a tenth as strong as at the edge, in px (lowest–highest).
// Settings other than the defaults: DEPTH=100 LIMITER=off node scripts/real-pulse.mjs …
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { openPopup } from './cdp-popup.mjs';
import { quiet } from './browser.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const [url, ...builds] = process.argv.slice(2);
const watchdog = setTimeout(() => { console.log('watchdog'); process.exit(1); }, 170000);
for (const dist of builds) {
  const context = await chromium.launchPersistentContext('', await quiet({ channel: 'chromium', headless: true, viewport: { width: 1440, height: 900 },
    args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${resolve(dist)}`, `--load-extension=${resolve(dist)}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'] }));
  try {
    const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), id = sw.url().split('/')[2];
    const cdp = await context.browser().newBrowserCDPSession(), page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.locator('video').first().waitFor({ state: 'attached', timeout: 30000 });
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) { ready = await page.evaluate(() => { const v = document.querySelector('video'); return !!v && !document.querySelector('.ad-showing') && v.readyState >= 3 && !v.paused && v.currentTime > 1; }).catch(() => false); if (!ready) await sleep(500); }
    const info = await page.evaluate(() => { const v = document.querySelector('video'); return { ad: !!document.querySelector('.ad-showing'), t: v.currentTime, paused: v.paused, size: `${v.videoWidth}x${v.videoHeight}`, title: document.title.slice(0, 50) }; });
    if (!ready) { console.log(dist.split('/').pop(), 'not ready', JSON.stringify(info)); continue; }
    const popup = await openPopup(cdp, id, page.url()); await sleep(400);
    await popup.evaluate('document.querySelector("#start").click()'); await sleep(1500);
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id); await popup.close();
    const status = () => sw.evaluate(id => chrome.tabs.sendMessage(id, { target: 'content', type: 'status' }), tabId);
    const set = changes => sw.evaluate(async changes => { const { settings = {} } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, ...changes } }); }, changes);
    // In the page, frame by frame for `ms`: opacity of the bottom centre and the top centre of the light.
    const record = ms => page.evaluate(ms => new Promise(done => {
      const root = document.querySelector('#eclirim-lighting').shadowRoot, top = root.querySelector('canvas[data-side="top"]'), bottom = root.querySelector('canvas[data-side="bottom"]');
      const at = (c, y) => c.getContext('2d').getImageData(Math.floor(c.width * .53), y, 1, 1).data[3], out = [], until = performance.now() + ms;
      // How far the light of the bottom edge reaches into the page right now: the canvas as it is laid out and scaled.
      const reach = () => { const column = bottom.getContext('2d').getImageData(Math.floor(bottom.width * .53), 0, 1, bottom.height).data, edge = column[(bottom.height - 2) * 4 + 3]; let rows = 0; for (let y = bottom.height - 1; y >= 0 && column[y * 4 + 3] >= edge * .1 && edge > 0; y--) rows++; return rows / bottom.height * bottom.getBoundingClientRect().height; };
      const frame = now => { out.push([at(top, 1), at(bottom, bottom.height - 2), reach()]); if (now < until) requestAnimationFrame(frame); else done(out); };
      requestAnimationFrame(frame);
    }), ms);
    // How much the light moves from one frame to the next, and how far within any half second.
    const moved = (seen, i) => { const v = seen.map(s => s[i]); let step = 0, swing = 0; for (let k = 1; k < v.length; k++) step += Math.abs(v[k] - v[k - 1]); for (let k = 0; k + 30 <= v.length; k += 15) { const w = v.slice(k, k + 30); swing += Math.max(...w) - Math.min(...w); } return { perFrame: +(step / (v.length - 1)).toFixed(2), halfSecondSwing: +(swing / Math.max(1, Math.floor((v.length - 15) / 15))).toFixed(1), mean: Math.round(v.reduce((n, x) => n + x, 0) / v.length), range: `${Math.min(...v)}–${Math.max(...v)}` }; };
    const depth = Number(process.env.DEPTH || 40), limiter = process.env.LIMITER !== 'off';
    await set({ flashLimiter: limiter });
    const row = { build: dist.split('/').pop(), ...info };
    for (const on of [false, true]) {
      await set({ pulse: { enabled: on, depth, bass: 100, mid: 50, treble: 35, sensitivity: 50, wave: Number(process.env.WAVE || 60), bloom: Number(process.env.BLOOM || 70) } }); await sleep(2500);
      const before = await status(), seen = await record(9000), after = await status();
      row[on ? 'pulseOn' : 'pulseOff'] = { bottom: moved(seen, 1), top: moved(seen, 0), reach: `${Math.round(Math.min(...seen.map(s => s[2])))}–${Math.round(Math.max(...seen.map(s => s[2])))} px`, frames: seen.length, ...(on ? { beats: after.audio.beats - before.audio.beats, audio: after.audio.state, low: +after.audio.low.toFixed(2), mid: +after.audio.mid.toFixed(2), high: +after.audio.high.toFixed(2) } : {}), at: +(await page.evaluate(() => document.querySelector('video').currentTime)).toFixed(0) };
    }
    console.log(JSON.stringify(row));
  } finally { await context.close(); }
}
clearTimeout(watchdog);
