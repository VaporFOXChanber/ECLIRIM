import type { Rect, Settings } from '../shared/types';
import { MODES, clamp, glowDepth } from '../shared/settings';
import { edgeFilters, glowProfile, isClassicGlow, type FilterPrimitive } from '../engine/emission';
import { fullscreenElement } from '../capture/video';

const SVG = 'http://www.w3.org/2000/svg';
function build({ tag, children = [], ...attributes }: FilterPrimitive): SVGElement {
  const element = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  element.append(...children.map(build));
  return element;
}

/** Compositor-only: no drawImage, captureStream, getImageData, textures or pixel readback. */
export class CompatibilityRenderer {
  readonly host = document.createElement('div');
  // Top/bottom and left/right are two layers, each with its own filter, so they overlap in the corners like two lights.
  private sides = (['rows', 'columns'] as const).map(name => ({
    name, layer: document.createElement('div'), filter: document.createElementNS(SVG, 'filter'), last: ''
  }));
  constructor() {
    this.host.id = 'eclirim-compatibility'; this.host.setAttribute('aria-hidden', 'true');
    for (const [key, value] of Object.entries({ all: 'initial', display: 'block', position: 'fixed',
      inset: '0', 'pointer-events': 'none', 'z-index': '2147483647', background: 'transparent',
      margin: '0', border: '0', padding: '0' }))
      this.host.style.setProperty(key, value, 'important');
    // The filters live beside the layers in a shadow tree: nothing is fetched (page CSP cannot block it) and page CSS cannot reach it.
    // Opacity belongs to the layers themselves. On the host it would cut them off from the page behind.
    const shadow = this.host.attachShadow({ mode: 'open' }), svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.style.cssText = 'position:absolute;';
    for (const { name, layer, filter } of this.sides) {
      filter.id = `eclirim-${name}`; filter.setAttribute('filterUnits', 'userSpaceOnUse');
      filter.setAttribute('color-interpolation-filters', 'sRGB');
      layer.dataset.side = name;
      // Mask: the stretch of edge facing the picture, intersected with the two glow profiles of this pair.
      layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;transition:opacity 700ms ease;' +
        `backdrop-filter:url(#eclirim-${name});mask-composite:intersect,add,add;-webkit-mask-composite:source-in,source-over,source-over;`;
      svg.append(filter);
    }
    shadow.append(svg, ...this.sides.map(side => side.layer));
  }
  show(s: Settings, rect: Rect, lit: boolean): boolean {
    if (!CSS.supports('backdrop-filter', 'blur(10px)')) return false;
    const fs = fullscreenElement();
    if (fs instanceof HTMLVideoElement || fs instanceof HTMLIFrameElement) { this.hide(); return false; }
    const parent = fs || document.documentElement;
    if (this.host.parentNode !== parent) parent.append(this.host);
    const width = innerWidth, height = innerHeight, depth = glowDepth(width, height, s.glowWidth), mode = MODES[s.mode];
    const filters = edgeFilters({ width, height, depth, picture: rect, curve: mode.curve, saturation: s.saturation / 100 * mode.saturation });
    // Same shape as the analysed light: a thin strip on the edge, then a halo fading inward.
    const alpha = Math.min(1, s.brightness / 100 * mode.gain), strip = clamp(depth * .03, 2, 6) / depth;
    // The Glow Designer shapes this light too: the same profile, as gradient stops (more of them once it leaves the classic shape).
    const at = isClassicGlow(s.glow) ? [0, strip, strip * 1.7, strip * 2.4, .08, .14, .22, .32, .45, .6, .8, 1]
      : [0, strip * .5, strip, strip * 1.7, strip * 2.4, strip * 4, .05, .08, .11, .14, .18, .22, .27, .32, .38, .45, .52, .6, .7, .8, .9, 1].sort((a, b) => a - b);
    const stops = at.map(t =>
      `rgb(0 0 0 / ${(alpha * glowProfile(t, strip, s.intensity / 100, s.glow)).toFixed(3)}) ${(t * depth).toFixed(1)}px`).join(',');
    for (const side of this.sides) {
      const rows = side.name === 'rows', [clear, full, fullEnd, clearEnd] = filters.span[side.name];
      const key = JSON.stringify([width, height, stops, filters.span[side.name], filters[side.name]]);
      if (key !== side.last) {
        for (const [name, value] of Object.entries({ x: 0, y: 0, width, height })) side.filter.setAttribute(name, String(value));
        side.filter.replaceChildren(...filters[side.name].map(build));
        const mask = [`linear-gradient(to ${rows ? 'right' : 'bottom'},transparent ${clear}px,#000 ${full}px,#000 ${fullEnd}px,transparent ${clearEnd}px)`,
          ...(rows ? ['bottom', 'top'] : ['right', 'left']).map(to => `linear-gradient(to ${to},${stops})`)].join(',');
        side.layer.style.setProperty('mask-image', mask); side.layer.style.setProperty('-webkit-mask-image', mask);
        side.last = key;
      }
      side.layer.style.setProperty('opacity', lit ? '1' : '0');
    }
    return true;
  }
  hide(): void { this.host.remove(); }
}
