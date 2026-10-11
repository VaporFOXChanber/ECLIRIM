import type { ZoneMap } from '../shared/types';

/** Steps per side. Every per-side zone count in use (8, 16, 24, 32) divides it, so a zone always covers whole steps. */
export const STEPS = 96;
export type ZoneTrim = { brightness: number; saturation: number; intensity: number; on: number };
export const NEUTRAL: ZoneTrim = { brightness: 100, saturation: 100, intensity: 100, on: 1 };
const KEYS = ['brightness', 'saturation', 'intensity', 'on'] as const;
export const SIDES = ['上', '下', '左', '右'] as const;

export const blankZones = (): ZoneMap => ({
  brightness: Array(STEPS * 4).fill(100), saturation: Array(STEPS * 4).fill(100),
  intensity: Array(STEPS * 4).fill(100), on: Array(STEPS * 4).fill(1)
});

/** Anything that is not a complete map becomes null, and so does a map that changes nothing. */
export function sanitizeZones(raw: unknown): ZoneMap | null {
  const input = raw as Partial<ZoneMap> | null;
  if (!input || typeof input !== 'object') return null;
  const map = blankZones(); let touched = false;
  for (const key of KEYS) {
    const values = input[key];
    if (!Array.isArray(values) || values.length !== STEPS * 4) return null;
    values.forEach((v, i) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) return;
      map[key][i] = key === 'on' ? (v ? 1 : 0) : Math.min(200, Math.max(0, Math.round(v)));
      if (map[key][i] !== NEUTRAL[key]) touched = true;
    });
  }
  return touched ? map : null;
}

// Zone order everywhere: top L→R, bottom L→R, left T→B, right T→B. A zone's place on its side is what is stored.
function span(zone: number, count: number): [number, number] {
  const n = count / 4, side = Math.floor(zone / n), j = zone % n;
  const from = Math.floor(j * STEPS / n), to = Math.max(from + 1, Math.floor((j + 1) * STEPS / n));
  return [side * STEPS + from, side * STEPS + to];
}

/** One zone's trim in a layout of `count` zones: the mean of its steps. `mixed` when they differ, as after a layout change. */
export function zoneTrim(map: ZoneMap | null, count: number, zone: number): ZoneTrim & { mixed: boolean } {
  const out = { ...NEUTRAL, mixed: false };
  if (!map) return out;
  const [from, to] = span(zone, count);
  for (const key of KEYS) {
    let sum = 0;
    for (let i = from; i < to; i++) { sum += map[key][i]; if (map[key][i] !== map[key][from]) out.mixed = true; }
    out[key] = sum / (to - from);
  }
  return out;
}

export interface ZoneTrims { gain: Float32Array; saturation: Float32Array; spread: Float32Array; active: number; plain: boolean }
/** What the renderer needs for `count` zones: per zone, a multiplier for its drive, its chroma and its halo. */
export function zoneTrims(map: ZoneMap | null, count: number): ZoneTrims {
  const gain = new Float32Array(count).fill(1), saturation = new Float32Array(count).fill(1), spread = new Float32Array(count).fill(1);
  if (!map) return { gain, saturation, spread, active: count, plain: true };
  let active = 0;
  for (let zone = 0; zone < count; zone++) {
    const trim = zoneTrim(map, count, zone);
    gain[zone] = trim.brightness / 100 * trim.on; saturation[zone] = trim.saturation / 100; spread[zone] = trim.intensity / 100;
    if (gain[zone] > 0) active++;
  }
  return { gain, saturation, spread, active, plain: false };
}

/** Sets a trim on whole zones of the current layout. Returns a new map, or null once nothing is trimmed any more. */
export function editZones(map: ZoneMap | null, count: number, zones: Iterable<number>, patch: Partial<ZoneTrim>): ZoneMap | null {
  const next = blankZones();
  if (map) for (const key of KEYS) next[key] = [...map[key]];
  for (const zone of zones) {
    const [from, to] = span(zone, count);
    for (const key of KEYS) if (patch[key] !== undefined) next[key].fill(patch[key]!, from, to);
  }
  return sanitizeZones(next);
}

/** Zones are numbered from 1 in their fixed order; the label also says where on which side that is. */
export function zoneLabel(zone: number, count: number): string {
  const n = count / 4;
  return `#${zone + 1} · ${SIDES[Math.floor(zone / n)]} ${zone % n + 1}/${n}`;
}
