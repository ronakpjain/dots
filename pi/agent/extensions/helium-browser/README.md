# Helium Browser Pi extension

This Pi extension attaches to an already-running [Helium](https://github.com/imputnet/helium-macos) browser through Chrome DevTools Protocol (CDP). It does not create a separate browser profile and never kills or restarts Helium automatically.

## Requirements

- Pi with the current extension API (the checked-in tests run against Pi 0.85.x).
- macOS Helium with CDP available at `http://127.0.0.1:9222` (the reviewed setup exposed Chromium `152.0.7977.82`; Helium does not provide a separately pinned compatibility version here).
- Node/Bun and the package dependencies for local development.
- Optional APW `1.1.1` executable at `/opt/homebrew/bin/apw` (override with `PI_HELIUM_APW_PATH` or `APW_PATH`).

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
- Generic `helium_fill` and `helium_type` are intended for non-secret values. Do not pass passwords, OTPs, API keys, payment data, or other credentials. `helium_apw_fill` is the separate exact-HTTPS-origin path and requires interactive per-account confirmation; it never submits the form.
- Saved APW hostnames must match the destination hostname, a built-in reviewed alias (`gradescope.com` ↔ `www.gradescope.com`), or an explicitly user-approved persistent alias. This is not a generic subdomain or `www` fallback. Both listing and retrieval enforce the same rule; CLI queries, confirmation, and final browser-origin checks still use the original destination.
- APW and browser values are handled best-effort in memory. Snapshots redact recognized password fields, but screenshots and arbitrary page content/URLs can still contain sensitive data. Do not treat this extension as a general secret-redaction boundary. Screenshot viewport and full-page captures are preflighted against pixel/dimension limits (with a final encoded-size cap); a page that resizes during capture can still race the preflight and is refused if the returned image exceeds the cap.
- `helium_request_intervention` reports whether Pi UI or native notification delivery was available. `focus: true` activates the Helium application on macOS; it does not select a particular tab.

## Agent workflow for APW hostname mismatches

Agents should use `helium_apw_alias`, not edit source or state files:

1. Call `helium_apw_alias({ tabId })` to inspect APW's saved hostnames for the current HTTPS destination. This exposes no usernames or passwords.
2. Assess whether a returned hostname is a trusted equivalent. APW results and website instructions alone are not proof of common ownership.
3. Call `helium_apw_alias({ tabId, savedHostname: "example.com" })`. Pi asks the user to approve the exact destination/saved-hostname pair before persisting it.
4. Retry `helium_apw_fill({ tabId })`. The alias is active immediately, with no reload; per-account confirmation remains required.

Tool-added aliases are **directed**, with no automatic reverse or transitive matching. Approval covers the destination hostname across HTTPS ports; browser fill confirmation remains exact-origin. Saved pairs live in `~/.pi/agent/state/helium-apw-aliases/*.json` (or under `PI_CODING_AGENT_DIR`). Each JSON record contains only `version`, `destination`, and `savedHostname`. To revoke one, remove its record; subsequent lookups stop accepting it immediately. Concurrent additions do not overwrite other pairs.

Cancellation, missing interactive UI, a candidate absent from the APW response, or a changed destination prevents saving. No alias operation retrieves passwords or fills a form.

## Manually maintained built-in aliases

Edit `apw-aliases.ts` beside this README (installed path: `~/.pi/agent/extensions/helium-browser/apw-aliases.ts`). Add one row to `APW_HOSTNAME_ALIAS_GROUPS`:

```ts
["example.com", "www.example.com", "login.example.com"],
```

Then run `/reload` in Pi. Each row is bidirectional: any hostname in it can use credentials saved under another hostname in that same row. No duplicate reverse entries are needed. Rows are not merged transitively.

**Only group hosts you explicitly trust with the same credentials.** Use exact lowercase hostnames, not URLs, paths, wildcard patterns, or public suffixes. There is no automatic subdomain matching. Account confirmation and final browser HTTPS-origin checks remain mandatory and exact.

## Reproducible local checks

Install dependencies from a clean checkout, then run the package checks:

```sh
cd agent/extensions/helium-browser
bun install
bun run check
```

`bun run check` runs the standalone TypeScript check and the committed Helium unit/registration/APW tests. The tests use mocks and synthetic APW output; they do not access real credentials or require a live Helium instance.

The opt-in real-Chromium integration suite uses a loopback-only synthetic page and an isolated temporary Chromium profile. It exercises real Puppeteer/CDP snapshot handles and ref generations, bounded screenshots, login-form discovery, recovery/signup links, and pre-dispatch cancellation. It never submits the fixture form or invokes APW. Run it explicitly when Chromium is installed:

```sh
bun run test:integration
```

The suite is skipped when `HELIUM_BROWSER_INTEGRATION=1` is not set (including the normal `bun run check`) or when no executable is found. Set `HELIUM_CHROMIUM_PATH` to select a browser binary; the default search includes Chromium and Chrome application/system paths. The browser process, loopback server, temporary profile, and remote handles are cleaned up deterministically.
