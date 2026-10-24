import { DEFAULTS, LOOK_KEYS, lookOf, own, presetName, resolveSettings, sanitize, sanitizeCompare, sanitizePreset, sanitizePresets, sanitizeProfile, sanitizeProfiles } from './settings';
import { applyPreset, freePresetName, guardRestore } from './presets';
import type { Compare, GroupKey, LookKey, Patch, Presets, Profile, Profiles, SaveOp, Settings } from './types';

/**
 * Everything the popup and the settings page edit, as it is stored. `rev` counts the writes the background has made (stored
 * as `revision`, in the same write as what changed), so a page can tell which of its own changes storage already holds.
 */
export interface Saved { settings: Settings; profiles: Profiles; presets: Presets; compare: Compare | null; rev: number }
export type State = Omit<Saved, 'rev'>;
export const SAVED_KEYS = ['settings', 'profiles', 'presets', 'compare'] as const;
export const GROUPS: readonly GroupKey[] = ['director', 'pulse', 'color', 'trails', 'glow', 'guard', 'exposure'];
/** What `chrome.storage.local.get([...SAVED_KEYS, 'revision'])` gave, checked like any stored settings. */
export const readSaved = (raw: Record<string, unknown>): Saved => ({ settings: sanitize(raw.settings), profiles: sanitizeProfiles(raw.profiles),
  presets: sanitizePresets(raw.presets), compare: sanitizeCompare(raw.compare), rev: typeof raw.revision === 'number' ? raw.revision : 0 });

export const COMPARE_GONE = 'この A/B 比較はすでに終わっています。画面を最新の状態にしました。';
export const COMPARE_RUNNING = 'A/B 比較の途中です。保存してある設定は、比較を終えるまで変わりません。画面を最新の状態にしました。';
export const PROFILE_GONE = 'このサイトのプロファイルは、別の画面で削除されています。';

const settingKey = (key: string): key is keyof Settings => Object.hasOwn(DEFAULTS, key);
const isGroup = (key: string): key is GroupKey => GROUPS.includes(key as GroupKey);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** `patch` laid over `into` (the global settings, a profile, a side): a group takes the parts named, and keeps the rest as `shown` has it. */
function lay<T extends object>(into: T, shown: Settings, patch: Patch): T {
  const out: Record<string, unknown> = { ...into as Record<string, unknown> };
  for (const [key, value] of Object.entries(patch)) if (settingKey(key))
    out[key] = isGroup(key) && value && typeof value === 'object' ? { ...shown[key], ...value } : value;
  return out as T;
}
/** Look keys and the rest of a patch, apart. */
function split(patch: Patch): [Patch, Patch] {
  const look: Record<string, unknown> = {}, rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch && typeof patch === 'object' ? patch : {})) if (settingKey(key)) (LOOK_KEYS.includes(key as LookKey) ? look : rest)[key] = value;
  return [look, rest];
}
/** The part of `patch` that changes what `shown` has: a group keeps only the parts that differ. This is what a page sends. */
export function differing(patch: Patch, shown: Settings): Patch {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!settingKey(key)) continue;
    if (isGroup(key) && value && typeof value === 'object') {
      const parts = Object.entries(value).filter(([part, v]) => !same(v, (shown[key] as unknown as Record<string, unknown>)[part]));
      if (parts.length) out[key] = Object.fromEntries(parts);
    } else if (!same(value, shown[key])) out[key] = value;
  }
  return out;
}
/** Two patches one after the other, as one: a group keeps the parts of both. */
export const merged = (first: Patch, then: Patch): Patch => {
  const out: Record<string, unknown> = { ...first };
  for (const [key, value] of Object.entries(then)) out[key] = isGroup(key) && value && typeof value === 'object' && out[key] ? { ...out[key] as object, ...value } : value;
  return out;
};

/**
 * One change laid over what is stored now: the background does this right before writing, and a page does it to show its
 * own changes before they are stored. Never changes `s`. Throws (and nothing is written) when the change is meant for a
 * comparison that is no longer the stored one, for a profile that is gone, or would change saved looks under a comparison.
 * Applying the same change twice gives the same as once.
 */
