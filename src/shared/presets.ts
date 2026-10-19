import type { Compare, PresetLook, Presets, Profile, Profiles, Settings } from './types';
import { COLOR, DIRECTOR, EXPOSURE, GLOW, HALO, PULSE, SCHEMA, TRAILS, compareSettings, cut, presetName, resolveSettings, sanitize, sanitizePreset, sanitizePresets, sanitizeProfiles } from './settings';

/**
 * Preset Library. A preset is a complete look: everything a site profile can hold except zone trims, which belong to one
 * screen, and the UI Guard, which is a protection and stays as the user has it. Applying one never switches sound analysis
 * on or off, nor a Flash Limiter that is on off: its Pulse settings only say how the light should answer sound once the user
 * has switched the Pulse Engine on.
 */
export interface BuiltIn { name: string; note: string; look: PresetLook }
const look = (values: PresetLook): PresetLook => sanitizePreset(values);
export const BUILT_IN: readonly BuiltIn[] = [
  { name: 'Cinematic Balanced', note: '初期設定。映画に合わせた、自然でなめらかな光。',
    look: look({ mode: 'cinema', brightness: 65, glowWidth: 10, intensity: 65, saturation: 100, smoothing: 65, responseSpeed: 100, flashLimiter: true,
      director: DIRECTOR, pulse: PULSE, color: COLOR, trails: TRAILS, glow: GLOW, exposure: EXPOSURE }) },
  { name: 'Vivid Action', note: 'アクションやゲーム映像向け。鮮やかで、動きと音への反応が速い。',
    look: look({ mode: 'vivid', brightness: 80, glowWidth: 11, intensity: 60, saturation: 115, smoothing: 40, responseSpeed: 140, flashLimiter: true,
      director: { ...DIRECTOR, strength: 55, source: 55, motion: 70, response: 80, smoothing: 45 }, pulse: { ...PULSE, depth: 60, mid: 60, treble: 45, sensitivity: 60 },
      color: { ...COLOR, shadows: 45, highlights: 55, vibrance: 55 }, trails: { ...TRAILS, length: 45, strength: 75 },
      glow: { ...GLOW, thickness: 60, curve: 45, falloff: 55, softness: 35 }, exposure: { ...EXPOSURE, dark: 40, bright: 40, speed: 65 } }) },
  { name: 'Soft Ambient', note: '長時間の視聴向け。広く淡く、ゆっくり変わる光。',
    look: look({ mode: 'ambient', brightness: 50, glowWidth: 14, intensity: 85, saturation: 85, smoothing: 85, responseSpeed: 70, flashLimiter: true,
      director: { ...DIRECTOR, strength: 20, response: 35, smoothing: 85 }, pulse: { ...PULSE, depth: 20, mid: 35, treble: 20, sensitivity: 40 },
      color: { ...COLOR, shadows: 60, highlights: 70, vibrance: 20 }, trails: { ...TRAILS, length: 80, strength: 40 },
      glow: HALO, exposure: { ...EXPOSURE, dark: 60, bright: 60, speed: 35 } }) },
  { name: 'Midnight Subtle', note: '暗い部屋で深夜に。細く控えめで、暗い場面の色を残す。',
    look: look({ mode: 'cinema', brightness: 38, glowWidth: 7, intensity: 45, saturation: 90, smoothing: 75, responseSpeed: 85, flashLimiter: true,
      director: { ...DIRECTOR, strength: 25, response: 45, smoothing: 75 }, pulse: { ...PULSE, depth: 25, sensitivity: 40 },
      color: { ...COLOR, shadows: 75, highlights: 70, vibrance: 30 }, trails: { ...TRAILS, length: 60, strength: 45 },
      glow: { ...GLOW, thickness: 35, falloff: 60, softness: 60 }, exposure: { ...EXPOSURE, dark: 75, bright: 70 } }) },
  { name: 'Overkill', note: 'すべてを最大近くまで。光が映像より前に出ます。Flash Limiter は入れたままで、UI Guard もお使いの設定のままです。',
    look: look({ mode: 'vivid', brightness: 100, glowWidth: 18, intensity: 100, saturation: 150, smoothing: 15, responseSpeed: 200, flashLimiter: true,
      director: { ...DIRECTOR, strength: 100, source: 80, motion: 100, response: 100, smoothing: 30 }, pulse: { ...PULSE, depth: 100, mid: 80, treble: 70, sensitivity: 75 },
      color: { ...COLOR, shadows: 80, highlights: 30, vibrance: 80 }, trails: { ...TRAILS, length: 100, strength: 100 },
      glow: { ...GLOW, thickness: 85, curve: 60, falloff: 25, softness: 60 }, exposure: { ...EXPOSURE, dark: 20, bright: 20, speed: 70 } }) }
];

