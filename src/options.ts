import { t, initI18n, localizeDocument, localizeText, getLanguage, getLanguagePreference, setLanguagePreference } from './shared/i18n';
import { DIRECTOR, GLOW, HALO, LOOK_KEYS, PULSE, clamp, effectiveSettings, glowDepth, presetName, sanitize } from './shared/settings';
import type { ColorSettings, DirectorSettings, ExposureSettings, GlowSettings, GuardSettings, LookKey, Message, PresetLook, Profile, PulseSettings, RGB, Settings, Status, TrailSettings } from './shared/types';
import { siteKey } from './shared/site';
import { AUDIO_NAMES, BackupOffer, LOOK_NAMES, Store, protectedSite } from './ui/store';
import { BUILT_IN, applyPreset, builtInName, exportBackup, exportPreset, importJSON, limiterKept, matchesPreset, presetFrom } from './shared/presets';
import { WIZARD, WIZARD_START, WIZARD_STEPS, closestPreset, recommend, type WizardAnswers } from './shared/wizard';
import { glowProfile } from './engine/emission';
import { guardCap } from './engine/guard';
import { LightingRenderer } from './render/lighting';
import { NEUTRAL, editZones, zoneLabel as rawZoneLabel, zoneTrim, zoneTrims, type ZoneTrim } from './engine/zones';
import { PATTERNS, testPattern, type Pattern } from './engine/patterns';
import { ANALYSIS_BUDGET_MS, RENDER_BUDGET_MS } from './engine/adaptive';
import { setupFeedback } from './ui/feedback';
import { diagnosticsFromStatus } from './shared/diagnostics';

void (async () => {
await initI18n();
localizeDocument();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
function make<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); Object.assign(el, props); el.append(...children); return el;
}
function error(message: string): void { message = localizeText(message); $('error').textContent = message; $('error').hidden = !message; }
// A change the background refused or could not store: the page shows what is stored again, and says so.
const store = new Store(message => { error(message); render(); });
store.onChange = () => render();
let settings: Settings = store.settings;
const zoneLabel = (zone: number, count: number) => rawZoneLabel(zone, count).replace(/[上下左右]/g, side => t(side));
const refreshers: Array<() => void> = [];

/** Whether the change being made comes from a slider being dragged: those are gathered (`Store.slide`), the last always sent. */
let sliding = false;
/** A labelled range input. `read` takes its value from the settings on every render, `write` stores a change. */
function slider(parent: string, id: string, label: string, min: number, max: number, read: () => number, write: (value: number) => void): HTMLInputElement {
  const out = make('output'), input = make('input', { type: 'range', id, min: String(min), max: String(max) });
  input.addEventListener('input', () => { out.textContent = `${input.value}%`; sliding = true; try { write(input.valueAsNumber); } finally { sliding = false; } });
  input.addEventListener('change', () => store.flush());
  $(parent).append(make('div', { className: 'slider' }, make('label', { htmlFor: id }, label, out), input));
  refreshers.push(() => { input.value = String(Math.round(read())); out.textContent = `${input.value}%`; });
  return input;
}
function change(patch: Partial<Settings>): void { if (sliding) store.slide(patch); else void store.change(patch); render(); }

// ───── Lighting
for (const [key, label, min, max] of [
  ['brightness', t("Brightness · 明るさ"), 0, 100], ['glowWidth', t("Glow Width · 光の幅"), 2, 20], ['intensity', t("Glow Intensity · 光の拡散"), 0, 100],
  ['saturation', t("Saturation · 彩度"), 0, 180], ['smoothing', t("Smoothing · 滑らかさ"), 0, 100], ['responseSpeed', t("Response Speed · 追従速度"), 25, 200]
] as const) slider('look-sliders', key, label, min, max, () => settings[key], value => change({ [key]: value }));
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b => b.addEventListener('click', () => change({ mode: b.dataset.mode as Settings['mode'] })));
for (const key of ['flashLimiter', 'enabled', 'hud', 'adaptive'] as const)
  $<HTMLInputElement>(key).addEventListener('change', e => change({ [key]: (e.target as HTMLInputElement).checked }));
const checked = (id: string, write: (on: boolean) => void) => $<HTMLInputElement>(id).addEventListener('change', e => write((e.target as HTMLInputElement).checked));

// ───── Color Engine 2.0
const tone = (patch: Partial<ColorSettings>) => change({ color: { ...settings.color, ...patch } });
for (const [key, label] of [['shadows', t("Shadows · 暗い場面の色")], ['highlights', t("Highlights · 明るい側の丸め")], ['vibrance', t("Vibrance · 彩度の補正")]] as const)
  slider('color-sliders', `color-${key}`, label, 0, 100, () => settings.color[key], value => tone({ [key]: value }));
checked('color-enabled', enabled => tone({ enabled })); checked('color-wide', wideGamut => tone({ wideGamut }));
for (const key of ['source', 'protectedLight', 'manualColor', 'preset', 'zoneMode', 'zoneCount'] as const)
  $(key).addEventListener('change', e => { const value = (e.target as HTMLInputElement).value; change({ [key]: key === 'zoneCount' ? Number(value) : value }); });

// ───── UI Guard and Adaptive Brightness
const guardSet = (patch: Partial<GuardSettings>) => change({ guard: { ...settings.guard, ...patch } });
slider('guard-sliders', 'guard-strength', t("Guard Strength · 弱める強さ"), 0, 100, () => settings.guard.strength, value => guardSet({ strength: value }));
checked('guard-enabled', enabled => guardSet({ enabled })); checked('guard-pointer', pointer => guardSet({ pointer }));
const expose = (patch: Partial<ExposureSettings>) => change({ exposure: { ...settings.exposure, ...patch } });
for (const [key, label] of [['dark', t("Dark Scenes · 暗い場面で明るい光を抑える")], ['bright', t("Bright Scenes · 明るい場面で光を下げる")], ['speed', t("Adaptation Speed · 追従の速さ")]] as const)
  slider('exposure-sliders', `exposure-${key}`, label, 0, 100, () => settings.exposure[key], value => expose({ [key]: value }));
checked('exposure-enabled', enabled => expose({ enabled }));

// ───── Glow Designer
const shapeGlow = (patch: Partial<GlowSettings>) => change({ glow: { ...settings.glow, ...patch } });
for (const [key, label] of [['thickness', t("Source Thickness · 光源の太さ")], ['curve', t("Diffusion Curve · 拡散曲線")], ['falloff', t("Falloff · 減衰")], ['softness', t("Softness · 柔らかさ")]] as const)
  slider('glow-sliders', `glow-${key}`, label, 0, 100, () => settings.glow[key], value => shapeGlow({ [key]: value }));