export function applyOp(s: State, op: SaveOp): State & { written?: LookKey[]; name?: string; quieted?: boolean; limiter?: boolean; compared?: boolean } {
  const next: State = { ...s }, text = (v: unknown) => typeof v === 'string' ? v : '';
  const profile = (site: string): Profile | null => {
    if (!site) return null;
    if (!Object.hasOwn(s.profiles, site)) throw new Error(PROFILE_GONE);
    return s.profiles[site];
  };
  const kept = (site: string) => resolveSettings(s.settings, profile(site));
  const running = (id: unknown): Compare => {
    if (!s.compare || s.compare.id !== text(id)) throw new Error(COMPARE_GONE);
    return s.compare;
  };
  /** Look keys go to the profile of `site` when it has one, everything else to the global settings. */
  const store = (site: string, look: Patch, rest: Patch) => {
    if (site && Object.keys(look).length) next.profiles = sanitizeProfiles({ ...s.profiles, [site]: lay(profile(site)!, kept(site), look) });
    else rest = { ...rest, ...look };
    if (Object.keys(rest).length) next.settings = sanitize(lay(s.settings, s.settings, rest));
  };
  switch (op?.kind) {
    case 'change': {
      const site = text(op.site), [look, rest] = split(op.patch);
      profile(site);
      if (op.compare) {
        const c = running(op.compare.id), side = op.compare.side === 'b' ? 'b' : 'a';
        if (c.target !== site) throw new Error(COMPARE_GONE);
        next.compare = { ...c, [side]: sanitizeProfile(lay(c[side], sanitize({ ...kept(site), ...c[side] }), look)) };
        store(site, {}, rest);
      } else {
        if (Object.keys(look).length && s.compare?.target === site) throw new Error(COMPARE_RUNNING);
        store(site, look, rest);
      }
      return next;
    }
    case 'profile': {
      const site = text(op.site), profiles = { ...s.profiles };
      if (!/^[a-z0-9.-]{1,253}$/.test(site)) throw new Error('site');
      if (op.profile) profiles[site] = op.profile; else delete profiles[site];
      next.profiles = sanitizeProfiles(profiles);
      return next;
    }
    case 'inherit': {
      const site = text(op.site);
      if (!Object.hasOwn(s.profiles, site)) return next;
      const rest: Record<string, unknown> = { ...s.profiles[site] };
      for (const key of Array.isArray(op.keys) ? op.keys : []) delete rest[key];
      next.profiles = sanitizeProfiles({ ...s.profiles, [site]: rest });
      return next;
    }
    case 'preset': {
      const name = presetName(op.name), presets = { ...s.presets };
      if (!name) throw new Error('name');
      if (op.preset) own(presets, name, sanitizePreset(op.preset)); else delete presets[name];
      next.presets = presets;
      return next;
    }
    case 'import': {
      // Every import is a preset of its own, numbered in what is stored now: two pages importing the same name, even the
      // same file, keep two, as one page importing it twice does. Not to be laid twice: a page shows it only once its answer
      // has named it (`Store.show`).
      const name = freePresetName(op.name, s.presets);
      if (!name) throw new Error('name');
      next.presets = own({ ...s.presets }, name, sanitizePreset(op.preset));
      return { ...next, name };
    }
    case 'restore': {
      // Guarded against what is stored and showing now, not what the page that read the backup last saw.
      const guarded = guardRestore({ settings: sanitize(op.settings), profiles: sanitizeProfiles(op.profiles) }, s);
      return { settings: guarded.settings, profiles: guarded.profiles, presets: sanitizePresets(op.presets), compare: null, quieted: guarded.quieted, limiter: guarded.limiter, compared: !!s.compare };
    }
    case 'start': {
      // A is the look as it is stored now. B is A, or A with `b` laid over it the way applying a preset is (`applyPreset`).
      const site = text(op.site), id = text(op.id).slice(0, 64), now = kept(site), a = lookOf(now);
      if (!id) throw new Error('id');
      if (s.compare) throw new Error(COMPARE_RUNNING);
      next.compare = { id, active: 'b', a, b: sanitizeProfile({ ...a, ...(op.b ? applyPreset(now, sanitizeProfile(op.b)) : {}) }), target: site };
      return next;
    }
    case 'show': next.compare = { ...running(op.id), active: op.side === 'b' ? 'b' : 'a' }; return next;
    case 'end': {
      // Keeping a side writes only what differs from what is saved, in the same write that ends the comparison.
      const c = running(op.id), written: LookKey[] = [], patch: Record<string, unknown> = {};
      if (op.adopt === 'a' || op.adopt === 'b') {
        const before = lookOf(kept(c.target)), side = c[op.adopt];
        for (const key of LOOK_KEYS) if (key in side && !same(side[key], before[key])) { patch[key] = side[key]; written.push(key); }
        store(c.target, patch, {});
      }
      next.compare = null;
      return { ...next, written };
    }
    case 'flip': if (s.compare) next.compare = { ...s.compare, active: s.compare.active === 'a' ? 'b' : 'a' }; return next;
    default: throw new Error('op');
  }
}
