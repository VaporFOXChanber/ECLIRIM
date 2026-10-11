import { getLanguage, initI18n, t } from '../shared/i18n';
import { fullscreenElement } from '../capture/video';
/** Developer overlay: measured figures in a corner. It never takes a click, and sits away from player controls. */
export class Hud {
  readonly host = document.createElement('div');
  private text = document.createElement('pre');
  constructor() {
    void initI18n();
    this.host.id = 'eclirim-hud'; this.host.setAttribute('aria-hidden', 'true');
    for (const [key, value] of Object.entries({ all: 'initial', position: 'fixed', top: '12px', left: '12px',
      'pointer-events': 'none', 'z-index': '2147483647', display: 'block' })) this.host.style.setProperty(key, value, 'important');
    this.text.style.cssText = 'margin:0;padding:8px 10px;border-radius:6px;background:rgb(8 10 14 / .78);color:#d6dbe4;' +
      'font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-width:calc(100vw - 24px);border:1px solid rgb(255 255 255 / .12);';
    this.host.attachShadow({ mode: 'open' }).append(this.text);
  }
  show(lines: string[]): void {
    const fs = fullscreenElement();
    if (fs instanceof HTMLVideoElement || fs instanceof HTMLIFrameElement) { this.hide(); return; }
    const parent = fs || document.documentElement;
    if (this.host.parentNode !== parent) parent.append(this.host);
    // Preserve technical metric identifiers while providing Japanese explanations.
    const labels: Record<string, string> = { Analysis: '解析時間', Render: '描画時間', Zones: 'ゾーン', Path: '描画方式', Pulse: '音への反応', Glow: '光の形', Missed: '予算を超えた処理' };
    const text = lines.map(line => {
      const label = labels[line.trim().split(/\s/)[0]];
      return getLanguage() === 'ja' && label ? `${line} · ${t(label)}` : line;
    }).join('\n');
    if (this.text.textContent !== text) this.text.textContent = text;
  }
  hide(): void { this.host.remove(); }
}

/** A/B Comparison: says which side the page is showing, for a moment after every switch. It never takes a click. */
export class Badge {
  readonly host = document.createElement('div');
  private text = document.createElement('div'); private timer = 0;
  constructor() {
    this.host.id = 'eclirim-compare'; this.host.setAttribute('aria-hidden', 'true');
    for (const [key, value] of Object.entries({ all: 'initial', position: 'fixed', top: '18px', left: '50%', transform: 'translateX(-50%)',
      'pointer-events': 'none', 'z-index': '2147483647', display: 'block' })) this.host.style.setProperty(key, value, 'important');
    this.text.style.cssText = 'padding:7px 14px;border-radius:999px;background:rgb(8 10 14 / .82);color:#f3d0a5;border:1px solid rgb(243 208 165 / .35);' +
      'font:600 12px/1 -apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN",sans-serif;letter-spacing:.6px;white-space:nowrap;transition:opacity .4s ease;';
    this.host.attachShadow({ mode: 'open' }).append(this.text);
  }
  show(side: 'a' | 'b'): void {
    const fs = fullscreenElement();
    if (fs instanceof HTMLVideoElement || fs instanceof HTMLIFrameElement) { this.hide(); return; }
    const parent = fs || document.documentElement;
    if (this.host.parentNode !== parent) parent.append(this.host);
    this.host.dataset.side = side;
    this.text.textContent = t('ECLIRIM A/B · {0} を表示中', [side.toUpperCase()]); this.text.style.opacity = '1';
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.text.style.opacity = '0'; this.timer = window.setTimeout(() => this.host.remove(), 450); }, 2600);
  }
  hide(): void { clearTimeout(this.timer); this.host.remove(); }
}
