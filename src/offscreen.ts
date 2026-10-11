import { FrameSampler } from './capture/frame';
import { safeCaptureRect } from './engine/sampling';
import { AdaptiveQuality, QUALITY } from './engine/adaptive';
import type { Message, Settings, VideoContext } from './shared/types';
const video = document.createElement('video');
video.muted = true; video.playsInline = true;
const sampler = new FrameSampler(), quality = new AdaptiveQuality();
let level = 0;
let stream: MediaStream | null = null, tabId: number | null = null, timer = 0, epoch = 0;
let context: VideoContext, settings: Settings, contextTime = 0, blackSince = 0, frames = 0, firstSample = 0;
function stop(): void {
  epoch++; clearTimeout(timer); stream?.getTracks().forEach(track => track.stop());
  stream = null; video.pause(); video.srcObject = null; sampler.close(); quality.reset(); level = 0; tabId = null;
}
function relay(message: Message): void {
  if (tabId !== null) void chrome.runtime.sendMessage({ target: 'background', type: 'relay', tabId, message }).catch(stop);
}
function close(detail: string): void {
  const id = tabId; stop();
  if (id !== null) void chrome.runtime.sendMessage({ target: 'background', type: 'capture-closed', tabId: id, detail });
}
function tick(): void {
  if (!stream || tabId === null) return;
  const now = performance.now();
  if (context.protected) { close('暗号化動画への切り替えを検出したため、画質を守るためにタブ取得を終了しました。CSS互換描画をご利用ください。'); return; }
  if (now - contextTime > 2500 || context.hidden || context.paused || !context.rect || !settings.enabled || settings.source !== 'video') {
    close('停止・非表示・動画切替を検出し、映像取得を終了しました。再開はボタンから行ってください。'); return;
  }
  if (context.fullscreenUnsupported) { close('動画要素単体の全画面では照明を表示できないため取得を終了しました。'); return; }
  const safe = safeCaptureRect(context.rect, context.viewport.width, context.viewport.height, settings.glowWidth);
  if (!safe) { close('映り込みを除外できる動画領域が不足しています。動画を大きく表示するか発光幅を狭くしてください。'); return; }
  if (video.readyState >= 2) {
    try {
      const sx = video.videoWidth / context.viewport.width, sy = video.videoHeight / context.viewport.height;
      const at = Date.now(), used = level;
      const frame = sampler.read(video, settings.zoneCount, { x: safe.x * sx, y: safe.y * sy, width: safe.width * sx, height: safe.height * sy },
        { director: settings.director, trails: settings.trails, color: settings.color, quality: level });
      level = !settings.adaptive ? 0 : frame.settling ? level : quality.update(frame.ms, now);
      frames++;
      if (!firstSample) firstSample = now;
      if (!frame.black) blackSince = 0;
      else if (!blackSince) blackSince = now;
      if (blackSince && now - blackSince > 3000) {
        relay({ target: 'content', type: 'capture-status', state: context.protected ? 'Protected Content' : 'Capture Unavailable',
          detail: context.protected ? '暗号化動画から黒いフレームが続いています。互換描画または固定照明をお試しください。' : '黒いフレームが続いています。暗転か取得制限かは判定できません。明るい映像で自動復帰します。' });
      } else relay({ target: 'content', type: 'colors', colors: frame.colors, sampleMs: frame.ms, readMs: frame.readMs, reader: frame.reader, fps: frames > 1 ? (frames - 1) * 1000 / (now - firstSample) : 0, frames,
        directorMs: frame.directorMs, quality: used, stats: frame.stats, at, luma: frame.luma });
    } catch { close('標準APIで映像を解析できませんでした。互換描画または固定照明をご利用ください。'); return; }
  }
  timer = window.setTimeout(tick, 1000 / 12 * QUALITY[level].interval);
}
chrome.runtime.onMessage.addListener((m: Message, sender, reply) => {
  if (m?.target !== 'offscreen' || sender.id !== chrome.runtime.id) return;
  if (m.type === 'stop') { stop(); reply({ ok: true }); return; }
  if (m.type === 'status') { reply({ active: !!stream, tabId, audioTracks: stream?.getAudioTracks().length || 0 }); return; }
  if (m.type === 'context') {
    if (m.tabId === tabId) { context = m.context; settings = m.settings; contextTime = performance.now(); }
    reply({ ok: true }); return;
  }
  if (m.type === 'start') {
    stop(); const generation = epoch;
    context = m.context; settings = m.settings; tabId = m.tabId;
    contextTime = performance.now(); frames = 0; blackSince = 0; firstSample = 0;
    void (async () => {
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: m.streamId,
            maxWidth: 1280, maxHeight: 720, maxFrameRate: 15 } } as MediaTrackConstraints
        });
        if (generation !== epoch) { media.getTracks().forEach(t => t.stop()); reply({ ok: false, error: '取得を取り消しました。' }); return; }
        stream = media; video.srcObject = media;
        media.getVideoTracks()[0].addEventListener('ended', () => close('Chrome側で映像取得が終了しました。'), { once: true });
        await video.play();
        if (generation !== epoch) return;
        contextTime = performance.now(); tick(); reply({ ok: true });
      } catch (e) { stop(); reply({ ok: false, error: String(e) }); }
    })(); return true;
  }
});
