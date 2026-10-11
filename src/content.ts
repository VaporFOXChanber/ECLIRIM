import { DEFAULTS, compareSettings, effectiveSettings, fallbackColors, loadCompare, loadProfiles, loadSettings, resolveSettings, sanitize, sanitizeCompare, sanitizeProfiles } from './shared/settings';
import type { ColorStatus, Compare, DirectorStats, Message, Perf, Profiles, Reader, Settings, State, Status } from './shared/types';
import { FrameSampler, type ColorSpace } from './capture/frame';
import { AudioTap } from './capture/audio';
import { colorInfo, contextFor, findMedia, findVideo, serviceName } from './capture/video';
import { UiWatch } from './capture/ui';
import { PulseAnalyser, musicColors } from './engine/pulse';
import { LightingRenderer } from './render/lighting';
import { CompatibilityRenderer } from './render/compatibility';
import { Badge, Hud } from './render/hud';
import { lightingPath } from './shared/capture-policy';
import { siteKey } from './shared/site';
import { ANALYSIS_BUDGET_MS, AdaptiveQuality, QUALITY } from './engine/adaptive';

// Re-injection into the isolated world is idempotent, including SPA navigation.
type Instance = { alive: () => boolean; dispose: () => void };
const world = globalThis as typeof globalThis & { __eclirim?: Instance; __cineglow?: Instance };
// A page lit by 0.9.0 or earlier still holds that version's script under the name the extension had then.
if (world.__cineglow) { world.__cineglow.dispose(); delete world.__cineglow; }
if (world.__eclirim && !world.__eclirim.alive()) world.__eclirim.dispose();
if (!world.__eclirim) {
  let saved: Settings = DEFAULTS, settings: Settings = DEFAULTS, running = false, capture = false, captureRequested = false;
  // The page's site profile, if it has one, lies over the global settings. `revision` counts every change of either.
  let global: Settings = DEFAULTS, profiles: Profiles = {}, revision = 0;
  // A/B Comparison: while one is running for the settings this page uses, the page shows the side that is switched to.
  let compare: Compare | null = null;
  const site = siteKey(location.href);
  // Performance Monitor: all of it measured here, in this tab.
  const TICK = 1000 / 12, quality = new AdaptiveQuality(), hud = new Hud(), stamps: number[] = [];
  let level = 0, directorMs = 0, readMs = 0, reader: Reader = 'canvas', stats: DirectorStats | null = null, skipped = 0, over = 0, tickAt = 0, fastTick = false, hudAt = 0, turn = 0;
  // Pulse Engine: the sound of what is playing, read only once the user has switched it on (or chosen Music Mode).
  const tap = new AudioTap(), pulse = new PulseAnalyser();
  const sound = { gains: new Float32Array(0) as Float32Array, beat: false, lift: new Float32Array(0) as Float32Array, bloom: new Float32Array(4) as Float32Array }; let soundOnly: HTMLMediaElement | null = null;
  // Color Engine 2.0: what is known about the colours being read. Checked again every few seconds and for every new video.
  let colour: Omit<ColorStatus, 'engine' | 'space'> = colorInfo(null), colourAt = 0, space: ColorSpace = 'srgb';
  const hear = (count: number, dt: number): typeof sound | null => {
    const spectrum = tap.read();
    if (!spectrum) return null;
    sound.beat = pulse.update(spectrum, tap.sampleRate, dt, settings.pulse, settings.flashLimiter).onset;
    sound.gains = pulse.gains(count, settings.pulse, sound.gains); sound.lift = pulse.lift; sound.bloom = pulse.bloom(settings.pulse, sound.bloom);
    return sound;
  };
  let video: HTMLVideoElement | null = null, blocked = false, encrypted = false;
  let pageZoom = 1, needsDiscovery = true, wasCompat = false, resumeOnShow = false;
  let lastVideoTime = -1, timer = 0, discoverAt = 0, contextAt = 0, frames = 0, firstFrame = 0, lastOutput = '', stalledAt = 0;
  let state: Status = { state: 'Disabled', detail: 'このタブではまだ開始していません。', source: 'none', service: serviceName() };
  const sampler = new FrameSampler(), renderer = new LightingRenderer(settings), abort = new AbortController();
  const compatibility = new CompatibilityRenderer(), badge = new Badge();
  // UI Guard: looks for controls, captions and text under the light, only while the light is ours to shape.
  const watch = new UiWatch(() => renderer.guardReach, rects => renderer.guard(rects));
  const send = async (message: Message) => { try { return await chrome.runtime.sendMessage(message); } catch { return undefined; } };
  const status = (value: State, detail: string, source: Status['source'] = 'none') => {
    state = { ...state, state: value, detail, source, zoneCount: settings.zoneCount };
  };
  const dark = () => {
    if (lastOutput !== `dark:${settings.zoneCount}`) renderer.target(Array.from({ length: settings.zoneCount }, () => [0, 0, 0]));
    lastOutput = `dark:${settings.zoneCount}`;
  };
  function stop(): void {
    running = false; capture = false; captureRequested = false; clearTimeout(timer);
    renderer.hide(); compatibility.hide(); hud.hide(); badge.hide(); watch.stop(); sampler.close(); observer.disconnect(); lastOutput = ''; wasCompat = false;
    quality.reset(); level = 0; stamps.length = 0; fastTick = false;
    renderer.pulse = null; tap.detach(); pulse.reset();
    status('Disabled', '照明はオフです。'); void send({ target: 'background', type: 'release' });
  }
  function dispose(): void {
    delete world.__eclirim; stop(); tap.close(); abort.abort();
    try { chrome.runtime.onMessage.removeListener(onMessage); chrome.storage.onChanged.removeListener(onStorage); } catch { /* Context was unloaded. */ }
  }
  function discover(): void {
    const next = findVideo();
    if (next !== video) {
      if (capture) void send({ target: 'background', type: 'release' });
      video = next; blocked = false; encrypted = !!next?.mediaKeys;
      lastVideoTime = -1; sampler.reset(); frames = 0; firstFrame = 0; stamps.length = 0; colourAt = 0;
    }
    // Music Mode also listens to players that have no picture.
    soundOnly = settings.source === 'music' && !next ? findMedia() : null;
    discoverAt = performance.now(); needsDiscovery = false;
  }
  const observer = new MutationObserver(records => {
    if (records.some(r => r.target !== renderer.host && !renderer.host.contains(r.target))) needsDiscovery = true;
  });
  /** What this page uses: the global settings with this site's profile over them, at this screen's zone count. */
  function resolve(): void {
    const own = site && profiles[site] ? site : '', was = state.compare || '';
    saved = compareSettings(resolveSettings(global, own ? profiles[own] : null), compare, own); settings = effectiveSettings(saved, pageZoom);
    state.profile = own; state.compare = compare && compare.target === own ? compare.active : ''; revision++;
    if (state.compare && state.compare !== was && running) badge.show(state.compare);
    if (!state.compare) badge.hide();
  }
  /** The figures behind the Diagnostics page and the HUD. Light Director state says what is really running, not what is set. */
  function measure(): Perf {
    const paint = renderer.metrics, analysing = state.source === 'direct' || state.source === 'capture';
    return {
      // A paused picture is read once and then held: no frames are being analysed, so the rate is 0, not the last one seen.
      analysisFps: !analysing ? 0 : state.source === 'capture' || performance.now() - (stamps[stamps.length - 1] || 0) < 1500 ? state.fps || 0 : 0, analysisMs: analysing ? state.sampleMs || 0 : 0, directorMs: analysing ? directorMs : 0,
      readMs: analysing ? readMs : 0, reader,
      renderFps: paint.fps, renderMs: paint.ms, latencyMs: paint.latency, zones: settings.zoneCount, activeZones: paint.active,
      skippedAnalysis: skipped, skippedRender: paint.skipped, overBudget: over + paint.over, quality: level,
      // Load never switches the Light Director off: it only makes it look at fewer pixels, less often.
      director: !analysing ? 'unavailable' : !settings.director.enabled ? 'off' : level ? 'reduced' : 'active',
      stats: analysing && settings.director.enabled ? stats : null
    };
  }
  function overlay(now: number): void {
    if (!settings.hud || !running) { hud.hide(); return; }
    if (now - hudAt < 500) return;
    hudAt = now;
    const p = state.perf!, f = (v: number, digits = 1) => v.toFixed(digits);
    const heading = !p.stats || Math.hypot(p.stats.vx, p.stats.vy) < .03 ? '·' : Math.abs(p.stats.vx) >= Math.abs(p.stats.vy) ? (p.stats.vx > 0 ? '→' : '←') : p.stats.vy > 0 ? '↓' : '↑';
    hud.show([
      `ECLIRIM ${chrome.runtime.getManifest().version} · ${state.state}${state.compare ? ` · A/B: ${state.compare.toUpperCase()}` : ''}`,
      `Analysis  ${f(p.analysisFps)} fps · ${f(p.analysisMs)} ms (read ${f(p.readMs)} ms, ${p.reader})`,
      `Director  ${p.director}${p.stats ? ` · ${f(p.directorMs, 2)} ms · sources ${p.stats.sources} ${heading}` : ''}`,
      `Render    ${f(p.renderFps)} fps · ${f(p.renderMs, 2)} ms · first paint +${f(p.latencyMs, 0)} ms`,
      `Zones     ${p.zones} (on ${p.activeZones}) · quality ${p.quality}`,
      `Path      ${state.source}${state.profile ? ` · profile ${state.profile}` : ''} · color ${state.color?.engine}/${state.color?.space}${state.color?.hdr ? ' (HDR source)' : ''}`,
      `Pulse     ${state.audio?.state}${state.audio?.state === 'active' ? ` · low ${f(state.audio.low, 2)} mid ${f(state.audio.mid, 2)} high ${f(state.audio.high, 2)} · beats ${state.audio.beats}` : ''}`,
      `Glow      ${settings.glow.style} · guard ${state.guard?.state}${state.guard?.state === 'active' ? ` (${state.guard.held}/${state.guard.regions} held, ${f(state.guard.ms, 2)} ms)` : ''} · adaptive ${state.exposure?.state}${state.exposure?.state === 'active' ? ` (key ${f(state.exposure.key, 2)}, level ×${f(state.exposure.level, 2)})` : ''}`,
      `Missed    analysis ${p.skippedAnalysis} · render ${p.skippedRender} · over budget ${p.overBudget}`
    ]);
  }
  async function start(): Promise<void> {
    [global, profiles, compare] = await Promise.all([loadSettings(), loadProfiles(), loadCompare()]);
    const environment = await send({ target: 'background', type: 'heartbeat' });
    pageZoom = environment?.zoom || 1; resolve();
    if (!settings.enabled) { stop(); return; }
    if (!running) {
      running = true; discover(); renderer.update(settings); renderer.show();
      observer.observe(document.documentElement, { childList: true, subtree: true });
      clearTimeout(timer); tick();
    }
  }
  function tick(): void {
    if (!running) return;
    try {
      if (!chrome.runtime.id) { dispose(); return; }
      const now = performance.now();
      if (document.hidden) {
        renderer.hide(); compatibility.hide(); hud.hide(); watch.stop(); lastOutput = ''; lastVideoTime = -1; status('Paused', 'タブが非表示のため休止中です。');
        if (capture) void send({ target: 'background', type: 'release' });
        fastTick = false; stamps.length = 0; state.perf = measure();
        timer = window.setTimeout(tick, 800); return;
      }
      // An analysis tick that arrives late enough to have missed a slot was held up by something on this page's thread.
      if (fastTick && now - tickAt > TICK * 1.8) skipped += Math.round((now - tickAt) / TICK) - 1;
      tickAt = now;
      if (now - discoverAt > 1500 || needsDiscovery && now - discoverAt > 500) discover();
      const effective = effectiveSettings(saved, pageZoom);
      if (effective.zoneCount !== settings.zoneCount) { settings = effective; renderer.update(settings); lastVideoTime = -1; }
      const context = contextFor(video, encrypted);
      // On protected streams "follow the video" must not read pixels, so it switches to the CSS path by itself.
      const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform;
      const path = lightingPath(settings.source, state.service, context.protected, platform);
      const compat = path === 'compatibility', auto = compat && settings.source === 'video';
      if (compat !== wasCompat) {
        wasCompat = compat; lastOutput = ''; lastVideoTime = -1;
        if (compat && capture) void send({ target: 'background', type: 'release' });
      }
      if (!compat) { renderer.show(); compatibility.hide(); }
      else { renderer.hide(); if (context.fullscreenUnsupported) compatibility.hide(); }
      // The guard shapes the light this script paints. The compositor's own light (DRM-compatible rendering) is out of its reach.
      const guarding = settings.guard.enabled && !compat && !context.fullscreenUnsupported;
      if (guarding) watch.start(settings.guard.pointer); else watch.stop();
      state.guard = { state: !settings.guard.enabled ? 'off' : guarding ? 'active' : 'unavailable', regions: watch.regions, held: guarding ? renderer.guardHeld : 0, ms: watch.ms };
      // Sound is read only where the user asked for it and where the light is ours to move: never for protected media,
      // and not on the CSS path, whose light the page compositor makes without us.
      const media = video || soundOnly, music = settings.source === 'music';
      const listening = (settings.pulse.enabled || music) && !compat && path !== 'unreadable' && !context.fullscreenUnsupported;
      tap.attach(listening ? media : null, context.protected);
      renderer.pulse = listening && media && !media.paused && !media.ended ? hear : null;
      // Asked for, but this media is protected: say so. Its sound is never requested from Chrome at all.
      state.audio = { state: !(settings.pulse.enabled || music) ? 'off' : context.protected ? 'protected' : listening ? tap.state : 'off',
        low: pulse.frame.low, mid: pulse.frame.mid, high: pulse.frame.high, beats: pulse.beats };
      // A wide-gamut video is read and painted in Display P3 when this display can show it; everything else stays sRGB.
      if (now - colourAt > 3000) { colourAt = now; colour = colorInfo(path === 'analysis' && !context.protected && !blocked ? video : null); }
      const wanted: ColorSpace = settings.color.enabled && settings.color.wideGamut && colour.wide && colour.displayP3 && path === 'analysis' && !capture ? 'display-p3' : 'srgb';
      if (wanted !== space) { space = wanted; renderer.colorSpace(space); renderer.update(settings); lastVideoTime = -1; }
      state.color = { engine: settings.color.enabled ? 'v2' : 'classic', space, ...colour };
      if (!video || video.readyState >= 2) stalledAt = 0;
      if (capture && now - contextAt > 200) {
        contextAt = now;
        void send({ target: 'background', type: 'context', context, settings });
      }
      if (context.fullscreenUnsupported) {
        status('Fullscreen Unsupported', '動画要素単体の全画面には重ねられません。プレイヤー全体の全画面かシアターモードをご利用ください。');
      } else if (path === 'unreadable') {
        // The browser keeps this picture out of reach. Say so, and show only the fixed light chosen for this case.
        const light = settings.protectedLight, key = `protected:${revision}`;
        if (light === 'off' || !video || video.ended) dark();
        else if (light === 'drift' || key !== lastOutput) { renderer.target(fallbackColors({ ...settings, source: light }, now)); lastOutput = key; }
        const shown = light === 'off' ? '照明は表示していません。固定の照明は、ポップアップの「保護された動画での照明」で選べます。'
          : `代わりに「${{ preset: 'Cinemaプリセット', drift: 'ゆっくり変化', manual: '固定カラー' }[light]}」の照明を表示しています。映像には連動しません。`;
        status('Protected Content', `保護された動画です。このMacのChromeは保護された映像を別の層に表示するため、色を取り出せません（DRM互換描画でも光りません）。${shown}`,
          light === 'off' || !video || video.ended ? 'none' : 'fallback');
      } else if (compat) {
        if (!video || !context.rect) { compatibility.hide(); status('Waiting for Video', '互換描画に使用する動画を待っています。'); }
        else if (compatibility.show(settings, context.rect, !video.ended)) {
          const why = !auto ? 'CSS合成で外周を描画中。' : context.protected ? '暗号化動画を検出したため、自動でDRM互換描画（CSS合成）に切り替えました。'
            : `${state.service}では自動でDRM互換描画（CSS合成）を使います。`;
          status(context.paused ? 'Paused' : 'Compatibility Mode', `${why}画素の取得・64ゾーン解析は行いません。DRM映像の合成可否は環境依存で、光が出るか目視確認が必要です。`, 'compatibility');
        } else if (auto) status('Protected Content', '保護された動画ですが、この環境はCSSの互換描画に対応していません。固定カラーなどの照明を選べます。');
        else status('Capture Unavailable', 'この環境はCSSの互換描画に対応していません。');
      } else if (music) {
        // Music Mode: the colours come from the sound alone. No pixel of the picture is read.
        if (!media) { dark(); status('Waiting for Video', '音の出ている動画・音声を待っています。'); }
        else if (tap.state === 'protected') { dark(); status('Protected Content', '保護されたコンテンツの音は解析しません。Music Mode はここでは光りません。'); }
        else if (tap.state === 'blocked') { dark(); status('Capture Unavailable', 'この音声は別のサイトから配信されていて、Chromeが読み取りを許可しません。'); }
        else if (media.ended || media.paused) { dark(); status('Paused', '再生を待っています。'); }
        else {
          renderer.target(musicColors(pulse.frame, settings.zoneCount, now / 1000)); lastOutput = 'music';
          status('Active', tap.state === 'muted' ? 'Music Mode：プレイヤーがミュート中のため、光は止まっています。'
            : tap.state === 'waiting' ? 'Music Mode：ページを一度クリックすると、音の解析が始まります。'
            : 'Music Mode：音だけで光っています。映像の色は使いません。再生音は変えていません。', 'music');
        }
      } else if (settings.source !== 'video') {
        const key = `fixed:${revision}`;
        if (settings.source === 'drift' || key !== lastOutput) renderer.target(fallbackColors(settings, now));
        lastOutput = key;
        status('Active', settings.source === 'drift' ? 'ゆっくり変化する照明（映像解析なし）' : '固定照明（映像解析なし）', 'fallback');
      } else if (!video) {
        dark(); status('Waiting for Video', '表示中の動画を待っています。別オリジンの埋め込み動画は元サイトで開いてください。');
      } else if (video.ended || video.paused && (capture || blocked || captureRequested)) {
        dark(); status('Paused', video.ended ? '動画が終了しました。' : '動画の再生を待っています。');
      } else if (video.readyState < 2) {
        // A seek or a short buffer keeps the last light instead of blinking; a real stall lets it fade.
        stalledAt ||= now;
        if (lastOutput !== 'frame' || now - stalledAt > 3000) dark();
        status('Paused', '動画の再生を待っています。');
      } else if (capture) {
        // Offscreen reports its own measured state; never claim active before a frame arrives.
      } else if (blocked || captureRequested) {
        dark(); status('Capture Required', '動画を直接読み取れません。「タブの映像を取得」から映像のみの取得を開始できます。');
      } else if (video.currentTime !== lastVideoTime && turn++ % QUALITY[level].interval === 0) {
        // (At the last quality level that is every other tick; the light holds in between.)
        try {
          const frame = sampler.read(video, settings.zoneCount, undefined, { director: settings.director, trails: settings.trails, color: settings.color, quality: level, space });
          renderer.target(frame.colors, now, frame.luma); lastOutput = 'frame'; lastVideoTime = video.currentTime; frames++;
          if (!firstFrame) firstFrame = now;
          directorMs = frame.directorMs; readMs = frame.readMs; reader = frame.reader; stats = frame.stats;
          if (frame.ms > ANALYSIS_BUDGET_MS) over++;
          // A frame that was read twice to compare the two ways of reading says nothing about the frames to come.
          level = !settings.adaptive ? 0 : frame.settling ? level : quality.update(frame.ms, now);
          stamps.push(now); if (stamps.length > 24) stamps.shift();
          // A paused picture is still on screen, so its light stays; only a new frame (seek) is analysed.
          if (video.paused) status('Paused', '一時停止中。止めた場面の光を保っています。', 'direct');
          else status('Active', '動画の色をリアルタイム解析中。音声や再生設定は変更していません。', 'direct');
          state.sampleMs = frame.ms; state.frames = frames;
          // Over the last two seconds at most, so the figure follows what is happening now.
          state.fps = stamps.length > 1 ? (stamps.length - 1) * 1000 / (now - stamps[0]) : 0;
        } catch {
          blocked = true; sampler.reset(); dark();
          status('Capture Required', 'Canvasから映像を読み取れません。CORSなどの制限があります。DRMとは断定できません。');
        }
      } else if (video.paused) status('Paused', '一時停止中。止めた場面の光を保っています。', 'direct');
      // Detect extension invalidation even while no popup is open.
      if (!capture && now - contextAt > 5000) {
        contextAt = now;
        chrome.runtime.sendMessage({ target: 'background', type: 'heartbeat' }).then(r => { pageZoom = r?.zoom || 1; }).catch(dispose);
      }
      fastTick = !(compat || media?.paused || media?.ended || !media);
      // Adaptive Brightness needs a picture to follow: it rests on fixed lights, Music Mode and DRM-compatible rendering.
      const adaptation = renderer.adaptation, reading = state.source === 'direct' || state.source === 'capture';
      state.exposure = { state: !settings.exposure.enabled ? 'off' : reading && adaptation.key >= 0 ? 'active' : 'unavailable', key: Math.max(0, adaptation.key), level: reading ? adaptation.level : 1 };
      state.perf = measure(); overlay(now);
      timer = window.setTimeout(tick, fastTick ? TICK : 333);
    } catch { dispose(); }
  }
  function onMessage(m: Message, _s: chrome.runtime.MessageSender, reply: (v: unknown) => void): boolean | undefined {
    if (m.target !== 'content') return;
    if (m.type === 'start') { void start().then(() => reply(state), e => reply({ ok: false, error: String(e) })); return true; }
    if (m.type === 'stop') { stop(); reply(state); }
    if (m.type === 'status') reply(state);
    // For diagnostics: where the light stands inside, in numbers. Nothing of the page is in it.
    if (m.type === 'probe') reply({ running, capture, blocked, lastOutput, level, zoom: pageZoom, zones: settings.zoneCount, brightness: settings.brightness, mode: settings.mode, light: renderer.probe() });
    if (m.type === 'zoom') { pageZoom = m.factor; reply(true); }
    if (m.type === 'context') { discover(); reply({ context: contextFor(video, encrypted), settings }); }
    if (m.type === 'capture-started') {
      capture = true; captureRequested = true; dark(); status('Capture Required', '映像のみ取得中。最初のフレームを待っています。'); reply(true);
    }
    if (m.type === 'capture-ended') {
      capture = false; dark(); status('Capture Required', m.detail); reply(true);
    }
    if (m.type === 'colors' && running && capture && settings.source === 'video') {
      renderer.target(m.colors, performance.now() - Math.max(0, Date.now() - m.at), m.luma); lastOutput = 'frame';
      status('Active', 'タブ映像を解析中。光の映り込みを避けるため内側の領域を使用します。', 'capture');
      state.sampleMs = m.sampleMs; state.fps = m.fps; state.frames = m.frames;
      directorMs = m.directorMs; readMs = m.readMs; reader = m.reader; stats = m.stats; level = m.quality; if (m.sampleMs > ANALYSIS_BUDGET_MS) over++;
    }
    if (m.type === 'capture-status' && capture) { status(m.state, m.detail, 'capture'); dark(); }
  }
  function onStorage(changes: Record<string, chrome.storage.StorageChange>, area: string): void {
    if (area !== 'local' || !changes.settings && !changes.profiles && !changes.compare) return;
    if (changes.settings) global = sanitize(changes.settings.newValue);
    if (changes.profiles) profiles = sanitizeProfiles(changes.profiles.newValue);
    if (changes.compare) compare = sanitizeCompare(changes.compare.newValue);
    resolve(); lastOutput = '';
    if (!settings.enabled) { stop(); return; }
    renderer.update(settings); lastVideoTime = -1;
    if (settings.source !== 'video' && capture) void send({ target: 'background', type: 'release' });
    if (running) renderer.show();
  }
  chrome.runtime.onMessage.addListener(onMessage);
  world.__eclirim = { alive: () => { try { return !!chrome.runtime.id; } catch { return false; } }, dispose };
  chrome.storage.onChanged.addListener(onStorage);
  // The moment media turns out to be protected, or a player starts loading something else, the copy of its sound is closed.
  document.addEventListener('encrypted', e => { if (e.target === video) { encrypted = true; tap.detach(); } }, { capture: true, signal: abort.signal });
  document.addEventListener('loadstart', e => {
    if (e.target === video || e.target === soundOnly) tap.detach();
    if (e.target !== video) return;
    if (capture) void send({ target: 'background', type: 'release' });
    blocked = false; captureRequested = false; encrypted = !!video?.mediaKeys; lastVideoTime = -1; sampler.reset();
  }, { capture: true, signal: abort.signal });
  document.addEventListener('fullscreenchange', () => { renderer.mount(); renderer.update(settings); contextAt = 0; }, { signal: abort.signal });
  window.addEventListener('resize', () => { renderer.update(settings); contextAt = 0; }, { signal: abort.signal });
  // Back/forward can bring this very page back from the cache with no new load, so it resumes itself.
  window.addEventListener('pagehide', e => { resumeOnShow = e.persisted && running; stop(); }, { signal: abort.signal });
  window.addEventListener('pageshow', e => { if (e.persisted && resumeOnShow) void start(); }, { signal: abort.signal });
}
