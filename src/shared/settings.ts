import type { ColorSettings, Compare, DirectorSettings, ExposureSettings, GlowSettings, GuardSettings, LookKey, Mode, PresetLook, Presets, Profile, Profiles, PulseSettings, RGB, Settings, TrailSettings } from './types';
import { sanitizeZones } from '../engine/zones';
/** Modest by default: the Light Director supports the picture, it does not compete with it. */
export const DIRECTOR: DirectorSettings = { enabled: true, motion: 50, source: 50, strength: 35, response: 60, smoothing: 60 };
/** Off until the user switches it on: nothing reads sound before that. */
export const PULSE: PulseSettings = { enabled: false, depth: 40, bass: 100, mid: 50, treble: 35, sensitivity: 50, wave: 60, bloom: 70 };
export const COLOR: ColorSettings = { enabled: true, shadows: 50, highlights: 50, vibrance: 35, wideGamut: true };
export const TRAILS: TrailSettings = { enabled: true, length: 50, strength: 60 };
/** Edge Light, every slider in the middle: the light of 0.9.0 unchanged. */
export const GLOW: GlowSettings = { style: 'edge', thickness: 50, curve: 50, falloff: 50, softness: 50 };
/** Where the sliders go when Soft Halo is chosen: no strip, a round shoulder, a long reach, colours that run into each other. */
export const HALO: GlowSettings = { style: 'halo', thickness: 40, curve: 55, falloff: 45, softness: 70 };
export const GUARD: GuardSettings = { enabled: true, strength: 60, pointer: true };
export const EXPOSURE: ExposureSettings = { enabled: true, dark: 50, bright: 50, speed: 50 };
export const DEFAULTS: Settings = {
  enabled: true, mode: 'cinema', source: 'video', brightness: 65, glowWidth: 10,
  intensity: 65, saturation: 100, smoothing: 65, responseSpeed: 100,
  zoneCount: 64, zoneMode: 'auto', flashLimiter: true, manualColor: '#ffb477', preset: 'warm', protectedLight: 'off',
  director: DIRECTOR, pulse: PULSE, color: COLOR, trails: TRAILS, glow: GLOW, guard: GUARD, exposure: EXPOSURE,
  zones: null, hud: false, adaptive: true
};
/** gain: how hard the LEDs are driven. curve: above 1 holds dark scenes back, below 1 lifts them. */
export const MODES: Record<Mode, { gain: number; saturation: number; tau: number; curve: number }> = {
  cinema: { gain: 1.6, saturation: 0.92, tau: 0.24, curve: 1.1 },
  vivid: { gain: 2, saturation: 1.2, tau: 0.13, curve: 0.7 },
  ambient: { gain: 1.1, saturation: 0.8, tau: 0.8, curve: 0.9 }
};
export const PRESETS: Record<string, RGB> = {
  warm: [255, 178, 113], moon: [113, 159, 240], dusk: [194, 115, 175]
};
export const clamp = (v: number, min = 0, max = 1) => Math.min(max, Math.max(min, v));
/** Glow Width is where the light has mostly faded. Its faint tail runs on to this depth, so the glow never ends in a visible frame. */
export const glowDepth = (width: number, height: number, percent: number) => Math.ceil(Math.min(width, height) * percent / 100 * 1.5);
/** A group of switches and 0–100 sliders: every valid value given is taken, the rest keeps its default. */
function group<T extends object>(defaults: T, raw: unknown, switches: (keyof T)[], sliders: (keyof T)[]): T {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<keyof T, unknown>, out = { ...defaults };
  for (const key of switches) if (typeof input[key] === 'boolean') Object.assign(out, { [key]: input[key] });
  for (const key of sliders) { const value = input[key]; if (typeof value === 'number' && Number.isFinite(value)) Object.assign(out, { [key]: clamp(value, 0, 100) }); }
  return out;
}
export function sanitize(raw: unknown = {}): Settings {
  const input: Partial<Settings> = raw && typeof raw === 'object' ? raw : {};
  const s = { ...DEFAULTS };
  for (const [key, min, max] of [
    ['brightness', 0, 100], ['glowWidth', 2, 20], ['intensity', 0, 100],
    ['saturation', 0, 180], ['smoothing', 0, 100], ['responseSpeed', 25, 200]
  ] as const) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value)) s[key] = clamp(value, min, max);
  }
  if (typeof input.enabled === 'boolean') s.enabled = input.enabled;
  if (typeof input.flashLimiter === 'boolean') s.flashLimiter = input.flashLimiter;
  if (['cinema', 'vivid', 'ambient'].includes(input.mode!)) s.mode = input.mode!;
  if (['video', 'compatibility', 'manual', 'preset', 'drift', 'music'].includes(input.source!)) s.source = input.source!;
  if (input.zoneMode === 'manual') s.zoneMode = 'manual';
  if ([32, 64, 96, 128].includes(input.zoneCount!)) s.zoneCount = input.zoneCount!;
  if (/^#[\da-f]{6}$/i.test(input.manualColor || '')) s.manualColor = input.manualColor!;
  if (Object.hasOwn(PRESETS, input.preset || '')) s.preset = input.preset!;
  if (['preset', 'drift', 'manual', 'off'].includes(input.protectedLight!)) s.protectedLight = input.protectedLight!;
  const director: Partial<DirectorSettings> = input.director && typeof input.director === 'object' ? input.director : {};
  s.director = { ...DIRECTOR };
  if (typeof director.enabled === 'boolean') s.director.enabled = director.enabled;
  for (const key of ['motion', 'source', 'strength', 'response', 'smoothing'] as const) {
    const value = director[key];
    if (typeof value === 'number' && Number.isFinite(value)) s.director[key] = clamp(value, 0, 100);
  }
  s.pulse = group(PULSE, input.pulse, ['enabled'], ['depth', 'bass', 'mid', 'treble', 'sensitivity', 'wave', 'bloom']);
  s.color = group(COLOR, input.color, ['enabled', 'wideGamut'], ['shadows', 'highlights', 'vibrance']);
  s.trails = group(TRAILS, input.trails, ['enabled'], ['length', 'strength']);
  s.glow = group(GLOW, input.glow, [], ['thickness', 'curve', 'falloff', 'softness']);
  if ((input.glow as Partial<GlowSettings> | undefined)?.style === 'halo') s.glow.style = 'halo';
  s.guard = group(GUARD, input.guard, ['enabled', 'pointer'], ['strength']);
  s.exposure = group(EXPOSURE, input.exposure, ['enabled'], ['dark', 'bright', 'speed']);
  s.zones = sanitizeZones(input.zones);
  if (typeof input.hud === 'boolean') s.hud = input.hud;
  if (typeof input.adaptive === 'boolean') s.adaptive = input.adaptive;
  return s;
}

