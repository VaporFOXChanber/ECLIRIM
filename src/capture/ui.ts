import type { Rect } from '../shared/types';

// What a person operates. Whole cards and panels that happen to be links are left out further down by their size.
const CONTROL = ['a[href]', 'button', 'input', 'select', 'textarea', 'summary', 'label', '[contenteditable=""]', '[contenteditable="true"]',
  ...['button', 'link', 'slider', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'option', 'scrollbar']
    .map(role => `[role="${role}"]`), '[tabindex]:not([tabindex="-1"])'].join(',');
// Nothing readable lies under these.
const OPAQUE = new Set(['HTML', 'BODY', 'VIDEO', 'IFRAME', 'CANVAS', 'EMBED', 'OBJECT']);
const STEP = 28, KNOWN = 160, CONTROLS = 0, TEXT = 1, ICON = 2;
type Kind = typeof CONTROLS | typeof TEXT | typeof ICON;

type Checked = Element & { checkVisibility?: (options?: Record<string, boolean>) => boolean };
// Faded-out player controls are still in the page and still take clicks: what counts is whether they can be seen.
// Both spellings of the options are given: Chrome renamed them in 121.
const visible = (el: Element) => (el as Checked).checkVisibility?.({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true }) ?? true;
function hasText(el: Element): boolean {
  // Only whether there is any text at all. What it says is never read, kept or sent.
  for (let node = el.firstChild; node; node = node.nextSibling) if (node.nodeType === 3 && /\S/.test((node as Text).data)) return true;
  return false;
}
const box = (r: DOMRect): Rect => ({ x: r.left, y: r.top, width: r.width, height: r.height });
/** The topmost element at a point, looking into open shadow trees as well. Elements that take no clicks are never it. */
function at(x: number, y: number): Element | null {
  let found = document.elementFromPoint(x, y);
  for (let depth = 0; found?.shadowRoot && depth < 3; depth++) {
    const inner = found.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === found || !found.shadowRoot.contains(inner)) break;
    found = inner;
  }
  return found;
}

/**
 * UI Guard, the looking part: finds controls, icons and text that lie under the light near the edges of the page.
 *
 * Finding is done by asking the browser what is at a point, the same hit test a click uses; no pixel is ever read. On a
 * large page one such question is not cheap, so they are asked a few at a time (`sweep`), going round the edges again and
 * again. What has been found once is remembered and from then on only checked: is it still in the page, can it be seen,
 * where is it (`rects`). That is cheap, and it is what makes controls that fade in and out be guarded the moment they
 * are back.
 *
 * Things it cannot see: anything drawn inside a canvas, a video's built-in controls, elements that take no clicks.
 */
