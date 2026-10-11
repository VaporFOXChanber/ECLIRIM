// Does a player keep sounding while the Pulse Engine reads a copy of its sound? A headless browser has no audio output,
// so this one opens a visible test window and really plays — at −54 dB, which is as good as silent — and asks Chrome
// itself whether the tab is audible. Not part of `npm run test:e2e`: it puts a window on the screen for about 25 seconds.
//   npm run build && node scripts/audio-output-check.mjs
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { serve } from './serve.mjs';
import { openPopup } from './cdp-popup.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = await serve();
const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: false, viewport: { width: 900, height: 620 },
  args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`,
    '--autoplay-policy=no-user-gesture-required', '--window-position=40,60'] });
try {
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), id = sw.url().split('/')[2];
  const cdp = await context.browser().newBrowserCDPSession(), page = await context.newPage();
  await page.goto('http://localhost:4173'); await page.locator('#play').waitFor();
  const popup = await openPopup(cdp, id, page.url()); await sleep(300);
  await popup.evaluate('document.querySelector("#start").click()'); await sleep(900); await popup.close();
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
  const audible = () => sw.evaluate(async id => (await chrome.tabs.get(id)).audible, tabId);
  const heard = () => sw.evaluate(id => chrome.tabs.sendMessage(id, { target: 'content', type: 'status' }), tabId).then(s => s.audio);
  const set = changes => sw.evaluate(async changes => { const { settings = {} } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, ...changes } }); }, changes);
  const settle = async (wanted, label) => { for (let i = 0; i < 40; i++) { if (await audible() === wanted) return; await sleep(250); } throw new Error(`${label}: the tab is ${wanted ? 'not ' : ''}audible`); };
  // The Lab's music, turned down to 0.2% before it starts.
  await page.evaluate(() => { document.querySelector('[data-sound="music"]').click(); document.querySelector('#player video').volume = 0.002; });
  await settle(true, 'playing, Pulse Engine off'); console.log('playing, Pulse Engine off      → tab audible:', await audible(), '· extension hears:', (await heard()).state);
  await set({ pulse: { enabled: true, depth: 40, bass: 100, mid: 50, treble: 35, sensitivity: 50 } });
  for (let i = 0; i < 24 && (await heard()).state !== 'active'; i++) await sleep(250);
  for (let second = 2; second <= 8; second += 2) {
    await sleep(2000); const a = await heard();
    console.log(`Pulse Engine reading, +${second}s        → tab audible:`, await audible(), `· extension hears: ${a.state}, ${a.beats} beats`);
    assert.equal(await audible(), true, 'the player keeps sounding while its sound is read'); assert.equal(a.state, 'active');
  }
  const player = await page.evaluate(() => { const v = document.querySelector('#player video'); return { muted: v.muted, volume: v.volume, rate: v.playbackRate, paused: v.paused }; });
  assert.deepEqual(player, { muted: false, volume: 0.002, rate: 1, paused: false }, 'mute, volume and speed are as the page set them');
  // The control: when the player really is muted, Chrome says so — and the copy would still carry sound, which is why
  // the extension treats a muted player as silence by itself.
  await page.evaluate(() => { document.querySelector('#player video').muted = true; });
  await settle(false, 'player muted'); console.log('player muted (control)          → tab audible:', await audible(), '· extension hears:', (await heard()).state);
  assert.equal((await heard()).state, 'muted');
  await page.evaluate(() => { document.querySelector('#player video').muted = false; });
  await settle(true, 'unmuted'); console.log('unmuted                         → tab audible:', await audible(), '· extension hears:', (await heard()).state);
  console.log('OK: reading the sound does not silence the player.');
} finally { await context.close(); await server.close(); }
