export type RGB = [number, number, number];
export type Mode = 'cinema' | 'vivid' | 'ambient';
export type Source = 'video' | 'compatibility' | 'manual' | 'preset' | 'drift' | 'music';
/** Light Director: extra light for bright things and sudden light inside the picture. Every slider is 0–100. */
export interface DirectorSettings {
  enabled: boolean; motion: number; source: number; strength: number; response: number; smoothing: number;
}
/**
 * Pulse Engine: the sound of the playing media changes how hard the light is driven, never its colour. Sliders are 0–100.
 * Off by default: sound is only read after the user has switched this on (or chosen Music Mode).
 */
export interface PulseSettings { enabled: boolean; depth: number; bass: number; mid: number; treble: number; sensitivity: number; wave: number; bloom: number }
/** Color Engine 2.0. Off = the colour handling of 0.8. Sliders are 0–100. */
export interface ColorSettings { enabled: boolean; shadows: number; highlights: number; vibrance: number; wideGamut: boolean }
/** Dynamic Light Trails: afterglow along the edge where a followed light source has just been. Sliders are 0–100. */
export interface TrailSettings { enabled: boolean; length: number; strength: number }
/** Edge Light: a strip of virtual LEDs on the screen edge with a bloom and a halo. Soft Halo: one soft lobe, like indirect light. */
export type GlowStyle = 'edge' | 'halo';
/**
 * Glow Designer: the shape of the light, from the screen edge inward. Sliders are 0–100.
 * Edge Light with every slider at 50 is the light of 0.9.0, to the last digit. In both styles the light is strongest
 * on the outermost edge of the screen and never rises again toward the picture.
 */
export interface GlowSettings { style: GlowStyle; thickness: number; curve: number; falloff: number; softness: number }
/**
 * UI Guard: keeps controls, captions and text under the light readable by limiting how opaque the light may be over them.
 * `pointer` also eases the light around the mouse pointer while it is moving near an edge.
 */
export interface GuardSettings { enabled: boolean; strength: number; pointer: boolean }
/**
 * Adaptive Brightness: the light follows how bright the whole picture is. `dark`: how far bright zones are held back in
 * dark scenes. `bright`: how far all of the light is lowered in bright scenes. `speed`: how fast it follows. Sliders are 0–100.
 */
export interface ExposureSettings { enabled: boolean; dark: number; bright: number; speed: number }
/**
 * Zone Studio trims on a fixed grid of 96 steps per side (top, bottom, left, right), so they hold for any zone count.
 * Percentages, 100 = untouched. `on` is 1 or 0.
 */
export interface ZoneMap { brightness: number[]; saturation: number[]; intensity: number[]; on: number[] }
export interface Settings {
  enabled: boolean; mode: Mode; source: Source; brightness: number; glowWidth: number;
  intensity: number; saturation: number; smoothing: number; responseSpeed: number;
  zoneCount: number; zoneMode: 'auto' | 'manual'; flashLimiter: boolean; manualColor: string; preset: string;
  /** What to show on protected video whose colours cannot be had. Never follows the picture. */
  protectedLight: 'preset' | 'drift' | 'manual' | 'off';
  director: DirectorSettings; pulse: PulseSettings; color: ColorSettings; trails: TrailSettings;
  glow: GlowSettings; guard: GuardSettings; exposure: ExposureSettings;
  /** null = no zone was trimmed. */
  zones: ZoneMap | null;
  /** Developer overlay with measured figures. */
  hud: boolean;
  /** Lower the analysis quality by itself when frames keep running long. */
  adaptive: boolean;
}
/** The part of the settings a site can have for itself. A profile holds only what differs from the global settings. */
export type LookKey = 'mode' | 'brightness' | 'glowWidth' | 'intensity' | 'saturation' | 'smoothing' | 'responseSpeed'
  | 'flashLimiter' | 'director' | 'zones' | 'pulse' | 'color' | 'trails' | 'glow' | 'guard' | 'exposure';
/**
 * A preset is a look to hand around: no zone trims (they belong to one screen), no UI Guard (a protection the user keeps
 * as it is, whatever the preset), and it never switches sound analysis on.
 */
export type PresetKey = Exclude<LookKey, 'zones' | 'guard'>;
export type PresetLook = Partial<Pick<Settings, PresetKey>>;
export type Presets = Record<string, PresetLook>;
export type Profile = Partial<Pick<Settings, LookKey>>;
export type Profiles = Record<string, Profile>;
/**
 * A/B Comparison: two looks for the same settings (`target`: a site's profile, or '' for the global ones). The lit tabs
 * those settings govern show the `active` side. Nothing is written to the settings until the user adopts a side.
 */
export interface Compare { active: 'a' | 'b'; a: Profile; b: Profile; target: string }
export type State = 'Active' | 'Waiting for Video' | 'Capture Required' | 'Protected Content'
  | 'Capture Unavailable' | 'Paused' | 'Disabled' | 'Fullscreen Unsupported' | 'Compatibility Mode';