// Choosing a style also moves the sliders to that style's own starting point.
document.querySelectorAll<HTMLButtonElement>('[data-glow]').forEach(b => b.addEventListener('click', () => { if (b.dataset.glow !== settings.glow.style) change({ glow: b.dataset.glow === 'halo' ? HALO : GLOW }); }));
$('glow-reset').addEventListener('click', () => change({ glow: settings.glow.style === 'halo' ? HALO : GLOW }));
const PREVIEW_ZONES = 64;
const glowPreview = new LightingRenderer({ ...settings, zoneCount: PREVIEW_ZONES }, $('glow-stage'));
let glowLive: LightingRenderer | null = null, glowTimer = 0;
$<HTMLInputElement>('glow-live').addEventListener('change', e => {
  if ((e.target as HTMLInputElement).checked) { glowLive = new LightingRenderer(previewSettings(settings)); glowLive.show(); animateGlow(); }
  else { glowLive?.hide(); glowLive = null; }
});
/** Settings for a preview inside this page: the look as it is, on a fixed zone count and without zone trims. */
const previewSettings = (s: Settings): Settings => ({ ...s, zoneCount: PREVIEW_ZONES, enabled: true, zones: null });
/** A calm picture with one light travelling round it: the first shows the shape of the glow, the second how colours run together along the edge. */
function previewColors(): RGB[] {
  const calm = testPattern('sample', PREVIEW_ZONES, 0), light = testPattern('moving', PREVIEW_ZONES, performance.now() / 1000);
  return calm.map((c, i) => c.map((v, k) => Math.min(255, v * .6 + light[i][k])) as RGB);
}
function animateGlow(): void { const colors = previewColors(); glowPreview.target(colors); glowLive?.target(colors); }
/** The opacity of the glow from the screen edge inward, for this screen, with the standard Edge Light shape behind it. */
function drawCurve(): void {
  const canvas = $<HTMLCanvasElement>('glow-graph'), ctx = canvas.getContext('2d')!, w = canvas.width, h = canvas.height, pad = 34;
  const depth = glowDepth(screen.width, screen.height, settings.glowWidth), strip = clamp(depth * .03, 2, 6) / depth, spread = settings.intensity / 100;
  const x = (t: number) => pad + t * (w - pad * 2), y = (v: number) => h - pad - v * (h - pad * 2);
  ctx.clearRect(0, 0, w, h); ctx.lineWidth = 1; ctx.strokeStyle = '#272a32'; ctx.fillStyle = '#7f8897'; ctx.font = '20px -apple-system, sans-serif';
  for (const v of [0, .5, 1]) { ctx.beginPath(); ctx.moveTo(x(0), y(v)); ctx.lineTo(x(1), y(v)); ctx.stroke(); }
  ctx.fillText(t("縁"), x(0), h - 8); ctx.textAlign = 'right'; ctx.fillText(t("内側 {0}px", [depth]), x(1), h - 8); ctx.textAlign = 'left';
  // Where the UI Guard holds the light over controls and text.
  if (settings.guard.enabled) {
    ctx.setLineDash([4, 8]); ctx.strokeStyle = '#6f8f9c'; ctx.beginPath(); ctx.moveTo(x(0), y(guardCap(settings.guard.strength))); ctx.lineTo(x(1), y(guardCap(settings.guard.strength))); ctx.stroke();
    ctx.fillStyle = '#6f8f9c'; ctx.textAlign = 'right'; ctx.fillText(t("UI Guard の上限（UIの上だけ）"), x(1), y(guardCap(settings.guard.strength)) - 8); ctx.textAlign = 'left';
  }
  const line = (glow: GlowSettings | null) => { ctx.beginPath(); for (let i = 0; i <= 400; i++) { const t = i / 400; ctx[i ? 'lineTo' : 'moveTo'](x(t), y(glowProfile(t, strip, spread, glow))); } };
  ctx.setLineDash([10, 8]); ctx.strokeStyle = '#5d6470'; ctx.lineWidth = 2; line(null); ctx.stroke();
  ctx.setLineDash([]); line(settings.glow); ctx.lineTo(x(1), y(0)); ctx.lineTo(x(0), y(0)); ctx.closePath();
  const fill = ctx.createLinearGradient(x(0), 0, x(1), 0); fill.addColorStop(0, '#ffc98a99'); fill.addColorStop(1, '#8d86ff22'); ctx.fillStyle = fill; ctx.fill();
  ctx.strokeStyle = '#f3d0a5'; ctx.lineWidth = 3; line(settings.glow); ctx.stroke();
}
function renderGlow(): void {
  glowPreview.update(previewSettings(settings)); glowLive?.update(previewSettings(settings));
  document.querySelectorAll<HTMLButtonElement>('[data-glow]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.glow === settings.glow.style)));
  $('glow-stage-note').textContent = settings.glow.style === 'halo' ? 'Soft Halo' : 'Edge Light';
  drawCurve();
}

// ───── A/B Comparison
$('compare-start').addEventListener('click', () => { store.startCompare(); render(); });
document.querySelectorAll<HTMLButtonElement>('[data-side]').forEach(b => b.addEventListener('click', () => { store.showSide(b.dataset.side as 'a' | 'b'); render(); }));
// What was kept is said once the background has stored it; a refusal (the comparison ended elsewhere) says nothing here.
const decide = async (side: 'a' | 'b' | null) => {
  const saved = store.endCompare(side);
  error(''); render();
  const result = await saved;
  if (!result.ok) return;
  const written = result.written || [];
  $('compare-result').textContent = !side ? t("比較をやめました。保存してある設定は、比較の前のままです。")
    : written.length ? t("{0} に決めました。保存した項目: {1}", [side.toUpperCase(), written.map(key => t(LOOK_NAMES[key])).join(t("、"))])
    : t("{0} に決めました。保存してある設定と同じだったため、何も書き換えていません。", [side.toUpperCase()]);
};
$('compare-keep-a').addEventListener('click', () => void decide('a'));
$('compare-keep-b').addEventListener('click', () => void decide('b'));
$('compare-cancel').addEventListener('click', () => void decide(null));
document.addEventListener('keydown', e => {
  const key = e.key.toLowerCase(), typing = (e.target as HTMLElement).matches?.('input:not([type=checkbox]):not([type=range]),select,textarea');
  if (!store.compare || typing || e.metaKey || e.ctrlKey || e.altKey || key !== 'a' && key !== 'b') return;
  e.preventDefault(); store.showSide(key); render();
});
function renderCompare(): void {
  const compare = store.compare, here = store.comparing;
  $('compare-bar').hidden = !compare; $('compare-start').hidden = !!compare;
  // A comparison belongs to one set of settings; while it runs, that is what this page edits.
  $<HTMLSelectElement>('target').disabled = !!compare;
  if (!compare) return;
  $('compare-result').textContent = '';
  document.querySelectorAll<HTMLButtonElement>('[data-side]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.side === compare.active)));
  $<HTMLButtonElement>('compare-keep-a').disabled = $<HTMLButtonElement>('compare-keep-b').disabled = !here;
  $('compare-note').textContent = t("{0} を表示中 · 対象: {1}", [compare.active.toUpperCase(), compare.target ? t("{0} のプロファイル", [compare.target]) : t("グローバル設定")]);
  const differing = LOOK_KEYS.filter(key => JSON.stringify(compare.a[key]) !== JSON.stringify(compare.b[key])).map(key => t(LOOK_NAMES[key]));
  $('compare-diff').textContent = t("{0}いま動かした設定は、表示中の {1} に入ります。保存してある設定は、決めるまで変わりません。点灯中のタブは、表示中の側の光になります（A / B キー、または Alt+Shift+B でも切り替えられます）。", [differing.length ? t("A と B の違い: {0}。", [differing.join(t("、"))]) : t("A と B は、まだ同じ設定です。"), compare.active.toUpperCase()]);
}

// ───── Calibration Wizard
let wizardStep = 0, wizardShown = -1, wizardTimer = 0, wizardPreviews: LightingRenderer[] = [];
const answers: WizardAnswers = { ...WIZARD_START };
/** The settings a set of answers gives, laid over the look being edited. Sound analysis stays as the user has it. */
const wizardLook = (a: WizardAnswers) => applyPreset(settings, recommend(a));
const wizardSettings = (a: WizardAnswers): Settings => previewSettings(sanitize({ ...settings, ...wizardLook(a) }));
function feedWizard(): void { const colors = testPattern('sample', PREVIEW_ZONES, 0); for (const preview of wizardPreviews) preview.target(colors); }
function renderWizard(): void {
  const done = wizardStep >= WIZARD_STEPS.length;
  $('wizard-steps').replaceChildren(...[...WIZARD_STEPS.map(key => t(WIZARD[key].title)), t("結果")].map((title, i) => {
    const item = make('li', { className: i === wizardStep ? 'current' : i < wizardStep ? 'done' : '' }, make('i', {}, String(i + 1)), title);
    if (i === wizardStep) item.setAttribute('aria-current', 'step');
    return item;
  }));
  $('wizard-step').hidden = done; $('wizard-result').hidden = !done;
  $<HTMLButtonElement>('wizard-back').disabled = wizardStep === 0; $('wizard-next').hidden = done; $('wizard-restart').hidden = !done;
  $('wizard-next').textContent = wizardStep === WIZARD_STEPS.length - 1 ? t("結果を見る") : t("次へ");
  if (!done) {
    const key = WIZARD_STEPS[wizardStep], step = WIZARD[key];
    $('wizard-title').textContent = `${wizardStep + 1}. ${t(step.title)}`; $('wizard-question').textContent = t(step.question);
    // The pictures are only rebuilt when the question changes; picking an answer just moves the mark.
    if (wizardShown !== wizardStep) {
      for (const preview of wizardPreviews) preview.hide();
      wizardPreviews = [];
      $('wizard-options').replaceChildren(...step.options.map((option, i) => {
        const mini = make('div', { className: 'mini' }), card = make('button', { type: 'button', className: 'choice' }, mini, make('b', {}, t(option.name)), make('span', {}, t(option.note)));
        card.setAttribute('role', 'radio'); card.dataset.answer = String(i);
        card.addEventListener('click', () => { answers[key] = i; renderWizard(); });
        wizardPreviews.push(new LightingRenderer(wizardSettings({ ...answers, [key]: i }), mini));
        return card;
      }));
      // A picture only has a size once it is in the page, and the glow is sized from it.
      for (const [i, preview] of wizardPreviews.entries()) { preview.show(); preview.update(wizardSettings({ ...answers, [key]: i })); }
      wizardShown = wizardStep;
    }
    document.querySelectorAll<HTMLElement>('#wizard-options .choice').forEach(card => card.setAttribute('aria-checked', String(Number(card.dataset.answer) === answers[key])));
  } else {
    if (wizardShown !== wizardStep) {
      for (const preview of wizardPreviews) preview.hide();
      $('wizard-result').hidden = false;
      wizardPreviews = [new LightingRenderer(wizardSettings(answers), $('wizard-final'))]; wizardPreviews[0].show(); wizardPreviews[0].update(wizardSettings(answers)); wizardShown = wizardStep;
    }
    const look = recommend(answers), closest = closestPreset(look), used = sanitize({ ...settings, ...wizardLook(answers) });
    rows('wizard-summary', [
      ...WIZARD_STEPS.map(key => [t(WIZARD[key].title), t(WIZARD[key].options[answers[key]].name)] as [string, string]),
      [t("照明モード"), ({ cinema: 'Cinema', vivid: 'Vivid', ambient: 'Ambient' })[used.mode]], ['Brightness', `${used.brightness}%`], ['Glow Width', `${used.glowWidth}%`],
      ['Glow Style', used.glow.style === 'halo' ? 'Soft Halo' : 'Edge Light'], ['Smoothing', `${used.smoothing}%`], ['Light Director', t("強さ {0}%", [used.director.strength])]
    ]);
    $('wizard-closest').textContent = closest.exact ? t("標準プリセット「{0}」と同じ設定です。", [closest.name]) : t("標準プリセットの中では「{0}」にいちばん近い設定です。", [closest.name]);
  }
  feedWizard();
}
const wizardSay = (text: string) => { $('wizard-message').textContent = text; };
$('wizard-next').addEventListener('click', () => { wizardStep = Math.min(WIZARD_STEPS.length, wizardStep + 1); wizardSay(''); renderWizard(); });
$('wizard-back').addEventListener('click', () => { wizardStep = Math.max(0, wizardStep - 1); wizardSay(''); renderWizard(); });
$('wizard-restart').addEventListener('click', () => { wizardStep = 0; Object.assign(answers, WIZARD_START); wizardSay(''); renderWizard(); });
$('wizard-apply').addEventListener('click', async () => {
  const side = store.comparing ? store.compare!.active.toUpperCase() : '', where = store.target ? t("{0} のプロファイル", [store.target]) : t("グローバル設定");
  const saved = store.change(wizardLook(answers)); wizardSay(''); render();
  if (!(await saved).ok) return;
  wizardSay(side ? t("おすすめの設定を、比較中の {0} に入れました。使うには、上の比較バーで決めてください。", [side])
    : t("おすすめの設定を{0}に保存しました。Lighting や Glow Designer のタブで、ここからさらに調整できます。", [where]));
});
// Compare first, decide later: A stays what is saved now, B becomes the wizard's result.
// Both are sent at once; it says the comparison started only once each was stored.
$('wizard-compare').addEventListener('click', async () => {
  const look = wizardLook(answers);
  const steps = [...(store.compare ? [store.endCompare(null)] : []), store.startCompare(look)]; wizardSay(''); render();
  if ((await Promise.all(steps)).every(result => result.ok))
    wizardSay(t("A/B 比較を始めました。A がいまの設定、B がおすすめの設定です。点灯中のタブを見ながら、上の比較バー（または A / B キー）で切り替えてください。"));
});
$('wizard-save').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $<HTMLInputElement>('wizard-name');
  const name = presetName(input.value);
  if (builtInName(name)) { wizardSay(t("標準のプリセットと同じ名前は使えません。")); return; }
  if (!name) { wizardSay(t("名前を入力してください。")); return; }
  const saved = store.setPreset(name, recommend(answers)); input.value = ''; wizardSay(''); render();
  if ((await saved).ok) wizardSay(t("「{0}」として Preset Library に保存しました。Presets のタブからいつでも適用できます。", [name]));
});