/** What a site profile may hold. Everything else (on/off, the light source, zone count, diagnostics) is global only. */
export const LOOK_KEYS: readonly LookKey[] = ['mode', 'brightness', 'glowWidth', 'intensity', 'saturation', 'smoothing',
  'responseSpeed', 'flashLimiter', 'director', 'zones', 'pulse', 'color', 'trails', 'glow', 'guard', 'exposure'];
/** A profile keeps only valid look settings, and only the ones it was given: the rest stays inherited. */
export function sanitizeProfile(raw: unknown): Profile {
  const input: Record<string, unknown> = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const clean = sanitize(input), profile: Profile = {};
  for (const key of LOOK_KEYS) if (key in input) Object.assign(profile, { [key]: clean[key] });
  return profile;
}
export function sanitizeProfiles(raw: unknown): Profiles {
  const profiles: Profiles = {};
  if (raw && typeof raw === 'object') for (const [site, profile] of Object.entries(raw))
    if (/^[a-z0-9.-]{1,253}$/.test(site)) profiles[site] = sanitizeProfile(profile);
  return profiles;
}
/** A preset keeps valid look settings only: no zone trims, no UI Guard, and its Pulse settings never say "on". */
export function sanitizePreset(raw: unknown): PresetLook {
  const { zones: _zones, guard: _guard, ...look } = sanitizeProfile(raw);
  if (look.pulse) look.pulse = { ...look.pulse, enabled: false };
  return look;
}
export function sanitizePresets(raw: unknown): Presets {
  const presets: Presets = {};
  if (raw && typeof raw === 'object') for (const [name, look] of Object.entries(raw)) {
    const clean = presetName(name);
    if (clean) own(presets, clean, sanitizePreset(look));
  }
  return presets;
}
/** Puts `value` in `dict` as its own entry. Plain assignment would make `__proto__` the prototype instead of a name. */
export function own<T>(dict: Record<string, T>, key: string, value: T): Record<string, T> {
  return Object.defineProperty(dict, key, { value, enumerable: true, writable: true, configurable: true });
}
/** A preset name as it is stored and shown: plain text, at most 40 characters. '' = not usable. */
export const presetName = (name: unknown): string => typeof name === 'string' ? cut(name.replace(/[\u0000-\u001f<>]/g, '').trim(), 40) : '';
/** At most `max` UTF-16 units of `text`, never half of a character written with two (an emoji): Chrome would store that half as �. */
export const cut = (text: string, max: number): string => /[\uD800-\uDBFF]/.test(text[max - 1] || '') ? text.slice(0, max - 1) : text.slice(0, max);
/** The settings a page uses: the global ones, with its site profile laid over them. */
export const resolveSettings = (global: Settings, profile?: Profile | null): Settings => profile ? sanitize({ ...global, ...profile }) : global;
/** The whole look of these settings: every key a profile can hold. */
export const lookOf = (settings: Settings): Profile => sanitizeProfile(settings);
/** An A/B comparison as it is stored. Anything that is not a complete one is no comparison at all. */
export function sanitizeCompare(raw: unknown): Compare | null {
  const input = raw as Partial<Compare> | null;
  if (!input || typeof input !== 'object' || !input.a || !input.b || typeof input.a !== 'object' || typeof input.b !== 'object') return null;
  const target = typeof input.target === 'string' && /^[a-z0-9.-]{1,253}$/.test(input.target) ? input.target : '';
  return { active: input.active === 'b' ? 'b' : 'a', a: sanitizeProfile(input.a), b: sanitizeProfile(input.b), target };
}
/** The settings a tab shows while a comparison of the settings that govern it (`target`) is running. */
export const compareSettings = (settings: Settings, compare: Compare | null, target: string): Settings =>
  compare && compare.target === target ? sanitize({ ...settings, ...compare[compare.active] }) : settings;