export class UiScanner {
  private range = document.createRange();
  private known = new Map<Element, Kind>();
  // Text is measured letter by letter, which costs more: it is only measured again when its element has moved.
  private letters = new WeakMap<Element, { at: string; rect: Rect | null }>();
  private points: Float32Array[] = [new Float32Array(0), new Float32Array(0), new Float32Array(0), new Float32Array(0)];
  private cursor = [0, 0, 0, 0]; private plan = ''; private turn = 0;
  /** How many full rounds of the edges have been made since the last `forget`. */
  rounds = 0;
  private small(r: DOMRect, area: number): boolean {
    return r.width > 0 && r.height > 0 && Math.min(r.width, r.height) <= 96 && r.width * r.height <= area * .1;
  }
  private remember(el: Element, kind: Kind): void {
    if (this.known.has(el)) return;
    if (this.known.size >= KNOWN) this.known.delete(this.known.keys().next().value!);
    this.known.set(el, kind);
  }
  // Controls come in bars. Once one is found, the rest of its bar is taken along: a seek bar a few pixels thin sits
  // between the points that are looked at, but right next to a button that does not.
  private bar(control: Element, area: number): void {
    let bar: Element = control;
    for (let level = 0; level < 3 && bar.parentElement; level++) {
      const r = bar.parentElement.getBoundingClientRect();
      if (Math.min(r.width, r.height) > 140 || r.width * r.height > area * .25) break;
      bar = bar.parentElement;
    }
    if (bar === control) return;
    let taken = 0;
    for (const other of bar.querySelectorAll(CONTROL)) { if (taken++ >= 24) break; this.remember(other, CONTROLS); }
  }
  /** What is at this point, if it is something to keep readable. Remembered from then on. */
  private look(x: number, y: number, area: number): void {
    const el = at(x, y);
    if (!el || OPAQUE.has(el.tagName) || this.known.has(el)) return;
    const control = el.closest(CONTROL);
    if (control) {
      if (this.known.has(control)) return;
      if (this.small(control.getBoundingClientRect(), area)) { this.remember(control, CONTROLS); this.bar(control, area); return; }
    }
    if (hasText(el)) this.remember(el, TEXT);
    else if (el instanceof SVGElement || el.tagName === 'IMG') {
      const icon = el instanceof SVGElement && el.ownerSVGElement || el, r = icon.getBoundingClientRect();
      if (r.width > 0 && Math.max(r.width, r.height) <= 64) this.remember(icon, ICON);
    }
  }
  /** The points to look at: rows from each edge inward, close together where the light is strongest, wider apart further in. */
  private layout(reach: number): void {
    const width = innerWidth, height = innerHeight, plan = `${Math.round(reach)}|${width}|${height}`;
    if (plan === this.plan) return;
    this.plan = plan; this.cursor = [0, 0, 0, 0];
    const rows: number[] = [];
    for (let across = Math.min(5, reach / 2); across < reach; across += across < 76 ? 18 : 40) rows.push(across);
    this.points = [0, 1, 2, 3].map(side => {
      const span = side < 2 ? width : height, out: number[] = [];
      // Every other row is shifted by half a step.
      for (const [index, across] of rows.entries()) for (let along = index % 2 ? STEP : STEP / 2; along < span; along += STEP)
        out.push(side < 2 ? along : side === 2 ? across : width - 1 - across, side < 2 ? (side === 0 ? across : height - 1 - across) : along);
      return Float32Array.from(out);
    });
  }
  /**
   * Looks at more points for at most `budget` ms, carrying on where the last call stopped. `prefer`: a side (0 top,
   * 1 bottom, 2 left, 3 right) to look at twice as often as the others, or −1.
   */
  sweep(reach: number, budget: number, prefer = -1): void {
    this.layout(reach);
    const area = innerWidth * innerHeight, began = performance.now();
    for (let guard = 0; guard < 400 && performance.now() - began < budget; guard++) {
      const side = prefer >= 0 && this.turn % 2 ? prefer : Math.floor(this.turn / (prefer >= 0 ? 2 : 1)) % 4; this.turn++;
      const points = this.points[side];
      if (!points.length) continue;
      // A few points at a time between looks at the clock.
      for (let n = 0; n < 3; n++) {
        const i = this.cursor[side];
        this.look(points[i], points[i + 1], area);
        this.cursor[side] = i + 2 >= points.length ? 0 : i + 2;
        if (!this.cursor[side] && side === 3) this.rounds++;
      }
    }
  }
  /** Everything found so far that is in the page, can be seen, and lies within `reach` px of an edge, right now. */
  rects(reach: number): Rect[] {
    const width = innerWidth, height = innerHeight, area = width * height, out: Rect[] = [];
    for (const [el, kind] of this.known) {
      if (!el.isConnected) { this.known.delete(el); continue; }
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.left > reach && r.top > reach && r.right < width - reach && r.bottom < height - reach) continue;
      if (r.right < 0 || r.bottom < 0 || r.left > width || r.top > height || !visible(el)) continue;
      if (kind === CONTROLS) { if (this.small(r, area)) out.push(box(r)); continue; }
      if (kind === ICON) { out.push(box(r)); continue; }
      // The text itself, not the block it sits in: a short label in a wide bar guards only its own letters.
      const key = `${r.left}|${r.top}|${r.width}|${r.height}`; let text = this.letters.get(el);
      if (!text || text.at !== key) {
        this.range.selectNodeContents(el);
        const t = this.range.getBoundingClientRect();
        text = { at: key, rect: t.width > 0 && t.height > 0 ? box(t) : null }; this.letters.set(el, text);
      }
      if (text.rect) out.push(text.rect);
    }
    return out;
  }
  /** Starts over: after the page has changed what is on top of what (fullscreen in or out). */
  forget(): void { this.known.clear(); this.plan = ''; this.rounds = 0; }
  get remembered(): number { return this.known.size; }
}