/** Whether a name is a standard preset's. Case does not count: the two lists are shown side by side. */
export const builtInName = (name: string): boolean => BUILT_IN.some(p => p.name.toLowerCase() === name.toLowerCase());
/**
 * The name to keep an incoming preset under, as it will be stored (`presetName`): its own if neither the user's presets
 * nor a standard one has it, otherwise with " (2)", " (3)"… The name is shortened to make room for the number, so the
 * number is never cut off and every try is a new name. '' = not a usable name.
 */
export function freePresetName(name: unknown, mine: Presets): string {
  const base = presetName(name), taken = (candidate: string) => Object.hasOwn(mine, candidate) || builtInName(candidate);
  if (!base || !taken(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`, candidate = cut(base, 40 - suffix.length).trimEnd() + suffix;
    if (!taken(candidate)) return candidate;
  }
}

/**
 * The settings change that applying a preset makes. Whether the Pulse Engine is on stays as the user has it, and a Flash
 * Limiter that is on stays on (`limiterKept`): a preset may come from someone else, only the user's own switch turns it off.
 */
export function applyPreset(current: Settings, preset: PresetLook): Partial<Settings> {
  const patch: Partial<Settings> = { ...sanitizePreset(preset) };
  if (patch.pulse) patch.pulse = { ...patch.pulse, enabled: current.pulse.enabled };
  if (limiterKept(current, preset)) patch.flashLimiter = true;
  return patch;
}
/** Whether applying this preset keeps the Flash Limiter on although the preset has it off. */
export const limiterKept = (current: Settings, preset: PresetLook): boolean => current.flashLimiter && preset.flashLimiter === false;
/** The look of the settings as they are now, ready to be kept as a preset. */
export function presetFrom(settings: Settings): PresetLook { return sanitizePreset(settings); }
/** Whether the current settings are exactly this preset (Pulse on/off aside). */
export function matchesPreset(settings: Settings, preset: PresetLook): boolean {
  const mine = presetFrom(settings) as Record<string, unknown>;
  return Object.entries(sanitizePreset(preset)).every(([key, value]) => JSON.stringify(mine[key]) === JSON.stringify(value));
}

/**
 * A backup may come from someone else, so reading one never starts sound analysis and never takes the Flash Limiter away.
 * Both are judged by what a page shows now (during a comparison, the side that is showing) and what the backup asks of it:
 * the global settings, and each site with its profile laid over them. The Pulse Engine is on only where both say so, Music
 * Mode (which also listens) is not switched to, and the Flash Limiter is on where either does; a site that comes out
 * different from the global settings keeps that in its profile. Everything else is taken as it is.
 * `quieted` / `limiter`: listening, or the Flash Limiter, was kept from what the backup says.
 */
export function guardRestore(imported: { settings: Settings; profiles: Profiles }, current: { settings: Settings; profiles: Profiles; compare?: Compare | null }):
  { settings: Settings; profiles: Profiles; quieted: boolean; limiter: boolean } {
  const wanted = imported.settings, of = (profiles: Profiles, site: string) => Object.hasOwn(profiles, site) ? profiles[site] : null;
  // A page with a profile of its own shows a comparison only of that profile; every other page, one of the global settings.
  const seen = (site: string) => { const own = of(current.profiles, site); return compareSettings(resolveSettings(current.settings, own), current.compare || null, own ? site : ''); };
  const was = seen('');
  const settings = { ...wanted, flashLimiter: wanted.flashLimiter || was.flashLimiter, pulse: { ...wanted.pulse, enabled: wanted.pulse.enabled && was.pulse.enabled },
    source: wanted.source === 'music' && was.source !== 'music' ? was.source : wanted.source };
  let quieted = settings.pulse.enabled !== wanted.pulse.enabled || settings.source !== wanted.source, limiter = settings.flashLimiter !== wanted.flashLimiter;
  const profiles: Profiles = {};
  for (const site of new Set([...Object.keys(imported.profiles), ...Object.keys(current.profiles)])) {
    const profile: Profile = { ...of(imported.profiles, site) }, before = seen(site), asked = resolveSettings(wanted, profile), after = resolveSettings(settings, profile);
    const lit = before.flashLimiter || asked.flashLimiter, listening = before.pulse.enabled && asked.pulse.enabled;
    if (after.flashLimiter !== lit) profile.flashLimiter = lit;
    if (after.pulse.enabled !== listening) profile.pulse = { ...after.pulse, enabled: listening };
    limiter ||= lit !== asked.flashLimiter; quieted ||= listening !== asked.pulse.enabled;
    if (Object.hasOwn(imported.profiles, site) || Object.keys(profile).length) profiles[site] = profile;
  }
  return { settings, profiles, quieted, limiter };
}
/**
 * What a site profile keeps when it is reset to follow the global settings (`current`: what the site shows now): nothing,
 * unless following them would take away a Flash Limiter that is on, or start listening where it is off.
 */
export function resetProfile(current: Settings, global: Settings): Profile {
  const profile: Profile = {};
  if (current.flashLimiter && !global.flashLimiter) profile.flashLimiter = true;
  if (!current.pulse.enabled && global.pulse.enabled) profile.pulse = { ...global.pulse, enabled: false };
  return profile;
}

const APP = 'ECLIRIM';
/** Files written before the rename say CineGlow. They are the same format and are read like any other. */
const FORMER = 'CineGlow';
/** One preset as a file to hand to someone else. */
export function exportPreset(name: string, preset: PresetLook): string {
  return JSON.stringify({ app: APP, kind: 'preset', schema: SCHEMA, name: presetName(name), look: sanitizePreset(preset) }, null, 2);
}
/** Everything the user has set: global settings, site profiles and presets. Site permissions are Chrome's and are not part of it. */
export function exportBackup(settings: Settings, profiles: Profiles, presets: Presets): string {
  return JSON.stringify({ app: APP, kind: 'backup', schema: SCHEMA, settings: sanitize(settings), profiles: sanitizeProfiles(profiles), presets: sanitizePresets(presets) }, null, 2);
}
export type Imported =
  | { kind: 'preset'; name: string; look: PresetLook }
  | { kind: 'backup'; settings: Settings; profiles: Profiles; presets: Presets }
  | { kind: 'error'; error: string };
/**
 * Reads a file made by `exportPreset` or `exportBackup`. Whatever it contains is run through the same checks as stored
 * settings: unknown keys are dropped, values are clamped, and nothing in it is ever executed or fetched.
 */
export function importJSON(text: string): Imported {
  if (text.length > 400_000) return { kind: 'error', error: 'ファイルが大きすぎます（400KBまで）。' };
  let data: Record<string, unknown>;
  try { data = JSON.parse(text); } catch { return { kind: 'error', error: 'JSONとして読めませんでした。' }; }
  if (!data || typeof data !== 'object' || data.app !== APP && data.app !== FORMER) return { kind: 'error', error: 'ECLIRIMの書き出しファイルではありません。' };
  if (typeof data.schema === 'number' && data.schema > SCHEMA) return { kind: 'error', error: 'このファイルは新しい版のECLIRIMで作られています。拡張を更新してから読み込んでください。' };
  if (data.kind === 'preset') {
    const name = presetName(data.name);
    if (!name || !data.look || typeof data.look !== 'object') return { kind: 'error', error: 'プリセットの名前か内容がありません。' };
    return { kind: 'preset', name, look: sanitizePreset(data.look) };
  }
  if (data.kind === 'backup') return { kind: 'backup', settings: sanitize(data.settings), profiles: sanitizeProfiles(data.profiles), presets: sanitizePresets(data.presets) };
  return { kind: 'error', error: '種類のわからないファイルです。' };
}
