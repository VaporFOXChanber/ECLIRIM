import type { PresetLook } from './types';
import { COLOR, DIRECTOR, EXPOSURE, GLOW, HALO, PULSE, TRAILS, sanitizePreset } from './settings';
import { BUILT_IN } from './presets';

/**
 * Calibration Wizard: three questions, each answered by picking one of a few pictures, and a complete look comes out.
 * Nothing here measures the screen or the room: it turns what the user likes into settings, which the user can then
 * compare with the current ones (A/B) or keep as a preset.
 */
export interface WizardAnswers { amount: number; width: number; softness: number }
export const WIZARD = {
  amount: { title: '光の量', question: 'どのくらい光らせたいですか？', options: [
    { name: 'ひかえめ', note: '映像の邪魔をしない、うっすらとした光。' },
    { name: '標準', note: '映像に寄り添う、自然な明るさ。' },
    { name: '強め', note: '光がはっきり分かる、華やかな明るさ。' },
    { name: '最大', note: '光を主役に。映像より前に出ます。' }] },
  width: { title: '光の幅', question: '光は画面の内側へどこまで届かせますか？', options: [
    { name: '細い', note: '縁に沿った細い光。画面を広く使えます。' },
    { name: '標準', note: '縁から少し広がる、標準の幅。' },
    { name: '広い', note: '画面の内側まで大きく広がる光。' }] },
  softness: { title: '柔らかさ', question: '光の輪郭はどちらが好みですか？', options: [
    { name: 'くっきり', note: 'Edge Light。縁に芯のある、LEDらしい光。動きにも速く反応します。' },
    { name: '標準', note: 'Edge Light。芯と広がりのバランスを取った光。' },
    { name: 'ふんわり', note: 'Soft Halo。芯のない、間接照明のような光。ゆっくり変わります。' }] }
} as const;
export const WIZARD_STEPS = ['amount', 'width', 'softness'] as const;
export const WIZARD_START: WizardAnswers = { amount: 1, width: 1, softness: 1 };

const pick = <T>(values: readonly T[], index: number): T => values[Math.min(values.length - 1, Math.max(0, Math.round(index) || 0))];

/** The look for a set of answers. The middle answer to every question is Cinematic Balanced, the default look. */
export function recommend(a: WizardAnswers): PresetLook {
  const amount = Math.min(3, Math.max(0, Math.round(a.amount) || 0)), soft = Math.min(2, Math.max(0, Math.round(a.softness) || 0));
  return sanitizePreset({
    // A lot of light wants the punchy curve; a little, soft light wants the calm one.
    mode: amount === 3 ? 'vivid' : soft === 2 && amount <= 1 ? 'ambient' : 'cinema',
    brightness: pick([40, 65, 85, 100], amount), saturation: pick([90, 100, 110, 130], amount),
    glowWidth: pick([6, 10, 15], a.width), intensity: pick([50, 65, 85], a.width),
    smoothing: pick([45, 65, 82], soft), responseSpeed: pick([130, 100, 75], soft), flashLimiter: true,
    glow: pick([{ ...GLOW, thickness: 60, curve: 40, falloff: 62, softness: 25 }, GLOW, HALO], soft),
    director: { ...DIRECTOR, strength: pick([20, 35, 50, 80], amount), response: pick([75, DIRECTOR.response, 40], soft), smoothing: pick([45, DIRECTOR.smoothing, 80], soft) },
    trails: pick([{ ...TRAILS, length: 40, strength: 70 }, TRAILS, { ...TRAILS, length: 75, strength: 45 }], soft),
    // How the light answers sound if the user has the Pulse Engine on. It is never switched on from here.
    pulse: { ...PULSE, depth: pick([25, 40, 55, 85], amount) },
    color: { ...COLOR, shadows: pick([60, 50, 50, 60], amount), highlights: pick([65, 50, 45, 35], amount), vibrance: pick([25, 35, 45, 65], amount) },
    // The less light is wanted, the more it is held back in dark and in bright scenes.
    exposure: { ...EXPOSURE, dark: pick([65, 50, 40, 25], amount), bright: pick([65, 50, 40, 25], amount) }
  });
}

const numbers = (value: unknown, out: number[] = []): number[] => {
  if (typeof value === 'number') out.push(value);
  else if (typeof value === 'boolean') out.push(value ? 100 : 0);
  else if (typeof value === 'string') out.push(value.length * 17 + value.charCodeAt(0));
  else if (value && typeof value === 'object') for (const key of Object.keys(value).sort()) numbers((value as Record<string, unknown>)[key], out);
  return out;
};
/** The standard preset a look is closest to, and whether it is that preset exactly. For telling the user where a result sits. */
export function closestPreset(look: PresetLook): { name: string; exact: boolean } {
  const mine = numbers(look);
  let best = { name: BUILT_IN[0].name, distance: Infinity };
  for (const preset of BUILT_IN) {
    const theirs = numbers(preset.look);
    const distance = mine.length === theirs.length ? mine.reduce((sum, v, i) => sum + Math.abs(v - theirs[i]), 0) : Infinity;
    if (distance < best.distance) best = { name: preset.name, distance };
  }
  return { name: best.name, exact: best.distance === 0 };
}
