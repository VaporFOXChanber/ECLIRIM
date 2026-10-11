import type { Rect, RGB, Settings } from '../shared/types';
import { MODES, clamp, glowDepth } from '../shared/settings';
import { TemporalFilter } from '../engine/temporal';
import { alongBlur, cornerTaper, glowProfile, glowStrip, ledRow } from '../engine/emission';
import { AutoExposure } from '../engine/exposure';
import { FEATHER, PAD, RIM, guardCap, guardField, guardLevel, guardLimit, guardReach, mergeRects, sideRect, splitRects } from '../engine/guard';
import { zoneTrims, type ZoneTrims } from '../engine/zones';
import { RENDER_BUDGET_MS } from '../engine/adaptive';
import { fullscreenElement } from '../capture/video';
import type { ColorSpace } from '../capture/frame';
const LENGTH = 512, DEPTH = 96, FRAME = 1000 / 30;
/** Beat Bloom at 100%: on a full beat an edge's light reaches this much further into the page. */
const BLOOM = .8;
/**
 * What the Pulse Engine asks of one painted frame: what to multiply each zone's light by; whether a beat has just been
 * counted; per zone, how far to lift its opacity toward full (`lift`); per side, how far to let its light swell (`bloom`).
 */
export interface PulseDrive { gains: Float32Array; beat: boolean; lift?: ArrayLike<number> | null; bloom?: ArrayLike<number> | null }
export class LightingRenderer {
  readonly host = document.createElement('div');
  private canvases: HTMLCanvasElement[] = [];
  private masks: HTMLCanvasElement[] = [];
  // Keep this frame's four LED rows until the guard has seen their drive, before painting any of them.
  private samples = [0, 1, 2, 3].map(() => new Uint8ClampedArray(LENGTH * 4));
  private rows: ImageData[] = [];
  private scratch: HTMLCanvasElement[] = [];
  private space: ColorSpace | '' = '';
  private filter = new TemporalFilter();
  /**
   * Pulse Engine: asked once per painted frame for what to multiply each zone's light by, and whether a beat has just
   * been counted (null = leave the light alone). While it is set the loop keeps running, since sound can move the light
   * when the picture does not.
   */
  pulse: ((count: number, dt: number) => PulseDrive | null) | null = null;
  // Beat Bloom: how far each side's light is swollen into the page right now (0 = not at all), and what the Pulse Engine last asked to lift.
  private swollen = [0, 0, 0, 0]; private lift: ArrayLike<number> | null = null;
  private raf = 0; private last = 0; private awakeUntil = 0; private active = false; private maskKey = '';
  private trims: ZoneTrims = zoneTrims(null, 4);
  // The opacity of each side's glow in edge coordinates ([row inward * LENGTH + along], 0–255): as the Glow Designer shapes
  // it (`base`), with the UI Guard applied (`wanted`), and what is on screen while the guard eases in or out (`shown`).
  private base = [0, 1, 2, 3].map(() => new Float32Array(LENGTH * DEPTH));
  private wanted = this.base.map(() => new Float32Array(LENGTH * DEPTH));
  private shown = this.base.map(() => new Float32Array(LENGTH * DEPTH));
  private easing = [false, false, false, false];
  private images: ImageData[] = [];
  private strongest = new Float32Array(DEPTH); private geometry = { width: 0, height: 0, depth: 0 };
  // UI Guard: what is kept readable, how hard the LEDs along each side were driven in the last painted frame (`lit`),
  // and for every side and rectangle the drive the guard is holding against (`levels`).
  private guarded: Rect[] = []; private guardKey = '';
  // Each side sees what is guarded cut into short pieces along its edge, and holds a level for every piece.
  private pieces = [0, 1, 2, 3].map(side => splitRects([], side)); private levels = [0, 1, 2, 3].map(() => new Float32Array(0));
  private touched = new Set<number>();
  private lit = [0, 1, 2, 3].map(() => new Uint8ClampedArray(LENGTH));
  private guardCapUsed = -1; private stretchUsed = 1; private rim = 0; private painting = false;
  // Adaptive Brightness: follows how bright the whole picture is. Only fed where a picture is read.
  private exposure = new AutoExposure(); private lumaAt = 0;
  // Measured, never estimated: what the Performance Monitor shows for the painting side.
  private paints = 0; private windowAt = 0; private paintedAt = 0; private pendingAt = 0; private running = false;
  private measured = { fps: 0, ms: 0, latency: 0, skipped: 0, over: 0 };
  private restored = { mask: 0, scratch: 0, light: 0 };
  /** `frame`: light the edges of this element instead of the viewport (the Zone Studio preview). */
  constructor(private settings: Settings, private readonly frame: HTMLElement | null = null) {
    this.host.id = 'eclirim-lighting';
    this.host.setAttribute('aria-hidden', 'true');
    for (const [key, val] of Object.entries({
      all: 'initial', position: frame ? 'absolute' : 'fixed', inset: '0', width: '100%', height: '100%',
      'pointer-events': 'none', 'z-index': '2147483647', overflow: 'hidden', contain: 'strict',
      display: 'block', opacity: '1', transform: 'none', isolation: 'isolate'
    })) this.host.style.setProperty(key, val, 'important');
    this.host.attachShadow({ mode: 'open' });
    for (let side = 0; side < 4; side++) {
      const mask = document.createElement('canvas');
      mask.width = side < 2 ? LENGTH : DEPTH; mask.height = side < 2 ? DEPTH : LENGTH;
      this.restoreOnReady(mask, 'mask', side);
      this.masks.push(mask); this.images.push(new ImageData(mask.width, mask.height));
    }
    this.colorSpace('srgb');
    this.update(settings);
  }
  /** A restored 2D context has an empty bitmap, even when its cached shape and colours are unchanged. */
  private restoreOnReady(canvas: HTMLCanvasElement, kind: keyof LightingRenderer['restored'], side = 0): void {
    canvas.addEventListener('contextrestored', () => {
      // The mask is cached between shape/guard changes, so the paint loop alone cannot rebuild it.
      if (kind === 'mask') this.mask(side);
      this.restored[kind]++;
      // Output and scratch canvases are filled by the next paint. A paused picture may have no loop left to do that.
      this.wake();
    });
  }
  /**
   * The colour space the light is painted in. display-p3 shows the colours of a wide-gamut video that sRGB cannot.
   * A canvas keeps the space it was first given, so changing it means new canvases.
   */
  colorSpace(space: ColorSpace): void {
    if (space === this.space) return;
    this.space = space;
    this.rows = this.samples.map((samples, side) => new ImageData(samples, side < 2 ? LENGTH : 1, side < 2 ? 1 : LENGTH, { colorSpace: space }));
    this.scratch = [this.rows[0], this.rows[2]].map(row => {
      const canvas = document.createElement('canvas'); canvas.width = row.width; canvas.height = row.height;
      this.restoreOnReady(canvas, 'scratch');
      canvas.getContext('2d', { colorSpace: space }); return canvas;
    });
    this.canvases = this.masks.map((mask, side) => {
      const canvas = document.createElement('canvas'); canvas.width = mask.width; canvas.height = mask.height;
      // Scaled from the outer edge, so that a swelling light (Beat Bloom) grows into the page and stays put at the edge.
      canvas.style.cssText = `position:absolute;display:block;pointer-events:none;margin:0;border:0;padding:0;transform-origin:${['50% 0', '50% 100%', '0 50%', '100% 50%'][side]};`;
      canvas.dataset.side = ['top', 'bottom', 'left', 'right'][side];
      this.restoreOnReady(canvas, 'light');
      canvas.getContext('2d', { colorSpace: space }); return canvas;
    });
    this.host.shadowRoot!.replaceChildren(...this.canvases);
    if (this.settings) this.update(this.settings);
  }
  private size(): [number, number] {
    return this.frame ? [this.frame.clientWidth, this.frame.clientHeight] : [innerWidth, innerHeight];
  }
  mount(): boolean {
    if (!this.active) return false;
    if (this.frame) { if (this.host.parentNode !== this.frame) this.frame.append(this.host); return true; }
    const fs = fullscreenElement();
    const unsupported = fs instanceof HTMLVideoElement || fs instanceof HTMLIFrameElement;
    this.host.style.setProperty('visibility', unsupported ? 'hidden' : 'visible', 'important');
    if (!unsupported) {
      const parent = fs || document.documentElement;
      if (this.host.parentNode !== parent) parent.append(this.host);
    }
    return !unsupported;
  }
  update(s: Settings): void {
    this.settings = s; this.trims = zoneTrims(s.zones, s.zoneCount);
    const [width, height] = this.size(), depth = glowDepth(width, height, s.glowWidth);
    this.canvases.forEach((canvas, i) => {
      Object.assign(canvas.style, i < 2 ? { width: '100%', height: `${depth}px`, left: '0',
        top: i === 0 ? '0' : 'auto', bottom: i === 1 ? '0' : 'auto' } : {
        height: '100%', width: `${depth}px`, top: '0', left: i === 2 ? '0' : 'auto', right: i === 3 ? '0' : 'auto'
      });
    });
    this.shape(depth, width, height);
    // The guard's own switch and strength are not part of the shape.
    this.protect();
    this.wake();
  }
  /** How the light falls off from the edge. Only redrawn when the geometry, the spread or the Glow Designer changes. */
  private shape(depth: number, width: number, height: number): void {
    const { spread: zoneSpread, plain } = this.trims, glow = this.settings.glow;
    const key = [depth, width, height, this.settings.intensity, glow.style, glow.thickness, glow.curve, glow.falloff, glow.softness, plain ? '' : zoneSpread.join()].join();
    if (key === this.maskKey) return;
    this.maskKey = key; this.geometry = { width, height, depth };
    this.rim = Math.min(RIM, glowStrip(clamp(depth * .03, 2, 6), glow));
    const strip = clamp(depth * .03, 2, 6) / depth, spread = this.settings.intensity / 100, n = zoneSpread.length / 4;
    const profile = (factor: number) => Float32Array.from({ length: DEPTH }, (_, across) =>
      glowProfile((across + .5) / DEPTH, strip, clamp(spread * factor), glow) * 255);
    const even = profile(1);
    this.strongest.set(even);
    this.base.forEach((base, side) => {
      const span = side < 2 ? width : height;
      const taper = Float32Array.from({ length: LENGTH }, (_, along) =>
        cornerTaper(Math.min(along + .5, LENGTH - along - .5) / LENGTH * span, depth));
      // Zone Studio can widen or narrow the halo of single zones: one falloff per zone, blended between neighbours.
      const zones = plain ? null : Array.from({ length: n }, (_, j) => profile(zoneSpread[side * n + j]));
      if (zones) for (const zone of zones) for (let across = 0; across < DEPTH; across++) this.strongest[across] = Math.max(this.strongest[across], zone[across]);
      for (let along = 0; along < LENGTH; along++) {
        const x = clamp((along + .5) / LENGTH * n - .5, 0, n - 1), j = Math.min(n - 2, Math.floor(x)), u = n > 1 ? x - j : 0;
        for (let across = 0; across < DEPTH; across++) {
          const alpha = zones ? zones[Math.max(0, j)][across] * (1 - u) + zones[Math.min(n - 1, j + 1)][across] * u : even[across];
          base[across * LENGTH + along] = alpha * taper[along];
        }
      }
    });
    // A new shape is shown at once: only the guard coming and going is eased.
    this.protect(true);
  }
  /** Puts one side's opacity, as it is shown now, into the mask its light is cut with. */
  private mask(side: number): void {
    const horizontal = side < 2, far = side === 1 || side === 3, shown = this.shown[side], image = this.images[side];
    for (let across = 0; across < DEPTH; across++) {
      const d = far ? DEPTH - 1 - across : across;
      for (let along = 0; along < LENGTH; along++)
        image.data[(horizontal ? d * LENGTH + along : along * DEPTH + d) * 4 + 3] = shown[across * LENGTH + along];
    }
    this.masks[side].getContext('2d')!.putImageData(image, 0, 0);
  }
  /**
   * UI Guard: works out the opacity wanted on every side for what is to be kept readable, against how hard that stretch
   * of edge is driven in this frame. `snap`: show it without easing. `all`: every side again, whatever has changed.
   */
  private protect(snap = false, all = false): void {
    const s = this.settings.guard, { width, height, depth } = this.geometry, on = s.enabled && !this.frame;
    const cap = on ? guardCap(s.strength) : 2, stretch = this.reach;
    if (cap !== this.guardCapUsed || stretch !== this.stretchUsed) { all = true; this.guardCapUsed = cap; this.stretchUsed = stretch; }
    let moved = false;
    this.base.forEach((base, side) => {
      const { pieces, parent } = on ? this.pieces[side] : { pieces: [], parent: [] };
      if (this.levels[side].length !== pieces.length) { this.levels[side] = new Float32Array(pieces.length); all = true; }
      const span = side < 2 ? width : height, lit = this.lit[side], levels = this.levels[side], limits: number[] = []; let changed = all || snap;
      pieces.forEach((rect, r) => {
        const [from, to] = sideRect(side, rect, { width, height }), near = PAD + FEATHER;
        const i0 = clamp(Math.floor((from - near) / span * LENGTH), 0, LENGTH), i1 = clamp(Math.ceil((to + near) / span * LENGTH), 0, LENGTH);
        let peak = 0;
        for (let i = i0; i < i1; i++) if (lit[i] > peak) peak = lit[i];
        const level = guardLevel(levels[r], peak / 255);
        if (level !== levels[r]) { levels[r] = level; changed = true; }
        limits.push(guardLimit(cap, level));
      });
      if (!changed) return;
      const cut = new Uint8Array(pieces.length);
      guardField(base, this.wanted[side], LENGTH, DEPTH, side, pieces, { width, height }, depth, limits, this.rim, cut, stretch);
      // Counted as places, not as pieces: a place is held back if the light is cut for any piece of it on any side.
      for (const key of [...this.touched]) if (Math.floor(key / 4096) === side) this.touched.delete(key);
      cut.forEach((flag, r) => { if (flag) this.touched.add(side * 4096 + parent[r]); });
      if (snap) { this.shown[side].set(this.wanted[side]); this.easing[side] = false; this.mask(side); }
      else { this.easing[side] = true; moved = true; }
    });
    // From inside a painted frame the loop is already running, and carries on while anything is easing.
    if (moved && !this.painting) this.wake();
  }
  /** Tighten before this frame is painted; only releasing the guard is eased, so a beat cannot outrun its limit. */
  private ease(dt: number): void {
    const up = 1 - Math.exp(-dt / .45);
    this.easing.forEach((moving, side) => {
      if (!moving) return;
      const shown = this.shown[side], wanted = this.wanted[side]; let rest = false;
      for (let i = 0; i < shown.length; i++) {
        const d = wanted[i] - shown[i];
        if (d === 0) continue;
        if (d < .75) shown[i] = wanted[i]; else { shown[i] += d * up; rest = true; }
      }
      this.easing[side] = rest; this.mask(side);
    });
  }
  /**
   * How far in from each edge (px) the light can be more opaque than the UI Guard allows over a control: where to look
   * for controls at all. 0 = the guard is off, or the light is nowhere that strong.
   */
  get guardReach(): number {
    const s = this.settings.guard;
    // A swelling light reaches further in: controls are looked for as far as it can get.
    return s.enabled && !this.frame ? guardReach(this.strongest, guardCap(s.strength), this.geometry.depth) * this.reach : 0;
  }
  /**
   * Beat Bloom: how many times further than its own depth the light can reach into the page at the most, with the
   * settings as they are (1 = it does not swell). The UI Guard holds the light for that reach, whatever the beat does.
   */
  private get reach(): number {
    const s = this.settings, listening = (s.pulse.enabled || s.source === 'music') && !this.frame;
    return listening && s.pulse.bloom > 0 && s.pulse.depth > 0 ? 1 + BLOOM * s.pulse.bloom / 100 * (s.flashLimiter ? .5 : 1) : 1;
  }
  /**
   * Beat Bloom: scales each side's light from its edge into the page. Only the compositor has work to do for it.
   * With the Flash Limiter on it swells half as far and takes a moment to get there.
   */
  private swell(bloom: ArrayLike<number> | null | undefined, dt: number): void {
    const calm = this.settings.flashLimiter, most = this.reach - 1;
    this.canvases.forEach((canvas, side) => {
      let wanted = bloom ? Math.min(most, BLOOM * bloom[side] * (calm ? .5 : 1)) : 0;
      if (calm && wanted > this.swollen[side]) wanted = Math.min(wanted, this.swollen[side] + 2 * dt);
      if (Math.abs(wanted - this.swollen[side]) < .002 && (wanted > 0 || this.swollen[side] === 0)) return;
      this.swollen[side] = wanted;
      canvas.style.transform = wanted > 0 ? `${side < 2 ? 'scaleY' : 'scaleX'}(${(1 + wanted).toFixed(4)})` : '';
    });
  }
  /** UI Guard: the controls, captions and text found under the light (viewport px). Returns how many places that makes. */
  guard(rects: readonly Rect[]): number {
    const merged = mergeRects(rects, 10), key = merged.map(r => [r.x, r.y, r.width, r.height].map(Math.round).join()).join(';');
    if (key !== this.guardKey) {
      this.guardKey = key; this.guarded = merged; this.pieces = [0, 1, 2, 3].map(side => splitRects(merged, side));
      this.levels = this.levels.map(() => new Float32Array(0)); this.touched.clear(); this.protect(false, true);
    }
    return merged.length;
  }
  /** In how many of those places the light is being held back right now. In a dim scene that can be none of them. */
  get guardHeld(): number { return new Set([...this.touched].map(key => key % 4096)).size; }
  /** `at`: when the frame behind these colours was read, for measuring how long it takes to reach the screen. */
  /** `luma`: how bright the whole picture behind these colours is (Adaptive Brightness). Left out where no picture is read. */
  target(colors: RGB[], at = 0, luma?: number): void {
    if (this.trims.gain.length !== colors.length) this.trims = zoneTrims(this.settings.zones, colors.length);
    const exposure = this.settings.exposure, adapt = luma !== undefined && exposure.enabled, now = performance.now();
    if (adapt) { this.exposure.update(luma, (now - this.lumaAt) / 1000, exposure); this.lumaAt = now; }
    else if (!exposure.enabled) this.exposure.reset();
    this.filter.setTarget(colors, this.settings, this.trims.saturation, adapt ? l => this.exposure.scale(l, exposure) : null);
    if (at && !this.pendingAt) this.pendingAt = at;
    this.wake();
  }
  /** What the painting side measured. `fps` is 0 while nothing changes and the loop sleeps. */
  get metrics(): { fps: number; ms: number; latency: number; skipped: number; over: number; active: number } {
    return { ...this.measured, fps: performance.now() - this.paintedAt < 1500 ? this.measured.fps : 0, active: this.trims.active };
  }
  /** Adaptive Brightness as it stands: the brightness of the picture it follows (below 0 = none seen) and what it does to a full zone. */
  get adaptation(): { key: number; level: number } { return { key: this.exposure.key, level: this.exposure.level(this.settings.exposure) }; }
  /** For diagnostics: the state the light is painted from, in numbers. */
  probe(): Record<string, unknown> {
    const most = (values: ArrayLike<number>) => { let max = 0, bad = 0; for (let i = 0; i < values.length; i++) { if (!Number.isFinite(values[i])) bad++; else if (values[i] > max) max = values[i]; } return bad ? `${max} (${bad} not numbers)` : Math.round(max * 100) / 100; };
    return { active: this.active, looping: !!this.raf, sinceWake: Math.round(4000 - (this.awakeUntil - performance.now())), sincePaint: Math.round(performance.now() - this.paintedAt),
      geometry: this.geometry, swollen: this.swollen, rim: this.rim, space: this.space, zones: this.trims.gain.length, plain: this.trims.plain, trim: most(this.trims.gain),
      base: this.base.map(most), wanted: this.wanted.map(most), shown: this.shown.map(most), easing: this.easing, lit: this.lit.map(most), guarded: this.guarded.length, pieces: this.pieces.map(side => side.pieces.length), colours: this.filter.probe(), restored: { ...this.restored } };
  }
  /** Starts the paint loop if it has gone to sleep. */
  wake(): void {
    this.awakeUntil = performance.now() + 4000;
    if (this.active && !this.raf) { this.last = performance.now(); this.running = false; this.raf = requestAnimationFrame(this.render); }
  }
  show(): void { const wasActive = this.active; this.active = true; this.mount(); if (!wasActive) this.wake(); }
  hide(): void {
    const wasActive = this.active;
    this.active = false; cancelAnimationFrame(this.raf); this.raf = 0; this.pendingAt = 0; this.paintedAt = 0;
    this.filter.reset(); this.exposure.reset(); this.host.remove(); this.swell(null, 0);
    if (wasActive) this.canvases.forEach(canvas => canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height));
  }
  private render = (now: number): void => {
    this.raf = 0;
    if (!this.active) return;
    if (now - this.last >= FRAME - 1) {
      const began = performance.now(), gap = now - this.last, m = this.measured;
      const sound = this.pulse?.(this.trims.gain.length, gap / 1000);
      const colors = this.filter.step(gap / 1000, this.settings, sound?.gains, sound?.beat);
      // The lift acts on what is shown, past the Flash Limiter's reach: so it is only used while that is off.
      this.lift = sound && !this.settings.flashLimiter ? sound.lift || null : null;
      this.swell(sound?.bloom, gap / 1000);
      this.last = now;
      if (colors.length) { this.painting = true; try { this.paint(colors, Math.min(.1, gap / 1000)); } finally { this.painting = false; } }
      else if (this.easing.some(Boolean)) this.ease(Math.min(.1, gap / 1000));
      const took = performance.now() - began;
      m.ms += (took - m.ms) * (m.ms ? .1 : 1);
      if (took > RENDER_BUDGET_MS) m.over++;
      // A gap is only a missed frame while the loop was already running, not when it has just woken up.
      if (this.running && gap > FRAME * 2.5) m.skipped += Math.round(gap / FRAME) - 1;
      if (!this.running) { this.windowAt = began; this.paints = 0; }
      this.running = true; this.paints++; this.paintedAt = began;
      if (began - this.windowAt >= 1000) { m.fps = (this.paints - 1) * 1000 / (began - this.windowAt); this.paints = 1; this.windowAt = began; }
      if (this.pendingAt && colors.length) { const wait = performance.now() - this.pendingAt; m.latency += (wait - m.latency) * (m.latency ? .2 : 1); this.pendingAt = 0; }
    }
    if (now < this.awakeUntil || this.pulse || !this.filter.settled || this.easing.some(Boolean)) this.raf = requestAnimationFrame(this.render);
  };
  // Light, not paint: each LED keeps its full colour and brightness only changes how opaque it is,
  // so a dark scene leaves the page untouched instead of drawing a dark frame over it.
  private paint(colors: RGB[], dt: number): void {
    const mode = MODES[this.settings.mode], gain = this.settings.brightness / 100 * mode.gain, blur = alongBlur(this.settings.glow, colors.length / 4);
    this.samples.forEach((samples, side) => {
      ledRow(colors, side, LENGTH, gain, mode.curve, samples, this.trims.plain ? undefined : this.trims.gain, this.settings.color, blur, this.lift);
      const lit = this.lit[side];
      for (let i = 0; i < LENGTH; i++) lit[i] = samples[i * 4 + 3];
    });
    // The mask must hold against the drive about to be drawn, including a beat's lift or a sudden bright scene.
    if (this.guarded.length) this.protect();
    if (this.easing.some(Boolean)) this.ease(dt);
    this.canvases.forEach((canvas, side) => {
      const ctx = canvas.getContext('2d')!, row = side < 2 ? 0 : 1;
      this.scratch[row].getContext('2d')!.putImageData(this.rows[side], 0, 0);
      ctx.imageSmoothingEnabled = false; ctx.globalCompositeOperation = 'copy';
      ctx.drawImage(this.scratch[row], 0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(this.masks[side], 0, 0);
    });
  }
}
