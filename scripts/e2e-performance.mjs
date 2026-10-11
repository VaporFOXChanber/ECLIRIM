// 0.9.2: reading high-resolution video. Plays 1080p and 4K clips in the production build and in the real 0.9.1 build,
// and records what the Performance Monitor of each reports: how long a frame takes, how it was read, the quality level
// and whether the Light Director runs. Needs FFmpeg (the clips are generated, not stored), so it is run by itself:
//   npm run test:perf
// The browser is headless and uses this machine's GPU. The figures are from this machine, not from real sites.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { serve } from './serve.mjs';
import { openPopup } from './cdp-popup.mjs';
import { quiet } from './browser.mjs';
const baselineZip = process.env.ECLIRIM_PERF_BASELINE_ZIP;
if (!baselineZip) throw new Error('Supply ECLIRIM_PERF_BASELINE_ZIP with a locally retained baseline ZIP; historical binaries are not included in this public source snapshot.');
const sleep = ms => new Promise(r => setTimeout(r, ms)), mean = values => values.length ? values.reduce((n, v) => n + v, 0) / values.length : 0;
const results = [], record = (name, detail = '') => { results.push({ name, result: 'PASS', detail }); console.log('PASS', name, JSON.stringify(detail)); };
const watchdog = setTimeout(() => { console.error('FAIL timed out'); process.exit(1); }, 420000);
const work = await mkdtemp(join(tmpdir(), 'eclirim-perf-'));
await mkdir('artifacts', { recursive: true });

