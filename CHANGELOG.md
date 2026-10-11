# Changelog / 変更履歴

Current validation scope: [English](docs/QA-0.9.9.en.md) / [日本語](docs/QA.md).

## 0.9.9 — Global Update (2026-10-11)

- Added Japanese/English UI throughout the popup, all ten settings tabs, Wizard, presets, A/B comparison, diagnostics and feedback.
- Automatic language follows Chrome: Japanese for Japanese UI, English otherwise. Auto/Japanese/English can be selected separately and persists across restarts.
- Language switching refreshes extension UI without stopping lighting or resetting saved looks. An unfinished Wizard restarts and diagnostic attachments require review again; saved drafts remain.
- Chrome's native descriptions follow its UI language. Narrow English labels wrap, and missing translations fall back to the bundled catalog.
- Existing settings, profiles, presets and legacy CineGlow JSON remain compatible. Permissions, DRM policy, media analysis and diagnostic consent are unchanged.
- English and Japanese installation, feature and privacy guides are available. This version remains a Beta.

日本語・英語UIと再起動後も保持する言語選択を追加しました。言語切替で照明や保存済み設定は変わりません。途中のWizardと診断添付は再確認が必要です。既存データとの互換性、権限、DRM制限、音声解析の初期オフを維持しています。

## 0.9.8 Beta 2（2026-10-11）

- LICENSE原文をソースと配布ZIPへ同梱し、READMEの過去の説明を折りたたみました。拡張内のバージョンは0.9.8です。

## 0.9.8（2026-10-11）

- Diagnosticsの要約を、内容の確認と添付チェックを経てフィードバックへ含められます。URL・タブ名・プロファイル名・映像・音声は含めません。
- 添付する値を固定し、タブ変更・要約更新・画面の開き直しで確認を解除します。診断なしでも送信できます。
- 受信側が要約に対応していない場合、添付が欠けたまま送信成功と扱わず、送信前に知らせます。

## 0.9.7（2026-10-11）

- プリセット・明るさ・幅をポップアップの上部へまとめ、詳細設定を用途別に整理しました。狭い画面とキーボード操作に対応します。
- 評価・感想・不具合・改善案を下書き保存、プレビュー、コピー付きで送信できます。送信ボタンを押すまで外部へ送りません。失敗時も下書きを保持します。

## 0.9.6（2026-10-11）

- ビートや明るいカットでUI Guardの上限を一時的に超える問題を修正しました。保護は現在のフレームへ即時適用し、解除だけを滑らかに行います。
- 非表示後の全画面イベントで、停止した照明レイヤーが戻る問題を修正しました。

## 0.9.5（2026-10-11）

- Canvas復旧後に状態がActiveのまま光が消える問題を修正しました。停止中の場面も再描画し、照明OFFは維持します。

## 0.9.4（2026-10-11）

- Beat Bloomを追加。音に合わせて光が内側へ広がり、100%で最大1.8倍になります。
- Beat Waveの移動時間を100%で約0.32秒へ延ばしました。UI Guardも広がった光を保護します。
- Flash Limiterオフでは明るい場面のビートを強めます。オンでは広がりを半分にし、追加の明るさ上昇は使いません。

## 0.9.3（2026-10-10）

- Pulse Depthを見える濃さへの調整にし、反応を強めました。Beat WaveとポップアップのPulse Depthを追加しました。
- Flash Limiterオンでもビート時の限定的な瞬間変化を許します。穏やかな反応にはPulse Depthを下げてください。音声解析は初期オフです。

## 0.9.2（2026-10-10）

- 対応動画をGPUで縮小してから読み出し、高解像度での負荷を軽減しました。従来経路との照合に通らない動画、HDR、ライブ映像はCanvasで読みます。
- 負荷が高いときもLight Directorを止めず、解析の細かさと頻度を段階調整します。読み出し方式と時間をDiagnosticsへ表示します。

## 0.9.1 — Identity Update（2026-10-10）

- CineGlowからECLIRIMへ名称とアイコンを変更。旧JSONを引き続き読み込めます。
- Glow Designer、UI Guard、Adaptive Brightness、A/B比較、Calibration Wizardを追加しました。
- 保存データを読み終える前の操作で初期値を書き込む問題を修正しました。既存データは保持し、新規項目に初期値を加えます。

## 0.9.0 — Resonance Update（2026-10-10）

- 初期オフのPulse Engineと音だけで光るMusic Modeを追加。元の再生音を変更せず、解析は端末内で行います。
- Color Engine 2.0、Display P3対応、HDRの状態表示、Dynamic Light Trails、プリセットとJSON入出力を追加しました。
- プリセットやバックアップの読み込みで音声解析を自動的に有効にしません。

## 0.8.1（2026-10-09）

- YouTubeのサムネイルのホバープレビューを照明対象から除外しました。本編では通常どおり点灯します。

## 0.8.0 — Cinematic Update（2026-10-09）

- Light Director、Zone Studio、Site Profiles、Performance Monitor、負荷に応じた品質調整を追加しました。
- サイトプロファイルはグローバル設定との差分を保存します。権限の付与や自動点灯とは別の機能です。

## 0.7.1（2026-10-09）

- 保護動画での初期照明を「光らせない」へ変更しました。固定照明は選択できます。

## 0.7.0（2026-10-09）

- macOS Chromeの保護映像では色を取得できない制約を明示し、Protected Content表示と任意の固定照明へ変更しました。

## 0.6.0（2026-10-09）

- CSS互換描画で辺ごとのぼかしと光の合成を改善しました。

## 0.5.0（2026-10-09）

- 任意のサイト許可を使う「このサイトでは常に点灯」を追加しました。

## 0.4.0（2026-10-09）

- 同じサイトのページ移動・再読み込みで照明を再開します。

## 0.3.0（2026-10-09）

- Netflix・Prime VideoでCSS互換経路への切り替えを追加しました。macOSの保護映像で利用できない制約は0.7.0で反映しました。

## 0.2.0（2026-10-09）

- 色相を保ち、光量を不透明度で表す描画へ変更しました。暗い場面は透明になります。

## 0.1.0（2026-10-09）

- 64ゾーンのRGB解析と3つの描画経路を備えた最初の版です。
