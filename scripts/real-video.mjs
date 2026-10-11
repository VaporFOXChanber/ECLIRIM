// Light Director on real pictures: plays a public video in the test browser and compares the edge light with it on and off,
// on the same paused frames. Needs the network, so it is not part of `npm run test:e2e`. Nothing is logged in, saved or sent.
//   node scripts/real-video.mjs "https://www.youtube.com/watch?v=aqz-KE-bpKQ" 12,45,90,150
// The figures are measured in a headless test browser. They say how much light is added, not how it looks.
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { openPopup } from './cdp-popup.mjs';
import { quiet } from './browser.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const url = process.argv[2], times = (process.argv[3] || '15,60,120').split(',').map(Number);
if (!url) { console.error('usage: node scripts/real-video.mjs <video page URL> [seconds,seconds,...]'); process.exit(2); }
const context = await chromium.launchPersistentContext('', await quiet({ channel: 'chromium', headless: process.env.HEADED !== '1', viewport: { width: 1440, height: 900 },
  args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'] }));
try {
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), id = sw.url().split('/')[2];
  const cdp = await context.browser().newBrowserCDPSession(), page = await context.newPage();
  const set = changes => sw.evaluate(async changes => { const { settings = {} } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, ...changes } }); }, changes);
  // Opacity of the outermost row of each edge canvas, 16 points per side: what the extension itself painted.
  const edges = () => page.evaluate(() => {
    const host = document.querySelector('#eclirim-lighting')?.shadowRoot;
    return host ? Array.from(host.querySelectorAll('canvas')).flatMap((c, i) => Array.from({ length: 16 }, (_, j) => {
      const t = (j + .5) / 16, x = i < 2 ? Math.floor(t * c.width) : (i === 2 ? 1 : c.width - 2), y = i < 2 ? (i === 0 ? 1 : c.height - 2) : Math.floor(t * c.height);
      return c.getContext('2d').getImageData(x, y, 1, 1).data[3];
    })) : null;
  });
  const mean = values => values.reduce((n, v) => n + v, 0) / values.length, rows = [];
  let tabId;
  for (const t of times) {
    // A fresh load at each time is steadier than seeking inside a streaming player.
    await page.goto(`${url}${url.includes('?') ? '&' : '?'}t=${t}s`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.locator('video').first().waitFor({ state: 'attached', timeout: 30000 });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      ready = await page.evaluate(t => { const v = document.querySelector('video'); return !!v && !document.querySelector('.ad-showing') && v.readyState >= 3 && v.currentTime > t + 1.2; }, t).catch(() => false);
      if (!ready) await sleep(500);
    }
    if (tabId === undefined) {
      // While it plays: the rates and times the Performance Monitor reports.
      const popup = await openPopup(cdp, id, page.url()); await sleep(400);
      await popup.evaluate('document.querySelector("#start").click()'); await sleep(1200);
      tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id); await popup.close();
      await set({ zoneMode: 'manual', zoneCount: 64 }); await sleep(3000);
      const seen = [];
      for (let i = 0; i < 10; i++) { const s = await sw.evaluate(id => chrome.tabs.sendMessage(id, { target: 'content', type: 'status' }), tabId).catch(() => null); if (s?.perf) seen.push(s); await sleep(1000); }
      const playing = seen.filter(s => s.state === 'Active');
      console.log(playing.length ? `playing: ${playing[0].source}, analysis ${mean(playing.map(s => s.perf.analysisFps)).toFixed(1)} fps / ${mean(playing.map(s => s.perf.analysisMs)).toFixed(2)} ms (Light Director ${mean(playing.map(s => s.perf.directorMs)).toFixed(2)} ms), render ${mean(playing.map(s => s.perf.renderFps)).toFixed(1)} fps / ${mean(playing.map(s => s.perf.renderMs)).toFixed(2)} ms, quality ${Math.max(...playing.map(s => s.perf.quality))}, candidates ${Math.min(...playing.map(s => s.perf.stats?.sources ?? 0))}–${Math.max(...playing.map(s => s.perf.stats?.sources ?? 0))}`
        : `not analysing while playing: ${seen.at(-1)?.state} ${seen.at(-1)?.detail || ''}`);
    }
    await page.evaluate(() => document.querySelector('video').pause());
    for (let i = 0; i < 30 && !(await edges()); i++) await sleep(300);
    const read = async on => { await set({ director: { enabled: on, motion: 50, source: 50, strength: 35, response: 60, smoothing: 60 } }); await sleep(3200); return edges(); };
    const off = await read(false), on = await read(true);
    if (!ready || !off || !on) { console.log(`t=${t}s: skipped (video not ready or not lit)`); continue; }
    const added = on.map((v, i) => v - off[i]);
    rows.push({ base: mean(off), added: mean(added), most: Math.max(...added) });
    console.log(`t=${String(t).padStart(4)}s  base ${mean(off).toFixed(1).padStart(5)}  Light Director +${mean(added).toFixed(1)} (largest point +${Math.max(...added)})`);
  }
  if (rows.length) console.log(`${rows.length} frames: base ${mean(rows.map(r => r.base)).toFixed(1)}, Light Director adds ${mean(rows.map(r => r.added)).toFixed(1)} on average, ${Math.max(...rows.map(r => r.added)).toFixed(1)} in its strongest frame, +${Math.max(...rows.map(r => r.most))} at one point (opacity, 0–255)`);
} finally { await context.close(); }
