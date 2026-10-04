# Performance

## Budgets

| Target | Budget |
|---|---|
| Cached startup to interactive (primary machine) | ≤ 3 s |
| Ordinary interactions (app processing) | < 100 ms |
| Interface animation | 60 fps baseline; Living Canvas capped at 30 fps at reduced resolution |
| Libraries | thousands of games without jank (virtualized lists, worker palette extraction) |
| Minimized / during gameplay | near-zero CPU and GPU |
| AI during gameplay | none (refused while a game is running) |

## Measured (v0.1.0, 2026-10-04)

Machine: ASUS ROG Strix G16 (i7-13650HX, RTX 4060 Laptop, 16 GB), Windows 11, 1920×1200. Release build (self-contained), real library (2 Steam games), Obsidian theme, Living Canvas on.

| Measurement | Result | How |
|---|---|---|
| Process start → WebView2 debugging endpoint up | 0.86 s | Stopwatch around `Start-Process` |
| Navigation → first paint / first contentful paint | 180 ms / 264 ms | `performance.getEntriesByType('paint')` |
| Navigation → DOMContentLoaded | 169 ms | Navigation Timing |
| Approx. start → library visible | ~1.1–1.3 s | sum of the above, plus a ~200 ms library query |
| CPU, foreground idle (Living Canvas animating) | 0.51% of all logical cores | `TotalProcessorTime` delta over 10 s, VYSTRAL and its WebView2 processes |
| **CPU, minimized** | **0 ms over 15 s (0.000%)** | same, after minimizing (WebView hidden → page hidden → canvas stops) |
| Memory, foreground (7 processes incl. WebView2 GPU/renderer) | 417 MB private | `PrivateMemorySize64` sum |
| Memory, minimized | 323 MB private | same |
| UI JS heap | ~4 MB | `performance.memory` |
| Search over 10,000 games | < 250 ms (unit-test bound; typically ~20 ms) | `search.test.ts` |
| Library at 5,000 games | ~40–60 cards mounted; filter applies in < 3 s end-to-end (typically < 300 ms) | Playwright `virtualizes very large libraries` |
| Install size | 238 MB uncompressed (self-contained .NET 10 + Windows App SDK) | `artifacts/publish` |

**During a game,** Performance Mode additionally hides the WebView2 controller and calls `TrySuspendAsync()`. Controller polling, metadata enrichment and AI stop. When tracking is enabled, one read-only sample (performance counters plus NVML temperature) is taken every 2 s.

## Not yet measured

- Frame pacing of the Living Canvas on weak iGPUs (the "auto" quality setting lowers to "low" on ≤4-core CPUs).
- Startup with 5,000+ real games: tested with preview data only.
- GPU memory of the WebView2 GPU process (WebGL plus compositor).

## Reproducing

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333"
.\artifacts\publish\Vystral.exe
cd ui; node scripts/cdp-shot.mjs out.png "performance.getEntriesByType('paint')"
```