// ───── Light Director
const direct = (patch: Partial<DirectorSettings>) => change({ director: { ...settings.director, ...patch } });
for (const [key, label] of [
  ['strength', t("Effect Strength · 効果の強さ")], ['source', t("Light Source Sensitivity · 光源への感度")], ['motion', t("Motion Sensitivity · 動きへの感度")],
  ['response', t("Response Speed · 反応の速さ")], ['smoothing', t("Cinematic Smoothing · 余韻の長さ")]
] as const) slider('director-sliders', `director-${key}`, label, 0, 100, () => settings.director[key], value => direct({ [key]: value }));
$<HTMLInputElement>('director-enabled').addEventListener('change', e => direct({ enabled: (e.target as HTMLInputElement).checked }));
$('director-reset').addEventListener('click', () => change({ director: DIRECTOR }));
const trail = (patch: Partial<TrailSettings>) => change({ trails: { ...settings.trails, ...patch } });
for (const [key, label] of [['length', t("Trail Length · 残光の長さ")], ['strength', t("Trail Strength · 残光の強さ")]] as const)
  slider('trails-sliders', `trails-${key}`, label, 0, 100, () => settings.trails[key], value => trail({ [key]: value }));
checked('trails-enabled', enabled => trail({ enabled }));

// ───── Pulse Engine
const beat = (patch: Partial<PulseSettings>) => change({ pulse: { ...settings.pulse, ...patch } });
for (const [key, label] of [['depth', t("Pulse Depth · 反応の深さ")], ['bass', t("Bass · 低音")], ['mid', t("Mid · 中音")], ['treble', t("Treble · 高音")], ['sensitivity', t("Beat Sensitivity · ビートの感度")], ['wave', t("Beat Wave · ビートが走る時間")], ['bloom', t("Beat Bloom · ビートで光が広がる量")]] as const)
  slider('pulse-sliders', `pulse-${key}`, label, 0, 100, () => settings.pulse[key], value => beat({ [key]: value }));
