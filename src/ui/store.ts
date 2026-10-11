import { DEFAULTS, LOOK_KEYS, compareSettings, loadCompare, loadPresets, loadProfiles, loadSettings, lookOf, presetName, resolveSettings, sanitize, sanitizeCompare, sanitizePreset, sanitizePresets, sanitizeProfile, sanitizeProfiles, savePresets, saveProfiles, saveSettings } from '../shared/settings';
import type { AudioStatus, Compare, LookKey, PresetLook, Presets, Profile, Profiles, Settings } from '../shared/types';

/** What the popup and the settings page edit: the global settings, or one site's profile lying over them. */
export class Store {
  global: Settings = DEFAULTS; profiles: Profiles = {};
  /** The user's own presets, by name. */
  presets: Presets = {};
  /** The site whose profile is being edited, or '' for the global settings. */
  target = '';
  /** A/B Comparison in progress, if any. It belongs to one set of settings (its `target`). */
  compare: Compare | null = null;
  private saving: Promise<void> = Promise.resolve(); private pending = 0; private loaded = false;
  constructor(private readonly failed: (message: string) => void) {}
  async load(): Promise<void> {
    [this.global, this.profiles, this.presets, this.compare] = await Promise.all([loadSettings(), loadProfiles(), loadPresets(), loadCompare()]);
    this.loaded = true;
    if (this.target && !this.profiles[this.target]) this.target = '';
  }
  /**
   * Takes over a change made elsewhere (the popup and the settings page can be open together).
   * While this page's own changes are still being written it keeps its own, newer state: false means nothing was taken.
   */
  adopt(changes: Record<string, chrome.storage.StorageChange>): boolean {
    if (this.pending) return false;
    if (changes.settings) this.global = sanitize(changes.settings.newValue);
    if (changes.profiles) this.profiles = sanitizeProfiles(changes.profiles.newValue);
    if (changes.presets) this.presets = sanitizePresets(changes.presets.newValue);
    if (changes.compare) this.compare = sanitizeCompare(changes.compare.newValue);
    if (this.target && !this.profiles[this.target]) this.target = '';
    return true;
  }
  get profile(): Profile | null { return this.target ? this.profiles[this.target] || null : null; }
  /** What is saved for what is being edited, whatever is being compared. */
  get kept(): Settings { return resolveSettings(this.global, this.profile); }
  /** Whether an A/B comparison of the settings being edited is running. */
  get comparing(): boolean { return !!this.compare && this.compare.target === this.target; }
  /** The settings in effect for what is being edited: during a comparison, the side that is switched to. */
  get settings(): Settings { return compareSettings(this.kept, this.compare, this.target); }
  private queue(job: () => Promise<void>): void {
    // Nothing is written before what is stored has been read: a control touched in that first moment must not put the defaults in its place.
    if (!this.loaded) return;
    this.pending++;
    this.saving = this.saving.then(job).catch(e => this.failed(`設定を保存できませんでした: ${e}`)).finally(() => { this.pending--; });
  }
  /**
   * Look settings go to the profile being edited; everything else is global.
   * During an A/B comparison, look settings go to the side that is showing instead: the saved settings stay as they are.
   */
  change(patch: Partial<Settings>): void {
    if (this.comparing) {
      const look: Profile = {}, rest: Partial<Settings> = {};
      for (const [key, value] of Object.entries(patch)) Object.assign(LOOK_KEYS.includes(key as LookKey) ? look : rest, { [key]: value });
      if (Object.keys(look).length) { const c = this.compare!; this.setCompare({ ...c, [c.active]: sanitizeProfile({ ...c[c.active], ...look }) }); }
      if (!Object.keys(rest).length) return;
      patch = rest;
    }
    const profile = this.profile ? { ...this.profile } : null, global: Partial<Settings> = {};
    for (const [key, value] of Object.entries(patch)) Object.assign(profile && LOOK_KEYS.includes(key as LookKey) ? profile : global, { [key]: value });
    if (profile) this.setProfile(this.target, profile);
    if (Object.keys(global).length) { const next = this.global = sanitize({ ...this.global, ...global }); this.queue(() => saveSettings(next)); }
  }
  /** Creates or replaces a site's profile; null removes it, which returns that site to the global settings. */
  setProfile(site: string, profile: Profile | null): void {
    const next = { ...this.profiles };
    if (profile) next[site] = profile; else delete next[site];
    this.profiles = sanitizeProfiles(next);
    if (this.target && !this.profiles[this.target]) this.target = '';
    const snapshot = this.profiles; this.queue(() => saveProfiles(snapshot));
  }
  private setCompare(compare: Compare | null): void {
    this.compare = compare;
    this.queue(() => compare ? chrome.storage.local.set({ compare }) : chrome.storage.local.remove('compare'));
  }
  /**
   * Starts an A/B comparison of the settings being edited. A is their look as it is saved now. B starts as the same look,
   * or as A with `b` laid over it (a preset, a wizard result). B is the side shown first: it is the one to be changed.
   */
  startCompare(b?: Profile | null): void {
    const a = lookOf(this.kept);
    this.setCompare({ active: 'b', a, b: sanitizeProfile({ ...a, ...(b || {}) }), target: this.target });
  }
  /** Switches the lit tabs, and this page, to the other look. */
  showSide(side: 'a' | 'b'): void { if (this.compare && this.compare.active !== side) this.setCompare({ ...this.compare, active: side }); }
  /**
   * Ends the comparison. With a side, that look becomes the saved one (only what differs from before is written);
   * with null everything stays as it was saved. Returns what was written.
   */
  endCompare(adopt: 'a' | 'b' | null): LookKey[] {
    const compare = this.compare, mine = this.comparing;
    this.setCompare(null);
    if (!adopt || !compare || !mine) return [];
    const before = lookOf(this.kept), chosen = compare[adopt], patch: Profile = {};
    for (const key of LOOK_KEYS) if (key in chosen && JSON.stringify(chosen[key]) !== JSON.stringify(before[key])) Object.assign(patch, { [key]: chosen[key] });
    if (Object.keys(patch).length) this.change(patch);
    return Object.keys(patch) as LookKey[];
  }
  /** Keeps a preset under this name, or with null removes it. Returns the name as it was stored ('' = not a usable name). */
  setPreset(name: string, preset: PresetLook | null): string {
    const clean = presetName(name);
    if (!clean) return '';
    const next = { ...this.presets };
    if (preset) next[clean] = sanitizePreset(preset); else delete next[clean];
    this.presets = next; this.queue(() => savePresets(next));
    return clean;
  }
  /** Replaces everything at once: reading a backup. */
  restore(settings: Settings, profiles: Profiles, presets: Presets): void {
    this.global = sanitize(settings); this.profiles = sanitizeProfiles(profiles); this.presets = sanitizePresets(presets);
    if (this.target && !this.profiles[this.target]) this.target = '';
    const all = { settings: this.global, profiles: this.profiles, presets: this.presets };
    this.queue(() => chrome.storage.local.set(all));
  }
  /** Resolves once everything changed so far is stored. */
  get saved(): Promise<void> { return this.saving; }
}

