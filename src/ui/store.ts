import { DEFAULTS, LOOK_KEYS, compareSettings, presetName, resolveSettings, sanitize, sanitizeCompare, sanitizePresets, sanitizeProfiles } from '../shared/settings';
import { SAVED_KEYS, applyOp, differing, merged, readSaved, type Saved, type State } from '../shared/save';
import type { AudioStatus, Compare, LookKey, Message, Patch, PresetLook, Presets, Profile, Profiles, SaveOp, SaveResult, Settings } from '../shared/types';

/** How long slider moves are gathered into one change. The lit tabs still follow a slider while it is dragged. */
export const SLIDE_MS = 50;
/** One of this page's own changes: being gathered (a slider), sent, or written (`rev`) but not yet heard of from storage. */
interface Mine { op: SaveOp; done?: Promise<SaveResult>; rev?: number }
type ChangeOp = Extract<SaveOp, { kind: 'change' }>;
const refused = (error = ''): Promise<SaveResult> => Promise.resolve({ ok: false, error });

/**
 * What the popup and the settings page edit: the global settings, or one site's profile lying over them.
 * Every change goes to the background the moment it is made, as a change and not as a copy of everything: the background
 * lays it over what is stored then, one at a time (`applyOp`), so a page that closes, a page that is behind, or two pages
 * at once lose nothing of each other's. What this page shows is what storage holds, with its own changes that storage does
 * not hold yet laid over it again.
 */