checked('pulse-enabled', enabled => beat({ enabled }));
// Back to the default response. Whether it listens at all is the user's switch and is left as it is.
$('pulse-reset').addEventListener('click', () => change({ pulse: { ...PULSE, enabled: settings.pulse.enabled } }));
checked('music-mode', on => change({ source: on ? 'music' : 'video' }));

// ───── Zone Studio
let studioCount = 64, pattern: Pattern = 'sample', anchor = -1, live: LightingRenderer | null = null, studioTimer = 0;
const selected = new Set<number>();
const preview = new LightingRenderer({ ...settings, zoneCount: studioCount }, $('stage'));
const trimKeys = [['brightness', t("Brightness · 明るさ")], ['saturation', t("Saturation · 彩度")], ['intensity', t("Glow Intensity · 光の広がり")]] as const;
/** What the selected zones have in common. A value that differs between them is reported as mixed and shown from the first zone. */
function selection(): ZoneTrim & { mixed: boolean } {
  const trims = [...selected].map(zone => zoneTrim(settings.zones, studioCount, zone));
  if (!trims.length) return { ...NEUTRAL, mixed: false };
  const mixed = trims.some(t => t.mixed || (['brightness', 'saturation', 'intensity', 'on'] as const).some(key => t[key] !== trims[0][key]));
  return { ...trims[0], mixed };
}
const trimZones = (patch: Partial<ZoneTrim>) => { if (selected.size) change({ zones: editZones(settings.zones, studioCount, selected, patch) }); };
const trimInputs = trimKeys.map(([key, label]) => slider('zone-sliders', `zone-${key}`, label, 0, 200, () => selection()[key], value => trimZones({ [key]: value })));
$<HTMLInputElement>('zone-on').addEventListener('change', e => trimZones({ on: (e.target as HTMLInputElement).checked ? 1 : 0 }));
$('zone-reset').addEventListener('click', () => trimZones(NEUTRAL));
$('zones-reset').addEventListener('click', () => change({ zones: null }));
function buildZones(): void {
  const n = studioCount / 4;
  document.querySelectorAll<HTMLElement>('.zones').forEach(strip => {
    const side = Number(strip.dataset.side);
    strip.replaceChildren(...Array.from({ length: n }, (_, j) => {
      const zone = side * n + j, button = make('button', { className: 'zone', type: 'button', title: zoneLabel(zone, studioCount) });
      button.dataset.zone = String(zone); button.setAttribute('aria-label', zoneLabel(zone, studioCount));
      return button;
    }));
  });
  for (const zone of [...selected]) if (zone >= studioCount) selected.delete(zone);
  anchor = -1;
}
document.querySelector('.stage-grid')!.addEventListener('click', e => {
  const button = (e.target as HTMLElement).closest<HTMLElement>('.zone'), event = e as MouseEvent;
  if (!button) return;
  const zone = Number(button.dataset.zone);
  if (event.shiftKey && anchor >= 0) { for (let z = Math.min(anchor, zone); z <= Math.max(anchor, zone); z++) selected.add(z); }
  else if (event.metaKey || event.ctrlKey) { if (selected.has(zone)) selected.delete(zone); else selected.add(zone); anchor = zone; }
  else { const only = selected.size === 1 && selected.has(zone); selected.clear(); if (!only) selected.add(zone); anchor = zone; }
  render();
});
document.querySelectorAll<HTMLButtonElement>('[data-select]').forEach(b => b.addEventListener('click', () => {
  const which = b.dataset.select!, n = studioCount / 4;
  selected.clear(); anchor = -1;
  if (which === 'all') for (let z = 0; z < studioCount; z++) selected.add(z);
  else if (which !== 'none') for (let j = 0; j < n; j++) selected.add(Number(which) * n + j);
  render();
}));
$('patterns').append(...(Object.keys(PATTERNS) as Pattern[]).map(name => {
  const button = make('button', { type: 'button', textContent: PATTERNS[name] }); button.dataset.pattern = name;
  button.addEventListener('click', () => { pattern = name; render(); });
  return button;
}));
$('studio-count').addEventListener('change', e => { studioCount = Number((e.target as HTMLSelectElement).value); buildZones(); render(); });
$<HTMLInputElement>('studio-live').addEventListener('change', e => {
  if ((e.target as HTMLInputElement).checked) { live = new LightingRenderer({ ...settings, zoneCount: studioCount }); live.show(); }
  else { live?.hide(); live = null; }
});
/** Feeds the preview. Colours come from the zone layout and the clock alone: no picture is read, kept or needed. */
function animate(): void {
  const colors = testPattern(pattern, studioCount, performance.now() / 1000, selected);
  preview.target(colors); live?.target(colors);
}
function renderStudio(): void {
  const used = { ...settings, zoneCount: studioCount, enabled: true }, trims = zoneTrims(settings.zones, studioCount);
  preview.update(used); live?.update(used);
  document.querySelectorAll<HTMLElement>('.zone').forEach(button => {
    const zone = Number(button.dataset.zone), trim = zoneTrim(settings.zones, studioCount, zone);
    button.classList.toggle('selected', selected.has(zone)); button.classList.toggle('off', trims.gain[zone] === 0);
    button.classList.toggle('trimmed', trim.mixed || (['brightness', 'saturation', 'intensity'] as const).some(key => trim[key] !== 100));
    button.setAttribute('aria-pressed', String(selected.has(zone)));
  });
  const current = selection(), zones = [...selected].sort((a, b) => a - b);
  $('selection').textContent = !zones.length ? t("ゾーンを選ぶと、ここで調整できます。")
    : `${zones.length === 1 ? zoneLabel(zones[0], studioCount) : t("{0}ゾーンを選択中（#{1}〜#{2}）", [zones.length, zones[0] + 1, zones[zones.length - 1] + 1])}${current.mixed ? t(" · 値が混在しています（動かすとそろいます）") : ''}`;
  for (const input of trimInputs) input.disabled = !zones.length;
  const on = $<HTMLInputElement>('zone-on'); on.disabled = !zones.length; on.checked = current.on > 0; on.indeterminate = current.mixed && zones.length > 1;
  $<HTMLButtonElement>('zone-reset').disabled = !zones.length; $<HTMLButtonElement>('zones-reset').disabled = !settings.zones;
  $<HTMLSelectElement>('studio-count').value = String(studioCount);
  const real = effectiveSettings(store.global).zoneCount;
  $('studio-count-note').textContent = t("この画面で実際に使われるのは {0} ゾーンです（{1}）。別の数を選ぶと、調整がどう引き継がれるかを確かめられます。光っているゾーン: {2} / {3}", [real, store.global.zoneMode === 'auto' ? t("解像度から自動") : t("手動で指定"), trims.active, studioCount]);
  document.querySelectorAll<HTMLButtonElement>('[data-pattern]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.pattern === pattern)));
  $('stage-note').textContent = pattern === 'identify' ? (zones.length ? t("選んだゾーンだけを光らせています") : t("ゾーンを選ぶと、そのゾーンだけが光ります")) : PATTERNS[pattern];
}

// ───── Profiles
let confirming = '', granted: string[] = [];
const summary = (key: LookKey, profile: Profile): string => {
  const value = profile[key];
  if (key === 'mode') return ({ cinema: 'Cinema', vivid: 'Vivid', ambient: 'Ambient' })[value as Settings['mode']];
  if (key === 'flashLimiter') return value ? t("オン") : t("オフ");
  if (key === 'director') { const d = value as DirectorSettings; return d.enabled ? t("オン · 強さ {0}%", [Math.round(d.strength)]) : t("オフ"); }
  if (key === 'zones') return value ? t("調整あり") : t("調整なし");
  if (key === 'pulse') { const p = value as PulseSettings; return p.enabled ? t("オン · 深さ {0}%", [Math.round(p.depth)]) : t("オフ"); }
  if (key === 'color') return (value as ColorSettings).enabled ? '2.0' : t("0.8の色");
  if (key === 'trails') { const trails = value as TrailSettings; return trails.enabled ? t("オン · 強さ {0}%", [Math.round(trails.strength)]) : t("オフ"); }
  if (key === 'glow') return (value as GlowSettings).style === 'halo' ? 'Soft Halo' : 'Edge Light';
  if (key === 'guard') { const g = value as GuardSettings; return g.enabled ? t("オン · 強さ {0}%", [Math.round(g.strength)]) : t("オフ"); }
  if (key === 'exposure') return (value as ExposureSettings).enabled ? t("オン") : t("オフ");
  return `${Math.round(value as number)}%`;
};
function message(text: string): void { $('profile-message').textContent = text; }
function renderProfiles(): void {
  const sites = Object.keys(store.profiles).sort();
  const row = (site: string) => {
    const profile = store.profiles[site], keys = LOOK_KEYS.filter(key => key in profile);
    const chips = keys.map(key => {
      const drop = make('button', { type: 'button', className: 'drop', textContent: '×', title: t("この項目をグローバル設定に戻す") });
      drop.setAttribute('aria-label', t("{0} をグローバル設定に戻す", [t(LOOK_NAMES[key])]));
      drop.addEventListener('click', () => { void store.inherit(site, [key]); render(); });
      return make('span', { className: 'chip' }, `${t(LOOK_NAMES[key])}: ${summary(key, profile)}`, drop);
    });
    const edit = make('button', { type: 'button', textContent: store.target === site ? t("編集中") : t("編集") }); edit.dataset.edit = site;
    edit.addEventListener('click', () => { store.target = site; show('lighting'); render(); });
    const copy = make('button', { type: 'button', textContent: t("複製") });
    copy.addEventListener('click', () => { $<HTMLSelectElement>('profile-from').value = site; $('profile-site').focus(); message(t("「{0}」を写します。複製先のホスト名を入力して「作成」を押してください。", [site])); });
    const remove = make('button', { type: 'button', className: 'danger', textContent: confirming === site ? t("もう一度押すと削除") : t("削除（グローバルに戻す）") }); remove.dataset.remove = site;
    remove.addEventListener('click', async () => {
      if (confirming !== site) { confirming = site; window.setTimeout(() => { if (confirming === site) { confirming = ''; render(); } }, 4000); render(); return; }
      confirming = ''; const saved = store.setProfile(site, null); message(''); render();
      if ((await saved).ok) message(t("「{0}」のプロファイルを削除しました。このサイトはグローバル設定に従います。", [site]));
    });
    const notes = [
      granted.some(origin => origin.includes(`//${site}/`)) ? t("「このサイトでは常に点灯」: 許可あり（ポップアップで変更）") : t("「このサイトでは常に点灯」: なし。プロファイルだけでは自動で点灯しません。"),
      ...(protectedSite(site) ? [t("保護された動画では色を取り出せないため、このプロファイルがあっても映像には連動しません。")] : [])
    ];
    return make('div', { className: 'profile' },
      make('div', { className: 'profile-head' }, make('b', {}, site === 'file' ? t("file（ローカルファイル）") : site), make('span', { className: 'actions' }, edit, copy, remove)),
      make('div', { className: 'chips' }, ...(chips.length ? chips : [make('span', { className: 'hint' }, t("違いなし：すべてグローバル設定に従います。"))])),
      make('p', { className: 'hint' }, notes.join(' '))
    );
  };
  const global = make('button', { type: 'button', textContent: store.target ? t("編集") : t("編集中") });
  global.addEventListener('click', () => { store.target = ''; show('lighting'); render(); });
  $('profile-list').replaceChildren(
    make('div', { className: 'profile' }, make('div', { className: 'profile-head' }, make('b', {}, t("Global Default · グローバル設定")), make('span', { className: 'actions' }, global)),
      make('p', { className: 'hint' }, t("すべてのサイトの基準です。プロファイルの無いサイトは、この設定だけで光ります。"))),
    ...sites.map(row)
  );
  const from = $<HTMLSelectElement>('profile-from'), chosen = from.value;
  from.replaceChildren(make('option', { value: '', textContent: t("なし（グローバル設定に従う）") }), ...sites.map(site => make('option', { value: site, textContent: site })));
  from.value = sites.includes(chosen) ? chosen : '';
}
$('profile-form').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $<HTMLInputElement>('profile-site'), typed = input.value.trim().toLowerCase(), from = $<HTMLSelectElement>('profile-from').value;
  const site = typed === 'file' ? 'file' : siteKey(/^https?:\/\//.test(typed) ? typed : `https://${typed}`);
  if (!typed || !site) { message(t("ホスト名を入力してください（例: www.youtube.com）。")); return; }
  if (store.profiles[site]) { message(t("「{0}」のプロファイルはすでにあります。", [site])); return; }
  const saved = store.setProfile(site, from ? { ...store.profiles[from] } : {}); store.target = site; input.value = ''; message(''); render();
  if ((await saved).ok) message(t("「{0}」のプロファイルを作成しました。{1}上の「編集する設定」で選んだ状態です。", [site, from ? t("「{0}」の内容を写しています。", [from]) : t("まだ違いは無く、グローバル設定に従います。")]));
});