/** Human names of what a profile can hold, for listing its differences from the global settings. */
export const LOOK_NAMES: Record<LookKey, string> = {
  mode: '照明モード', brightness: '明るさ', glowWidth: '光の幅', intensity: '光の拡散', saturation: '彩度', smoothing: '滑らかさ',
  responseSpeed: '追従速度', flashLimiter: 'Flash Limiter', director: 'Light Director', zones: 'Zone Studio',
  pulse: 'Pulse Engine', color: 'Color Engine', trails: 'Light Trails', glow: 'Glow Designer', guard: 'UI Guard', exposure: 'Adaptive Brightness'
};
/** What the Pulse Engine is doing in a tab, in words. */
export const AUDIO_NAMES: Record<AudioStatus['state'], string> = {
  off: 'オフ', active: '音を解析中', muted: 'プレイヤーがミュート中（光は動きません）', waiting: 'ページを一度クリックすると始まります',
  protected: '保護されたコンテンツのため、音は解析しません', blocked: '別のサイトから配信された音のため、Chromeが読み取りを許可しません', none: '音の出ているものがありません'
};
/** Streaming sites where the picture itself may be protected: a profile can be kept there, but nothing in it makes the picture readable. */
export const protectedSite = (site: string) => /(^|\.)(netflix\.com|primevideo\.com|amazon\.(com|co\.jp|co\.uk|de|fr))$/.test(site);
