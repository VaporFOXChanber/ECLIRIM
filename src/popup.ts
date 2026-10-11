import { t, initI18n, localizeDocument, localizeText, getLanguagePreference, setLanguagePreference } from './shared/i18n';
import { DEFAULTS, DIRECTOR, GLOW, HALO, autoZoneCount } from './shared/settings';
import type { Message, Settings, Status } from './shared/types';
import { siteKey, sitePattern } from './shared/site';
import { AUDIO_NAMES, Store, protectedSite } from './ui/store';
import { BUILT_IN, applyPreset, matchesPreset } from './shared/presets';
void (async () => {
await initI18n();
localizeDocument();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
let settings: Settings = DEFAULTS, tabId: number | undefined, latest: Status | null = null;
let site: string | null = null, host: string | null = null, confirmReturn = 0;
let lastSourceHint = '';
const store = new Store(message => error(message));
const sliderSpecs = [
  ['brightness', t("Brightness · 明るさ"), 0, 100, '%', 'main-sliders'],
  ['glowWidth', t("Glow Width · 光の幅"), 2, 20, '%', 'main-sliders'],
  ['intensity', t("Glow Intensity · 光の拡散"), 0, 100, '%', 'advanced-sliders'],
  ['saturation', t("Saturation · 彩度"), 0, 180, '%', 'advanced-sliders'],
  ['smoothing', t("Smoothing · 滑らかさ"), 0, 100, '%', 'advanced-sliders'],
  ['responseSpeed', t("Response Speed · 追従速度"), 25, 200, '%', 'advanced-sliders']
] as const;
for (const [key, label, min, max, unit, parent] of sliderSpecs) {
  const wrap = document.createElement('div'); wrap.className = 'slider';
  const l = document.createElement('label'); l.htmlFor = key; l.textContent = label;
  const out = document.createElement('output'); out.id = `${key}-value`; out.htmlFor = key; l.append(out);
  const input = document.createElement('input'); input.type = 'range'; input.id = key; input.min = String(min); input.max = String(max);
  input.addEventListener('input', () => { out.textContent = input.value + unit; change({ [key]: input.valueAsNumber }); });
  wrap.append(l, input); $(parent).append(wrap);
}
function error(message: string): void { message = localizeText(message); $('error').textContent = message; $('error').hidden = !message; }
/** Saves a change where it belongs: look settings in this site's profile when it has one, everything else globally. */
function change(patch: Partial<Settings>): void { store.change(patch); settings = store.settings; }
function render(): void {
  settings = store.settings;
  for (const [key, , , , unit] of sliderSpecs) {
    $<HTMLInputElement>(key).value = String(settings[key]); $(`${key}-value`).textContent = String(settings[key]) + unit;
  }
  for (const key of ['enabled', 'flashLimiter'] as const) $<HTMLInputElement>(key).checked = settings[key];
  $<HTMLInputElement>('director').checked = settings.director.enabled;
  $<HTMLInputElement>('pulse').checked = settings.pulse.enabled;
  $<HTMLInputElement>('guard').checked = settings.guard.enabled; $<HTMLInputElement>('exposure').checked = settings.exposure.enabled;
  document.querySelectorAll<HTMLButtonElement>('[data-glow]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.glow === settings.glow.style)));
  // A/B Comparison: which look is showing, and where a change goes while it runs.
  const compare = store.compare, here = store.comparing;
  $('compare-bar').hidden = !compare; $('compare-start').hidden = !!compare;
  if (compare) {
    document.querySelectorAll<HTMLButtonElement>('[data-side]').forEach(b => { b.setAttribute('aria-pressed', String(b.dataset.side === compare.active)); b.disabled = false; });
    $('compare-note').textContent = t("{0} を表示中", [compare.active.toUpperCase()]);
    $<HTMLButtonElement>('compare-keep-a').disabled = $<HTMLButtonElement>('compare-keep-b').disabled = !here;
    $('compare-hint').textContent = here ? t("いま動かした設定は {0} に入ります。保存してある設定は、決めるまで変わりません。A / B キーでも切り替えられます。", [compare.active.toUpperCase()])
      : t("{0}で比較中です。このページの設定とは別のため、ここでは切り替えと中止だけができます。", [compare.target ? t("{0} のプロファイル", [compare.target]) : t("グローバル設定")]);
  }
  // The preset list shows which preset the current look is, if it is one.
  const library = $<HTMLSelectElement>('library'), option = (value: string, text: string) => Object.assign(document.createElement('option'), { value, textContent: text });
  const group = (label: string, options: HTMLOptionElement[]) => { const g = document.createElement('optgroup'); g.label = label; g.append(...options); return g; };
  const mine = Object.keys(store.presets).sort();
  library.replaceChildren(option('', t("カスタム（どのプリセットとも違う設定）")), group(t("標準"), BUILT_IN.map(p => option(`b:${p.name}`, p.name))),
    ...(mine.length ? [group(t("自分のプリセット"), mine.map(name => option(`u:${name}`, name)))] : []));
  library.value = BUILT_IN.filter(p => matchesPreset(settings, p.look)).map(p => `b:${p.name}`)[0] || mine.filter(name => matchesPreset(settings, store.presets[name])).map(name => `u:${name}`)[0] || '';
  for (const key of ['source', 'protectedLight', 'manualColor', 'preset', 'zoneMode', 'zoneCount'] as const)
    $<HTMLInputElement>(key).value = String(settings[key]);
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === settings.mode)));
  $('manual-row').hidden = settings.source !== 'manual' && settings.protectedLight !== 'manual';
  $('preset-row').hidden = settings.source !== 'preset' && settings.protectedLight !== 'preset';
  $('zone-count-row').hidden = settings.zoneMode === 'auto';
  // Which settings are being edited: the global ones, or this site's own profile. A profile never grants site access.
  const own = !!store.profile;
  $('editing-context').textContent = own ? t("{0} 専用の設定を編集中", [host]) : t("グローバル設定 · 全サイト共通");
  $('profile-row').hidden = !host;
  $('profile-name').textContent = own ? t("{0} 専用のプロファイル", [host]) : t("グローバル設定（全サイト共通）");
  $('profile-toggle').textContent = own ? (confirmReturn ? t("もう一度押すと削除") : t("グローバルに戻す")) : t("このサイト専用にする");
  $('profile-note').hidden = !own;
  $('profile-note').textContent = own ? t("モード・明るさ・Light Director などはこのサイトだけの設定として保存されます。{0}", [host && protectedSite(host) ? t("保護された動画が映像に連動するようにはなりません。") : '']) : '';
  describe();
}
/** Notes and locks follow what this tab is really doing, which on protected streams differs from the saved choice. */
function describe(): void {
  const auto = settings.source === 'video' && latest?.source === 'compatibility', unreadable = latest?.state === 'Protected Content';
  const compat = auto || unreadable || settings.source === 'compatibility';
  $('source-note').textContent = unreadable
    ? t("この動画は保護されていて、色を取り出せません。{0}", [settings.protectedLight === 'off' ? t("照明は出していません。固定の照明は、下の「保護された動画での照明」で選べます。") : t("下の「保護された動画での照明」で選んだ照明を使います。")])
    : auto
    ? t("保護された配信のため、自動でDRM互換描画（CSS合成）に切り替えています。64ゾーン解析・時間平滑化・Flash Limiterは適用されません。")
    : compat ? t("映像の画素を読み出さないCSS合成。64ゾーン解析・時間平滑化・Flash Limiterは適用できません。DRM配信での表示は環境により異なります。")
    : settings.source === 'video' ? t("映像の位置に対応する色を、画面の最外周へ。Netflix・Prime Videoなど保護された動画では、自動でDRM互換描画に切り替わります。")
    : settings.source === 'music' ? t("Music Mode：再生中の音だけで光ります。映像の色は読みません。音は端末の中で解析し、録音・保存・送信はしません。再生音は変えません。保護されたコンテンツでは光りません。")
    : t("映像の取得・解析を行わない照明です。");
  captureControls(auto);
  const count = autoZoneCount(screen.width, screen.height, devicePixelRatio);
  $('zone-note').textContent = compat ? t("互換描画は連続したCSS光です。ゾーン数の指定はRGB解析で使用します。")
    : t("現在 {0}ゾーン · 自動判定 {1}×{2}px（推定）。各辺に均等配分。", [settings.zoneMode === 'auto' ? count : settings.zoneCount, Math.round(screen.width * devicePixelRatio), Math.round(screen.height * devicePixelRatio)]);
  for (const key of ['smoothing', 'responseSpeed', 'flashLimiter', 'zoneMode', 'zoneCount'])
    ($<HTMLInputElement>(key)).disabled = compat;
  // The Light Director reads the picture, so it only exists where the picture can be read.
  const reads = settings.source === 'video' && !compat;
  $<HTMLInputElement>('director').disabled = !reads;
  $('director-note').textContent = !reads ? t("映像を解析できる照明（映像に連動 · RGB解析）でのみ働きます。")
    : latest?.perf?.director === 'reduced' ? t("動作中。解析に時間がかかっているため、少し粗く見ています（自動で戻ります）。")
    : t("映像の中の光源と、急に現れた光を外周へ。強さや感度は詳細設定で調整できます。");
  // UI Guard and Adaptive Brightness say what they are doing in this tab, not only what is set.
  const guard = latest?.guard;
  $<HTMLInputElement>('guard').disabled = compat;
  $('guard-note').textContent = compat ? t("DRM互換描画の光には掛けられません。")
    : !settings.guard.enabled ? t("オフ。光がボタンや文字に重なっても、弱めません。")
    : guard?.state === 'active' && guard.held ? t("操作UI・字幕・文字の上だけ、光を弱めています（いま {0} か所）。", [guard.held])
    : guard?.state === 'active' && guard.regions ? t("光の下にUIや文字を {0} か所見つけています。いまの光はその上でも十分に薄いため、弱めていません。", [guard.regions])
    : t("操作UI・字幕・文字の上だけ、光を自動で弱めて読みやすさを保ちます。");
  const exposure = latest?.exposure;
  $<HTMLInputElement>('exposure').disabled = !reads;
  $('exposure-note').textContent = !reads ? t("映像を解析できる照明（映像に連動 · RGB解析）でのみ働きます。")
    : !settings.exposure.enabled ? t("オフ。場面の明るさに関係なく、同じ強さで光ります。")
    : exposure?.state === 'active' && exposure.level < .97 ? t("場面の明るさに合わせて、明るいゾーンの光を {0}% 暗くしています。", [Math.round((1 - exposure.level) * 100)])
    : t("暗い場面では明るい光を抑え、明るい場面では全体を少し下げます。");
  // The Pulse Engine moves the light the extension paints itself. It reads sound only while this is on (or in Music Mode).
  const audio = latest?.audio?.state, listening = settings.pulse.enabled || settings.source === 'music';
  $<HTMLInputElement>('pulse').disabled = compat;
  $('pulse-note').textContent = compat ? t("DRM互換描画と保護された動画では働きません（音も解析しません）。")
    : !listening ? t("オンにすると、再生中の音を端末の中で解析します。録音・送信せず、再生音も変えません。")
    : audio && audio !== 'off' && audio !== 'active' ? t("{0}。", [t(AUDIO_NAMES[audio])])
    : t("音で明るさと広がりが変わります。色は映像のまま。再生音は変えていません。");
  // How strongly, right under the switch: the two Pulse settings worth changing while watching.
  for (const key of ['depth', 'bloom'] as const) {
    $(`pulse-${key}-row`).hidden = !listening || compat;
    $<HTMLInputElement>(`pulse-${key}`).value = String(settings.pulse[key]); $(`pulse-${key}-value`).textContent = `${Math.round(settings.pulse[key])}%`;
  }
}
function captureControls(auto: boolean): void {
  const guarded = auto || ['Netflix', 'Prime Video'].includes(latest?.service || '') || latest?.state === 'Protected Content';
  $('capture').hidden = settings.source !== 'video' || guarded;
  $('capture-note').hidden = settings.source !== 'video';
  $('capture-note').textContent = guarded
    ? t("画質への影響を避けるため、この動画ではタブ取得を使用しません。「DRM互換描画」をお試しください。")
    : t("直接解析できない場合に使用。映像のみを取得し、録画・保存は行いません。");
}
async function request(type: 'start' | 'stop' | 'status' | 'capture' | 'stop-capture'): Promise<any> {
  if (tabId === undefined) throw new Error(t("対象タブがありません。"));
  const result = await chrome.runtime.sendMessage({ target: 'background', type, tabId } satisfies Message);
  if (result?.ok === false) throw new Error(result.error);
  return result;
}
async function refresh(): Promise<void> {
  try {
    latest = await request('status');
    describe();
    $('state').textContent = latest?.state || 'Disabled';
    $('detail').textContent = latest?.detail ? localizeText(latest.detail) : t("動画のあるタブで「照明を開始」を押してください。");
    $('service').textContent = latest?.service || '';
    $('dot').classList.toggle('active', ['Active', 'Compatibility Mode'].includes(latest?.state || ''));
    $('capture').textContent = latest?.source === 'capture' ? t("タブの取得を停止") : t("タブの映像を取得");
    const director = latest?.perf?.director;
    $('metrics').textContent = latest?.source === 'direct' || latest?.source === 'capture'
      ? `${latest.zoneCount || 64} ZONES · ${(latest.fps || 0).toFixed(1)} fps · ${(latest.sampleMs || 0).toFixed(1)} ms / sample${director && director !== 'off' && director !== 'unavailable' ? ` · DIRECTOR ${director.toUpperCase()}` : ''}${latest.audio?.state === 'active' ? ' · PULSE' : ''}`
      : latest?.source === 'music' ? `MUSIC MODE · ${latest.zoneCount || 64} ZONES · SOUND ONLY`
      : latest?.source === 'compatibility' ? 'CSS COMPOSITOR · NO PIXEL READBACK' : '';
    if (latest?.compare && $('metrics').textContent) $('metrics').textContent += ` · A/B ${latest.compare.toUpperCase()}`;
    $('status-details').hidden = !$('metrics').textContent;
    if (latest?.state !== lastSourceHint && latest && ['Protected Content', 'Capture Required', 'Compatibility Mode'].includes(latest.state)) $<HTMLDetailsElement>('source-details').open = true;
    lastSourceHint = latest?.state || '';
    $('start').innerHTML = latest && ['Active', 'Compatibility Mode'].includes(latest.state) ? t("このタブの照明を更新 <span>↗</span>") : t("このタブで照明を開始 <span>↗</span>");
  } catch (e) { error(String(e)); }
}
async function action(type: 'start' | 'capture' | 'stop-capture'): Promise<void> {
  error(''); $<HTMLButtonElement>('start').disabled = $<HTMLButtonElement>('capture').disabled = true;
  try {
    change({ enabled: true }); await store.saved; render(); await request(type); await refresh();
  } catch (e) { error(String(e instanceof Error ? e.message : e)); }
  finally { $<HTMLButtonElement>('start').disabled = $<HTMLButtonElement>('capture').disabled = false; }
}
$('start').addEventListener('click', () => void action('start'));
$('capture').addEventListener('click', () => void action(latest?.source === 'capture' ? 'stop-capture' : 'capture'));
for (const key of ['enabled', 'flashLimiter'] as const) $<HTMLInputElement>(key).addEventListener('change', async e => {
  change({ [key]: (e.target as HTMLInputElement).checked });
  if (key === 'enabled') { await store.saved; if (settings.enabled) await action('start'); else await request('stop').catch(e => error(String(e))); }
  await refresh();
});
for (const key of ['depth', 'bloom'] as const) $<HTMLInputElement>(`pulse-${key}`).addEventListener('input', e => {
  const value = (e.target as HTMLInputElement).valueAsNumber;
  $(`pulse-${key}-value`).textContent = `${value}%`; change({ pulse: { ...settings.pulse, [key]: value } });
});
$<HTMLInputElement>('pulse').addEventListener('change', e => {
  change({ pulse: { ...settings.pulse, enabled: (e.target as HTMLInputElement).checked } }); render();
});
// Applying a preset changes the look only. Whether sound is analysed stays as it is.
$<HTMLSelectElement>('library').addEventListener('change', e => {
  const value = (e.target as HTMLSelectElement).value, look = value.startsWith('b:') ? BUILT_IN.find(p => p.name === value.slice(2))?.look : store.presets[value.slice(2)];
  if (look) change(applyPreset(settings, look));
  render();
});
$<HTMLInputElement>('guard').addEventListener('change', e => { change({ guard: { ...settings.guard, enabled: (e.target as HTMLInputElement).checked } }); render(); });
$<HTMLInputElement>('exposure').addEventListener('change', e => { change({ exposure: { ...settings.exposure, enabled: (e.target as HTMLInputElement).checked } }); render(); });
// Choosing a style also sets the sliders of the Glow Designer to that style's own starting point.
document.querySelectorAll<HTMLButtonElement>('[data-glow]').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.glow !== settings.glow.style) change({ glow: b.dataset.glow === 'halo' ? HALO : GLOW });
  render();
}));
// A/B Comparison. Starting one copies the current look to both sides and shows B, which is then the one being changed.
$('compare-start').addEventListener('click', () => { store.startCompare(); render(); });
document.querySelectorAll<HTMLButtonElement>('[data-side]').forEach(b => b.addEventListener('click', () => { store.showSide(b.dataset.side as 'a' | 'b'); render(); }));
$('compare-keep-a').addEventListener('click', () => { store.endCompare('a'); render(); });
$('compare-keep-b').addEventListener('click', () => { store.endCompare('b'); render(); });
$('compare-cancel').addEventListener('click', () => { store.endCompare(null); render(); });
document.addEventListener('keydown', e => {
  const key = e.key.toLowerCase(), typing = (e.target as HTMLElement).matches?.('input:not([type=checkbox]):not([type=range]),select,textarea');
  if (!store.compare || typing || e.metaKey || e.ctrlKey || e.altKey || key !== 'a' && key !== 'b') return;
  e.preventDefault(); store.showSide(key); render();
});
$('wizard').addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL(`options.html${store.target ? `?site=${encodeURIComponent(store.target)}` : ''}#wizard`) });
});
$<HTMLInputElement>('director').addEventListener('change', e => {
  change({ director: { ...settings.director, enabled: (e.target as HTMLInputElement).checked } }); render();
});
for (const key of ['source', 'protectedLight', 'manualColor', 'preset', 'zoneMode', 'zoneCount'] as const) $(key).addEventListener('change', e => {
  const value = (e.target as HTMLInputElement).value;
  change({ [key]: key === 'zoneCount' ? Number(value) : value }); render();
});
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b => b.addEventListener('click', () => {
  change({ mode: b.dataset.mode as Settings['mode'] }); render();
}));
// "初期設定" resets what is being edited: a site profile goes back to inheriting everything, otherwise the global settings reset.
$('reset').addEventListener('click', () => {
  if (store.profile) store.setProfile(store.target, {}); else change({ ...DEFAULTS, director: DIRECTOR, zones: null });
  render();
});
// A profile is only a set of saved settings. Making one asks Chrome for nothing; "always light this site" stays a separate choice.
$('profile-toggle').addEventListener('click', () => {
  if (!host) return;
  if (!store.profile) { store.setProfile(host, {}); store.target = host; }
  else if (!confirmReturn) { confirmReturn = window.setTimeout(() => { confirmReturn = 0; render(); }, 4000); }
  else { clearTimeout(confirmReturn); confirmReturn = 0; store.setProfile(host, null); }
  render();
});
$('open-options').addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL(`options.html${store.target ? `?site=${encodeURIComponent(store.target)}` : ''}#lighting`) });
});
$('feedback').addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#feedback') });
});
// "Always light this site" is nothing but Chrome's own permission for that site: granting it turns it on, removing it turns it off.
$('always').addEventListener('change', async e => {
  const box = e.target as HTMLInputElement, note = $('always-note');
  if (!site) return;
  error(''); note.hidden = true;
  try {
    if (box.checked) {
      // Chrome asks here. If that closes this popup, the background still lights the site once it is granted.
      box.checked = await chrome.permissions.request({ origins: [site] });
      if (box.checked) await action('start');
      else { note.textContent = t("Chromeの許可が得られなかったため、常に点灯はオフのままです。"); note.hidden = false; }
    } else {
      box.checked = !(await chrome.permissions.remove({ origins: [site] }));
      if (!box.checked) { note.textContent = t("このサイトへの常時の許可を返しました。このタブの照明は、ページを移動するまで続きます。"); note.hidden = false; }
    }
  } catch (err) {
    box.checked = await chrome.permissions.contains({ origins: [site] }).catch(() => false);
    error(String(err instanceof Error ? err.message : err));
  }
});
window.addEventListener('eclirim-language', () => { void store.saved.then(() => location.reload()); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings && !changes.profiles && !changes.presets && !changes.compare) return;
  if (store.adopt(changes)) render();
});
void (async () => {
  const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  tabId = tab?.id; site = sitePattern(tab?.url); host = siteKey(tab?.url);
  await store.load();
  if (host && store.profiles[host]) store.target = host;
  if (site) {
    $('always-row').hidden = false;
    $('always-site').textContent = t("{0} · 新しいタブやChromeの再起動後も自動で開始", [new URL(tab!.url!).hostname]);
    $<HTMLInputElement>('always').checked = await chrome.permissions.contains({ origins: [site] });
  }
  render(); await refresh(); window.setInterval(() => void refresh(), 1000);
})().catch(e => error(String(e)));

})();
