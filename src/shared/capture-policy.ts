import type { Source, VideoContext } from './types';
/** Services whose streams are protected throughout: no need to wait for an `encrypted` event. */
export const protectedService = (service: string) => service === 'Netflix' || service === 'Prime Video';
/**
 * Chrome on macOS shows protected video in a separate layer that neither screen capture nor the page's own compositing
 * can see. A backdrop filter over it receives nothing, so there the CSS path has no colour to work with.
 * Measured on a real display with Widevine: the same film lit the edges unprotected and left them dark protected.
 */
export const hidesProtectedVideo = (platform: string) => /mac/i.test(platform);
export type LightingPath = 'analysis' | 'compatibility' | 'unreadable' | 'fixed';
/** Which light a tab gets. Protected pixels are never read; where they cannot even be composited, that is said plainly. */
export function lightingPath(source: Source, service: string, protectedMedia: boolean, platform: string): LightingPath {
  if (source !== 'video' && source !== 'compatibility') return 'fixed';
  if (protectedMedia) return hidesProtectedVideo(platform) ? 'unreadable' : 'compatibility';
  return source === 'compatibility' || protectedService(service) ? 'compatibility' : 'analysis';
}
export function captureBlockReason(context: VideoContext, url: string): string | null {
  if (context.protected) return '暗号化動画のタブ取得は画質に影響する場合があります。「DRM互換描画」を使用してください。';
  let host = '';
  try { host = new URL(url).hostname; } catch { return '動画ページのURLを確認できません。'; }
  if (/(^|\.)netflix\.com$|(^|\.)primevideo\.com$|(^|\.)amazon\.(com|co\.jp|co\.uk|de|fr)$/.test(host))
    return 'この配信サイトではタブ取得によるHDCP・画質への影響を避けるため、CSS互換描画を使用してください。';
  return null;
}
