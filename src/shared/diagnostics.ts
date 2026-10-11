import { t as translate, formatMessage } from './i18n';
import type { Status } from './types';

/** A small, fixed snapshot. No tab metadata, profile names, status detail, media or device identifiers. */
export interface DiagnosticsSummary {
  state: Status['state']; source: Status['source'];
  analysisFps?: number; renderFps?: number; analysisMs?: number; readMs?: number; renderMs?: number;
  zones?: number; activeZones?: number; quality?: number;
  reader?: 'gpu' | 'canvas'; director?: 'active' | 'reduced' | 'off' | 'unavailable';
  pulse?: 'off' | 'active' | 'muted' | 'waiting' | 'protected' | 'blocked' | 'none';
  guard?: 'off' | 'active' | 'unavailable'; exposure?: 'off' | 'active' | 'unavailable';
  colorEngine?: 'v2' | 'classic'; colorSpace?: 'srgb' | 'display-p3';
}
const enums = {
  state: ['Active', 'Waiting for Video', 'Capture Required', 'Protected Content', 'Capture Unavailable', 'Paused', 'Disabled', 'Fullscreen Unsupported', 'Compatibility Mode'],
  source: ['direct', 'capture', 'compatibility', 'fallback', 'music', 'none'],
  reader: ['gpu', 'canvas'], director: ['active', 'reduced', 'off', 'unavailable'],
  pulse: ['off', 'active', 'muted', 'waiting', 'protected', 'blocked', 'none'],
  guard: ['off', 'active', 'unavailable'], exposure: ['off', 'active', 'unavailable'],
  colorEngine: ['v2', 'classic'], colorSpace: ['srgb', 'display-p3']
};
const numbers = { analysisFps: 1000, renderFps: 1000, analysisMs: 60000, readMs: 60000, renderMs: 60000,
  zones: 2048, activeZones: 2048, quality: 3 };

/** Allowlist at the boundary: arbitrary strings and extra fields can never enter a diagnostic attachment. */
export function diagnosticsSummary(raw: unknown): DiagnosticsSummary | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const input = raw as Record<string, unknown>, output: Record<string, string | number> = {};
  for (const [key, values] of Object.entries(enums)) {
    const value = input[key];
    if (typeof value === 'string' && values.includes(value)) output[key] = value;
  }
  if (!output.state || !output.source) return;
  for (const [key, max] of Object.entries(numbers)) {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) continue;
    if (['zones', 'activeZones', 'quality'].includes(key) && !Number.isInteger(value)) continue;
    output[key] = Math.round(value * 100) / 100;
  }
  return output as unknown as DiagnosticsSummary;
}
export function diagnosticsFromStatus(status: Status): DiagnosticsSummary | undefined {
  return diagnosticsSummary({ state: status.state, source: status.source,
    analysisFps: status.perf?.analysisFps, renderFps: status.perf?.renderFps,
    analysisMs: status.perf?.analysisMs, readMs: status.perf?.readMs, renderMs: status.perf?.renderMs,
    zones: status.perf?.zones, activeZones: status.perf?.activeZones, quality: status.perf?.quality,
    reader: status.perf?.reader, director: status.perf?.director, pulse: status.audio?.state,
    guard: status.guard?.state, exposure: status.exposure?.state,
    colorEngine: status.color?.engine, colorSpace: status.color?.space });
}
export function diagnosticsText(summary: DiagnosticsSummary, localized = false): string {
  const t = localized ? translate : formatMessage;
  const lines = [t("Diagnostics の要約"), t("状態: {0}", [summary.state]), t("描画方式: {0}", [summary.source])];
  for (const [key, label, unit] of [
    ['analysisFps', t("解析FPS"), ' fps'], ['renderFps', t("描画FPS"), ' fps'],
    ['analysisMs', t("解析時間"), ' ms'], ['readMs', t("映像の読み出し時間"), ' ms'], ['renderMs', t("描画時間"), ' ms'],
    ['zones', t("ゾーン数"), ''], ['activeZones', t("光るゾーン数"), ''], ['quality', t("品質の段階"), ''],
    ['reader', t("映像の読み出し方"), ''], ['director', 'Light Director', ''], ['pulse', 'Pulse Engine', ''],
    ['guard', 'UI Guard', ''], ['exposure', 'Adaptive Brightness', ''],
    ['colorEngine', 'Color Engine', ''], ['colorSpace', t("色空間"), '']
  ] as const) if (summary[key] !== undefined) lines.push(`${label}: ${summary[key]}${unit}`);
  return lines.join('\n');
}