// ───── Presets
let removing = '';
const offered = new BackupOffer();
const say = (id: string, text: string) => { $(id).textContent = text; };
/** Messages one after another, as each language writes them. */
const sentences = (...texts: (string | false)[]) => texts.filter(Boolean).join(getLanguage() === 'ja' ? '' : ' ');
function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })), link = make('a', { href: url, download: name });
  document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fileName = (name: string) => `eclirim-${name.replace(/[^\w\u3040-\u30ff\u4e00-\u9fff-]+/g, '-').replace(/^-|-$/g, '') || 'preset'}.json`;
function renderPresets(): void {
  const row = (name: string, note: string, look: PresetLook, own: boolean) => {
    const active = matchesPreset(settings, look), apply = make('button', { type: 'button', textContent: active ? t("適用中") : t("適用"), disabled: active });
    apply.dataset.apply = name;
    // Only the look changes. Whether sound is analysed, and a Flash Limiter that is on, stay the user's own switches.
    // During a comparison the look goes to the side that is showing, like any other change: nothing saved is written until a side is kept.
    apply.addEventListener('click', async () => {
      const kept = limiterKept(settings, look), side = store.comparing ? store.compare!.active.toUpperCase() : '', where = store.target ? t("{0} のプロファイル", [store.target]) : t("グローバル設定");
      const saved = store.change(applyPreset(settings, look)); say('preset-message', ''); render();
      if (!(await saved).ok) return;
      say('preset-message', sentences(side ? t("「{0}」を比較中の {1} に入れました。使うには、上の比較バーで決めてください。", [name, side])
        : t("「{0}」を{1}に適用しました。", [name, where]),
        kept && t("Flash Limiter はオンのままにしました（このプリセットではオフ）。オフにする場合は、Flash Limiter のスイッチでご自身で切り替えてください。")));
    });
    const save = make('button', { type: 'button', textContent: t("書き出す") }); save.dataset.export = name;
    save.addEventListener('click', () => { download(fileName(name), exportPreset(name, look)); say('preset-message', t("「{0}」をJSONファイルに書き出しました。", [name])); });
    const copy = make('button', { type: 'button', textContent: t("JSONをコピー") });
    copy.addEventListener('click', () => { void navigator.clipboard.writeText(exportPreset(name, look)).then(() => say('preset-message', t("「{0}」のJSONをコピーしました。", [name])), () => say('preset-message', t("コピーできませんでした。「書き出す」をお使いください。"))); });
    const actions = [apply, save, copy];
    if (own) {
      const remove = make('button', { type: 'button', className: 'danger', textContent: removing === name ? t("もう一度押すと削除") : t("削除") }); remove.dataset.removePreset = name;
      remove.addEventListener('click', async () => {
        if (removing !== name) { removing = name; window.setTimeout(() => { if (removing === name) { removing = ''; render(); } }, 4000); render(); return; }
        removing = ''; const saved = store.setPreset(name, null); say('preset-message', ''); render();
        if ((await saved).ok) say('preset-message', t("「{0}」を削除しました。", [name]));
      });
      actions.push(remove);
    }
    return make('div', { className: 'profile' }, make('div', { className: 'profile-head' }, make('b', {}, name), make('span', { className: 'actions' }, ...actions)), make('p', { className: 'note' }, note));
  };
  const mine = Object.keys(store.presets).sort();
  $('preset-list').replaceChildren(...BUILT_IN.map(p => row(p.name, t(p.note), p.look, false)), ...mine.map(name => row(name, t("自分で保存したプリセット。"), store.presets[name], true)));
}
$('preset-form').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $<HTMLInputElement>('preset-name'), name = presetName(input.value);
  if (builtInName(name)) { say('preset-message', t("標準のプリセットと同じ名前は使えません。")); return; }
  if (!name) { say('preset-message', t("名前を入力してください。")); return; }
  const saved = store.setPreset(name, presetFrom(settings)); input.value = ''; say('preset-message', ''); render();
  if ((await saved).ok) say('preset-message', t("いまの設定を「{0}」として保存しました。", [name]));
});
/** Takes in a file made by this page. A preset is added to the list, not applied. A backup is only shown; replacing needs a second press. */
async function take(text: string): Promise<void> {
  const result = importJSON(text);
  offered.offer(null); $('import-confirm').hidden = true;
  if (result.kind === 'error') { say('import-message', localizeText(result.error)); return; }
  if (result.kind === 'preset') {
    // Never over an existing one: the user's own presets and the standard ones are both kept, also against another page importing at once.
    const saved = store.importPreset(result.name, result.look);
    say('import-message', ''); render();
    const added = await saved;
    if (added.ok) say('import-message', t("プリセット「{0}」を追加しました。使うには、上の一覧で「適用」を押してください。", [added.name]));
    return;
  }
  offered.offer(result); offer();
}
/** Shows the backup that is offered, and the press that restores it. */
function offer(): void {
  const backup = offered.backup!; $('import-confirm').hidden = false;
  say('import-message', t("バックアップです（プロファイル {0} 件、プリセット {1} 件）。読み込むと、現在のグローバル設定・プロファイル・プリセットがすべて置き換わります。よければ「現在の設定をすべて置き換える」を押してください。", [Object.keys(backup.profiles).length, Object.keys(backup.presets).length]));
}
$('import-pick').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async e => {
  const input = e.target as HTMLInputElement, file = input.files?.[0];
  if (file) void take(file.size > 400_000 ? 'x'.repeat(400_001) : await file.text());
  input.value = '';
});
$('import-paste').addEventListener('click', () => void take($<HTMLTextAreaElement>('import-text').value));
$('import-confirm').addEventListener('click', async () => {
  if (!offered.backup) return;
  // A backup may come from someone else: reading it never starts sound analysis that is not already on here, and never turns a Flash Limiter off.
  // Judged by what is stored and showing when it is written, a comparison's side included; the comparison then ends with the restore.
  const saved = offered.confirm(store);
  $('import-confirm').hidden = true; say('import-message', ''); render();
  const result = await saved;
  // Another file was read meanwhile: what is shown is about that one, and stays.
  if (!result) return;
  // Not stored: the backup is offered again, as it was before the press.
  if (!result.ok) { offer(); return; }
  $<HTMLTextAreaElement>('import-text').value = '';
  say('import-message', t("バックアップを読み込みました。{0}", [sentences(
    !!result.quieted && t("音の解析（Pulse Engine・Music Mode）は、この読み込みではオンにしていません。使う場合はご自身でオンにしてください。"),
    !!result.limiter && t("Flash Limiter は、オンだったところではオンのままにしました（バックアップではオフ）。オフにする場合は、ご自身で切り替えてください。"),
    !!result.compared && t("進めていた A/B 比較は終了しました。"))]));
});
$('backup-export').addEventListener('click', () => {
  download('eclirim-backup.json', exportBackup(store.global, store.profiles, store.presets));
  say('import-message', t("すべての設定をJSONファイルに書き出しました。"));
});

