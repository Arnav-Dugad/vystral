# Testing strategy

| Layer | Tool | What it covers | Command |
|---|---|---|---|
| Core & services | xunit v3 (`tests/Vystral.Tests`) | VDF parsing, title normalization, duplicate matching, SQLite migrations and repository (scan reconciliation, merge/unmerge, sessions, recovery), launch validation, bridge dispatcher hardening, settings validation, metadata parsing, AI output validation, artwork safety, perf summaries, media path-traversal protection | `dotnet test tests/Vystral.Tests` |
| Store adapters | xunit + `TempDir` fixtures + `FakeRegistry` | Steam (both `libraryfolders.vdf` formats, StateFlags, duplicate playtime keys, hashed artwork folders), Epic (DLC and plugin filters, stale paths), Xbox (`.GamingRoot` bytes, `MicrosoftGame.config`, AUMIDs), GOG, EA (UTF-16 XML, Steam-library exclusion), Ubisoft (stale keys), Battle.net (product codes) | same |
| UI logic | Vitest | Natural-language query parser, title scoring, 10k-game search timing, OKLab conversions, **WCAG contrast guarantee for artwork accents**, palette determinism, recommendations, formatting, journal statistics, performance series, constellation layout, assistant text parsing | `cd ui; npm test` |
| End to end | Playwright (Chromium = WebView2's engine) on the preview backend | Navigation, history, command bar interpretation, launch overlay phases, library filters, 5,000-game virtualization, list view, game details and versions, theme and reduced-motion settings, update progress viewer, onboarding, Immersive keyboard navigation, startup intro and skip, exact return (scroll and focus), Immersive focus ring and game panel, notification centre, Storage Studio | `cd ui; npm run e2e` |
| Accessibility | `@axe-core/playwright` | Home, Library, Settings, Journal, Performance, Moments, Constellation, Assistant, Storage: no serious or critical violations (sampled after animations settle) | part of `npm run e2e` |
| Visual regression | Playwright `toHaveScreenshot` (reduced motion, Living Canvas masked) | Home, Library, Settings | part of `npm run e2e`; update with `npx playwright test -u` |
| Controller | Playwright with simulated controller events (preview backend records haptics) | On-screen keyboard navigation and predictions, hold-to-confirm, haptic patterns requested | part of `npm run e2e` |
| Real app | Manual + CDP scripts | Real store discovery on the dev PC, real WebView2 rendering, Performance Mode CPU, startup timing, intro, Immersive, trailers, Storage Studio, notifications | `ui/scripts/cdp-shot.mjs` and `ui/scripts/real-*.mjs` (see PERFORMANCE.md) |
| CI | GitHub Actions `ci.yml` | All of the above except the real-app checks, on every push | — |

## Scenario coverage

| Scenario | Covered by |
|---|---|
| Fresh install / first launch | Onboarding e2e; `Database.Migrate` on a new file |
| Empty library | `?empty` preview; Home/Library empty states |
| Very large library | 5,000-game e2e; 10,000-game search unit test; 10k-session journal test |
| Steam-only / Epic-only / Xbox-only / multiple stores | Adapter fixture tests; real Steam + EA + Ubisoft on the dev PC |
| Duplicate detection | `DuplicateMatcher` and `ApplyScan` merge tests; duplicates dialog |
| Multiple drives | Drive filters in the search tests; Steam multi-library fixtures |
| Missing installations | Repository "missing, not deleted" tests; launch-failure messages |
| Unavailable platform client | `SessionService` client check; adapter `NotInstalled` status |
| Launch failures | `LaunchValidator` tests; failed overlay state |
| Interrupted scans / adapter failure | Failed `AdapterScanResult` changes nothing (repository test); per-adapter timeouts |
| No internet / corrupt metadata | Metadata parser tests with malformed JSON; enrichment stops quietly |
| Missing artwork | Generated covers (all preview games have no art) |
| Restart / crash recovery | `RecoverOpenSessions` test; crash marker → toast |
| DB migration failure | Fallback path in `AppBackend` (keeps old file, starts fresh) |
| Reduced motion / keyboard-only | Settings e2e; Immersive keyboard e2e; axe |
| AI unavailable | Assistant states; `ai.status` problem message |
| Sleep/resume, DPI change, monitor change, controller disconnect | **Not yet tested.** Handled in code (window placement validates the monitor; controller add/remove events; session tracking is wall-clock based) but no automated or manual pass has been recorded |

Destructive or disruptive operations are only tested against fixtures and temporary databases. Tests never launch real games or modify real store data.