/** What the Light Director saw in the last frame it analysed. Velocity is in picture widths / heights per second. */
export interface DirectorStats { sources: number; motion: number; vx: number; vy: number; cut: boolean; calm: number }
/** How the pixels of a frame were got: scaled down on the GPU, or drawn into a 2D canvas (the way up to 0.9.1). */
export type Reader = 'gpu' | 'canvas';
/** Measured in this tab. Nothing here is estimated: figures Chrome does not expose to extensions (CPU, GPU) are left out. */
export interface Perf {
  analysisFps: number; analysisMs: number; directorMs: number;
  /** The part of `analysisMs` spent getting the pixels out of the video, and how they were got. */
  readMs: number; reader: Reader;
  renderFps: number; renderMs: number; latencyMs: number;
  zones: number; activeZones: number;
  /** Analysis ticks that came late enough to miss a slot, and painted frames that did. */
  skippedAnalysis: number; skippedRender: number;
  /** Analyses over ANALYSIS_BUDGET_MS plus paints over RENDER_BUDGET_MS. */
  overBudget: number;
  /** 0 = full quality … 3 = coarsest, analysed half as often. The Light Director runs at every level. */
  quality: number;
  director: 'active' | 'reduced' | 'off' | 'unavailable';
  stats: DirectorStats | null;
}
/**
 * What the Pulse Engine is doing with the sound. `off`: not asked for. `active`: hearing it. `muted`: the player is muted, so
 * nothing moves. `waiting`: the page has not let audio processing start yet. `protected` / `blocked`: Chrome does not hand
 * out this media's sound (DRM, or another origin). `none`: nothing playing that has sound.
 */
export interface AudioStatus {
  state: 'off' | 'active' | 'muted' | 'waiting' | 'protected' | 'blocked' | 'none';
  low: number; mid: number; high: number; beats: number;
}
/**
 * UI Guard in this tab. `regions`: places with controls, captions or text found under the light. `held`: in how many of
 * them the light is being held back right now (none while the light there is thin anyway). `ms`: what the last look for
 * them cost. `unavailable`: this light is made by the page compositor (DRM-compatible rendering), which the guard cannot shape.
 */
export interface GuardStatus { state: 'off' | 'active' | 'unavailable'; regions: number; held: number; ms: number }
/**
 * Adaptive Brightness in this tab. `key`: how bright the picture is as a whole (0–1, perceptual). `level`: what the
 * lightness of a fully bright zone is multiplied by right now (1 = untouched). `unavailable`: no picture is being read.
 */
export interface ExposureStatus { state: 'off' | 'active' | 'unavailable'; key: number; level: number }
/** What is known about the colours being read, and how they are handled. */
export interface ColorStatus {
  engine: 'v2' | 'classic'; space: 'srgb' | 'display-p3';
  /** As Chrome reports them for the playing video, e.g. bt709, smpte432 (P3), bt2020 / bt709, pq, hlg. '' = not readable. */
  primaries: string; transfer: string; hdr: boolean; wide: boolean; displayP3: boolean; displayHdr: boolean;
}
export interface Status {
  state: State; detail: string; source: 'direct' | 'capture' | 'compatibility' | 'fallback' | 'music' | 'none';
  service: string; zoneCount?: number; sampleMs?: number; fps?: number; frames?: number;
  /** The site profile in use, or '' for the global settings. */
  profile?: string; perf?: Perf; audio?: AudioStatus; color?: ColorStatus; guard?: GuardStatus; exposure?: ExposureStatus;
  /** The side of an A/B comparison this tab is showing, or '' when it shows the saved settings. */
  compare?: 'a' | 'b' | '';
}
export interface Rect { x: number; y: number; width: number; height: number }
export interface VideoContext {
  rect: Rect | null; viewport: { width: number; height: number }; paused: boolean;
  hidden: boolean; protected: boolean; fullscreenUnsupported: boolean;
}
/** What the offscreen analyser measured for one captured frame. */
/** `at` is the wall clock (Date.now) when the frame was read: the two documents do not share a performance clock. */
/** `luma`: how bright the whole picture is (mean perceptual lightness, 0–1), for Adaptive Brightness. */
export interface CaptureSample { sampleMs: number; readMs: number; reader: Reader; fps: number; frames: number; directorMs: number; quality: number; stats: DirectorStats | null; at: number; luma: number }
export type Message =
  | { target: 'background'; type: 'start' | 'capture' | 'stop' | 'status' | 'stop-capture'; tabId: number }
  | { target: 'background'; type: 'tabs' }
  | { target: 'background'; type: 'compare'; compare: Compare | null; saved?: { settings?: unknown; profiles?: unknown; presets?: unknown } }
  | { target: 'content'; type: 'start' | 'stop' | 'status' | 'context' | 'capture-started' | 'probe' }
  | { target: 'content'; type: 'capture-ended'; detail: string }
  | ({ target: 'content'; type: 'colors'; colors: RGB[] } & CaptureSample)
  | { target: 'content'; type: 'capture-status'; state: State; detail: string }
  | { target: 'content'; type: 'zoom'; factor: number }
  | { target: 'background'; type: 'context'; context: VideoContext; settings: Settings }
  | { target: 'background'; type: 'relay'; tabId: number; message: Message }
  | { target: 'background'; type: 'capture-closed'; tabId: number; detail: string }
  | { target: 'background'; type: 'release' }
  | { target: 'background'; type: 'heartbeat' }
  | { target: 'offscreen'; type: 'start'; tabId: number; streamId: string; context: VideoContext; settings: Settings }
  | { target: 'offscreen'; type: 'context'; tabId: number; context: VideoContext; settings: Settings }
  | { target: 'offscreen'; type: 'stop' | 'status' };