// ───── Diagnostics
type Listed = { tabId: number; title: string; url: string; status: Status };
let listed: Listed[] = [], watched = 0, diagnosticsTimer = 0;
const paths: Record<Status['source'], string> = { direct: t("Canvas 直接解析"), capture: t("タブ取得（Offscreen）"), compatibility: t("DRM互換描画（CSS合成）"), fallback: t("固定の照明（映像に連動しない）"), music: t("Music Mode（音だけで発光）"), none: t("なし") };
const directorNames = { active: t("動作中"), reduced: t("動作中（負荷に合わせて、粗く・間引いて解析）"), off: t("オフ"), unavailable: t("対象外（映像を解析していません）") };
const rows = (parent: string, values: Array<[string, string]>) => $(parent).replaceChildren(...values.flatMap(([name, value]) => [make('dt', {}, name), make('dd', {}, value)]));
async function poll(): Promise<void> {
  listed = (await chrome.runtime.sendMessage({ target: 'background', type: 'tabs' } satisfies Message).catch(() => [])) || [];
  if (!Array.isArray(listed)) listed = [];
  renderDiagnostics();
}
function renderDiagnostics(): void {
  const select = $<HTMLSelectElement>('diag-tab');
  if (!listed.some(tab => tab.tabId === watched)) watched = listed[0]?.tabId || 0;
  select.replaceChildren(...(listed.length ? listed.map(tab => make('option', { value: String(tab.tabId), textContent: `${tab.title || tab.url}`.slice(0, 70) }))
    : [make('option', { value: '0', textContent: t("点灯中のタブがありません") })]));
  select.value = String(watched);
  const status = listed.find(tab => tab.tabId === watched)?.status, p = status?.perf, f = (v: number, digits = 1) => v.toFixed(digits);
  $('diag-full').hidden = !$<HTMLInputElement>('diag-detail').checked || !p;
  if (!status || !p) {
    rows('diag-simple', []); rows('diag-full', []);
    $('diag-note').textContent = t("動画のあるタブで照明を開始すると、ここに計測値が出ます。計測は点灯中のタブの中で行い、1秒ごとに読みに行きます。");
    return;
  }
  const analysing = status.source === 'direct' || status.source === 'capture';
  rows('diag-simple', [
    [t("状態"), status.state], [t("描画方式"), paths[status.source]],
    ['Analysis FPS', analysing ? `${f(p.analysisFps)} fps` : t("—（映像を解析していません）")],
    ['Rendering FPS', p.renderFps ? `${f(p.renderFps)} fps` : t("0（光に変化が無く、描画を休んでいます）")],
    [t("ゾーン"), t("{0}（光るゾーン {1}）", [p.zones, p.activeZones])],
    ['Light Director', `${directorNames[p.director]}${p.stats ? t(" · 光源の候補 {0}", [p.stats.sources]) : ''}`],
    ['Pulse Engine', status.audio ? `${t(AUDIO_NAMES[status.audio.state])}${status.audio.state === 'active' ? t("（低 {0} · 中 {1} · 高 {2} · ビート {3} 回）", [f(status.audio.low, 2), f(status.audio.mid, 2), f(status.audio.high, 2), status.audio.beats]) : ''}` : '—'],
    [t("色"), status.color ? `Color Engine ${status.color.engine === 'v2' ? '2.0' : t("オフ（0.8の色）")} · ${status.color.space === 'display-p3' ? t("Display P3 で読み取り・描画") : 'sRGB'}` : '—'],
    ['UI Guard', !status.guard ? '—' : status.guard.state === 'off' ? t("オフ") : status.guard.state === 'unavailable' ? t("対象外（DRM互換描画の光には掛けられません）") : t("動作中 · 光の下に見つけたUI・文字 {0} か所 · いま光を弱めている場所 {1} か所", [status.guard.regions, status.guard.held])],
    ['Adaptive Brightness', !status.exposure ? '—' : status.exposure.state === 'off' ? t("オフ") : status.exposure.state === 'unavailable' ? t("対象外（映像を解析していません）")
      : t("動作中 · 場面の明るさ {0} · 明るいゾーンの明るさ ×{1}", [f(status.exposure.key, 2), f(status.exposure.level, 2)])],
    [t("A/B 比較"), status.compare ? t("{0} を表示中", [status.compare.toUpperCase()]) : t("なし")],
    [t("プロファイル"), status.profile ? t("{0} 専用", [status.profile]) : t("グローバル設定")]
  ]);
  const s = p.stats;
  rows('diag-full', [
    [t("解析時間"), analysing ? t("{0} ms（うち 映像の読み出し {1} ms、Light Director {2} ms）", [f(p.analysisMs, 2), f(p.readMs, 2), f(p.directorMs, 2)]) : '—'],
    [t("映像の読み出し方"), !analysing ? '—' : p.reader === 'gpu' ? t("GPUで縮小してから読み出し") : t("2D Canvas（動画の解像度が高いほど時間がかかります）")],
    [t("描画時間"), `${f(p.renderMs, 2)} ms`], [t("最初の描画までの遅延"), p.latencyMs ? `${f(p.latencyMs, 0)} ms` : '—'],
    [t("品質の段階"), t("{0}（0 = 最高{1}）", [p.quality, p.quality >= 3 ? t("。いまは解析の回数を半分にしています") : ''])], [t("遅れた解析"), t("{0} 回", [p.skippedAnalysis])], [t("抜けた描画フレーム"), t("{0} 枚", [p.skippedRender])],
    [t("予算を超えた処理"), t("{0} 回（解析 {1} ms、描画 {2} ms を超えたもの）", [p.overBudget, ANALYSIS_BUDGET_MS, RENDER_BUDGET_MS])],
    [t("キャプチャ状態"), status.source === 'capture' ? t("タブの映像を取得中") : t("取得していません")],
    [t("UI Guard の調査時間"), status.guard?.state === 'active' ? t("{0} ms（約0.1秒ごとに1回。この時間を上限にして少しずつ調べます）", [f(status.guard.ms, 2)]) : '—'],
    [t("動きの量"), s ? f(s.motion, 2) : '—'],
    [t("光源の候補の速度"), s ? t("横 {0} 画面幅/秒 · 縦 {1} 画面高/秒", [f(s.vx, 2), f(s.vy, 2)]) : '—'],
    [t("場面の切り替わり"), s ? (s.cut ? t("検出") : t("なし")) : '—'], [t("点滅の抑制"), s ? t("{0}%（100% = 抑制なし）", [Math.round(s.calm * 100)]) : '—'],
    [t("映像の色空間"), status.color?.primaries ? t("原色 {0} · 伝達特性 {1}{2}{3}", [status.color.primaries, status.color.transfer, status.color.hdr ? t("（HDR。読める画素はChromeがSDRへ変換した値です）") : '', status.color.wide ? t("（広色域）") : '']) : t("取得できません（映像を直接読めないとき）")],
    [t("このディスプレイ"), status.color ? `P3 ${status.color.displayP3 ? t("対応") : t("非対応")} · HDR ${status.color.displayHdr ? t("対応") : t("非対応")}` : '—']
  ]);
  // A tab that is not showing rests, so it cannot be watched from another tab of the same window.
  $('diag-note').textContent = document.hidden || !/非表示/.test(status.detail) ? localizeText(status.detail)
    : t("{0} 動かしながら見るには、この設定ページを別のウィンドウに出すか、HUDをお使いください。", [localizeText(status.detail)]);
}
$('diag-tab').addEventListener('change', e => { watched = Number((e.target as HTMLSelectElement).value); renderDiagnostics(); });
$('diag-detail').addEventListener('change', renderDiagnostics);

