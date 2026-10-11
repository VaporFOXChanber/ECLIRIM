import type { ColorStatus, Rect, VideoContext } from '../shared/types';
export function serviceName(host = location.hostname): string {
  if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(host)) return 'YouTube';
  if (/(^|\.)netflix\.com$/.test(host)) return 'Netflix';
  if (/(^|\.)primevideo\.com$|(^|\.)amazon\.(com|co\.jp|co\.uk|de|fr)$/.test(host)) return 'Prime Video';
  return 'HTML5 Video';
}
function videos(root: Document | ShadowRoot): HTMLVideoElement[] {
  const found = Array.from(root.querySelectorAll('video'));
  for (const el of root.querySelectorAll('*')) if (el.shadowRoot) found.push(...videos(el.shadowRoot));
  return found;
}
// A hover preview in a list is not something being watched: lighting it makes the page flash while the user is only choosing.
// YouTube plays every such preview in one shared player, `ytd-video-preview`, which it moves over the hovered thumbnail.
const PREVIEW = 'ytd-video-preview, #inline-preview-player';
export function findVideo(): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null, score = 0;
  for (const v of videos(document)) {
    if (v.closest(PREVIEW)) continue;
    const r = v.getBoundingClientRect(), css = getComputedStyle(v);
    const area = Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left)) *
      Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top));
    if (r.width < 80 || r.height < 45 || area < 3000 || css.visibility === 'hidden' || css.display === 'none' || css.opacity === '0') continue;
    const candidate = area * (!v.paused && !v.ended ? 2 : 1);
    if (candidate > score) { best = v; score = candidate; }
  }
  return best;
}
/** For Music Mode: whatever is playing sound, with or without a picture. The one that is playing wins over one that is not. */
export function findMedia(root: Document | ShadowRoot = document): HTMLMediaElement | null {
  let best: HTMLMediaElement | null = null;
  for (const media of root.querySelectorAll<HTMLMediaElement>('audio, video')) {
    if (media.closest(PREVIEW)) continue;
    if (!media.paused && !media.ended) return media;
    best ||= media.currentSrc || media.srcObject ? media : null;
  }
  for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { const inner = findMedia(el.shadowRoot); if (inner && (!inner.paused || !best)) best = inner; }
  return best;
}
/**
 * What Chrome says about the colours of the playing video and of this display. Reading a frame's colour space is refused
 * for the same videos whose pixels cannot be read; then the fields stay empty.
 * HDR is only ever detected here: the pixels a page can read are the ones Chrome has already mapped down to SDR.
 */
export function colorInfo(video: HTMLVideoElement | null): Pick<ColorStatus, 'primaries' | 'transfer' | 'hdr' | 'wide' | 'displayP3' | 'displayHdr'> {
  let primaries = '', transfer = '';
  try {
    if (video && video.readyState >= 2 && typeof VideoFrame === 'function') {
      const frame = new VideoFrame(video);
      primaries = frame.colorSpace.primaries || ''; transfer = frame.colorSpace.transfer || ''; frame.close();
    }
  } catch { /* Not readable: cross-origin or protected. */ }
  return { primaries, transfer, hdr: transfer === 'pq' || transfer === 'hlg', wide: primaries === 'bt2020' || primaries === 'smpte432',
    displayP3: matchMedia('(color-gamut: p3)').matches, displayHdr: matchMedia('(dynamic-range: high)').matches };
}
export function fullscreenElement(): Element | null {
  let el = document.fullscreenElement;
  while (el?.shadowRoot?.fullscreenElement) el = el.shadowRoot.fullscreenElement;
  return el;
}
export function videoRect(v: HTMLVideoElement): Rect {
  const r = v.getBoundingClientRect(), css = getComputedStyle(v);
  // Standard players use centered contain. Unknown positioning is explicitly restricted in capture.
  if (css.objectFit === 'contain' && v.videoWidth && v.videoHeight) {
    const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const width = v.videoWidth * scale, height = v.videoHeight * scale;
    return { x: r.x + (r.width - width) / 2, y: r.y + (r.height - height) / 2, width, height };
  }
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}
export function contextFor(v: HTMLVideoElement | null, encrypted: boolean): VideoContext {
  const fs = fullscreenElement();
  return {
    rect: v ? videoRect(v) : null, viewport: { width: innerWidth, height: innerHeight },
    paused: !v || v.paused || v.ended, hidden: document.hidden,
    protected: encrypted || !!v?.mediaKeys,
    fullscreenUnsupported: fs instanceof HTMLVideoElement || fs instanceof HTMLIFrameElement
  };
}
