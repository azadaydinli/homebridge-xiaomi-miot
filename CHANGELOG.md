# Changelog

## [1.1.1] - 2026-06-08

### Added
- **Offline detection** — devices that lose network connectivity now show "No Response" in HomeKit. Detection works by overriding HAP `getHandler`s to throw `SERVICE_COMMUNICATION_FAILURE` after 4 missed polling cycles. Original handlers are restored automatically when the device reconnects.
- **Auto/sleep mode rotation speed** — when a device is in Auto or Sleep mode, the `RotationSpeed` characteristic shows a configurable placeholder value (default `50%`) instead of `0%`. Configurable via `"autoRotationSpeed"` in device config (set to `0` to disable).
- **Per-model feature toggles (Config UI)** — the device settings UI now lists device-specific feature toggles (buzzer, LED, child lock, modes, fan speed, swing, screen, ioniser, etc.) sourced from the homebridge-miot device registry. Features default to **OFF**; the user enables only what they need. Covers 83+ device models across 7 categories (fans, air purifiers, humidifiers, lights, heaters, vacuums, outlets).
- **`normalizeFeatures()`** — on every UI render, any feature key that is `undefined` in config is explicitly written as `false` before saving, preventing homebridge-miot's built-in defaults from silently enabling disabled features.
- **`device-features.js`** — feature definitions moved to a separate file for easy maintenance; adding a new model requires editing only that file.
- **`autoRotationSpeed` config key** in `config.schema.json`.

### Changed
- Feature toggle buttons now use a **solid green** active state (`#16a34a`, white text) consistent with homebridge-ac-freedom UI style.
- Feature toggle hover state changed from accent-blue to neutral grey (`#9ca3af`) for better visual clarity.
- Updated CSS colour system in Config UI (success / warn / danger variables, refined accent alpha values).

### Fixed
- Features marked as OFF were still being enabled in HomeKit because `getConfigValue('key', true)` defaults to `true` when the key is absent from config. Fix: write explicit `false` values via `normalizeFeatures()` before saving.

---

## [1.1.0] - 2026-05-25

### Added
- MiCloud auto-discovery in Config UI — log in with Mi account credentials to fetch device list (IP, token, model) automatically.
- OTP / identity verification flow support.
- Persistent MiCloud session (survives Homebridge restarts).
- Local network token fetch fallback.

---

## [1.0.0] - 2026-05-18

### Added
- Initial release.
- Wraps `homebridge-miot` as a child-bridge platform plugin.
- Config UI with per-device settings (name, IP, token, model, polling interval, connection type).
- Cloud (MiCloud) and local connection modes.
