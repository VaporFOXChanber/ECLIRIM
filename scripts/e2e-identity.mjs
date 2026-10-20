// 0.9.1 "Identity Update": the rename to ECLIRIM, Glow Designer, UI Guard, Adaptive Brightness, A/B Comparison and the
// Calibration Wizard, driven through the production build in a real browser. Earlier behaviour stays covered by e2e.mjs,
// e2e-cinematic.mjs and e2e-resonance.mjs. The browser is headless: what the tests read is what the extension painted.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { serve } from './serve.mjs';
import { openPopup } from './cdp-popup.mjs';
import { quiet } from './browser.mjs';
const baselineZip = process.env.ECLIRIM_IDENTITY_BASELINE_ZIP;
if (!baselineZip) throw new Error('Supply ECLIRIM_IDENTITY_BASELINE_ZIP with a locally retained baseline ZIP; historical binaries are not included in this public source snapshot.');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The version this build says it is: checked against package.json, so a release only changes it in one place.
const VERSION = JSON.parse(await readFile('package.json', 'utf8')).version;
const results = [], errors = [];
await mkdir('artifacts', { recursive: true });
const server = await serve();
const launch = async dist => chromium.launchPersistentContext('', await quiet({
  channel: 'chromium', headless: process.env.HEADED !== '1', viewport: { width: 1280, height: 900 }, acceptDownloads: true,
  args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--autoplay-policy=no-user-gesture-required']
}));
const context = await launch(resolve('dist'));
let page, sw, cdp, id, tabId, popup;
const until = async (fn, label, timeout = 10000) => {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(120); }
  throw new Error(`Timed out: ${label}; last=${JSON.stringify(last)}`);
};
const record = (name, detail = '') => { results.push({ name, result: 'PASS', detail }); console.log('PASS', name, detail); };
const status = (tab = tabId) => sw.evaluate(id => chrome.tabs.sendMessage(id, { target: 'content', type: 'status' }), tab);
const used = (tab = tabId) => sw.evaluate(id => chrome.tabs.sendMessage(id, { target: 'content', type: 'context' }), tab).then(r => r.settings);
const stored = () => sw.evaluate(() => chrome.storage.local.get(['settings', 'profiles', 'presets', 'schema', 'compare']));
const set = changes => sw.evaluate(async changes => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, ...changes } });
}, changes);
const GLOW = { style: 'edge', thickness: 50, curve: 50, falloff: 50, softness: 50 }, HALO = { style: 'halo', thickness: 40, curve: 55, falloff: 45, softness: 70 };
const GUARD = { enabled: true, strength: 60, pointer: true }, EXPOSURE = { enabled: true, dark: 50, bright: 50, speed: 50 };
const DIRECTOR = { enabled: true, motion: 50, source: 50, strength: 35, response: 60, smoothing: 60 };
const guardOff = { ...GUARD, enabled: false }, exposureOff = { ...EXPOSURE, enabled: false }, cap = strength => .6 - .48 * strength / 100;
const expectState = wanted => until(async () => { const s = await status().catch(() => null); return s?.state === wanted ? s : false; }, wanted);
const scene = name => page.evaluate(name => document.querySelector(`[data-scene="${name}"]`).click(), name);
const press = selector => page.evaluate(selector => document.querySelector(selector).click(), selector);
const HOST = '#eclirim-lighting';
// The light at a point of the page: [r, g, b, alpha] of the edge canvas lying over it (the strongest, where two overlap).
const lightAt = (x, y, target = page, host = HOST) => target.evaluate(([x, y, host]) => {
  const root = document.querySelector(host)?.shadowRoot; let best = [0, 0, 0, 0];
  for (const c of root ? root.querySelectorAll('canvas') : []) {
    const r = c.getBoundingClientRect();
    if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) continue;
    const d = c.getContext('2d').getImageData(Math.floor((x - r.left) / r.width * c.width), Math.floor((y - r.top) / r.height * c.height), 1, 1).data;
    if (d[3] >= best[3]) best = Array.from(d);
  }
  return best;
}, [x, y, host]);
const alphaAt = async (x, y) => (await lightAt(x, y))[3];
// Opacity from the top edge inward, at the middle of the page: one value per row of the canvas.
const column = (at = .5) => page.evaluate(([host, at]) => {
  const c = document.querySelector(host).shadowRoot.querySelector('canvas[data-side="top"]');
  return Array.from(c.getContext('2d').getImageData(Math.floor(c.width * at), 0, 1, c.height).data).filter((_, i) => i % 4 === 3);
}, [HOST, at]);
// Opacity along the top edge on its outermost row.
const along = () => page.evaluate(host => {
  const c = document.querySelector(host).shadowRoot.querySelector('canvas[data-side="top"]');
  return Array.from(c.getContext('2d').getImageData(0, 1, c.width, 1).data).filter((_, i) => i % 4 === 3);
}, HOST);
const center = selector => page.evaluate(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; }, selector);
const slide = (target, selector, value) => target.locator(selector).evaluate((el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
const mean = values => values.reduce((n, v) => n + v, 0) / values.length;
const settle = (ms = 2600) => sleep(ms);
// For failure messages: everything about the light that can be seen from the page. (A reading of 0 some seconds after a
// settings change has stopped this suite a few times since 0.9.1 and has not been reproduced on purpose.)
const lightDump = () => page.evaluate(host => {
  const element = document.querySelector(host), root = element?.shadowRoot, v = document.querySelector('video');
  return { inner: [innerWidth, innerHeight], visibility: document.visibilityState, parent: element?.parentNode?.nodeName, style: element?.getAttribute('style')?.match(/visibility:[^;]+/)?.[0],
    canvases: root ? [...root.querySelectorAll('canvas')].map(c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let max = 0, lit = 0; for (let i = 3; i < d.length; i += 4) { if (d[i] > max) max = d[i]; if (d[i]) lit++; } return `${c.dataset.side} ${c.style.width}x${c.style.height} max ${max} lit ${lit}`; }) : null,
    video: { time: v?.currentTime, paused: v?.paused, readyState: v?.readyState, stream: !!v?.srcObject }, hud: document.querySelector('#eclirim-hud')?.shadowRoot?.textContent?.slice(0, 700) };
}, HOST).catch(error => String(error)).then(async seen => ({ seen, inside: await sw.evaluate(id => chrome.tabs.sendMessage(id, { target: 'content', type: 'probe' }), tabId).catch(error => String(error)) }));
// Stored objects come back with their keys in another order, so they are compared by content.
const same = (a, b) => { try { assert.deepEqual(a, b); return true; } catch { return false; } };
const openPopupOn = async (target = page) => { await target.bringToFront(); const p = await openPopup(cdp, id, target.url()); await sleep(450); return p; };
const pop = (expression) => popup.evaluate(expression);
try {
  sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); id = sw.url().split('/')[2];
  cdp = await context.browser().newBrowserCDPSession(); page = await context.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto('http://localhost:4173'); await page.locator('#play').waitFor();

  // ── The name, the icon, and what has not changed.
  const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
  const former = JSON.parse(execFileSync('unzip', ['-p', baselineZip, 'manifest.json'], { encoding: 'utf8' }));
  assert.deepEqual([manifest.name, manifest.short_name, manifest.version, manifest.action.default_title], ['ECLIRIM', 'ECLIRIM', VERSION, 'ECLIRIM']);
  assert.deepEqual([former.name, former.version], ['CineGlow', '0.9.0']);
  assert.deepEqual(manifest.permissions, former.permissions, 'the same permissions as 0.9.0');
  assert.deepEqual(manifest.optional_host_permissions, former.optional_host_permissions); assert.equal(manifest.host_permissions, undefined); assert.equal(manifest.key, undefined, 'no key: the id stays the one Chrome derives');
  assert.deepEqual(manifest.content_security_policy, former.content_security_policy); assert.equal(manifest.minimum_chrome_version, former.minimum_chrome_version);
  const icons = await sw.evaluate(async sizes => Promise.all(sizes.map(async size => {
    const blob = await (await fetch(chrome.runtime.getURL(`icons/icon-${size}.png`))).blob(), image = await createImageBitmap(blob);
    return [image.width, image.height, blob.type];
  })), [16, 32, 48, 128]);
  assert.deepEqual(icons, [16, 32, 48, 128].map(size => [size, size, 'image/png'])); assert.deepEqual(Object.keys(manifest.icons), ['16', '32', '48', '128']);
  assert.equal(await sw.evaluate(() => chrome.action.getTitle({})), 'ECLIRIM');
  const commands = await sw.evaluate(() => chrome.commands.getAll());
  assert.ok(commands.some(c => c.name === 'compare-switch' && /A\/B/.test(c.description)), 'a keyboard command for switching A/B');
  popup = await openPopupOn();
  assert.deepEqual(await pop('[document.title, document.querySelector("h1").textContent, document.querySelector("img.mark").naturalWidth > 0]'), ['ECLIRIM', 'ECLIRIM', true]);
  await pop('document.querySelector("#start").click()');
  tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
  await expectState('Active'); await popup.close();
  await set({ zoneMode: 'manual', zoneCount: 64 }); await until(async () => (await status()).zoneCount === 64, '64 zones');
  const marks = await page.evaluate(() => ({ now: document.querySelectorAll('#eclirim-lighting').length, before: document.querySelectorAll('[id^="cineglow"]').length }));
  assert.deepEqual(marks, { now: 1, before: 0 });
  const fresh = await stored();
  assert.deepEqual([fresh.settings.glow, fresh.settings.guard, fresh.settings.exposure], [GLOW, GUARD, EXPOSURE], 'the new parts start at their defaults');
  assert.equal(fresh.compare, undefined);
  const options = await context.newPage(); options.on('pageerror', e => errors.push(`options: ${e}`));
  await options.goto(`chrome-extension://${id}/options.html`);
  assert.deepEqual(await options.evaluate(() => [document.title, document.querySelector('h1').textContent, document.querySelector('#version').textContent, document.querySelector('img.mark').naturalWidth > 0]), ['ECLIRIM 設定', 'ECLIRIM', `v${VERSION}`, true]);
  const sections = ['lighting', 'glow', 'director', 'pulse', 'studio', 'wizard', 'presets', 'profiles', 'diagnostics', 'feedback'];
  assert.deepEqual(await options.evaluate(() => [...document.querySelectorAll('[role=tab]')].map(b => b.dataset.tab)), sections);
  assert.deepEqual(await options.evaluate(() => [...document.querySelector('#section-select').options].map(o => o.value)), sections);
  record('Renamed to ECLIRIM: name, title, icons (16/32/48/128) and pages; permissions, CSP and minimum Chrome are those of 0.9.0; no key in the manifest', { permissions: manifest.permissions, optional: manifest.optional_host_permissions });

  // ── Edge Light at its defaults is the light of 0.9.0: the real 0.9.0 build paints the same pixels.
  const edgeData = (target, host) => target.evaluate(host => Array.from(document.querySelector(host).shadowRoot.querySelectorAll('canvas')).map(c => Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data)), host);
  const quiet = { director: { ...DIRECTOR, enabled: false }, zoneMode: 'manual', zoneCount: 64 };
  await page.bringToFront(); await set({ ...quiet, guard: guardOff, exposure: exposureOff }); await scene('split'); await expectState('Active'); await sleep(6000);
  const mine = await edgeData(page, HOST);
  const earlier = await mkdtemp(join(tmpdir(), 'eclirim-090-'));
  execFileSync('unzip', ['-q', baselineZip, '-d', earlier]);
  const old = await launch(earlier);
  let identical;
  try {
    const worker = old.serviceWorkers()[0] || await old.waitForEvent('serviceworker'), oldCdp = await old.browser().newBrowserCDPSession(), oldId = worker.url().split('/')[2];
    const tab = await old.newPage(); await tab.goto('http://localhost:4173'); await tab.locator('#play').waitFor();
    const p = await openPopup(oldCdp, oldId, tab.url()); await sleep(400); await p.evaluate('document.querySelector("#start").click()'); await sleep(900); await p.close();
    await worker.evaluate(async quiet => { const { settings = {} } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, ...quiet } }); }, quiet);
    await sleep(6000);
    const theirs = await edgeData(tab, '#cineglow-lighting');
    // Compared as what reaches the screen: opacity, and colour times opacity. (A canvas stores colour that way; read back as
    // plain colour, a nearly transparent pixel has only a few possible values, so one step of rounding looks like a jump.)
    let lit = 0, differingAlpha = 0, largestAlpha = 0, differingLight = 0, largestLight = 0;
    theirs.forEach((canvas, side) => { for (let i = 0; i < canvas.length; i += 4) {
      const a = canvas[i + 3], b = mine[side][i + 3], d = Math.abs(a - b);
      if (a > 0) lit++; if (d) differingAlpha++; largestAlpha = Math.max(largestAlpha, d);
      for (let k = 0; k < 3; k++) { const light = Math.abs(canvas[i + k] * a - mine[side][i + k] * b) / 255; if (light > .5) differingLight++; largestLight = Math.max(largestLight, light); }
    } });
    identical = { canvases: theirs.length, pixels: theirs.reduce((n, c) => n + c.length / 4, 0), litPixels: lit, differingAlpha, largestAlpha, differingLight, largestLight: Number(largestLight.toFixed(2)) };
    assert.equal(theirs.length, 4); assert.ok(lit > 50000, `the 0.9.0 build is lit: ${lit}`);
    assert.ok(largestAlpha <= 1 && largestLight <= 1.5 && differingAlpha + differingLight < identical.pixels / 500, `same light as 0.9.0: ${JSON.stringify(identical)}`);
  } finally { await old.close(); await rm(earlier, { recursive: true, force: true }); }
  record('Edge Light at its defaults (UI Guard and Adaptive Brightness off) paints the same pixels as the real 0.9.0 build on the same picture', identical);

  // ── Glow Designer: two styles, four sliders, the edge always the brightest place.
  await set({ director: DIRECTOR }); await scene('snow'); await expectState('Active'); await settle(3200);
  const edgeColumn = await column();
  popup = await openPopupOn();
  assert.deepEqual(await pop('[...document.querySelectorAll("[data-glow]")].map(b => [b.dataset.glow, b.getAttribute("aria-pressed")])'), [['edge', 'true'], ['halo', 'false']]);
  await pop('document.querySelector("[data-glow=halo]").click()'); await popup.close();
  await until(async () => (await stored()).settings.glow.style === 'halo', 'Soft Halo chosen in the popup');
  assert.deepEqual((await stored()).settings.glow, HALO, 'choosing a style sets its own starting point'); await page.bringToFront(); await settle();
  const haloColumn = await column();
  const falling = values => values.every((v, i) => !i || v <= values[i - 1] + 1);
  assert.ok(falling(edgeColumn) && falling(haloColumn), 'both styles only ever fall from the edge inward');
  assert.equal(Math.max(...edgeColumn), edgeColumn[0]); assert.equal(Math.max(...haloColumn), haloColumn[0]);
  assert.ok(haloColumn[0] > edgeColumn[0] * .74 && haloColumn[0] < edgeColumn[0] * .86, `Soft Halo has no strip at full strength: ${haloColumn[0]} against ${edgeColumn[0]}`);
  assert.ok(haloColumn[38] > edgeColumn[38] * 1.15, `and more light further in: ${haloColumn[38]} against ${edgeColumn[38]}`);
  assert.ok(edgeColumn[95] <= 1 && haloColumn[95] <= 1, 'both are gone at their inner limit');
  await page.screenshot({ path: 'artifacts/16-soft-halo.png' });
  // The Glow Designer page: the same settings, a preview painted by the real renderer, and the curve.
  await options.bringToFront(); await options.reload(); await options.locator('[data-tab="glow"]').click(); await sleep(900);
  assert.deepEqual(await options.evaluate(() => [...document.querySelectorAll('#tab-glow [data-glow]')].map(b => b.getAttribute('aria-pressed'))), ['false', 'true']);
  assert.deepEqual(await options.evaluate(() => ['thickness', 'curve', 'falloff', 'softness'].map(key => document.querySelector(`#glow-${key}`).value)), ['40', '55', '45', '70']);
  const previewed = await options.evaluate(() => {
    const stage = document.querySelector('#glow-stage #eclirim-lighting').shadowRoot.querySelector('canvas[data-side="top"]'), curve = document.querySelector('#glow-graph');
    const drawn = Array.from(curve.getContext('2d').getImageData(0, 0, curve.width, curve.height).data).filter((v, i) => i % 4 === 3 && v > 0).length;
    return { lit: Array.from(stage.getContext('2d').getImageData(0, 1, stage.width, 1).data).filter((v, i) => i % 4 === 3 && v > 20).length, drawn };
  });
  assert.ok(previewed.lit > 100 && previewed.drawn > 5000, `the preview is painted and the curve is drawn: ${JSON.stringify(previewed)}`);
  await options.screenshot({ path: 'artifacts/15-glow-designer.png', fullPage: true });
  await options.locator('#tab-glow [data-glow="edge"]').click(); await until(async () => (await stored()).settings.glow.style === 'edge', 'back to Edge Light');
  assert.deepEqual((await stored()).settings.glow, GLOW);
  const shaped = async (key, value) => { await options.bringToFront(); await slide(options, `#glow-${key}`, value); await until(async () => (await stored()).settings.glow[key] === value, `${key} stored`); await page.bringToFront(); await settle(1800); return column(); };
  const full = values => values.filter(v => v >= values[0] * .985).length;
  const thick = await shaped('thickness', 100), thin = await shaped('thickness', 0); await shaped('thickness', 50);
  assert.ok(full(thick) >= full(edgeColumn) + 4 && full(thin) <= full(edgeColumn), `Source Thickness widens the strip: ${full(thin)} / ${full(edgeColumn)} / ${full(thick)} rows at full strength`);
  const fast = await shaped('falloff', 100), slow = await shaped('falloff', 0); await shaped('falloff', 50);
  assert.ok(fast[30] < edgeColumn[30] * .7 && slow[30] > edgeColumn[30] * 1.3, `Falloff: ${fast[30]} / ${edgeColumn[30]} / ${slow[30]} a third of the way in`);
  const held = await shaped('curve', 100), spiked = await shaped('curve', 0); await shaped('curve', 50);
  assert.ok(held[8] > spiked[8] && held[45] < spiked[45], `Diffusion Curve: near the edge ${spiked[8]} → ${held[8]}, far in ${spiked[45]} → ${held[45]}`);
  for (const values of [thick, thin, fast, slow, held, spiked]) { assert.ok(falling(values)); assert.equal(Math.max(...values), values[0]); }
  // Softness along the edge: one bright window in a dark picture spreads further along the top.
  await set({ exposure: exposureOff, director: { ...DIRECTOR, enabled: false } }); await scene('lamp'); await settle(3000);
  const spread = values => values.filter(v => v > Math.max(...values) * .2).length, crisp = spread(await along());
  await set({ glow: { ...GLOW, softness: 100 } }); await settle(1800); const softened = spread(await along());
  await set({ glow: HALO }); await settle(1800); const haloed = spread(await along());
  assert.ok(softened > crisp * 1.08 && haloed > crisp * 1.08, `Softness lets the light run along the edge: ${crisp} → ${softened} samples lit (Soft Halo ${haloed}); ${JSON.stringify(await lightDump())}; ${JSON.stringify(await status())}`);
  await options.bringToFront(); await options.reload(); await options.locator('[data-tab="glow"]').click(); await sleep(700);
  await slide(options, '#glow-thickness', 90); await until(async () => (await stored()).settings.glow.thickness === 90, 'a Soft Halo slider moved');
  await options.locator('#glow-reset').click();
  await until(async () => same((await stored()).settings.glow, HALO), 'reset to the style\'s own values');
  // The compositor's light (DRM-compatible rendering) takes the same shape.
  await page.bringToFront(); await set({ source: 'compatibility', glow: GLOW }); await expectState('Compatibility Mode');
  const maskOf = () => page.evaluate(() => document.querySelector('#eclirim-compatibility').shadowRoot.querySelector('[data-side="rows"]').style.getPropertyValue('mask-image'));
  const edgeMask = await maskOf(); await set({ glow: HALO }); await until(async () => await maskOf() !== edgeMask, 'the compositor light follows the Glow Designer');
  // Chrome hands the gradient back in its own spelling: the opacity of the first stop of the glow's own gradient is what counts.
  const atEdge = mask => { const found = mask.match(/linear-gradient\(to (?:bottom|top), rgba?\(0, 0, 0(?:, ([\d.]+))?\) 0px/); return found ? Number(found[1] ?? 1) : -1; };
  assert.deepEqual([atEdge(edgeMask), atEdge(await maskOf())], [1, .8], `Soft Halo starts below full strength there too: ${(await maskOf()).slice(0, 260)}`);
  await set({ source: 'video', glow: GLOW, exposure: EXPOSURE, director: DIRECTOR }); await expectState('Active');
  record('Glow Designer: Edge Light and Soft Halo both fall monotonically from the outermost edge; Thickness, Curve, Falloff and Softness each do what they say; the popup, the settings page with its live preview, and the compositor path all use it',
    { atEdge: { edge: edgeColumn[0], halo: haloColumn[0] }, at40percent: { edge: edgeColumn[38], halo: haloColumn[38] }, rowsAtFullStrength: { thin: full(thin), standard: full(edgeColumn), thick: full(thick) },
      aThirdIn: { fastFalloff: fast[30], standard: edgeColumn[30], slowFalloff: slow[30] }, alongTheEdge: { crisp, softened, haloed }, previewed });

  // ── UI Guard: the light is held back over controls and text, and only there.
  await page.bringToFront(); await scene('snow'); await press('[data-ui="show"]');
  popup = await openPopupOn();
  await pop('(() => { const s = document.querySelector("#library"); s.value = "b:Overkill"; s.dispatchEvent(new Event("change", { bubbles: true })); })()'); await popup.close();
  await until(async () => (await stored()).settings.brightness === 100, 'Overkill applied');
  assert.deepEqual((await stored()).settings.guard, guardOff, 'a preset leaves the UI Guard as the user has it (here: off)');
  const overkillGlow = (await stored()).settings.glow;
  await page.bringToFront(); await page.mouse.move(640, 450); await settle(3200);
  const spots = { like: await center('#g-like'), search: await center('#guard-ui input'), text: await center('.g-right'), play: await center('.g-left button'), seek: await center('.g-seek') };
  // Places with nothing under the light, as far in from their edge as the like button and the play button are from theirs.
  const bare = { top: [640, spots.like[1]], left: [spots.play[0], 170] }, ghost = await center('.g-ghost');
  const read = async points => Object.fromEntries(await Promise.all(Object.entries(points).map(async ([name, [x, y]]) => [name, await alphaAt(x, y)])));
  const without = await read({ ...spots, ...bare, ghost });
  await page.screenshot({ path: 'artifacts/17-ui-guard-off.png' });
  for (const name of Object.keys(spots)) assert.ok(without[name] > 120, `without the guard the light lies thick over the ${name}: ${without[name]}`);
  await set({ guard: GUARD });
  const guarding = await until(async () => { const s = await status(); return s.guard?.state === 'active' && s.guard.held >= 3 ? s.guard : false; }, 'the guard takes hold');
  await settle(1500);
  const guarded = await read({ ...spots, ...bare, ghost }), limit = cap(GUARD.strength) * 255;
  await page.screenshot({ path: 'artifacts/18-ui-guard-on.png' });
  for (const name of Object.keys(spots)) assert.ok(guarded[name] <= limit + 4, `over the ${name} the light is at most the limit (${limit.toFixed(0)}): ${guarded[name]}`);
  for (const name of Object.keys(bare)) assert.ok(Math.abs(guarded[name] - without[name]) <= 3, `where nothing is to be read (${name}), the light is untouched: ${without[name]} → ${guarded[name]}`);
  assert.ok(Math.abs(guarded.ghost - without.ghost) <= 3, 'text that takes no clicks cannot be found, as documented');
  // The outermost line of the edge is the light source: it stays lit right above a control, and the light is held back
  // from just inside it. With Overkill's thick strip (already measured above) and with the standard one.
  const stripWithout = [await alphaAt(spots.like[0], 1), without.like], stripGuarded = [await alphaAt(spots.like[0], 1), guarded.like];
  await set({ guard: guardOff }); await settle(2000); stripWithout[0] = await alphaAt(spots.like[0], 1);
  await set({ glow: GLOW }); await settle(2200); const standardWithout = [await alphaAt(spots.like[0], 1), await alphaAt(...spots.like)];
  await set({ guard: GUARD }); await until(async () => (await status()).guard.held >= 3, 'the guard takes hold again'); await settle(1500);
  const standardGuarded = [await alphaAt(spots.like[0], 1), await alphaAt(...spots.like)];
  for (const [label, off, on] of [['Overkill', stripWithout, stripGuarded], ['standard strip', standardWithout, standardGuarded]]) {
    assert.ok(Math.abs(on[0] - off[0]) <= 3 && off[0] > 200, `${label}: the outermost line stays lit above the button: ${off[0]} → ${on[0]}`);
    assert.ok(off[1] > 120 && on[1] <= limit + 4, `${label}: while the button itself is guarded: ${off[1]} → ${on[1]}`);
  }
  await set({ glow: overkillGlow }); await settle(2200);
  // The light never takes a click: the button under it works.
  await page.mouse.click(...spots.like); assert.equal(await page.evaluate(() => document.querySelector('#g-count').textContent), '1');
  await page.mouse.move(640, 450);
  // Controls that have faded out are no longer guarded; when they come back, they are again.
  await press('[data-ui="fade"]');
  await until(async () => await alphaAt(...spots.play) > without.play - 12, 'the light returns over a control that has faded out', 6000);
  const began = Date.now(); await press('[data-ui="fade"]'); await page.mouse.move(640, 452);
  await until(async () => await alphaAt(...spots.play) <= limit + 4, 'the guard returns with the control', 4000);
  const returned = Date.now() - began;
  // Stricter and looser.
  await set({ guard: { ...GUARD, strength: 100 } }); await settle(1600); const strict = await alphaAt(...spots.like);
  await set({ guard: { ...GUARD, strength: 0 } }); await settle(2200); const loose = await alphaAt(...spots.like);
  assert.ok(strict <= cap(100) * 255 + 4 && loose > limit + 20 && loose <= cap(0) * 255 + 4, `Guard Strength: ${loose} (0%) / ${guarded.like} (60%) / ${strict} (100%)`);
  await set({ guard: GUARD });
  // A dim scene: the light is thin anyway, so nothing is held back although the controls are there.
  popup = await openPopupOn();
  await pop('(() => { const s = document.querySelector("#library"); s.value = "b:Cinematic Balanced"; s.dispatchEvent(new Event("change", { bubbles: true })); })()'); await popup.close();
  await page.bringToFront(); await scene('night'); await page.mouse.move(640, 450);
  const resting = await until(async () => { const s = await status(); return s.guard?.regions >= 3 && s.guard.held === 0 ? s.guard : false; }, 'nothing held back in a dim scene', 15000);
  // The light of the bright scene before has to have died away before the two can be compared.
  await settle(5000); const dimGuarded = await read(spots); await set({ guard: guardOff }); await settle(1800); const dimWithout = await read(spots);
  for (const name of Object.keys(spots)) assert.ok(Math.abs(dimGuarded[name] - dimWithout[name]) <= 2, `dim scene, ${name}: ${dimWithout[name]} → ${dimGuarded[name]}`);
  // The pointer near an edge counts as something to keep readable, at once, where nothing else was found.
  await press('[data-ui="show"]'); await scene('snow');
  popup = await openPopupOn();
  await pop('(() => { const s = document.querySelector("#library"); s.value = "b:Overkill"; s.dispatchEvent(new Event("change", { bubbles: true })); })()'); await popup.close();
  await page.bringToFront(); await page.mouse.move(640, 450); await set({ guard: GUARD }); await settle(3200);
  const idle = await alphaAt(30, 600);
  const wiggle = async () => { for (let i = 0; i < 6; i++) { await page.mouse.move(30 + (i % 2) * 10, 600 + i * 2); await sleep(60); } };
  await wiggle(); await sleep(350); const pointed = await alphaAt(30, 600);
  assert.ok(idle > 120 && pointed <= limit + 4, `the light eases around the moving pointer: ${idle} → ${pointed}`);
  await page.mouse.move(640, 450);
  await until(async () => await alphaAt(30, 600) > idle - 10, 'and returns when the pointer has gone', 7000);
  await set({ guard: { ...GUARD, pointer: false } }); await sleep(500); await wiggle(); await sleep(450);
  assert.ok(await alphaAt(30, 600) > idle - 10, 'with the pointer option off, the pointer changes nothing');
  await page.mouse.move(640, 450); await set({ guard: GUARD });
  // Its switch in the popup, and where it cannot work.
  popup = await openPopupOn();
  assert.equal(await pop('document.querySelector("#guard").checked'), true);
  await pop('document.querySelector("#guard").click()'); await until(async () => (await stored()).settings.guard.enabled === false, 'UI Guard switched off in the popup');
  await until(async () => (await status()).guard.state === 'off', 'the tab says so');
  assert.match(await pop('document.querySelector("#guard-note").textContent'), /オフ/);
  await pop('document.querySelector("#guard").click()'); await until(async () => (await stored()).settings.guard.enabled === true, 'and on again'); await popup.close();
  await set({ source: 'compatibility' }); await until(async () => (await status()).guard?.state === 'unavailable', 'out of reach on the compositor path');
  await set({ source: 'video' }); await expectState('Active');
  record('UI Guard: over buttons, an input, a slider and text the light stays at or under the limit even at Overkill, elsewhere and on the outermost strip it is untouched; clicks pass; faded-out controls are released; a dim scene holds nothing back; the pointer is guarded at once',
    { limit: Math.round(limit), without, guarded, outermostLine: { overkill: { without: stripWithout, guarded: stripGuarded }, standard: { without: standardWithout, guarded: standardGuarded } }, strict, loose, guarding, returnedAfterMs: returned, dimScene: { resting, dimWithout, dimGuarded }, pointer: { idle, pointed } });

  // ── Adaptive Brightness: bright scenes come down, dark scenes hold back bright zones only, the middle is left alone.
  popup = await openPopupOn();
  await pop('(() => { const s = document.querySelector("#library"); s.value = "b:Cinematic Balanced"; s.dispatchEvent(new Event("change", { bubbles: true })); })()'); await popup.close();
  await page.bringToFront(); await page.mouse.move(640, 450); await set({ guard: guardOff, director: { ...DIRECTOR, enabled: false } });
  const topRow = async () => { const values = await along(); return { middle: values[256], side: values[60] }; };
  const bottomMiddle = () => alphaAt(640, 898);
  const measure = async name => {
    await scene(name); await set({ exposure: EXPOSURE });
    const on = await until(async () => { const s = await status(); return s.exposure?.state === 'active' ? s.exposure : false; }, `${name}: following the picture`);
    await settle(5200); const followed = (await status()).exposure, lit = { ...await topRow(), bottom: await bottomMiddle() };
    await set({ exposure: exposureOff }); await until(async () => (await status()).exposure.state === 'off', 'switched off'); await settle(3200);
    const off = { ...await topRow(), bottom: await bottomMiddle() };
    // A light that reads as nothing at all is not a measurement of Adaptive Brightness: say what was there instead.
    assert.ok(off.middle > 0 && lit.middle > 0, `${name}: the light is there to be measured: on ${JSON.stringify(lit)}, off ${JSON.stringify(off)}; ${JSON.stringify(await lightDump())}; ${JSON.stringify(await status())}`);
    return { key: followed.key, level: followed.level, on: lit, off, first: on.key };
  };
  const snow = await measure('snow'), split = await measure('split'), lamp = await measure('lamp');
  assert.ok(snow.key > .85 && Math.abs(snow.level - .75) < .02, `a bright scene: ${JSON.stringify(snow)}`);
  assert.ok(snow.on.middle < snow.off.middle * .88 && snow.on.middle > snow.off.middle * .65 && snow.on.bottom < snow.off.bottom * .88, `all of the light comes down, by about a fifth of its opacity: ${snow.off.middle} → ${snow.on.middle}`);
  assert.ok(split.key > .45 && split.key < .58 && split.level === 1, `an ordinary scene: ${JSON.stringify(split)}`);
  assert.ok(Math.abs(split.on.middle - split.off.middle) <= 1 && Math.abs(split.on.side - split.off.side) <= 1 && Math.abs(split.on.bottom - split.off.bottom) <= 1, 'is not touched at all');
  assert.ok(lamp.key < .22 && Math.abs(lamp.level - .8) < .02, `a dark scene with one bright window: ${JSON.stringify(lamp)}`);
  assert.ok(lamp.on.middle < lamp.off.middle * .92 && lamp.on.middle > lamp.off.middle * .7, `the bright window is held back: ${lamp.off.middle} → ${lamp.on.middle}`);
  assert.ok(lamp.off.bottom > 4 && Math.abs(lamp.on.bottom - lamp.off.bottom) <= 1, `the dim blue along the bottom glows exactly as before: ${lamp.off.bottom} → ${lamp.on.bottom}`);
  await set({ exposure: EXPOSURE, source: 'manual' }); await until(async () => (await status()).exposure?.state === 'unavailable', 'no picture, nothing to follow');
  await set({ source: 'video', director: DIRECTOR }); await expectState('Active');
  popup = await openPopupOn();
  assert.equal(await pop('document.querySelector("#exposure").checked'), true);
  await pop('document.querySelector("#exposure").click()'); await until(async () => (await stored()).settings.exposure.enabled === false, 'switched off in the popup');
  assert.match(await pop('document.querySelector("#exposure-note").textContent'), /オフ/);
  await pop('document.querySelector("#exposure").click()'); await until(async () => (await stored()).settings.exposure.enabled === true, 'and on again'); await popup.close();
  await options.bringToFront(); await options.reload(); await options.locator('[data-tab="lighting"]').click();
  await slide(options, '#exposure-dark', 80); await slide(options, '#guard-strength', 75);
  await until(async () => { const s = (await stored()).settings; return s.exposure.dark === 80 && s.guard.strength === 75; }, 'the settings page writes both groups');
  await options.screenshot({ path: 'artifacts/19-guard-and-adaptive.png', fullPage: true });
  await set({ exposure: EXPOSURE, guard: GUARD });
  record('Adaptive Brightness: a bright scene makes all of the light a quarter less bright, a dark scene holds back its bright window and leaves the dim zones exactly as they were, an ordinary scene is untouched; off, and where no picture is read, it does nothing', { snow, split, lamp });

  // ── A/B Comparison: two looks, switched at once, nothing saved until one is chosen.
  await page.bringToFront(); await scene('split'); await expectState('Active');
  const before = await stored();
  popup = await openPopupOn();
  assert.deepEqual(await pop('[document.querySelector("#compare-bar").hidden, document.querySelector("#compare-start").hidden]'), [true, false]);
  await pop('document.querySelector("#compare-start").click()');
  const started = await until(async () => (await stored()).compare, 'a comparison is stored');
  assert.equal(started.active, 'b'); assert.equal(started.target, ''); assert.deepEqual(started.a, started.b, 'both sides start as the current look'); assert.equal(started.a.brightness, before.settings.brightness);
  await pop('(() => { const el = document.querySelector("#brightness"); el.value = "20"; el.dispatchEvent(new Event("input", { bubbles: true })); })()');
  await until(async () => (await stored()).compare?.b.brightness === 20, 'the change went to B');
  assert.deepEqual((await stored()).settings, before.settings, 'the saved settings are untouched');
  await until(async () => (await used()).brightness === 20 && (await status()).compare === 'b', 'the tab shows B');
  assert.match(await page.evaluate(() => document.querySelector('#eclirim-compare')?.shadowRoot.textContent || ''), /B を表示中/);
  await settle(1800); const lightB = (await along())[256];
  const flipped = Date.now(); await pop('document.querySelector("[data-side=a]").click()');
  await until(async () => (await status()).compare === 'a' && (await used()).brightness === before.settings.brightness, 'the tab shows A');
  const switchMs = Date.now() - flipped; await settle(1800); const lightA = (await along())[256];
  assert.ok(lightA > lightB * 1.5, `A and B really look different: ${lightA} against ${lightB}`);
  await pop('document.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }))'); await until(async () => (await status()).compare === 'b', 'the B key switches too');
  assert.match(await pop('document.querySelector("#compare-hint").textContent'), /B に入ります/);
  await until(async () => /A\/B B/.test(await pop('document.querySelector("#metrics").textContent')), 'the popup says which side the tab is showing');
  await popup.close();
  // Closing the popup does not end it, and the settings page takes it up where it stands.
  await options.bringToFront(); await options.reload(); await sleep(500);
  assert.deepEqual(await options.evaluate(() => [document.querySelector('#compare-bar').hidden, document.querySelector('#target').disabled, document.querySelector('[data-side="b"]').getAttribute('aria-pressed')]), [false, true, 'true']);
  assert.match(await options.locator('#compare-diff').textContent(), /A と B の違い: 明るさ。/);
  await options.locator('[data-tab="glow"]').click(); await options.locator('#tab-glow [data-glow="halo"]').click();
  await until(async () => (await stored()).compare?.b.glow.style === 'halo', 'the settings page edits B as well');
  assert.deepEqual((await stored()).settings, before.settings); assert.match(await options.locator('#compare-diff').textContent(), /明るさ、Glow Designer。/);
  await options.screenshot({ path: 'artifacts/20-ab-comparison.png' });
  await options.locator('#compare-keep-a').click();
  await until(async () => !(await stored()).compare, 'decided for A');
  assert.deepEqual((await stored()).settings, before.settings, 'A was the saved look: nothing is rewritten');
  // Said once the background has answered, which may come a moment after storage shows it.
  await until(async () => /何も書き換えていません/.test(await options.locator('#compare-result').textContent()), 'it says nothing was rewritten');
  await until(async () => (await status()).compare === '' && (await used()).brightness === before.settings.brightness, 'the tab is back on the saved settings');
  // Deciding for B writes what differs, and only that.
  await options.locator('#compare-start').click(); await until(async () => (await stored()).compare, 'a second comparison');
  await options.locator('[data-tab="lighting"]').click(); await slide(options, '#brightness', 80);
  await options.locator('[data-tab="glow"]').click(); await options.locator('#tab-glow [data-glow="halo"]').click();
  await until(async () => { const c = (await stored()).compare; return c?.b.brightness === 80 && c.b.glow.style === 'halo'; }, 'B is ready');
  await options.locator('#compare-keep-b').click(); await until(async () => !(await stored()).compare, 'decided for B');
  const decided = (await stored()).settings;
  assert.deepEqual(decided, { ...before.settings, brightness: 80, glow: HALO });
  await until(async () => /保存した項目: 明るさ、Glow Designer/.test(await options.locator('#compare-result').textContent()), 'it says what was saved');
  // Giving up leaves everything as it was.
  await options.locator('#compare-start').click(); await until(async () => (await stored()).compare, 'a third comparison');
  await options.locator('[data-tab="lighting"]').click(); await slide(options, '#brightness', 5); await until(async () => (await stored()).compare?.b.brightness === 5, 'B changed');
  await options.locator('#compare-cancel').click(); await until(async () => !(await stored()).compare, 'given up');
  assert.deepEqual((await stored()).settings, decided);
  // A comparison belongs to one set of settings: a site's profile is compared on that site's tabs only.
  await set({ brightness: 65, glow: GLOW }); await sw.evaluate(() => chrome.storage.local.set({ profiles: { localhost: { brightness: 50 } } }));
  const elsewhere = await context.newPage(); await elsewhere.goto('http://127.0.0.1:4173/'); await elsewhere.locator('#play').waitFor();
  popup = await openPopupOn(elsewhere); await pop('document.querySelector("#start").click()'); await sleep(900); await popup.close();
  const otherTab = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
  await until(async () => (await status(otherTab).catch(() => null))?.state === 'Active', 'the other site is lit');
  popup = await openPopupOn(page);
  assert.match(await pop('document.querySelector("#profile-name").textContent'), /localhost 専用/);
  await pop('document.querySelector("#compare-start").click()'); await until(async () => (await stored()).compare?.target === 'localhost', 'a comparison of the localhost profile');
  await pop('(() => { const el = document.querySelector("#brightness"); el.value = "10"; el.dispatchEvent(new Event("input", { bubbles: true })); })()');
  await until(async () => (await used()).brightness === 10 && (await status()).compare === 'b', 'the profile\'s own tab shows B');
  assert.deepEqual([(await used(otherTab)).brightness, (await status(otherTab)).compare], [65, ''], 'a tab on another site keeps the global settings');
  await pop('document.querySelector("#compare-cancel").click()'); await until(async () => !(await stored()).compare, 'given up'); await popup.close();
  assert.deepEqual((await stored()).profiles, { localhost: { brightness: 50 } }); await elsewhere.close();
  await sw.evaluate(() => chrome.storage.local.set({ profiles: {} })); await page.bringToFront();
  record('A/B Comparison: both sides start as the current look, changes go to the side showing, the lit tab follows a switch at once, the saved settings stay untouched until a side is chosen; A, B and giving up each store exactly what they should; a profile is compared on its own site only',
    { switchMs, light: { a: lightA, b: lightB } });

  // ── The popup closed right after a slider move, while an earlier change is still being written.
  await set({ brightness: 65, mode: 'cinema' });
  popup = await openPopupOn();
  // Every write in the background waits at a gate until the test opens it: the mode change below is still being written as the popup goes.
  assert.ok(await sw.evaluate(() => {
    const local = chrome.storage.local, write = local.set.bind(local), gate = { write, waiting: 0, open: () => {} };
    const opened = new Promise(resolve => { gate.open = resolve; });
    const held = (...args) => { gate.waiting++; return opened.then(() => write(...args)); };
    globalThis.__eclirimGate = gate; local.set = held;
    return local.set === held;
  }), 'writes can be held');
  const popupGone = async () => !(await cdp.send('Target.getTargets')).targetInfos.some(t => t.url === `chrome-extension://${id}/popup.html`);
  try {
    await pop('document.querySelector("[data-mode=vivid]").click()');
    await until(() => sw.evaluate(() => globalThis.__eclirimGate.waiting === 1), 'the mode change waits at the gate');
    // The last move and the close in one go: well inside the 50 ms the popup gathers slider moves for, so only the flush on
    // pagehide can send it. Not awaited: a closing popup may never answer, so it is the popup's target going away that is waited for.
    void pop(`(() => {
      const el = document.querySelector("#brightness");
      for (const v of [30, 35, 41]) { el.value = String(v); el.dispatchEvent(new Event("input", { bubbles: true })); }
      window.close();
    })()`).catch(() => undefined);
    await until(popupGone, 'the popup is closed');
    assert.equal(await sw.evaluate(() => globalThis.__eclirimGate.waiting), 1, 'the gate still holds the earlier change, and nothing behind it was written');
    assert.notEqual((await stored()).settings.mode, 'vivid', 'the earlier change was still being written when the popup closed');
    await sw.evaluate(() => globalThis.__eclirimGate.open());
    await until(async () => { const s = (await stored()).settings; return s.mode === 'vivid' && s.brightness === 41; }, 'the earlier change and the last slider move are both stored');
  } finally { await sw.evaluate(() => { globalThis.__eclirimGate.open(); chrome.storage.local.set = globalThis.__eclirimGate.write; }); }
  await set({ brightness: 65, mode: 'cinema' });
  record('A popup closed right after its last slider move, behind a change still being written, leaves both stored');

  // ── Calibration Wizard: three answers, a whole look, nothing saved before the user says so.
  popup = await openPopupOn();
  const opened = context.waitForEvent('page'); await pop('document.querySelector("#wizard").click()');
  const wizard = await opened; await wizard.waitForLoadState(); wizard.on('pageerror', e => errors.push(`wizard: ${e}`));
  assert.match(wizard.url(), /options\.html#wizard$/); await sleep(900);
  const asked = await stored();
  const pictures = () => wizard.evaluate(() => [...document.querySelectorAll('#wizard-options .choice')].map(card => {
    const canvas = card.querySelector('#eclirim-lighting')?.shadowRoot.querySelector('canvas[data-side="top"]');
    return { name: card.querySelector('b').textContent, checked: card.getAttribute('aria-checked'), lit: canvas ? Array.from(canvas.getContext('2d').getImageData(0, 1, canvas.width, 1).data).filter((v, i) => i % 4 === 3).reduce((n, v) => n + v, 0) : -1 };
  }));
  const amounts = await until(async () => { const p = await pictures(); return p.length === 4 && p.every(c => c.lit > 0) ? p : false; }, 'four pictures, each painted by the renderer');
  assert.deepEqual(amounts.map(c => c.name), ['ひかえめ', '標準', '強め', '最大']); assert.deepEqual(amounts.map(c => c.checked), ['false', 'true', 'false', 'false']);
  assert.ok(amounts.every((c, i) => !i || c.lit > amounts[i - 1].lit), `each picture is brighter than the one before: ${amounts.map(c => c.lit)}`);
  await wizard.screenshot({ path: 'artifacts/21-wizard.png', fullPage: true });
  await wizard.locator('[data-answer="3"]').click(); await wizard.locator('#wizard-next').click(); await sleep(500);
  assert.deepEqual((await pictures()).map(c => c.name), ['細い', '標準', '広い']);
  await wizard.locator('[data-answer="2"]').click(); await wizard.locator('#wizard-next').click(); await sleep(500);
  assert.deepEqual((await pictures()).map(c => c.name), ['くっきり', '標準', 'ふんわり']);
  await wizard.locator('[data-answer="2"]').click(); await wizard.locator('#wizard-next').click(); await sleep(700);
  const summary = await wizard.evaluate(() => Object.fromEntries([...document.querySelectorAll('#wizard-summary dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent])));
  assert.deepEqual([summary['光の量'], summary['光の幅'], summary['柔らかさ'], summary['照明モード'], summary['Brightness'], summary['Glow Width'], summary['Glow Style']], ['最大', '広い', 'ふんわり', 'Vivid', '100%', '15%', 'Soft Halo']);
  assert.match(await wizard.locator('#wizard-closest').textContent(), /「Overkill」にいちばん近い|「.+」にいちばん近い/);
  assert.deepEqual(await stored(), asked, 'answering the questions stores nothing');
  await wizard.screenshot({ path: 'artifacts/22-wizard-result.png', fullPage: true });
  // Kept as a preset, compared, and only then used.
  await wizard.locator('#wizard-name').fill('Wizard look'); await wizard.locator('#wizard-save button').click();
  const kept = await until(async () => (await stored()).presets?.['Wizard look'], 'saved to the Preset Library');
  assert.deepEqual([kept.brightness, kept.glowWidth, kept.glow.style, kept.pulse.enabled, 'guard' in kept, 'zones' in kept], [100, 15, 'halo', false, false, false]);
  assert.deepEqual((await stored()).settings, asked.settings);
  await wizard.locator('#wizard-compare').click();
  const offered = await until(async () => (await stored()).compare, 'the result goes to B of a comparison');
  assert.deepEqual([offered.active, offered.a.brightness, offered.b.brightness, offered.b.glow.style, offered.b.guard.strength], ['b', asked.settings.brightness, 100, 'halo', asked.settings.guard.strength]);
  assert.deepEqual((await stored()).settings, asked.settings); await page.bringToFront();
  await until(async () => (await used()).brightness === 100 && (await status()).compare === 'b', 'the lit tab shows the wizard\'s look');
  await wizard.bringToFront(); await wizard.locator('#compare-cancel').click(); await until(async () => !(await stored()).compare, 'comparison ended');
  await set({ guard: { ...GUARD, strength: 33 } }); await sleep(300);
  await wizard.locator('#wizard-apply').click();
  const applied = await until(async () => { const s = (await stored()).settings; return s.brightness === 100 ? s : false; }, 'the look is used');
  assert.deepEqual([applied.mode, applied.glowWidth, applied.intensity, applied.glow.style, applied.smoothing, applied.flashLimiter], ['vivid', 15, 85, 'halo', 82, true]);
  assert.deepEqual([applied.guard.strength, applied.pulse.enabled, applied.source, applied.zoneCount], [33, false, 'video', 64], 'the UI Guard, sound analysis and the global settings are left as they were');
  assert.match(await wizard.locator('#wizard-message').textContent(), /グローバル設定に保存しました/);
  popup = await openPopupOn();
  assert.ok((await pop('[...document.querySelectorAll("#library option")].map(o => o.value)')).includes('u:Wizard look'), 'the saved look is in the popup\'s preset list'); await popup.close();
  await wizard.close();
  record('Calibration Wizard: opened from the popup, three questions with pictures painted by the real renderer, a whole look out; nothing is stored until it is saved as a preset, compared (B) or used; the UI Guard and sound analysis are left alone', { amounts: amounts.map(c => c.lit), summary });

  // ── Diagnostics and the HUD name the new parts.
  popup = await openPopupOn();
  await pop('(() => { const s = document.querySelector("#library"); s.value = "b:Cinematic Balanced"; s.dispatchEvent(new Event("change", { bubbles: true })); })()'); await popup.close();
  await set({ guard: GUARD, hud: true }); await page.bringToFront(); await scene('snow'); await press('[data-ui="show"]'); await page.mouse.move(640, 450); await settle(3000);
  const hud = await until(async () => { const t = await page.evaluate(() => document.querySelector('#eclirim-hud')?.shadowRoot.textContent || ''); return /Glow/.test(t) ? t : false; }, 'the HUD');
  assert.ok(hud.includes(`ECLIRIM ${VERSION} · Active`), hud); assert.match(hud, /Glow {6}edge · guard active \(\d+\/\d+ held, [\d.]+ ms\) · adaptive active \(key 0\.\d+, level ×0\.7\d\)/);
  await set({ hud: false });
  await sw.evaluate(() => chrome.windows.create({ url: chrome.runtime.getURL('options.html#diagnostics'), width: 1100, height: 900 }));
  const diagnostics = await until(() => context.pages().find(p => p.url().endsWith('options.html#diagnostics')), 'the diagnostics window');
  const rows = await until(async () => { const r = await diagnostics.evaluate(() => Object.fromEntries([...document.querySelectorAll('#diag-simple dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent]))); return /動作中/.test(r['UI Guard'] || '') ? r : false; }, 'diagnostics rows');
  assert.match(rows['UI Guard'], /動作中 · 光の下に見つけたUI・文字 \d+ か所 · いま光を弱めている場所 \d+ か所/);
  assert.match(rows['Adaptive Brightness'], /動作中 · 場面の明るさ 0\.\d+ · 明るいゾーンの明るさ ×0\.7\d/); assert.equal(rows['A/B 比較'], 'なし');
  await diagnostics.screenshot({ path: 'artifacts/23-diagnostics-identity.png', fullPage: true }); await diagnostics.close();
  await page.bringToFront(); await press('[data-ui="show"]');
  record('Diagnostics and the HUD report the UI Guard (found / held back), Adaptive Brightness (scene brightness, factor) and the A/B side', { hud: hud.split('\n').filter(line => /Glow|ECLIRIM/.test(line)), rows: { guard: rows['UI Guard'], adaptive: rows['Adaptive Brightness'] } });

  // ── What the new parts cost. On a freshly loaded page, like the other suites: reading the edge canvases back, as the
  // tests above do, makes Chrome keep them in main memory and paint them several times slower.
  await page.reload(); await page.locator('#play').waitFor(); await expectState('Active');
  await page.evaluate(() => document.querySelector('[data-sound="music"]').click()); await expectState('Active'); await press('[data-ui="show"]'); await page.mouse.move(640, 450);
  const cdpPage = await context.newCDPSession(page); await cdpPage.send('Performance.enable');
  const task = async () => (await cdpPage.send('Performance.getMetrics')).metrics.find(m => m.name === 'TaskDuration').value;
  const seconds = Number(process.env.COMPARE_SECONDS || 12);
  const cost = async changes => {
    await set({ glow: GLOW, guard: guardOff, exposure: exposureOff, ...changes }); await sleep(2500);
    const first = await status(), startedAt = await task(), seen = [];
    for (let i = 0; i < seconds * 2; i++) { seen.push(await status()); await sleep(500); }
    const last = await status(), perf = seen.map(s => s.perf);
    return { analysisMs: mean(perf.map(p => p.analysisMs)), renderMs: mean(perf.map(p => p.renderMs)), analysisFps: mean(perf.map(p => p.analysisFps)), renderFps: mean(perf.map(p => p.renderFps)),
      latencyMs: mean(perf.map(p => p.latencyMs)), quality: Math.max(...perf.map(p => p.quality)), skippedRender: last.perf.skippedRender - first.perf.skippedRender,
      overBudget: last.perf.overBudget - first.perf.overBudget, guardLookMs: Math.max(...seen.map(s => s.guard?.ms || 0)), guardRegions: last.guard?.regions || 0, taskSecondsPerSecond: (await task() - startedAt) / seconds };
  };
  const comparison = { date: '2026-10-10', browser: context.browser()?.version(), platform: process.platform, seconds, scene: 'Light Lab 23 (music) with the UI Guard test controls shown, 64 zones, Cinema',
    as090: await cost({}), adaptive: await cost({ exposure: EXPOSURE }), adaptiveAndGuard: await cost({ exposure: EXPOSURE, guard: GUARD }),
    softHaloToo: await cost({ exposure: EXPOSURE, guard: GUARD, glow: HALO }),
    note: 'Headless test browser on this Mac. Each row adds one feature to the one before; the first is the configuration of 0.9.0 (Light Director, Color Engine 2.0 and Light Trails on). guardLookMs is the longest single look under one side of the page. taskSecondsPerSecond is the page\'s main thread (page, video and extension together), not CPU load.' };
  await writeFile('artifacts/performance-identity.json', JSON.stringify(comparison, null, 2));
  const all = comparison.softHaloToo;
  assert.ok(all.renderMs < 3 && all.analysisMs < 12 && all.quality === 0 && all.guardLookMs < 6, `everything on stays light: ${JSON.stringify(all)}`);
  // On failure: what the player was doing. A stopped player reads as analysis rate 0, which says nothing about cost.
  const player = await page.evaluate(() => { const v = document.querySelector('video'), q = v.getVideoPlaybackQuality(); return { time: v.currentTime, paused: v.paused, ended: v.ended, readyState: v.readyState, seeking: v.seeking, muted: v.muted, error: v.error?.message || null, src: v.currentSrc.split('/').pop(), dropped: q.droppedVideoFrames, frames: q.totalVideoFrames, hidden: document.hidden }; });
  assert.ok(all.renderFps > 25 && all.analysisFps > 9 && all.guardRegions >= 3, `full rate with everything on: ${JSON.stringify(all)}; player ${JSON.stringify(player)}; ${JSON.stringify(await status())}`);
  assert.ok(all.taskSecondsPerSecond < comparison.as090.taskSecondsPerSecond + .04, `the main thread is barely busier: ${comparison.as090.taskSecondsPerSecond} → ${all.taskSecondsPerSecond}`);
  await set({ glow: GLOW, guard: GUARD, exposure: EXPOSURE });
  record(`Cost of Adaptive Brightness, the UI Guard and Soft Halo, ${seconds}s each on the same scene`, comparison);

  // ── Updating from CineGlow 0.9.0, for real: the 0.9.0 build runs, stores its data, and its folder is then replaced by this build.
  const folder = await mkdtemp(join(tmpdir(), 'eclirim-update-'));
  execFileSync('unzip', ['-q', baselineZip, '-d', folder]);
  const updating = await launch(folder);
  try {
    let worker = updating.serviceWorkers()[0] || await updating.waitForEvent('serviceworker'); const extension = worker.url().split('/')[2], updateCdp = await updating.browser().newBrowserCDPSession();
    assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().name), 'CineGlow');
    const manager = await updating.newPage(); await manager.goto('chrome://extensions');
    if (!await manager.locator('#devMode').evaluate(el => el.checked)) await manager.locator('#devMode').click();
    await manager.close();
    const tab = await updating.newPage(); tab.on('pageerror', e => errors.push(`update: ${e}`)); await tab.goto('http://localhost:4173'); await tab.locator('#play').waitFor();
    let p = await openPopup(updateCdp, extension, tab.url()); await sleep(400); await p.evaluate('document.querySelector("#start").click()'); await sleep(900); await p.close();
    assert.equal(await tab.evaluate(() => document.querySelectorAll('#cineglow-lighting').length), 1, '0.9.0 is lighting the tab');
    // Settings as 0.9.0 itself wrote them (sanitised by its own code), plus a profile and a preset.
    const mineBefore = await worker.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, mode: 'vivid', brightness: 77, glowWidth: 13, saturation: 120, flashLimiter: false, zoneMode: 'manual', zoneCount: 96, protectedLight: 'drift',
        pulse: { ...settings.pulse, depth: 55 }, color: { ...settings.color, shadows: 80 }, trails: { ...settings.trails, enabled: false } },
        profiles: { 'www.youtube.com': { mode: 'ambient', brightness: 40 } }, presets: { 'My look': { brightness: 33, saturation: 140 } } });
      return chrome.storage.local.get(null);
    });
    assert.equal(mineBefore.schema, 3);
    // The files of this build take the place of the 0.9.0 files, in the same folder, and the extension is reloaded: an update.
    for (const name of await readdir(folder)) await rm(join(folder, name), { recursive: true, force: true });
    await cp('dist', folder, { recursive: true });
    const beforeUpdate = worker; await worker.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 100); });
    worker = await until(() => updating.serviceWorkers().find(w => w !== beforeUpdate && w.url().includes(extension)), 'the updated service worker');
    const after = await until(() => worker.evaluate(() => chrome.storage.local.get(null)).then(s => s.schema === 4 ? s : false, () => false), 'stored data brought to this version');
    assert.equal(worker.url().split('/')[2], extension, 'the extension id is the same');
    assert.deepEqual(await worker.evaluate(() => [chrome.runtime.getManifest().name, chrome.runtime.getManifest().version]), ['ECLIRIM', VERSION]);
    // What 0.9.0 stored, as this version keeps it: every value as it was, and the one Pulse setting 0.9.0 did not have
    // (Beat Wave, 0.9.3, and Beat Bloom, 0.9.4) at their defaults wherever there are Pulse settings.
    const grown = value => !value || typeof value !== 'object' || Array.isArray(value) ? value
      : Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, key === 'pulse' && inner && typeof inner === 'object' ? { ...inner, wave: 60, bloom: 70 } : grown(inner)]));
    for (const [key, value] of Object.entries(grown(mineBefore.settings))) assert.deepEqual(after.settings[key], value, `kept: ${key}`);
    assert.deepEqual([after.settings.glow, after.settings.guard, after.settings.exposure], [GLOW, GUARD, EXPOSURE]);
    assert.deepEqual([after.profiles, after.presets], [grown(mineBefore.profiles), grown(mineBefore.presets)]);
    // The page 0.9.0 was lighting: lit again by this version, its old light is gone and exactly one new one is there.
    await tab.bringToFront(); p = await openPopup(updateCdp, extension, tab.url()); await sleep(400);
    assert.equal(await p.evaluate('document.querySelector("h1").textContent'), 'ECLIRIM');
    await p.evaluate('document.querySelector("#start").click()'); await sleep(1200); await p.close();
    assert.deepEqual(await tab.evaluate(() => [document.querySelectorAll('#eclirim-lighting').length, document.querySelectorAll('[id^="cineglow"]').length]), [1, 0]);
    // A comparison left open does not survive a restart of the extension; the saved settings do.
    await worker.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ compare: { active: 'b', a: { brightness: settings.brightness }, b: { brightness: 3 }, target: '' } }); });
    const beforeRestart = worker; await worker.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 100); });
    worker = await until(() => updating.serviceWorkers().find(w => w !== beforeRestart && w.url().includes(extension)), 'the restarted service worker');
    const restarted = await until(() => worker.evaluate(() => chrome.storage.local.get(null)).then(s => s.compare === undefined && s.settings ? s : false, () => false), 'the open comparison is dropped');
    assert.deepEqual(restarted.settings, after.settings);
    record(`Update from the real CineGlow 0.9.0 build in the same folder: same extension id, now ECLIRIM ${VERSION}; every stored setting, profile and preset is kept and the new parts start at their defaults; the tab 0.9.0 was lighting ends up with exactly one light; an open A/B comparison is dropped on restart`,
      { id: extension, keptSettings: Object.keys(mineBefore.settings).length, profiles: Object.keys(after.profiles), presets: Object.keys(after.presets), schema: after.schema });
  } finally { await updating.close(); await rm(folder, { recursive: true, force: true }); }
  assert.equal(errors.length, 0, errors.join('\n'));
} catch (e) {
  results.push({ name: 'Failure', result: 'FAIL', detail: String(e.stack || e) }); console.error(e);
  if (page) await page.screenshot({ path: 'artifacts/failure-identity.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile('artifacts/e2e-identity-results.json', JSON.stringify({ date: '2026-10-10', browser: context.browser()?.version(), platform: process.platform, results, errors }, null, 2));
  await context.close(); await server.close();
}