// ───── Shell
function show(tab: string): void {
  document.body.dataset.section = tab;
  $('privacy-note').textContent = tab === 'feedback' ? t("フィードバックは送信操作時のみ · 映像の送信なし")
    : t("ローカル処理 · 映像の送信なし · 映像フレームは保存しません");
  $<HTMLSelectElement>('section-select').value = tab;
  document.querySelectorAll<HTMLElement>('[role=tab]').forEach(b => {
    const selected = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(selected)); b.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll<HTMLElement>('[role=tabpanel]').forEach(panel => { panel.hidden = panel.id !== `tab-${tab}`; });
  history.replaceState(null, '', `#${tab}`);
  // The preview and the monitor only run while they can be seen.
  clearInterval(studioTimer); clearInterval(diagnosticsTimer); clearInterval(glowTimer); clearInterval(wizardTimer); studioTimer = diagnosticsTimer = glowTimer = wizardTimer = 0;
  if (tab === 'studio') { preview.show(); renderStudio(); animate(); studioTimer = window.setInterval(animate, 100); } else preview.hide();
  if (tab === 'glow') { glowPreview.show(); renderGlow(); animateGlow(); glowTimer = window.setInterval(animateGlow, 100); }
  else { glowPreview.hide(); glowLive?.hide(); glowLive = null; $<HTMLInputElement>('glow-live').checked = false; }
  // The wizard's pictures stand still, so they are fed once and then rest.
  if (tab === 'wizard') { wizardShown = -1; renderWizard(); }
  else { for (const shown of wizardPreviews) shown.hide(); wizardPreviews = []; wizardShown = -1; }
  if (tab === 'diagnostics') { void poll(); diagnosticsTimer = window.setInterval(() => void poll(), 1000); }
}
function render(): void {
  settings = store.settings;
  for (const refresh of refreshers) refresh();
  for (const key of ['flashLimiter', 'enabled', 'hud', 'adaptive'] as const) $<HTMLInputElement>(key).checked = settings[key];
  for (const key of ['source', 'protectedLight', 'manualColor', 'preset', 'zoneMode', 'zoneCount'] as const) $<HTMLInputElement>(key).value = String(settings[key]);
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === settings.mode)));
  $('zone-count-row').hidden = settings.zoneMode === 'auto';
  $('zone-note').textContent = t("この画面では {0} ゾーンを使います。各辺に均等に配分します。", [effectiveSettings(store.global).zoneCount]);
  $<HTMLInputElement>('director-enabled').checked = settings.director.enabled;
  document.querySelectorAll<HTMLInputElement>('#director-sliders input').forEach(input => { input.disabled = !settings.director.enabled; });
  // Each feature has its own switch; its sliders rest while it is off.
  const group = (id: string, sliders: string, on: boolean) => { $<HTMLInputElement>(id).checked = on; document.querySelectorAll<HTMLInputElement>(`#${sliders} input`).forEach(input => { input.disabled = !on; }); };
  group('color-enabled', 'color-sliders', settings.color.enabled); group('pulse-enabled', 'pulse-sliders', settings.pulse.enabled || settings.source === 'music');
  group('trails-enabled', 'trails-sliders', settings.trails.enabled && settings.director.enabled);
  group('guard-enabled', 'guard-sliders', settings.guard.enabled); group('exposure-enabled', 'exposure-sliders', settings.exposure.enabled);
  $<HTMLInputElement>('guard-pointer').checked = settings.guard.pointer; $<HTMLInputElement>('guard-pointer').disabled = !settings.guard.enabled;
  $<HTMLInputElement>('trails-enabled').disabled = !settings.director.enabled;
  $<HTMLInputElement>('pulse-enabled').checked = settings.pulse.enabled;
  $<HTMLInputElement>('color-wide').checked = settings.color.wideGamut; $<HTMLInputElement>('color-wide').disabled = !settings.color.enabled;
  $<HTMLInputElement>('music-mode').checked = settings.source === 'music';
  const target = $<HTMLSelectElement>('target');
  target.replaceChildren(make('option', { value: '', textContent: t("グローバル設定（全サイト共通）") }),
    ...Object.keys(store.profiles).sort().map(site => make('option', { value: site, textContent: t("{0} のプロファイル", [site]) })));
  target.value = store.target;
  $('target-note').textContent = store.target
    ? t("「照明の見た目」「Light Director」「Zone Studio」の変更は、{0} のプロファイルに保存されます。変えていない項目はグローバル設定に従います。{1}", [store.target, protectedSite(store.target) ? t("保護された動画が映像に連動するようにはなりません。") : ''])
    : t("すべてのサイトで使う設定です。サイト専用のプロファイルがあるサイトでは、プロファイルにある項目が優先されます。");
  renderStudio(); renderProfiles(); renderPresets(); renderGlow(); renderCompare();
  // The wizard's pictures show its answers over the look being edited, so they follow that look.
  if (!$('tab-wizard').hidden) { for (const [i, shown] of wizardPreviews.entries()) shown.update(wizardSettings(wizardStep < WIZARD_STEPS.length ? { ...answers, [WIZARD_STEPS[wizardStep]]: i } : answers)); renderWizard(); }
}
$('target').addEventListener('change', e => { store.target = (e.target as HTMLSelectElement).value; render(); });
document.querySelectorAll<HTMLElement>('[role=tab]').forEach(b => b.addEventListener('click', () => show(b.dataset.tab!)));
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role=tab]'));
tabs.forEach((button, index) => {
  button.id = `nav-${button.dataset.tab}`; button.setAttribute('aria-controls', `tab-${button.dataset.tab}`);
  $(`tab-${button.dataset.tab}`).setAttribute('aria-labelledby', button.id);
  button.addEventListener('keydown', event => {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); show(tabs[next].dataset.tab!); tabs[next].focus();
  });
});
$('section-select').addEventListener('change', event => show((event.target as HTMLSelectElement).value));
window.addEventListener('resize', () => {
  preview.update({ ...settings, zoneCount: studioCount, enabled: true }); live?.update({ ...settings, zoneCount: studioCount, enabled: true });
  glowPreview.update(previewSettings(settings)); glowLive?.update(previewSettings(settings));
});
window.addEventListener('eclirim-language', () => { void store.saved.then(() => location.reload()); });
// A slider move still being gathered goes out when the page is hidden or closed.
window.addEventListener('pagehide', () => store.flush());
document.addEventListener('visibilitychange', () => { if (document.hidden) store.flush(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.settings || changes.profiles || changes.presets || changes.compare) && store.adopt(changes)) render();
});
chrome.permissions.onAdded.addListener(() => void permissions());
chrome.permissions.onRemoved.addListener(() => void permissions());
async function permissions(): Promise<void> { granted = (await chrome.permissions.getAll()).origins || []; renderProfiles(); }
void (async () => {
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  await store.load();
  const language = $<HTMLSelectElement>('language');
  language.value = getLanguagePreference();
  language.addEventListener('change', () => {
    language.disabled = true;
    void store.saved.then(() => setLanguagePreference(language.value)).catch(() => {
      language.value = getLanguagePreference(); language.disabled = false;
      error(t('言語を保存できませんでした。もう一度お試しください。'));
    });
  });
  const wanted = new URLSearchParams(location.search).get('site');
  if (wanted && store.profiles[wanted]) store.target = wanted;
  // A comparison in progress is picked up where it was left: this page then edits the settings it belongs to.
  if (store.compare) store.target = store.compare.target && store.profiles[store.compare.target] ? store.compare.target : '';
  studioCount = effectiveSettings(store.global).zoneCount;
  buildZones(); render(); await permissions();
  await setupFeedback(async () => {
    const tabs: Listed[] = await chrome.runtime.sendMessage({ target: 'background', type: 'tabs' } satisfies Message);
    if (!Array.isArray(tabs)) throw new Error('Diagnostics unavailable');
    return tabs.flatMap((tab, index) => {
      const summary = tab?.status && diagnosticsFromStatus(tab.status);
      return summary ? [{ id: String(tab.tabId), label: (tab.title || t("照明タブ {0}", [index + 1])).slice(0, 80), summary }] : [];
    });
  });
  const tab = location.hash.slice(1);
  show(['wizard', 'lighting', 'glow', 'director', 'pulse', 'studio', 'presets', 'profiles', 'diagnostics', 'feedback'].includes(tab) ? tab : 'lighting');
})().catch(e => error(String(e)));

})();