/**
 * Version of the stored data. 1 = settings only (up to 0.7.x). 2 = adds site profiles, Light Director, zone trims (0.8.x).
 * 3 = adds Pulse Engine, Color Engine 2.0, Light Trails and the user's presets (0.9.0).
 * 4 = adds Glow Designer, UI Guard and Adaptive Brightness (0.9.1, the first version named ECLIRIM). The storage keys are
 * the ones CineGlow used, so everything saved before is found again.
 */
export const SCHEMA = 4;
export interface Stored { settings?: unknown; profiles?: unknown; presets?: unknown; schema?: unknown }
/**
 * Brings stored data to this version. Earlier settings keep every value they had; what is new takes its default.
 * 0.7.0 saved "Cinema preset" as its default light for protected video. That default is now no light, so it follows.
 */
export function migrate(stored: Stored, previousVersion?: string): { settings: Settings; profiles: Profiles; presets: Presets; schema: number } {
  const settings = sanitize(stored.settings);
  if (previousVersion === '0.7.0' && settings.protectedLight === 'preset') settings.protectedLight = 'off';
  return { settings, profiles: sanitizeProfiles(stored.profiles), presets: sanitizePresets(stored.presets), schema: SCHEMA };
}
/** screen CSS pixels × DPR is a browser estimate, not an EDID/native-panel query. */
export function autoZoneCount(width: number, height: number, dpr: number): number {
  if (![width, height, dpr].every(v => Number.isFinite(v) && v > 0)) return 64;
  return clamp(Math.round((width + height) * dpr / 3000 * 2) * 32, 32, 128);
}
export function effectiveSettings(s: Settings, pageZoom = 1): Settings {
  return s.zoneMode === 'auto' ? { ...s, zoneCount: autoZoneCount(screen.width, screen.height, devicePixelRatio / pageZoom) } : s;
}
export async function loadSettings(): Promise<Settings> {
  return sanitize((await chrome.storage.local.get('settings')).settings);
}
export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ settings: sanitize(s) });
}
export async function loadPresets(): Promise<Presets> {
  return sanitizePresets((await chrome.storage.local.get('presets')).presets);
}
export async function savePresets(presets: Presets): Promise<void> {
  await chrome.storage.local.set({ presets: sanitizePresets(presets) });
}
export async function loadCompare(): Promise<Compare | null> {
  return sanitizeCompare((await chrome.storage.local.get('compare')).compare);
}
export async function loadProfiles(): Promise<Profiles> {
  return sanitizeProfiles((await chrome.storage.local.get('profiles')).profiles);
}
export async function saveProfiles(profiles: Profiles): Promise<void> {
  await chrome.storage.local.set({ profiles: sanitizeProfiles(profiles) });
}
export function fallbackColors(s: Settings, time: number): RGB[] {
  let rgb: RGB = PRESETS[s.preset];
  if (s.source === 'manual') rgb = [1, 3, 5].map(i => parseInt(s.manualColor.slice(i, i + 2), 16)) as RGB;
  if (s.source === 'drift') {
    const t = (Math.sin(time / 18000) + 1) / 2;
    rgb = PRESETS.warm.map((v, i) => v * (1 - t) + PRESETS.moon[i] * t) as RGB;
  }
  return Array.from({ length: s.zoneCount }, () => [...rgb]);
}
