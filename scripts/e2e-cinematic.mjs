// 0.8.0 "Cinematic Update": Light Director, Zone Studio, Site Profiles and the Performance Monitor,
// driven through the production build in a real browser. The older behaviour stays covered by e2e.mjs.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { serve } from './serve.mjs';
import { openPopup } from './cdp-popup.mjs';
import { quiet } from './browser.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [], errors = [];
await mkdir('artifacts', { recursive: true });
const server = await serve();
const context = await chromium.launchPersistentContext('', await quiet({
  channel: 'chromium', headless: process.env.HEADED !== '1', viewport: { width: 1280, height: 900 },
  args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`]
}));
let page, sw, cdp, id, tabId, popup;
const until = async (fn, label, timeout = 10000) => {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(120); }
  throw new Error(`Timed out: ${label}; last=${JSON.stringify(last)}`);
};
const record = (name, detail = '') => { results.push({ name, result: 'PASS', detail }); console.log('PASS', name, detail); };
const status = (tab = tabId) => sw.evaluate(id => chrome.tabs.sendMessage(id, { target: 'content', type: 'status' }), tab);
const used = (tab = tabId) => sw.evaluate(id => chrome.tabs.sendMessage(id, { target: 'content', type: 'context' }), tab).then(r => r.settings);
const stored = () => sw.evaluate(() => chrome.storage.local.get(['settings', 'profiles', 'schema']));
const set = changes => sw.evaluate(async changes => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, ...changes } });
}, changes);
const DIRECTOR = { enabled: true, motion: 50, source: 50, strength: 35, response: 60, smoothing: 60 };
const director = patch => set({ director: { ...DIRECTOR, ...patch } });
// What the Light Director reports. Right after it is switched on there is no analysed frame yet.
const seen = async () => (await status()).perf?.stats || { sources: 0, motion: 0, vx: 0, vy: 0, cut: false, calm: 1 };
const expectState = wanted => until(async () => { const s = await status().catch(() => null); return s?.state === wanted ? s : false; }, wanted);
// Scene buttons are pressed from script so the page never scrolls and the whole player stays on screen.
const scene = name => page.evaluate(name => document.querySelector(`[data-scene="${name}"]`).click(), name);
// The outermost row of every edge canvas, 16 samples per side as [r, g, b, a]. Order: top, bottom, left, right.
const edgesOf = target => target.evaluate(root => {
  const host = (root || document).querySelector('#eclirim-lighting')?.shadowRoot;
  return host ? Array.from(host.querySelectorAll('canvas')).map((c, i) => Array.from({ length: 16 }, (_, j) => {
    const t = (j + .5) / 16, x = i < 2 ? Math.floor(t * c.width) : (i === 2 ? 1 : c.width - 2), y = i < 2 ? (i === 0 ? 1 : c.height - 2) : Math.floor(t * c.height);
    return Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data);
  })) : null;
});
const edges = () => edgesOf(page.locator('html'));
const alphas = async () => (await edges()).map(side => side.map(p => p[3]));
const slide = (target, selector, value) => target.locator(selector).evaluate((el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
const mean = values => values.reduce((n, v) => n + v, 0) / values.length;
try {
  sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); id = sw.url().split('/')[2];
  cdp = await context.browser().newBrowserCDPSession(); page = await context.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto('http://localhost:4173'); await page.locator('#play').waitFor();
  popup = await openPopup(cdp, id, page.url()); await sleep(300);
  await popup.evaluate('document.querySelector("#start").click()');
  tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
  await expectState('Active');
  const shown = await popup.evaluate(`(async () => { for (let i = 0; i < 30 && !/DIRECTOR ACTIVE/.test(document.querySelector('#metrics').textContent); i++) await new Promise(r => setTimeout(r, 100)); return { director: document.querySelector('#director').checked, metrics: document.querySelector('#metrics').textContent, profile: document.querySelector('#profile-name').textContent }; })()`);
  assert.equal(shown.director, true, 'Light Director is on by default'); assert.match(shown.metrics, /DIRECTOR ACTIVE/); assert.match(shown.profile, /グローバル設定/);
  await popup.close();
  await set({ zoneMode: 'manual', zoneCount: 64 }); await until(async () => (await status()).zoneCount === 64, '64 zones');
  assert.deepEqual((await stored()).settings.director, DIRECTOR, 'modest defaults');

  // ── Performance Monitor: everything it reports is measured in the tab.
  await sleep(2500);
  const perf = (await status()).perf;
  assert.ok(perf.analysisFps > 8 && perf.analysisFps < 14, `analysis about 12 fps: ${perf.analysisFps}`);
  assert.ok(perf.renderFps > 20 && perf.renderFps < 33, `render at most 30 fps: ${perf.renderFps}`);
  assert.ok(perf.analysisMs > 0 && perf.directorMs > 0 && perf.directorMs < perf.analysisMs, 'analysis time, and the Light Director share of it');
  assert.ok(perf.renderMs > 0 && perf.latencyMs > 0 && perf.latencyMs < 250, `paint time and first-paint delay: ${perf.renderMs} / ${perf.latencyMs}`);
  assert.deepEqual([perf.zones, perf.activeZones, perf.quality, perf.director], [64, 64, 0, 'active']);
  for (const key of ['skippedAnalysis', 'skippedRender', 'overBudget']) assert.ok(Number.isInteger(perf[key]) && perf[key] >= 0, key);
  assert.ok(!('cpu' in perf) && !('gpu' in perf), 'no CPU or GPU figure is made up');
  record('Performance Monitor: analysis/render rate and time, Light Director time, first-paint delay, zones, quality and missed-frame counters are measured in the tab', perf);

  // ── Light Director on/off: a lamp in the picture reaches the edges; switched off, the light is the base lighting again.
  await director({ enabled: false }); await scene('still'); await sleep(2500);
  const base = await alphas(), offStatus = await status();
  assert.equal(offStatus.perf.director, 'off'); assert.equal(offStatus.perf.stats, null); assert.equal(offStatus.perf.directorMs, 0);
  await director({}); await until(async () => (await seen()).sources === 1, 'the lamp is a light source candidate');
  await sleep(2500);
  const lit = await alphas();
  assert.ok(lit[0][4] > base[0][4] + 25, `top edge above the lamp: ${base[0][4]} → ${lit[0][4]}`);
  assert.ok(lit[0][4] > lit[0][14] * 2 && lit[0][4] > lit[1][4] * 1.5, 'strongest on the nearest edge, nearest to the lamp');
  assert.ok(lit[0][4] < 110, `supporting light, not a spotlight: ${lit[0][4]}`);
  const steady = []; for (let i = 0; i < 10; i++) { steady.push((await alphas())[0][4]); await sleep(200); }
  assert.ok(Math.max(...steady) - Math.min(...steady) <= 3, `a still object gives a still light: ${steady}`);
  await director({ strength: 100 }); await sleep(2500); const strong = (await alphas())[0][4];
  await director({ strength: 0 }); await sleep(3500); const none = await alphas();
  assert.ok(strong > lit[0][4] * 1.3, `Effect Strength scales it: ${lit[0][4]} → ${strong}`);
  assert.ok(Math.abs(none[0][4] - base[0][4]) <= 2, 'strength 0 equals off');
  await director({ enabled: false }); await sleep(2500);
  const back = await alphas();
  assert.ok(back.every((side, i) => side.every((a, j) => Math.abs(a - base[i][j]) <= 2)), 'off restores the earlier rendering');
  record('Light Director ON/OFF and Effect Strength: a lamp inside the picture lights its nearest edge steadily; OFF returns the base lighting', { base: base[0], on: lit[0], strong, steady });

  // ── Direction: followed from the source itself. Left→right is positive, right→left negative, and the edge light travels with it.
  await director({});
  const sweep = async name => {
    await scene(name); await sleep(700);
    const track = [];
    for (let i = 0; i < 14; i++) { const { vx } = await seen(), top = (await alphas())[0]; track.push({ vx, peak: top.indexOf(Math.max(...top)) }); await sleep(180); }
    return track;
  };
  const right = await sweep('sweep-right'), left = await sweep('sweep-left');
  // The light jumps back to its start every three seconds: that moment has no direction and is left out.
  const moving = track => track.map(s => s.vx).filter(v => Math.abs(v) > .05);
  assert.ok(moving(right).length >= 9 && moving(right).every(v => v > .15 && v < .45), `left→right reads as about +0.28 widths/s: ${right.map(s => s.vx.toFixed(2))}`);
  assert.ok(moving(left).length >= 9 && moving(left).every(v => v < -.15 && v > -.45), `right→left reads as about −0.28: ${left.map(s => s.vx.toFixed(2))}`);
  const steps = track => track.slice(1).map((s, i) => Math.sign(s.peak - track[i].peak));
  assert.ok(steps(right).filter(v => v > 0).length > steps(right).filter(v => v < 0).length + 2, `the brightest point of the top edge moves right: ${right.map(s => s.peak)}`);
  assert.ok(steps(left).filter(v => v < 0).length > steps(left).filter(v => v > 0).length + 2, `and left: ${left.map(s => s.peak)}`);
  record('Moving light: direction has the right sign and speed in both directions, and the edge light follows the object', { right, left });

  // ── A local burst on a dark picture: the edges nearest to it answer, the far ones barely.
  const burst = async () => { let best = Array(4).fill(0).map(() => Array(16).fill(0));
    for (let i = 0; i < 42; i++) { const a = await alphas(); best = best.map((side, s) => side.map((v, j) => Math.max(v, a[s][j]))); await sleep(100); } return best; };
  await scene('burst'); await sleep(2600);   // let the light of the previous scene die away first
  const burstOn = await burst();
  assert.ok(burstOn[0][13] > 30 && burstOn[0][13] > burstOn[0][2] * 4, `upper right over upper left: ${burstOn[0]}`);
  // The right edge is about three times brighter near the burst than far from it. The bound used to be exactly 3, which is
  // where the value sits: measured again on 2026-10-10, the 0.9.0 build gives 71 / 24 = 2.96 and this one 2.92–3.0.
  assert.ok(burstOn[3][2] > burstOn[3][13] * 2.5 && burstOn[1][13] < burstOn[0][13] / 3, `right edge near the top; the bottom edge barely: right ${burstOn[3]} · bottom ${burstOn[1]}`);
  // Motion Sensitivity decides how much the moment of appearing counts. Light Source Sensitivity is held at 0 so only that differs.
  const kick = async motion => { await director({ motion, source: 0, strength: 100, response: 100 }); await sleep(2600); return (await burst())[0][13]; };
  const calmKick = await kick(0), sharpKick = await kick(100);
  assert.ok(sharpKick > calmKick + 4, `Motion Sensitivity 0 → 100: ${calmKick} → ${sharpKick}`);
  await director({ enabled: false }); await sleep(2600);
  const burstOff = await burst();
  // The base lighting only sees the fireball once it has grown into the strip next to the edge, so its answer is late and weak.
  assert.ok(burstOn[0][13] > burstOff[0][13] * 1.5, `the Light Director answers the burst clearly more than the base lighting alone: ${burstOn[0][13]} vs ${burstOff[0][13]}`);
  record('Local burst: nearest zones react, Motion Sensitivity changes how strongly, OFF leaves only the base lighting', { on: burstOn[0], off: burstOff[0], motion0: calmKick, motion100: sharpKick });

  // ── Blinking source: repeated flashes are turned down until hardly any blinking is left on the edges.
  // (That the Flash Limiter bounds Light Director light is shown exactly in the unit tests; here so little blinking
  // remains that switching the limiter off makes no measurable difference. Both readings are recorded.)
  const swing = async () => { const levels = []; for (let i = 0; i < 40; i++) { levels.push((await alphas())[0][8]); await sleep(50); } return { min: Math.min(...levels), max: Math.max(...levels) }; };
  await director({}); await set({ flashLimiter: true }); await scene('blink'); await sleep(4000);
  const guarded = await swing(), calm = (await seen()).calm;
  assert.ok(calm < .4, `3 Hz blinking is recognised and turned down: ${calm}`);
  await set({ flashLimiter: false }); await sleep(2500);
  const unlimited = await swing();
  for (const reading of [guarded, unlimited]) assert.ok(reading.max - reading.min <= 12 && reading.max < 70, `a strobe never becomes a strobe on the edges: ${JSON.stringify(reading)}`);
  await set({ flashLimiter: true });
  record('Blinking source (3 Hz): the flicker guard turns it down to a nearly steady, faint light, with the Flash Limiter on or off', { calm, withLimiter: guarded, withoutLimiter: unlimited });

  // ── Fast cuts, subtitles, darkness: nothing extra. Several lights: several candidates.
  const average = async () => { const levels = []; for (let i = 0; i < 16; i++) { levels.push(mean((await alphas()).flat())); await sleep(110); } return mean(levels); };
  await scene('cuts'); await sleep(1500);
  let sawCut = false, polls = 0; const cutStarted = Date.now(); for (; polls < 80 && !sawCut; polls++) { sawCut = (await seen()).cut; await sleep(40); }
  const cutDebug = JSON.stringify({ polls, ms: Date.now() - cutStarted, perf: (await status()).perf });
  const cutsOn = await average(); await director({ enabled: false }); await sleep(1200); const cutsOff = await average(); await director({});
  assert.ok(sawCut, `cuts are recognised as cuts ${cutDebug}`); assert.ok(Math.abs(cutsOn - cutsOff) < 8, `and add no light of their own: ${cutsOn} vs ${cutsOff}`);
  await scene('caption'); await sleep(2500);
  let captionSources = 0; const captionOn = []; for (let i = 0; i < 20; i++) { captionSources = Math.max(captionSources, (await seen()).sources); captionOn.push((await alphas())[1][8]); await sleep(150); }
  await director({ enabled: false }); await sleep(1500);
  const captionOff = []; for (let i = 0; i < 20; i++) { captionOff.push((await alphas())[1][8]); await sleep(150); }
  await director({});
  assert.equal(captionSources, 0, 'a subtitle line is not a light source');
  assert.ok(Math.max(...captionOn) <= Math.max(...captionOff) + 3, `subtitles do not flash the bottom edge: ${Math.max(...captionOn)} vs ${Math.max(...captionOff)}`);
  await scene('multi'); await until(async () => (await seen()).sources === 3, 'three lights, three candidates'); await sleep(2000);
  const multi = await edges();
  assert.ok(multi[0][2][0] > multi[0][2][1] * 2 && multi[0][13][1] > multi[0][13][0] * 2 && multi[1][8][2] > multi[1][8][0] * 1.5, 'red upper left, green upper right, blue below: each keeps its colour');
  await scene('scope'); await sleep(1500);
  const scope = []; for (let i = 0; i < 10; i++) { scope.push((await seen()).vx); await sleep(200); }
  assert.ok(scope.filter(v => v > .1).length >= 6, `direction inside a letterboxed picture: ${scope.map(v => v.toFixed(2))}`);
  await scene('dark'); await until(async () => (await alphas()).flat().every(a => a === 0), 'a full blackout goes fully dark', 8000);
  record('Fast cuts, subtitle-like bar and blackout add no light; three lights give three coloured candidates; direction works inside letterbox bars', { cutsOn, cutsOff, captionOn: Math.max(...captionOn), captionOff: Math.max(...captionOff), scopeVx: scope });

  // ── Pause, resume, seek, SPA replacement, fullscreen, hidden tab: nothing keeps running that should not.
  await scene('still'); await expectState('Active'); await sleep(1500);
  await page.locator('video').evaluate(v => v.pause()); await expectState('Paused'); await sleep(2200);
  const held = await status();
  assert.equal(held.perf.analysisFps, 0, 'no analysis while paused'); assert.ok((await alphas())[0][4] > 25, 'the paused picture keeps its light');
  await page.locator('video').evaluate(v => v.play()); await expectState('Active');
  await scene('file'); await until(() => page.locator('video').evaluate(v => v.readyState >= 2 && !v.paused), 'file playback');
  await page.locator('video').evaluate(v => { v.currentTime = 6; }); await expectState('Active');
  await until(async () => (await status()).perf.director === 'active', 'Light Director after a seek');
  await page.evaluate(() => document.querySelector('#replace').click()); await expectState('Active');
  await until(async () => (await status()).perf.analysisFps > 6, 'analysis follows the replaced video element');
  await set({ hud: true }); await until(() => page.locator('#eclirim-hud').count().then(n => n === 1), 'HUD on');
  const hud = await page.locator('#eclirim-hud').evaluate(el => ({ text: el.shadowRoot.textContent, events: getComputedStyle(el).pointerEvents, box: el.getBoundingClientRect().toJSON() }));
  assert.match(hud.text, /Analysis\s+\d+\.\d fps/); assert.match(hud.text, /Director\s+active/); assert.match(hud.text, /Render\s+\d+\.\d fps/); assert.match(hud.text, /Zones\s+64/);
  assert.equal(hud.events, 'none', 'the HUD never takes a click'); assert.ok(hud.box.top < 40 && hud.box.left < 40 && hud.box.bottom < 250, 'top-left, clear of player controls');
  await page.evaluate(() => document.querySelector('#fullscreen').click());
  await until(() => page.evaluate(() => document.fullscreenElement?.id === 'player' && ['#eclirim-lighting', '#eclirim-hud'].every(s => document.querySelector(s)?.parentElement?.id === 'player')), 'light and HUD follow fullscreen');
  await expectState('Active'); await page.evaluate(() => document.exitFullscreen());
  // A headless browser never reports a background tab as hidden, so the test says "hidden" to the content script itself,
  // inside its own isolated world. This exercises the extension's pause path, not Chrome's visibility bookkeeping.
  const world = await context.newCDPSession(page), worlds = [];
  world.on('Runtime.executionContextCreated', e => worlds.push(e.context)); await world.send('Runtime.enable');
  const isolated = await until(() => worlds.find(c => c.origin === `chrome-extension://${id}` && c.auxData?.frameId), 'the content script world');
  const hide = hidden => world.send('Runtime.evaluate', { contextId: isolated.id, expression: hidden ? "Object.defineProperty(document, 'hidden', { get: () => true, configurable: true })" : 'delete document.hidden' });
  await hide(true);
  const hidden = await until(async () => { const s = await status(); return s.state === 'Paused' && /非表示/.test(s.detail) ? s : false; }, 'a hidden tab pauses');
  assert.equal(hidden.perf.analysisFps, 0); assert.equal(hidden.perf.renderFps, 0);
  assert.equal(await page.locator('#eclirim-lighting').count(), 0); assert.equal(await page.locator('#eclirim-hud').count(), 0);
  const frames = hidden.frames; await sleep(1500); assert.equal((await status()).frames, frames, 'no frame is analysed while hidden');
  await hide(false); await world.detach(); await expectState('Active');
  await set({ hud: false }); await until(() => page.locator('#eclirim-hud').count().then(n => n === 0), 'HUD off');
  record('Pause holds the light with no analysis; seek, replaced video element (SPA) and fullscreen behave; a tab reported as hidden stops analysing and painting; HUD shows measured figures and passes clicks through', hud);

  // ── A hover preview in a list (YouTube's shared preview player) is not what is being watched: it gets no light.
  await scene('split'); await expectState('Active');
  await page.evaluate(() => {
    const main = document.querySelector('#player video'); main.style.display = 'none';
    const preview = document.createElement('ytd-video-preview'), player = document.createElement('div'), video = document.createElement('video');
    preview.style.cssText = 'position:fixed;left:260px;top:110px;width:504px;height:283px;z-index:5'; player.id = 'inline-preview-player';
    video.muted = true; video.playsInline = true; video.style.cssText = 'width:100%;height:100%'; video.srcObject = main.srcObject;
    player.append(video); preview.append(player); document.body.append(preview); return video.play();
  });
  const choosing = await until(async () => { const s = await status(); return s.state === 'Waiting for Video' ? s : false; }, 'a playing hover preview is not picked up');
  await until(async () => (await alphas()).flat().every(a => a === 0), 'and the edges stay dark while only a preview plays', 8000);
  assert.equal(await page.locator('ytd-video-preview video').evaluate(v => !v.paused && v.currentTime > 0), true, 'the preview itself is playing');
  // The very same element, no longer inside the preview player, is an ordinary video again.
  await page.evaluate(() => { const video = document.querySelector('ytd-video-preview video'), box = document.createElement('div'); box.id = 'was-preview'; box.style.cssText = document.querySelector('ytd-video-preview').style.cssText; document.body.append(box); box.append(video); return video.play(); });
  await expectState('Active');
  await page.evaluate(() => { document.querySelector('#was-preview').remove(); document.querySelector('ytd-video-preview').remove(); document.querySelector('#player video').style.display = ''; });
  await expectState('Active');
  record('A video inside YouTube\'s hover-preview player is not lit while it plays; outside that player the same video is', { state: choosing.state, detail: choosing.detail });

  // ── Zone Studio, through its own page.
  await scene('split'); await sleep(2500);
  const plain = await edges();
  const options = await context.newPage(); options.on('pageerror', e => errors.push(`options: ${e}`));
  await options.goto(`chrome-extension://${id}/options.html#studio`);
  await until(() => options.locator('.zone').count().then(n => n === 64), 'one button per zone');
  assert.equal(await options.locator('#target').inputValue(), ''); assert.match(await options.locator('#studio-count-note').textContent(), /実際に使われるのは 64 ゾーン/);
  assert.equal(await options.locator('.zone[data-zone="0"]').getAttribute('title'), '#1 · 上 1/16');
  await options.locator('[data-select="2"]').click(); await options.locator('#zone-on').uncheck();          // the whole left side off
  await options.locator('.zone[data-zone="20"]').click(); assert.match(await options.locator('#selection').textContent(), /#21 · 下 5\/16/);
  await slide(options, '#zone-brightness', 180);                                                           // one bottom zone boosted
  await options.locator('.zone[data-zone="0"]').click(); await options.locator('.zone[data-zone="3"]').click({ modifiers: ['Shift'] });
  assert.match(await options.locator('#selection').textContent(), /4ゾーンを選択中/);
  await slide(options, '#zone-saturation', 0);                                                             // top-left zones grey
  await options.locator('.zone[data-zone="40"]').click(); await options.locator('.zone[data-zone="42"]').click({ modifiers: ['ControlOrMeta'] });
  assert.match(await options.locator('#selection').textContent(), /2ゾーンを選択中/);
  await options.locator('.zone[data-zone="12"]').click(); await slide(options, '#zone-intensity', 0);       // one top zone with no halo
  const zones = await until(async () => { const z = (await stored()).settings.zones; return z && z.intensity.some(v => v === 0) ? z : false; }, 'zone trims saved');
  assert.equal(zones.on.length, 384); assert.ok(zones.on.slice(192, 288).every(v => v === 0) && zones.on.slice(0, 192).every(v => v === 1) && zones.on.slice(288).every(v => v === 1));
  assert.ok(zones.brightness.slice(96 + 24, 96 + 30).every(v => v === 180) && zones.brightness[96 + 30] === 100 && zones.saturation.slice(0, 24).every(v => v === 0) && zones.saturation[24] === 100);
  assert.equal(await options.locator('.zone.off').count(), 16); assert.equal(await options.locator('.zone.trimmed').count(), 6);
  // The preview is the real renderer on a small stage, fed by test patterns: no picture is involved.
  const stage = options.locator('#stage');
  assert.equal(await stage.locator('#eclirim-lighting').count(), 1);
  await options.locator('.zone[data-zone="5"]').click(); await options.locator('[data-pattern="identify"]').click(); await sleep(2500);
  const identify = (await edgesOf(stage)).map(side => side.map(p => p[3]));
  assert.ok(identify[0][5] > 100 && identify[0][10] === 0 && identify[1][5] === 0 && identify[3][8] === 0, `Zone Identification lights the chosen zone only: ${identify[0]}`);
  await options.locator('[data-pattern="corners"]').click(); await sleep(2500);
  const corners = await edgesOf(stage);
  assert.ok(corners[0][15][1] > 150 && corners[0][15][0] < 80 && corners[3][0][1] > 150, 'Corner Test: green in the top-right corner, from both sides');
  // A side that is switched off still meets the lit corner zone of its neighbour over its last half zone, like any two zones do.
  const inner = side => side.slice(2, 14);
  assert.ok(inner(corners[2]).every(p => p[3] === 0), 'and the switched-off left side stays dark in the preview too');
  for (const pattern of ['sample', 'rainbow', 'rgb', 'moving', 'gradient']) { await options.locator(`[data-pattern="${pattern}"]`).click(); await sleep(250); }
  await sleep(1500); assert.ok((await edgesOf(stage))[0].map(p => p[3]).slice(0, 15).every((a, j, all) => j === 0 || a >= all[j - 1] - 2), 'Brightness Gradient rises along the edge');
  await options.locator('#studio-live').check(); await until(() => options.locator('#eclirim-lighting').count().then(n => n === 2), 'full-size preview on the page edges');
  await options.locator('#studio-live').uncheck(); await until(() => options.locator('#eclirim-lighting').count().then(n => n === 1), 'and off again');
  // Another zone count in the editor: every trim is still in its place.
  await options.locator('#studio-count').selectOption('128'); await until(() => options.locator('.zone').count().then(n => n === 128), '128 zones');
  assert.equal(await options.locator('.zone.off').count(), 32); assert.equal(await options.locator('.zones[data-side="2"] .zone.off').count(), 32);
  assert.equal(await options.locator('.zone.trimmed').count(), 12, 'each trimmed zone became two');
  await options.locator('#studio-count').selectOption('64');
  await options.screenshot({ path: 'artifacts/09-zone-studio.png', fullPage: true });
  // On the real page: the same trims on the real light, at 64 zones and after the zone count changes.
  await page.bringToFront(); await expectState('Active'); await sleep(2500);
  const trimmed = await edges(), layout = async count => { await set({ zoneCount: count }); await until(async () => (await status()).zoneCount === count, `${count} zones`); await sleep(2000); return { active: (await status()).perf.activeZones, edges: await edges() }; };
  assert.ok(inner(trimmed[2]).every(p => p[3] === 0) && trimmed[3].every(p => p[3] > 100), 'left side off, right side as before');
  assert.ok(trimmed[1][4][3] > plain[1][4][3] * 1.3 && Math.abs(trimmed[1][12][3] - plain[1][12][3]) <= 4, `boosted bottom zone: ${plain[1][4][3]} → ${trimmed[1][4][3]}`);
  const chroma = p => Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]);
  assert.ok(chroma(plain[0][1]) > 80 && chroma(trimmed[0][1]) < 12 && chroma(trimmed[0][8]) > 40, 'desaturated top-left zones are grey, the rest keeps its colour');
  assert.equal((await status()).perf.activeZones, 48);
  for (const [count, active] of [[128, 96], [32, 24], [96, 72], [64, 48]]) {
    const now = await layout(count);
    assert.equal(now.active, active, `${count} zones: three sides lit`);
    assert.ok(inner(now.edges[2]).every(p => p[3] === 0) && now.edges[3].every(p => p[3] > 100), `${count} zones: the left side is still the one that is off`);
    assert.ok(now.edges[1][4][3] > plain[1][4][3] * 1.15 && chroma(now.edges[0][1]) < 14, `${count} zones: boost and grey zones are where they were`);
  }
  await options.bringToFront(); await options.locator('#zones-reset').click();
  await until(async () => (await stored()).settings.zones === null, 'all zones reset'); assert.equal(await options.locator('.zone.off, .zone.trimmed').count(), 0);
  await page.bringToFront(); await expectState('Active'); await until(async () => (await edges())[2].every(p => p[3] > 60), 'the left side lights again');
  await until(async () => (await status()).perf.activeZones === 64, 'all 64 zones count as lit again');
  record('Zone Studio: select (click, Shift range, ⌘/Ctrl), per-zone brightness / saturation / halo / on-off, whole side, test patterns in a live preview, reset; trims are saved and survive 64 → 128 → 32 → 96 → 64 zones on the real light');

  // ── Site Profiles.
  await options.bringToFront(); await options.locator('[data-tab="profiles"]').click();
  await options.locator('#profile-site').fill('bad host!'); await options.locator('#profile-form button').click();
  assert.match(await options.locator('#profile-message').textContent(), /ホスト名を入力/); assert.deepEqual((await stored()).profiles || {}, {});
  await options.locator('#profile-site').fill('localhost'); await options.locator('#profile-form button').click();
  await until(async () => (await stored()).profiles?.localhost, 'profile created'); assert.deepEqual((await stored()).profiles, { localhost: {} });
  assert.equal(await options.locator('#target').inputValue(), 'localhost'); assert.match(await options.locator('#target-note').textContent(), /localhost のプロファイルに保存/);
  await options.locator('[data-tab="lighting"]').click(); await options.locator('[data-mode="vivid"]').click(); await slide(options, '#brightness', 20);
  await options.locator('[data-tab="director"]').click(); await options.locator('#director-enabled').uncheck();
  await options.locator('[data-tab="lighting"]').click(); await options.locator('#protectedLight').selectOption('drift');   // global-only: must not land in the profile
  const saved = await until(async () => { const s = await stored(); return s.profiles.localhost.director?.enabled === false && s.settings.protectedLight === 'drift' ? s : false; }, 'profile holds what was changed');
  await options.locator('#protectedLight').selectOption('off');
  assert.deepEqual(Object.keys(saved.profiles.localhost).sort(), ['brightness', 'director', 'mode']); assert.deepEqual([saved.profiles.localhost.mode, saved.profiles.localhost.brightness], ['vivid', 20]);
  assert.deepEqual([saved.settings.mode, saved.settings.brightness, saved.settings.director.enabled], ['cinema', 65, true], 'the global settings are untouched');
  assert.deepEqual(await sw.evaluate(async () => (await chrome.permissions.getAll()).origins), [], 'a profile asks for no site access');
  await page.bringToFront(); await expectState('Active');
  const applied = await until(async () => { const s = await status(); return s.profile === 'localhost' && s.perf.director === 'off' ? s : false; }, 'the profile is used on its site');
  assert.deepEqual(await used().then(s => [s.mode, s.brightness, s.director.enabled, s.source, s.zoneCount]), ['vivid', 20, false, 'video', 64]);
  // Inheritance: what the profile leaves alone follows the global settings, here and now.
  await set({ glowWidth: 16 }); await until(async () => (await used()).glowWidth === 16, 'inherited value follows the global one'); await set({ glowWidth: 10 });
  // Another site keeps the global settings.
  const elsewhere = await context.newPage(); await elsewhere.goto('http://127.0.0.1:4173/'); await elsewhere.locator('#play').waitFor(); await elsewhere.bringToFront();
  popup = await openPopup(cdp, id, elsewhere.url()); await sleep(300); await popup.evaluate('document.querySelector("#start").click()');
  const elsewhereTab = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
  const global = await until(async () => { const s = await status(elsewhereTab).catch(() => null); return s?.state === 'Active' && s.perf.director === 'active' ? s : false; }, 'other site lit');
  assert.equal(global.profile, ''); assert.deepEqual(await used(elsewhereTab).then(s => [s.mode, s.brightness]), ['cinema', 65]);
  assert.match(await popup.evaluate('document.querySelector("#profile-name").textContent'), /グローバル設定/);
  await popup.close(); await elsewhere.close(); await page.bringToFront();
  // Moving between pages of the site: the profile comes along.
  await page.goto('http://localhost:4173/?page=2'); await page.locator('#play').waitFor();
  await until(async () => { const s = await status().catch(() => null); return s?.state === 'Active' && s.profile === 'localhost'; }, 'profile applied again after navigation');
  // The popup edits the profile of the site it is opened on.
  popup = await openPopup(cdp, id, page.url()); await sleep(400);
  assert.match(await popup.evaluate('document.querySelector("#profile-name").textContent'), /localhost 専用のプロファイル/);
  assert.equal(await popup.evaluate('document.querySelector("#director").checked'), false);
  await popup.evaluate('document.querySelector(\'[data-mode="ambient"]\').click()');
  await until(async () => (await stored()).profiles.localhost.mode === 'ambient', 'popup wrote to the profile'); assert.equal((await stored()).settings.mode, 'cinema');
  await popup.close();
  // Duplicate, per-item return to global, delete.
  await options.bringToFront(); await options.locator('[data-tab="profiles"]').click();
  await options.locator('.profile', { hasText: 'localhost' }).getByRole('button', { name: '複製' }).click();
  assert.equal(await options.locator('#profile-from').inputValue(), 'localhost');
  await options.locator('#profile-site').fill('www.youtube.com'); await options.locator('#profile-form button').click();
  await until(async () => (await stored()).profiles['www.youtube.com'], 'duplicated'); const both = (await stored()).profiles;
  assert.deepEqual(both['www.youtube.com'], both.localhost);
  await options.locator('#profile-from').selectOption(''); await options.locator('#profile-site').fill('www.netflix.com'); await options.locator('#profile-form button').click();
  await until(async () => (await stored()).profiles['www.netflix.com'], 'a profile for a protected site can be kept');
  assert.match(await options.locator('.profile', { hasText: 'www.netflix.com' }).textContent(), /映像には連動しません/);
  assert.match(await options.locator('.profile', { hasText: 'www.netflix.com' }).textContent(), /プロファイルだけでは自動で点灯しません/);
  await options.screenshot({ path: 'artifacts/10-site-profiles.png', fullPage: true });
  await options.locator('.profile', { hasText: 'localhost' }).getByRole('button', { name: '明るさ をグローバル設定に戻す' }).click();
  await until(async () => !('brightness' in (await stored()).profiles.localhost), 'one item returned to global');
  await options.locator('#target').selectOption('localhost');   // deleting the profile that is being edited falls back to the global settings
  await options.locator('[data-remove="localhost"]').click();
  assert.ok((await stored()).profiles.localhost, 'one click does not delete'); await options.locator('[data-remove="localhost"]').click();
  await until(async () => !(await stored()).profiles.localhost, 'profile deleted'); assert.equal(await options.locator('#target').inputValue(), '');
  await page.bringToFront(); await expectState('Active');
  await until(async () => { const s = await status(); return s.profile === '' && s.perf.director === 'active'; }, 'the site is back on the global settings');
  assert.deepEqual(await used().then(s => [s.mode, s.brightness]), ['cinema', 65]);
  assert.deepEqual(Object.keys((await stored()).profiles).sort(), ['www.netflix.com', 'www.youtube.com']);
  assert.deepEqual(await sw.evaluate(async () => (await chrome.permissions.getAll()).origins), []);
  record('Site Profiles: create, edit (settings page and popup), inherit, duplicate, return single items, delete; applied per host and after navigation; other sites and global-only settings untouched; no site access requested');

  // ── Diagnostics page, next to a tab that is playing (its own window, so the video tab stays visible).
  await options.close();
  const windowed = context.waitForEvent('page');
  await sw.evaluate(() => chrome.windows.create({ url: chrome.runtime.getURL('options.html#diagnostics'), width: 1100, height: 900 }));
  const diagnostics = await windowed; diagnostics.on('pageerror', e => errors.push(`diagnostics: ${e}`));
  const read = () => diagnostics.evaluate(() => Object.fromEntries([...document.querySelectorAll('#diag-simple dt, #diag-full dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent])));
  const simple = await until(async () => { const v = await read(); return /fps/.test(v['Analysis FPS'] || '') && /fps/.test(v['Rendering FPS'] || '') ? v : false; }, 'live figures of the playing tab', 15000);
  assert.equal(simple['状態'], 'Active'); assert.equal(simple['描画方式'], 'Canvas 直接解析'); assert.match(simple['ゾーン'], /^64（光るゾーン 64）/);
  assert.match(simple['Light Director'], /動作中/); assert.equal(simple['プロファイル'], 'グローバル設定');
  assert.ok(parseFloat(simple['Analysis FPS']) > 8 && parseFloat(simple['Rendering FPS']) > 20);
  assert.equal(await diagnostics.locator('#diag-full').isHidden(), true, 'developer detail is off until asked for');
  await diagnostics.locator('#diag-detail').check();
  const detail = await until(async () => { const v = await read(); return v['解析時間'] ? v : false; }, 'developer detail');
  assert.match(detail['解析時間'], /\d+\.\d\d ms（うち 映像の読み出し \d+\.\d\d ms、Light Director \d+\.\d\d ms）/); assert.match(detail['映像の読み出し方'], /GPUで縮小|2D Canvas/); assert.match(detail['最初の描画までの遅延'], /\d+ ms/);
  assert.match(detail['予算を超えた処理'], /12 ms、描画 6 ms/); assert.match(await diagnostics.locator('#tab-diagnostics').textContent(), /CPU使用率・GPU使用率は表示しません/);
  await diagnostics.locator('#hud').check(); await until(() => page.locator('#eclirim-hud').count().then(n => n === 1), 'HUD switched on from the page');
  await diagnostics.screenshot({ path: 'artifacts/11-diagnostics.png', fullPage: true });
  await diagnostics.locator('#hud').uncheck(); await until(() => page.locator('#eclirim-hud').count().then(n => n === 0), 'and off');
  await diagnostics.close();
  record('Diagnostics page: simple view and developer detail show the playing tab\'s measured figures; HUD toggles from there; CPU/GPU are stated as not measured', { simple, detail });

  // ── Cost of the Light Director: the same moving scene, measured with it on and off.
  await page.bringToFront(); await scene('motion'); await expectState('Active');
  const cdpPage = await context.newCDPSession(page); await cdpPage.send('Performance.enable');
  const task = async () => (await cdpPage.send('Performance.getMetrics')).metrics.find(m => m.name === 'TaskDuration').value;
  const seconds = Number(process.env.COMPARE_SECONDS || 15);
  const measure = async on => {
    await director({ enabled: on }); await sleep(2000);
    const before = await status(), started = await task(), seen = [];
    for (let i = 0; i < seconds * 2; i++) { seen.push((await status()).perf); await sleep(500); }
    const after = await status();
    return { analysisMs: mean(seen.map(p => p.analysisMs)), directorMs: mean(seen.map(p => p.directorMs)), renderMs: mean(seen.map(p => p.renderMs)), analysisFps: mean(seen.map(p => p.analysisFps)),
      renderFps: mean(seen.map(p => p.renderFps)), latencyMs: mean(seen.map(p => p.latencyMs)), quality: Math.max(...seen.map(p => p.quality)),
      skippedAnalysis: after.perf.skippedAnalysis - before.perf.skippedAnalysis, skippedRender: after.perf.skippedRender - before.perf.skippedRender, overBudget: after.perf.overBudget - before.perf.overBudget,
      taskSecondsPerSecond: (await task() - started) / seconds };
  };
  const comparison = { date: '2026-10-09', browser: context.browser()?.version(), platform: process.platform, seconds, scene: 'Light Lab 02 (moving light), 64 zones, Cinema',
    off: await measure(false), on: await measure(true),
    note: 'Headless test browser on this Mac. taskSecondsPerSecond is the page\'s main thread (page script, synthetic video and extension together), not CPU load. Not a measurement on real sites.' };
  await writeFile('artifacts/performance-director.json', JSON.stringify(comparison, null, 2));
  assert.ok(comparison.on.directorMs > 0 && comparison.off.directorMs === 0); assert.ok(comparison.on.directorMs < 3, `Light Director stays cheap: ${comparison.on.directorMs} ms`);
  assert.ok(comparison.on.analysisFps > 9 && comparison.on.renderFps > 20 && comparison.on.quality === 0, 'full rate and full quality with the Light Director on');
  record(`Light Director cost, ${seconds}s each on the same scene`, comparison);

  // ── Site access and profiles are separate things, and stored data from 0.7.1 is brought forward.
  const copy = await mkdtemp(join(tmpdir(), 'eclirim-profiles-'));
  await cp('dist', copy, { recursive: true });
  const built = { ...JSON.parse(await readFile('dist/manifest.json', 'utf8')), host_permissions: ['http://localhost/*'] };
  await writeFile(join(copy, 'manifest.json'), JSON.stringify({ ...built, version: '0.7.1' }));
  const granted = await chromium.launchPersistentContext('', await quiet({ channel: 'chromium', headless: process.env.HEADED !== '1', viewport: { width: 1280, height: 900 },
    args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${copy}`, `--load-extension=${copy}`] }));
  try {
    let worker = granted.serviceWorkers()[0] || await granted.waitForEvent('serviceworker'); const extension = worker.url().split('/')[2];
    const manager = await granted.newPage(); await manager.goto('chrome://extensions');
    if (!await manager.locator('#devMode').evaluate(el => el.checked)) await manager.locator('#devMode').click();
    await manager.close();
    // What 0.7.1 had stored: settings only, in its shape.
    const old = { enabled: true, mode: 'vivid', source: 'video', brightness: 80, glowWidth: 14, intensity: 30, saturation: 120, smoothing: 20, responseSpeed: 150,
      zoneCount: 96, zoneMode: 'manual', flashLimiter: false, manualColor: '#112233', preset: 'moon', protectedLight: 'drift' };
    await worker.evaluate(async old => { await chrome.storage.local.clear(); await chrome.storage.local.set({ settings: old }); }, old);
    await writeFile(join(copy, 'manifest.json'), JSON.stringify(built));
    const before = worker; await worker.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 100); });
    worker = await until(() => granted.serviceWorkers().find(w => w !== before && w.url().includes(extension)), 'updated service worker');
    const migrated = await until(() => worker.evaluate(() => chrome.storage.local.get(null)).then(s => s.schema === 4 ? s : false, () => false), 'stored data brought to this version');
    for (const [key, value] of Object.entries(old)) assert.equal(migrated.settings[key], value, `kept: ${key}`);
    assert.deepEqual(migrated.settings.director, DIRECTOR); assert.equal(migrated.settings.zones, null); assert.deepEqual([migrated.settings.hud, migrated.settings.adaptive], [false, true]);
    assert.deepEqual(migrated.profiles, {});
    // Profiles for a site that is approved and for one that is not.
    await worker.evaluate(() => chrome.storage.local.set({ profiles: { localhost: { mode: 'ambient' }, '127.0.0.1': { mode: 'cinema' } } }));
    const approved = await granted.newPage(); approved.on('pageerror', e => errors.push(String(e)));
    await approved.goto('http://localhost:4173/'); await approved.locator('#play').waitFor(); await approved.bringToFront();
    await until(() => approved.locator('#eclirim-lighting').count().then(n => n === 1), 'the approved site lights by itself');
    const there = await until(() => worker.evaluate(async () => { const [tab] = await chrome.tabs.query({ url: 'http://localhost/*' }); return tab ? chrome.tabs.sendMessage(tab.id, { target: 'content', type: 'context' }).then(r => r.settings.mode, () => false) : false; }), 'its profile is in use');
    assert.equal(there, 'ambient', 'profile over the migrated global settings (vivid)');
    const unapproved = await granted.newPage(); await unapproved.goto('http://127.0.0.1:4173/'); await unapproved.locator('#play').waitFor(); await unapproved.bringToFront(); await sleep(2500);
    assert.equal(await unapproved.locator('#eclirim-lighting').count(), 0, 'a profile alone does not light a site');
    assert.deepEqual(await worker.evaluate(async () => (await chrome.permissions.getAll()).origins), ['http://localhost/*'], 'and it changes no permission');
    record('Update from 0.7.1 keeps every stored value and adds the new defaults; an approved site uses its profile, a profile alone neither lights a site nor changes permissions', { schema: migrated.schema });
  } finally { await granted.close(); await rm(copy, { recursive: true, force: true }); }
  assert.equal(errors.length, 0, errors.join('\n'));
} catch (e) {
  results.push({ name: 'Failure', result: 'FAIL', detail: String(e.stack || e) }); console.error(e);
  if (page) await page.screenshot({ path: 'artifacts/failure-cinematic.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile('artifacts/e2e-cinematic-results.json', JSON.stringify({ date: '2026-10-09', browser: context.browser()?.version(), platform: process.platform, results, errors }, null, 2));
  await context.close(); await server.close();
}
