# Helium Browser Pi extension

This Pi extension attaches to an already-running [Helium](https://github.com/imputnet/helium-macos) browser through Chrome DevTools Protocol (CDP). It does not create a separate browser profile and never kills or restarts Helium automatically.

## Requirements

- Pi with the current extension API.
- macOS Helium with CDP available at `http://127.0.0.1:9222` (the reviewed setup exposed Chromium `152.0.7977.82`; Helium does not provide a separately pinned compatibility version here).
- Node/Bun and the package dependencies for local development.

Pi core packages (`@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`) are peer dependencies supplied by Pi. `StringEnum` is used for provider-compatible string enum schemas.

## Install or try locally

From a checkout, try the extension for one Pi run:

```sh
pi -e ./agent/extensions/helium-browser
```

To install a package permanently, use Pi's package installer with the extension directory:

```sh
pi install ./agent/extensions/helium-browser
```

For a first connection, run `/helium setup` for the exact launch command, then `/helium status`. The extension uses Helium's normal `Default` profile. Starting Helium with CDP can expose existing tabs to Pi, so review open tabs before enabling it.

## Browser and secret-handling contract

- Status and tab listing are read-only. Pi adopts an existing default window only when every page is an empty new tab; otherwise it creates/reuses Pi-owned tabs and leaves meaningful user windows alone. Tab metadata reads are concurrency-limited; `helium_tabs` text and structured details expose at most 50 tabs and report omissions.
- Use `helium_snapshot` before a ref-based action and prefer explicit `tabId` values for multi-tab work. Snapshot traversal is bounded; when `details.cursor` is present, call `helium_snapshot` again with that opaque cursor (and the same `tabId`, `scope`, and `includeRefs`) to inspect later controls/text. Cursors are single-use and become stale after navigation, a fresh snapshot, or tab replacement. `scope` is a bounded CSS selector for one subtree.
- Navigation accepts only `http(s)` URLs and `about:blank`.
- Generic `helium_fill` and `helium_type` are intended for non-secret values. Do not pass passwords, OTPs, API keys, payment data, or other credentials. Use `helium_request_intervention` for manual credential entry.
- Snapshots redact recognized password fields, but screenshots and arbitrary page content/URLs can still contain sensitive data. Do not treat this extension as a general secret-redaction boundary. Screenshot captures are bounded by dimension, pixel, and encoded-size limits.
- `helium_request_intervention` reports whether Pi UI or native notification delivery was available. `focus: true` activates the Helium application on macOS; it does not select a particular tab.

## Reproducible local checks

Install dependencies from a clean checkout, then run the package checks:

```sh
cd agent/extensions/helium-browser
bun install
bun run check
```

`bun run check` runs the standalone TypeScript check. No test suite is included.