export class Store {
  global: Settings = DEFAULTS; profiles: Profiles = {};
  /** The user's own presets, by name. */
  presets: Presets = {};
  /** The site whose profile is being edited, or '' for the global settings. */
  target = '';
  /** A/B Comparison in progress, if any. It belongs to one set of settings (its `target`). */
  compare: Compare | null = null;
  /** What storage holds, as last heard from it. */
  private base: Saved = { settings: DEFAULTS, profiles: {}, presets: {}, compare: null, rev: 0 };
  private mine: Mine[] = []; private draft: Mine | null = null; private timer: ReturnType<typeof setTimeout> | undefined; private loaded = false;
  /** Called when what this page shows changes without a storage change to say so: an answer that came after the storage change it was part of. */
  onChange: () => void = () => {};
  /**
   * `failed` hears of a change the background refused or could not write, once this page shows storage without it again.
   * `send` carries a message to the background.
   */
  constructor(private readonly failed: (message: string) => void, private readonly send: (message: Message) => Promise<unknown> = m => chrome.runtime.sendMessage(m)) {}
  async load(): Promise<void> {
    await this.read();
    // Nothing is sent before what is stored has been read: a control touched in that first moment must not change anything.
    this.loaded = true;
  }
  private async read(): Promise<void> {
    const stored = readSaved(await chrome.storage.local.get([...SAVED_KEYS, 'revision']));
    // A change heard of while reading is newer than what was read.
    if (stored.rev >= this.base.rev) this.base = stored;
    this.prune(); this.show();
  }
  /**
   * Takes over what changed in storage, by this page or elsewhere (the popup and the settings page can be open together).
   * Own changes not stored yet stay laid over it. Returns whether what this page shows changed.
   */
  adopt(changes: Record<string, chrome.storage.StorageChange>): boolean {
    const b = this.base, value = (key: string) => changes[key]?.newValue, rev = value('revision');
    this.base = { settings: changes.settings ? sanitize(value('settings')) : b.settings, profiles: changes.profiles ? sanitizeProfiles(value('profiles')) : b.profiles,
      presets: changes.presets ? sanitizePresets(value('presets')) : b.presets, compare: changes.compare ? sanitizeCompare(value('compare')) : b.compare,
      rev: typeof rev === 'number' ? rev : b.rev };
    this.prune();
    return this.show();
  }
  /** Forgets own changes that storage now holds. */
  private prune(): void { this.mine = this.mine.filter(m => m.rev === undefined || m.rev > this.base.rev); }
  private show(): boolean {
    let state: State = this.base;
    // An import is named by the background alone: it is shown once the answer says under which name (see `post`).
    for (const { op } of this.mine) if (op.kind !== 'import') try { state = applyOp(state, op); } catch { /* The background refuses it as well. */ }
    const before = JSON.stringify([this.global, this.profiles, this.presets, this.compare]);
    ({ settings: this.global, profiles: this.profiles, presets: this.presets, compare: this.compare } = state);
    if (this.target && !this.profiles[this.target]) this.target = '';
    return JSON.stringify([this.global, this.profiles, this.presets, this.compare]) !== before;
  }
  get profile(): Profile | null { return this.target ? this.profiles[this.target] || null : null; }
  /** What is saved for what is being edited, whatever is being compared. */
  get kept(): Settings { return resolveSettings(this.global, this.profile); }
  /** Whether an A/B comparison of the settings being edited is running. */
  get comparing(): boolean { return !!this.compare && this.compare.target === this.target; }
  /** The settings in effect for what is being edited: during a comparison, the side that is switched to. */
  get settings(): Settings { return compareSettings(this.kept, this.compare, this.target); }
  /** Sends a change at once, after a slider move still being gathered. Resolves with what the background answered. */
  private push(op: SaveOp): Promise<SaveResult> {
    if (!this.loaded) return refused();
    this.flush();
    const mine: Mine = { op }; this.mine.push(mine);
    return this.post(mine);
  }
  private post(mine: Mine): Promise<SaveResult> {
    mine.done = this.send({ target: 'background', type: 'save', op: mine.op } satisfies Message).then(
      reply => (reply as SaveResult | undefined)?.ok ? reply as SaveResult : { ok: false as const, error: (reply as { error?: string } | undefined)?.error || 'ECLIRIM の応答がありませんでした。' },
      e => ({ ok: false as const, error: String(e?.message || e) })
    ).then(async (result): Promise<SaveResult> => {
      // Storage may have told of this change, and of others after it, before this answer came: while it was not known to be
      // stored it was laid over them again. Now it is known, what storage holds is shown as it is.
      if (result.ok) {
        // A named import is from now on that one preset, kept under that name: laid again, it stays one.
        if (mine.op.kind === 'import' && result.name) mine.op = { kind: 'preset', name: result.name, preset: mine.op.preset };
        mine.rev = result.rev; this.prune(); if (this.show()) this.onChange(); return result;
      }
      // Refused or not written: this page shows storage as it is, without it, before it says so.
      this.mine = this.mine.filter(m => m !== mine);
      await this.read().catch(() => this.show());
      this.failed(`設定を保存できませんでした: ${result.error}`);
      return result;
    });
    this.show();
    return mine.done;
  }
  /** A change of what is being edited, as it is sent: only what differs from what is shown, for the side shown during a comparison. */
  private changeOp(patch: Patch): ChangeOp | null {
    if (!this.loaded) return null;
    const diff = differing(patch, this.settings), compare = this.compare;
    const look = Object.keys(diff).some(key => LOOK_KEYS.includes(key as LookKey));
    return { kind: 'change', site: this.target, patch: diff, ...(this.comparing && look ? { compare: { id: compare!.id, side: compare!.active } } : {}) };
  }
  /**
   * Look settings go to the profile being edited; everything else is global.
   * During an A/B comparison, look settings go to the side that is showing instead: the saved settings stay as they are.
   */
  change(patch: Patch): Promise<SaveResult> { const op = this.changeOp(patch); return op ? this.push(op) : refused(); }
  /**
   * A slider being moved: shown at once, and sent at most every SLIDE_MS with its latest value. `flush` sends what is left
   * at once: when the slider is let go, when the page is hidden or closes, and before any other change.
   */
  slide(patch: Patch): void {
    const op = this.changeOp(patch), last = this.draft?.op as ChangeOp | undefined;
    if (!op) return;
    if (last && last.site === op.site && JSON.stringify(last.compare) === JSON.stringify(op.compare)) this.draft!.op = { ...last, patch: merged(last.patch, op.patch) };
    else { this.flush(); this.draft = { op }; this.mine.push(this.draft); }
    this.show();
    this.timer ??= setTimeout(() => { this.timer = undefined; this.flush(); }, SLIDE_MS);
  }
  flush(): void {
    clearTimeout(this.timer); this.timer = undefined;
    const draft = this.draft; this.draft = null;
    if (draft) void this.post(draft);
  }
  /** Creates or replaces a site's profile; null removes it, which returns that site to the global settings. */
  setProfile(site: string, profile: Profile | null): Promise<SaveResult> { return this.push({ kind: 'profile', site, profile }); }
  /** Returns these settings of a site's profile to the global ones; the rest of the profile stays as it is stored. */
  inherit(site: string, keys: LookKey[]): Promise<SaveResult> { return this.push({ kind: 'inherit', site, keys }); }
  /**
   * Starts an A/B comparison of the settings being edited. A is their look as it is saved. B starts as the same look,
   * or as A with `b` laid over it (a preset, a wizard result) the way `applyPreset` lays it: listening and a Flash Limiter
   * that is on stay as they are. B is the side shown first: it is the one to be changed.
   */
  startCompare(b?: Profile | null): Promise<SaveResult> { return this.push({ kind: 'start', id: crypto.randomUUID(), site: this.target, b: b ?? null }); }
  /** Switches the lit tabs, and this page, to the other look. */
  showSide(side: 'a' | 'b'): Promise<SaveResult> {
    return this.compare && this.compare.active !== side ? this.push({ kind: 'show', id: this.compare.id, side }) : Promise.resolve({ ok: true, rev: this.base.rev });
  }
  /**
   * Ends the comparison. With a side, that look becomes the saved one (only what differs from before is written, in the
   * same write that ends the comparison: `written`); with null everything stays as it was saved. A comparison that has
   * ended elsewhere in the meantime is not brought back and nothing is kept from it: the answer is then an error.
   */
  endCompare(adopt: 'a' | 'b' | null): Promise<SaveResult> {
    if (!this.compare) return Promise.resolve({ ok: true, rev: this.base.rev, written: [] });
    return this.push({ kind: 'end', id: this.compare.id, adopt: this.comparing ? adopt : null });
  }
  /** Keeps a preset under this name, or with null removes it. A name that is not usable (`presetName`) is refused with no error. */
  setPreset(name: string, preset: PresetLook | null): Promise<SaveResult> { return presetName(name) ? this.push({ kind: 'preset', name, preset }) : refused(); }
  /**
   * Adds an imported preset, never over another one: under its own name, or the next free number (`freePresetName`), as
   * the background finds them free when it writes. `name` in the answer is the name it was stored under; the list shows
   * it from then on, not before.
   */
  importPreset(name: string, preset: PresetLook): Promise<SaveResult> { return presetName(name) ? this.push({ kind: 'import', name, preset }) : refused(); }
  /**
   * Replaces everything at once with a backup as it was read. It is guarded (`guardRestore`) against what is stored and
   * showing when it is written. A comparison in progress ends without a side being kept: its A is no longer what is saved,
   * and keeping its B would write over what was just restored.
   */
  restore(settings: Settings, profiles: Profiles, presets: Presets): Promise<SaveResult> { return this.push({ kind: 'restore', settings, profiles, presets }); }
  /** Resolves once everything changed so far has been answered. */
  get saved(): Promise<void> { this.flush(); return Promise.all(this.mine.map(m => m.done)).then(() => undefined); }
}
type Backup = { settings: Settings; profiles: Profiles; presets: Presets };
/**
 * A backup read on the settings page, waiting for the second press that restores it. Each file read replaces what is
 * offered (`offer`, null for none). A restore that fails offers its backup again, unless another file has been read in the
 * meantime: that one is what is offered then, and `confirm` answers null (the answer no longer speaks for what is shown).
 */
export class BackupOffer {
  backup: Backup | null = null; private reads = 0;
  offer(backup: Backup | null): void { this.backup = backup; this.reads++; }
  async confirm(store: Store): Promise<SaveResult | null> {
    const backup = this.backup, reads = this.reads;
    if (!backup) return null;
    this.backup = null;
    const result = await store.restore(backup.settings, backup.profiles, backup.presets);
    if (reads !== this.reads) return null;
    if (!result.ok) this.backup = backup;
    return result;
  }
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
