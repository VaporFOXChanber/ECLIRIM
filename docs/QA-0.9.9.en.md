# ECLIRIM 0.9.9 — validation scope

[日本語](QA.md)

Type checking, **100 client unit tests**, and the production build passed for this package on macOS Apple Silicon. Checks used existing dependencies whose applicable installed versions matched the lockfile; a fresh dependency installation was not tested.

Browser E2E, real feedback delivery and long sessions were not rerun for this package. Earlier browser results do not establish validation of this package. Windows, Linux, Intel Mac, minimum-version Chrome 116, current commercial streaming services, HDR viewing and physical multi-monitor moves remain unverified.

On macOS Chrome, protected video cannot supply colors to ECLIRIM. Optional fixed lighting does not follow protected video. The automated ClearKey fixtures check detection and fallback; they do not substitute for commercial Widevine playback or physical-display evaluation.

This is a Beta. See the [user guide](../README.md) for installation and limitations, and the [developer guide](DEVELOPMENT.md) for test commands.
