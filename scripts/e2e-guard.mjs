// Deterministic renderer regression: fixed controls and a sudden drive change, including the very first painted frame.
// This uses the production renderer and real Canvas2D. Only the clock and incoming scene/audio values are controlled;
// the extension/audio integration is checked separately by e2e-resonance.mjs.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const source = resolve('src/render/lighting.ts'), reportDir = resolve(process.env.ECLIRIM_REPORT_DIR || 'artifacts');
const renderer = await readFile(process.env.ECLIRIM_RENDERER_SOURCE || source, 'utf8');
const bundle = await build({ stdin: { contents: renderer + '\nimport { sanitize } from "../shared/settings"; Object.assign(globalThis, { LightingRenderer, sanitize });',
  resolveDir: dirname(source), loader: 'ts' }, bundle: true, write: false, format: 'iife', target: 'chrome116' });
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const results = [], errors = [];
const record = (name, detail) => { results.push({ name, result: 'PASS', detail }); console.log('PASS', name, detail); };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => errors.push(String(error)));
  await page.setContent('<body style="margin:0;background:#111"></body>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const seen = await page.evaluate(() => {
    // No timing luck: call the actual render loop once per simulated 34ms frame.
    window.requestAnimationFrame = () => 0;
    let now = 1000;
    Object.defineProperty(performance, 'now', { value: () => now });
    let settings = sanitize({ brightness: 100, flashLimiter: false, exposure: { enabled: false },
      pulse: { enabled: true, depth: 100, bloom: 100 }, guard: { enabled: true, strength: 60 } });
    const light = new LightingRenderer(settings); light.show();
    const rects = [{ x: 600, y: 14, width: 80, height: 28 }, { x: 600, y: 858, width: 80, height: 28 },
      { x: 14, y: 400, width: 28, height: 100 }, { x: 1238, y: 400, width: 28, height: 100 }];
    light.guard(rects);
    let rgb = [128, 128, 128], lift = 0;
    light.filter.step = () => Array.from({ length: 64 }, () => rgb);
    light.pulse = () => ({ gains: new Float32Array(64).fill(1), beat: false,
      lift: new Float32Array(64).fill(lift), bloom: new Float32Array(4).fill(1) });
    const read = () => rects.map((r, side) => {
      const canvas = light.canvases[side], screen = canvas.getBoundingClientRect();
      return canvas.getContext('2d').getImageData(Math.floor((r.x + r.width / 2 - screen.x) / screen.width * canvas.width),
        Math.floor((r.y + r.height / 2 - screen.y) / screen.height * canvas.height), 1, 1).data[3];
    });
    const tick = () => { now += 34; light.render(now); return read(); };
    const settle = () => { for (let i = 0; i < 100; i++) tick(); };
    settle(); const medium = tick();
    // Every rising edge is observed, rather than sampling only after the guard has settled.
    const beats = [];
    for (let beat = 0; beat < 12; beat++) {
      lift = .85; for (let i = 0; i < 5; i++) beats.push(tick());
      lift = 0; for (let i = 0; i < 10; i++) beats.push(tick());
    }
    settle(); rgb = [255, 255, 255];
    const sceneCut = Array.from({ length: 8 }, tick);
    settings = sanitize({ ...settings, guard: { ...settings.guard, strength: 100 } });
    light.update(settings); const stronger = tick();
    rects[0].x = rects[1].x = 300; rects[2].y = rects[3].y = 600;
    light.guard(rects); const moved = tick();
    light.guard([]); const firstRelease = tick(); settle(); const released = tick();
    light.update(sanitize({ ...settings, guard: { ...settings.guard, enabled: false } })); settle(); const unguarded = tick();
    const scales = light.canvases.map(c => c.style.transform), restored = light.probe().restored;
    // fullscreenchange can arrive after hide() has already removed the layer.
    light.hide(); light.mount(); light.update(settings);
    const inactive = { layers: document.querySelectorAll('#eclirim-lighting').length, active: light.probe().active, looping: light.probe().looping };
    light.show(); const resumedLayers = document.querySelectorAll('#eclirim-lighting').length;
    return { medium, beats, sceneCut, stronger, moved, firstRelease, released, unguarded,
      scales, restored, inactive, resumedLayers };
  });
  const cap = strength => Math.round((.6 - .48 * strength / 100) * 255);
  const within = (frames, limit, label) => frames.forEach((values, frame) => values.forEach((value, side) =>
    assert.ok(value <= limit + 1, `${label}, frame ${frame}, side ${side}: opacity ${value} > ${limit} (+1 rounding)`)));
  within([seen.medium, ...seen.beats], cap(60), 'beat');
  assert.ok(seen.medium.every(n => n > 60), 'the guard holds lit controls rather than losing all light');
  record('All four edges stay within the guard cap from the first frame of every sudden beat', {
    cap: cap(60), frames: seen.beats.length, peak: Math.max(...seen.beats.flat()), firstBeat: seen.beats[0], medium: seen.medium });
  within(seen.sceneCut, cap(60), 'bright scene cut');
  record('A sudden bright scene is guarded before its first frame is drawn', { cap: cap(60), first: seen.sceneCut[0], peak: Math.max(...seen.sceneCut.flat()) });
  within([seen.stronger, seen.moved], cap(100), 'stronger or moved guard');
  record('Increasing guard strength and moving controls applies the cap on the next painted frame', { cap: cap(100), stronger: seen.stronger, moved: seen.moved });
  seen.firstRelease.forEach((value, side) => {
    assert.ok(value >= seen.moved[side] && value < seen.released[side] - 20, 'guard release is gradual');
    assert.ok(seen.released[side] > seen.moved[side] + 50, 'removing controls restores the light');
  });
  assert.deepEqual(seen.released, seen.unguarded, 'after release the light equals the guard switched off');
  assert.ok(seen.scales.every(s => /1\.8/.test(s)), 'all four edges still swell with the guard');
  assert.deepEqual(seen.restored, { mask: 0, scratch: 0, light: 0 }, 'no context recovery caused the result');
  assert.deepEqual(errors, []);
  record('Releasing the guard stays smooth and Beat Bloom still reaches 1.8 on all four edges', { firstRelease: seen.firstRelease, released: seen.released, scales: seen.scales });
  assert.deepEqual(seen.inactive, { layers: 0, active: false, looping: false }, 'late fullscreen work cannot remount a hidden renderer');
  assert.equal(seen.resumedLayers, 1, 'showing the renderer still creates exactly one layer');
  record('An inactive renderer stays removed if fullscreen work arrives late, and show restores one layer', { inactive: seen.inactive, resumedLayers: seen.resumedLayers });
} catch (error) {
  results.push({ name: 'Failure', result: 'FAIL', detail: String(error.stack || error) }); console.error(error); process.exitCode = 1;
} finally {
  await mkdir(reportDir, { recursive: true });
  await writeFile(resolve(reportDir, 'e2e-guard-results.json'), JSON.stringify({ date: '2026-10-11', version,
    rendererSource: process.env.ECLIRIM_RENDERER_SOURCE || 'src/render/lighting.ts', browser: browser.version(), results, errors }, null, 2));
  await browser.close();
}