// ── Clips: a moving test picture, 60 frames a second, 6 s, VP9.
const CLIPS = [['1080p', '1920x1080'], ['2160p', '3840x2160']];
for (const [name, size] of CLIPS)
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=60:duration=6`, '-pix_fmt', 'yuv420p',
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-b:v', '6M', '-an', '-y', join(work, `${name}.webm`)]);
const PAGE = '<!doctype html><meta charset="utf-8"><title>clip</title><body style="margin:0;background:#101014"><video id="video" muted loop playsinline autoplay style="display:block;width:80vw;margin:5vh auto"></video><script>const v=document.getElementById("video");v.src=new URLSearchParams(location.search).get("clip")+".webm";v.play().catch(()=>{});</script>';
const PORT = 4183, clips = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://x').pathname.slice(1);
  if (!name) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE); return; }
  let size; const file = join(work, name.replace(/[^\w.-]/g, ''));
  try { size = statSync(file).size; } catch { res.writeHead(404).end(); return; }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || ''), start = range ? +range[1] : 0, end = range && range[2] ? Math.min(+range[2], size - 1) : size - 1;
  res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
  createReadStream(file, { start, end }).pipe(res);
});
await new Promise(done => clips.listen(PORT, '127.0.0.1', done));
const lab = await serve();

const launch = async dist => chromium.launchPersistentContext('', await quiet({
  channel: 'chromium', headless: process.env.HEADED !== '1', viewport: { width: 1440, height: 900 },
  args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio']
}));
/** Lights `url` with the build in `dist` and reports what its Performance Monitor says over `seconds`. */
async function watch(dist, url, seconds, prepare) {
  const context = await launch(dist);
  try {
    const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), id = sw.url().split('/')[2];
    const cdp = await context.browser().newBrowserCDPSession(), page = await context.newPage();
    await page.goto(url); if (prepare) await prepare(page);
    for (let i = 0; i < 80 && !(await page.evaluate(() => { const v = document.querySelector('video'); return !!v && v.readyState >= 3 && v.currentTime > .3; })); i++) await sleep(250);
    const popup = await openPopup(cdp, id, page.url()); await sleep(400);
    await popup.evaluate('document.querySelector("#start").click()'); await sleep(1000);
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
    // The note the popup shows under the Light Director switch, at the end: what the user reads.
    const seen = [];
    for (let i = 0; i < seconds * 2; i++) { const s = await sw.evaluate(id => chrome.tabs.sendMessage(id, { target: 'content', type: 'status' }), tabId).catch(() => null); if (s?.perf && s.state === 'Active') seen.push(s); await sleep(500); }
    await sleep(600); const note = await popup.evaluate('document.querySelector("#director-note").textContent'); await popup.close();
    const late = seen.slice(-10), last = seen.at(-1), video = await page.evaluate(() => { const v = document.querySelector('video'), q = v.getVideoPlaybackQuality(); return { size: `${v.videoWidth}x${v.videoHeight}`, dropped: q.droppedVideoFrames, frames: q.totalVideoFrames }; });
    const round = v => Math.round(v * 100) / 100;
    return { video, samples: seen.length, analysisMs: round(mean(seen.map(s => s.perf.analysisMs))), lateAnalysisMs: round(mean(late.map(s => s.perf.analysisMs))), readMs: last?.perf.readMs === undefined ? null : round(mean(late.map(s => s.perf.readMs))),
      directorMs: round(mean(late.map(s => s.perf.directorMs))), analysisFps: round(mean(late.map(s => s.perf.analysisFps))), reader: last?.perf.reader ?? '(not reported)', quality: last?.perf.quality, highestQualityLevel: Math.max(...seen.map(s => s.perf.quality)),
      director: last?.perf.director, sources: last?.perf.stats?.sources ?? null, overBudget: last?.perf.overBudget, note };
  } finally { await context.close(); }
}

let failed = false;
try {
  const former = join(work, 'eclirim-0.9.1');
  execFileSync('unzip', ['-q', baselineZip, '-d', former]);
  const table = {};
  for (const [name] of CLIPS) {
    const url = `http://127.0.0.1:${PORT}/?clip=${name}`;
    table[name] = { before: await watch(former, url, 26), now: await watch(resolve('dist'), url, 26) };
    console.log(name, JSON.stringify(table[name]));
  }
  // ── What was reported: on high-resolution video 0.9.1 ends with the Light Director switched off, and stays there.
  const worst = table['2160p'].before;
  assert.equal(worst.director, 'suspended', `0.9.1 on 4K: ${JSON.stringify(worst)}`);
  assert.equal(worst.quality, 3); assert.match(worst.note, /休止/);
  assert.ok(worst.lateAnalysisMs > 8, 'and its frames are still slow at the lowest level: lowering the quality did not help');
  record('The reported problem, in the real 0.9.1 build: on a 4K video one analysis takes far longer than its limit whatever the quality level, so the Light Director ends switched off and the popup says so',
    { '2160p': { analysisMs: worst.lateAnalysisMs, quality: worst.quality, director: worst.director, note: worst.note }, '1080p': { analysisMs: table['1080p'].before.lateAnalysisMs, quality: table['1080p'].before.quality, director: table['1080p'].before.director } });

  // ── Now: read on the GPU, full quality, Light Director running.
  for (const [name] of CLIPS) {
    const now = table[name].now, before = table[name].before;
    assert.equal(now.reader, 'gpu', `${name}: ${JSON.stringify(now)}`);
    assert.deepEqual([now.quality, now.highestQualityLevel, now.director], [0, 0, 'active'], `${name}: ${JSON.stringify(now)}`);
    assert.ok(now.analysisMs < 8 && now.readMs < now.analysisMs, `${name}: ${JSON.stringify(now)}`);
    assert.ok(now.analysisFps > 10, `${name}: full analysis rate, ${now.analysisFps}`);
    assert.ok(now.directorMs > 0 && now.directorMs < 2, `${name}: the Light Director is measured running, ${now.directorMs} ms`);
    assert.doesNotMatch(now.note, /休止/);
    assert.ok(now.video.size === before.video.size && now.video.dropped <= Math.max(5, now.video.frames * .02), `${name}: playback, ${JSON.stringify(now.video)}`);
  }
  record('1080p and 4K video: frames are read scaled down on the GPU, an analysis stays under 8 ms, quality stays at 0 and the Light Director runs for the whole 26 s',
    Object.fromEntries(CLIPS.map(([name]) => [name, { analysisMs: table[name].now.analysisMs, readMs: table[name].now.readMs, directorMs: table[name].now.directorMs, analysisFps: table[name].now.analysisFps, reader: table[name].now.reader, quality: table[name].now.quality, director: table[name].now.director, dropped: `${table[name].now.video.dropped}/${table[name].now.video.frames}` }])));

  // ── A video the GPU reads differently from the canvas (HDR: another tone mapping) keeps being read the old way.
  const pick = scene => page => page.evaluate(scene => document.querySelector(`[data-scene="${scene}"]`).click(), scene);
  const hdr = await watch(resolve('dist'), 'http://127.0.0.1:4173/', 8, pick('color-hdr'));
  assert.equal(hdr.reader, 'canvas', `HDR clip: ${JSON.stringify(hdr)}`); assert.notEqual(hdr.director, 'off');
  const plain = await watch(resolve('dist'), 'http://127.0.0.1:4173/', 8, pick('file'));
  assert.equal(plain.reader, 'gpu', `ordinary clip: ${JSON.stringify(plain)}`);
  // A live stream (here: a captured canvas) is not tried at all.
  const stream = await watch(resolve('dist'), 'http://127.0.0.1:4173/', 8, pick('motion'));
  assert.equal(stream.reader, 'canvas', `stream: ${JSON.stringify(stream)}`); assert.equal(stream.director, 'active');
  record('The GPU reading is used only for a video on which it matches the canvas reading: an ordinary clip is read on the GPU, an HDR clip (which the GPU tone-maps differently) and a live stream through the canvas as before',
    { ordinary: { reader: plain.reader, analysisMs: plain.analysisMs }, hdr: { reader: hdr.reader, analysisMs: hdr.analysisMs, quality: hdr.quality, director: hdr.director }, stream: { reader: stream.reader, analysisMs: stream.analysisMs } });

  await writeFile('artifacts/performance-reading.json', JSON.stringify({
    date: new Date().toISOString().slice(0, 10), browser: (await (async () => { const b = await chromium.launch({ channel: 'chromium', headless: true }); const v = b.version(); await b.close(); return v; })()), platform: process.platform,
    clips: 'testsrc2, 60 fps, VP9, 6 s looped; 64 zones (auto), defaults; 26 s each', before: '0.9.1 (releases/ECLIRIM-0.9.1.zip)', table,
    note: 'Headless test browser on this Mac, using its GPU. analysisMs is the mean over the run, lateAnalysisMs and readMs over its last 5 s. 0.9.1 does not report readMs or reader. Not a measurement in the user\'s Chrome or on real sites.'
  }, null, 2));
} catch (error) { failed = true; console.error('FAIL', error); }
finally {
  await writeFile('artifacts/e2e-performance-results.json', JSON.stringify({ date: new Date().toISOString(), results, failed }, null, 2));
  await lab.close(); await new Promise(done => clips.close(done)); await rm(work, { recursive: true, force: true }); clearTimeout(watchdog);
}
console.log(failed ? 'FAILED' : `${results.length} groups passed`);
process.exit(failed ? 1 : 0);