/** How long the watching may take: per tick while the page is left alone, per tick while it is in use, and the tick itself (ms). */
export const BUDGET = { idle: .7, busy: 1.6, tick: 110 };
/**
 * UI Guard, the watching part. Every tick it checks what has been found, looks at a few more points, and hands what
 * lies under the light to `apply`. While the page is being used (the pointer moves, a key is pressed, the page scrolls)
 * it looks harder, and first on the side the pointer is closest to. Its time is bounded: see BUDGET.
 * With `pointer` on, the place of the mouse pointer near an edge counts as something to keep readable too, at once:
 * that covers controls the looking cannot see, and the moment before it has found the ones it can.
 */
export class UiWatch {
  private scanner = new UiScanner();
  private found: Rect[] = []; private turn = 0;
  private mouse = { x: -1, y: -1, at: 0 }; private stirred = 0; private timer = 0; private pointer = true;
  private listening: AbortController | null = null; private sent = '';
  /** What the last tick cost in all (checking and looking), and how many things are being kept readable. */
  ms = 0; regions = 0;
  constructor(private readonly reach: () => number, private readonly apply: (rects: Rect[]) => number) {}
  get running(): boolean { return !!this.listening; }
  start(pointer: boolean): void {
    this.pointer = pointer;
    if (this.listening) return;
    const signal = (this.listening = new AbortController()).signal, stir = () => { this.stirred = performance.now(); };
    addEventListener('pointermove', e => {
      const now = performance.now(), moved = Math.abs(e.clientX - this.mouse.x) + Math.abs(e.clientY - this.mouse.y);
      this.mouse = { x: e.clientX, y: e.clientY, at: now }; this.stirred = now;
      // The light eases around the pointer without waiting for the next tick.
      if (this.pointer && moved >= 8) this.send();
    }, { capture: true, passive: true, signal });
    for (const type of ['pointerdown', 'keydown', 'wheel', 'scroll', 'focusin', 'resize']) addEventListener(type, stir, { capture: true, passive: true, signal });
    // In fullscreen only the fullscreen element is on screen: what was found on the page under it no longer counts.
    document.addEventListener('fullscreenchange', () => { stir(); this.scanner.forget(); this.found = []; }, { signal });
    this.stirred = performance.now(); this.timer = window.setInterval(() => this.tick(), BUDGET.tick);
  }
  stop(): void {
    if (!this.listening) return;
    this.listening.abort(); this.listening = null; clearInterval(this.timer);
    this.scanner.forget(); this.found = []; this.sent = ''; this.regions = 0; this.ms = 0; this.apply([]);
  }
  private near(reach: number): Rect | null {
    const { x, y, at } = this.mouse, margin = reach + 40;
    if (!this.pointer || performance.now() - at > 1800 || x < 0) return null;
    if (x > margin && x < innerWidth - margin && y > margin && y < innerHeight - margin) return null;
    return { x: Math.round(x / 8) * 8 - 44, y: Math.round(y / 8) * 8 - 30, width: 88, height: 60 };
  }
  private send(): void {
    const reach = this.reach(), mouse = reach ? this.near(reach) : null, rects = reach ? (mouse ? [...this.found, mouse] : this.found) : [];
    const key = rects.map(r => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`).join(';');
    if (key === this.sent) return;
    this.sent = key; this.regions = this.apply(rects);
  }
  private tick(): void {
    if (document.hidden) return;
    const reach = this.reach(), began = performance.now();
    if (reach) {
      const busy = began - this.stirred < 1500, { x, y } = this.mouse;
      // What is known is checked on every tick while the page is in use, and on every other one while it is left alone.
      if (busy || this.turn++ % 2 === 0) this.found = this.scanner.rects(reach + 30);
      const closest = !busy || x < 0 ? -1 : [y, innerHeight - y, x, innerWidth - x].reduce((best, d, side, all) => d < all[best] ? side : best, 0);
      // Until the edges have been gone round once, there is catching up to do.
      this.scanner.sweep(reach, busy || !this.scanner.rounds ? BUDGET.busy : BUDGET.idle, closest);
      this.ms = performance.now() - began;
    } else { this.found = []; this.ms = 0; }
    this.send();
  }
}
