/** Longer than this for one analysis, or one paint, counts as over budget in the Performance Monitor. */
export const ANALYSIS_BUDGET_MS = 12, RENDER_BUDGET_MS = 6;
/**
 * What each quality level means for the analysis. 0 is full quality.
 * `width`: of the picture that is read. `stride` and `every`: the Light Director reads every `stride`th pixel each way,
 * on every `every`th frame. `interval`: the picture is analysed on every `interval`th tick.
 * The Light Director stays on at every level. It is a small part of the analysis (about 0.2 ms of it at full quality),
 * so switching it off would give almost nothing back: what is left when nothing else helps is analysing less often.
 */
export const QUALITY = [
  { width: 256, stride: 1, every: 1, interval: 1 },
  { width: 256, stride: 2, every: 1, interval: 1 },
  { width: 192, stride: 2, every: 2, interval: 1 },
  { width: 160, stride: 2, every: 2, interval: 2 }
] as const;

/**
 * Lowers the analysis quality when frames keep running long, and raises it again only after a long calm spell.
 * Playback matters more than quality, so going down is quick (about a second of slow frames) and coming back is slow.
 * A level that had to be given up again shortly after it was regained needs twice the calm next time, so a machine
 * sitting right at the limit settles instead of switching back and forth.
 *
 * The last level halves how often the picture is analysed, which shows, so it takes more to get there (`last`) than to
 * the levels before it (`high`), which only make the analysis coarser. A level is regained once frames run `margin`
 * under what it was given up for. (Up to 0.9.1 that took frames under 3.5 ms. Reading a 1080p video alone took longer
 * than that, so a level, once lost, never came back.)
 */
export class AdaptiveQuality {
  level = 0;
  private average = 0; private slow = 0; private calm = 0; private changedAt = -Infinity; private raisedAt = -Infinity; private patience = 1;
  constructor(private readonly high = 8, private readonly last = ANALYSIS_BUDGET_MS, private readonly margin = 1.5) {}
  /** `ms` is how long the last analysis took, `now` the clock in milliseconds. Returns the level to use next. */
  update(ms: number, now: number): number {
    const floor = QUALITY.length - 1;
    this.average = this.average ? this.average + (ms - this.average) * .2 : ms;
    this.slow = this.average > (this.level >= floor - 1 ? this.last : this.high) ? this.slow + 1 : 0;
    this.calm = this.average < (this.level >= floor ? this.last : this.high) - this.margin ? this.calm + 1 : 0;
    if (now - this.changedAt < 4000) return this.level;
    if (this.slow >= 12 && this.level < floor) {
      this.patience = now - this.raisedAt < 30000 ? Math.min(16, this.patience * 2) : this.patience;
      this.level++; this.changedAt = now; this.slow = this.calm = 0;
    } else if (this.calm >= 60 * this.patience && this.level > 0) {
      this.level--; this.changedAt = this.raisedAt = now; this.slow = this.calm = 0;
    } else if (now - this.changedAt > 120000) this.patience = 1;
    return this.level;
  }
  reset(): void { this.level = 0; this.average = this.slow = this.calm = 0; this.changedAt = this.raisedAt = -Infinity; this.patience = 1; }
}
