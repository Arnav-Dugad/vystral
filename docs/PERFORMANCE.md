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

**During a game,** Performance Mode additionally hides the WebView2 controller and calls `TrySuspendAsync()`. Controller polling, metadata enrichment and AI stop. When tracking is enabled, one read-only sample (performance counters plus NVML temperature, graphics clock and clock-event/throttle reasons) is taken every 2 s.

### Launch pre-flight

When a launch starts, five read-only checks run in parallel on the thread pool with a 300 ms total budget (disk space, Steam manifest update state, controllers, display refresh/HDR, other store apps' memory). Any check that throws or doesn't finish in time is dropped; the launch never waits for them.

### Frame-rate capture (opt-in)

With *Frame-rate capture* on, VYSTRAL runs the verified PresentMon 2.6.0 console exe as a below-normal-priority child process for the game's PID:

```
PresentMon-2.6.0-x64.exe --process_id <pid> --output_stdout --no_console_stats --no_track_input
                         --session_name VYSTRAL_FrameCapture --stop_existing_session --terminate_on_proc_exit
```

Its CSV is parsed as a stream: memory is fixed regardless of session length (a 0.1 ms histogram up to 250 ms, sums, a 32-frame ring for stutters, and at most 20,000 frames per 2-second window). At the end of a session the ETW session is closed with `--terminate_existing_session` before anything is killed. Reported figures:

| Figure | Definition |
|---|---|
| Average FPS | frames ÷ total frame time |
| 1% / 0.1% low | average frame rate of the slowest 1% / 0.1% of frames |
| Frame time p50 / p99 | nearest-rank percentile of time between presents (±0.05 ms) |
| Stutter | a frame > 2× the average of the previous 32 frames *and* ≥ 8 ms longer |

PresentMon's own overhead (an ETW consumer) has not been measured on the reference machine yet.

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
