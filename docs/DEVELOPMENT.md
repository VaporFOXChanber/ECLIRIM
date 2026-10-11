# Developer guide / 開発者ガイド

Build and test the extension source with Node.js and npm. Dependencies are development tools; the extension has no runtime library dependencies. Read [LICENSE](../LICENSE) for applicable terms.

## Build

```sh
npm ci
npm run check
npm run package
```

`check` runs TypeScript checking, 100 client unit tests and the build. `build` produces `dist/`, which can be loaded through Chrome's **Load unpacked** control. `package` builds and writes the extension ZIP and checksum to `releases/`. The packager requires the expected 20 extension files, including LICENSE, and rejects unexpected files and symlinks. Source maps are not generated. It needs no external ZIP program.

## Browser tests

```sh
npx playwright install chromium
npm run test:e2e
```

Set these environment variables to archive paths before running suites that need an earlier version:

| Variable | Required archive | Suite |
|---|---|---|
| `ECLIRIM_UPGRADE_BASELINE_ZIP` | ECLIRIM 0.9.8 Beta 2; SHA-256 `e4bc47e77a0961474eb3fe9256bf46507e735319424b5acb70581f795b3d5a53` | i18n/update; full E2E |
| `ECLIRIM_IDENTITY_BASELINE_ZIP` | CineGlow 0.9.0 | Identity; full E2E |
| `ECLIRIM_PERF_BASELINE_ZIP` | ECLIRIM 0.9.1 | Separate performance comparison |

Missing baseline archives stop the relevant test. `test:e2e` runs baseline, Cinematic, Resonance, Identity, Canvas recovery, UI Guard, UI/feedback, diagnostic attachment and i18n suites. Individual commands include `test:recovery`, `test:guard`, `test:ui`, `test:feedback-diagnostics` and `test:i18n`. The separate `npm run test:perf` also requires FFmpeg to generate 1080p/4K fixtures. `SOAK_SECONDS=300` extends the baseline soak; `COMPARE_SECONDS` changes feature comparisons (default 15 seconds each). Results and screenshots are written to `artifacts/`.

Tests launch isolated Chrome for Testing profiles with the production manifest. They do not add test host permissions. Toolbar actions use CDP and the real popup. Test-only extension-debugging flags are confined to these browsers. Media-key handling is disabled in the test browser. Feedback tests intercept delivery and clipboard APIs; they do not send email or change the OS clipboard. Automated screenshots do not establish protected-video behavior on the physical display.

## Light Lab and optional tools

`npm run dev` serves Light Lab at `http://localhost:4173`; port 4174 supplies cross-origin video. Start the loaded extension through its normal controls. The page supplies synthetic color, motion, letterboxing, cuts, flashes, CORS, ClearKey, audio and near-edge UI scenarios. Regenerate fixtures with FFmpeg and `sh scripts/generate-fixtures.sh`.

Optional tools `scripts/real-pulse.mjs`, `real-ui.mjs` and `real-video.mjs` take public video URLs and need network access. `scripts/audio-output-check.mjs` opens a visible browser and plays quiet audio (−54 dB) for about 25 seconds. These tools are outside automatic tests. `scripts/make-icons.mjs` regenerates the icon assets.

## Source map

| Location | Responsibility |
|---|---|
| `public/` | Manifest, extension HTML/CSS, offscreen page, icons |
| `src/background.ts`, `src/content.ts`, `src/offscreen.ts` | User actions, injection, rendering lifecycle and video-only capture |
| `src/popup.ts`, `src/options.ts`, `src/ui/` | Popup, settings, comparison and feedback controls |
| `src/capture/` | Video readback, audio copy, color metadata and UI geometry |
| `src/engine/` | Color, effects, zones and adaptive quality |
| `src/render/` | Canvas/CSS lighting, HUD and A/B badge |
| `src/shared/` | Settings, presets, migration, privacy boundaries and translations |
| `tests/`, `test-page/`, `scripts/` | Unit tests, synthetic fixtures, browser suites and build tools |

## Technical references

- [Internationalization](I18N.md)
- [Glow, UI Guard, adaptive brightness and comparison](IDENTITY.md)（日本語）
- [Audio, color and presets](RESONANCE.md)（日本語）
- [Light Director and adaptive quality](LIGHT_DIRECTOR.md)（日本語）
- [Protected-video compatibility](DRM_COMPATIBILITY.md)（日本語）
- Current validation scope: [English](QA-0.9.9.en.md) / [日本語](QA.md)

日本語: `npm run check` は型検査・単体テスト・ビルド、`npm run package` は配布物を作成します。ブラウザー試験にはPlaywrightのChromiumと、上表の対象版ZIPが必要です。これらの手順を実行できることと、すべてのブラウザーや実サイトで動作確認済みであることは異なります。
