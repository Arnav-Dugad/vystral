# Performance

## Budgets

| Target | Budget |
|---|---|
| Cached startup to interactive (primary machine) | ≤ 3 s |
| Process start → Home on screen from the first-paint snapshot (v0.7) | < 1 s |
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

**During a game,** Performance Mode additionally hides the WebView2 controller and calls `TrySuspendAsync()`. Controller polling, metadata enrichment and AI stop. When tracking is enabled, one read-only sample (CPU and RAM from two kernel32 calls, GPU load and VRAM from kernel graphics statistics, plus NVML temperature, graphics clock and clock-event/throttle reasons) is taken every 2 s. It costs about 0.06% of one core; see [GPU readings](#gpu-readings-v05).

### Data insights during a session (v0.3)

Everything piggybacks on the existing 2 s sampling loop; nothing new wakes up on its own.

| Work | When | Cost |
|---|---|---|
| GPU name and driver version | Once, when the session starts | Two NVML string calls (NVIDIA) or a handful of registry reads in the display-adapter class key |
| Background-app snapshot | Every 15th tick (~30 s), first one at session start as the CPU baseline | One `NtQuerySystemInformation(SystemProcessInformation)` call into a reused buffer (512 KB–1 MB, grown only if needed), a linear parse of ~300 entries, then per-name sums. No process handles are opened. Aggregates (≤ 48 names) are kept in memory and written with the existing 30 s flush (≤ 48 small rows replaced in one transaction) |
| Memory load | With each snapshot | One `GlobalMemoryStatusEx` call |
| Achievement check | After the session ends, not during it | Up to two Steam Web API refreshes for that one game (~5 s and ~60 s after it closes), skipped when another game starts |

The heatmap, achievement timeline, driver comparison and background-app report are all computed from SQLite when you open them (the achievement feed is paginated, 40 per page).

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

### Background tracker (opt-in, v0.4)

Measured 2026-10-05 on the reference machine (i7-13650HX, ~410 processes), Release build, the real `Vystral.exe --background-tracker --data-dir <scratch>` against a scratch data folder with 301 installed games. CPU from `TotalProcessorTime` deltas (15.6 ms accounting ticks, so short windows are rounded), memory from `PrivateMemorySize64` / `WorkingSet64`.

| Measurement | Result |
|---|---|
| Start-up (process start → watching) | ~0.6 s; 0.4–0.6 s of CPU once |
| **Idle CPU, waiting for a game** | **0.04–0.075% of one logical core** (406 ms over 540 s; 109 ms over 300 s after sessions) — under 0.005% of the whole 20-thread CPU |
| Idle memory | 19–25 MB private; working set 7–35 MB (trimmed after start and after each session) |
| Paused while VYSTRAL is open | waits on a mutex: no polling at all |
| During a game, performance recording off | 0.8% of one core (a full process snapshot every 2 s) |
| During a game, performance recording on | measured with the 0.4 sampler: dominated by its GPU counter reads; 58 MB private, back to ~20 MB after. Since 0.5 the sampler adds ~0.06% of one core (see [GPU readings](#gpu-readings-v05)) |
| App opens → app owns tracking | 13 ms (session parked and continued without a gap) |

What one look costs: a full `NtQuerySystemInformation(SystemProcessInformation)` snapshot is ~10 ms of CPU with ~410 processes (mostly kernel time copying thread records), so it runs only once a minute while idle; the other looks every 4 s (15 s on battery or energy saver) cost a few microseconds (the foreground window's process plus processes already matched, one `SystemProcessIdInformation` path query each). Matching a snapshot against 301 installed games takes ~0.2 ms (folder index, not a scan per game).

**Found while measuring:** the 0.4 performance sampler (`PerfSampler`, used for every recorded session, in the app too) cost ~11% of one core while a game ran, almost all of it reading Windows' *GPU Engine* performance counters. Fixed in 0.5 (next section).

### GPU readings (v0.5)

Every recorded session, in the app and in the background tracker (both go through `SessionService`'s recorder), takes one `PerfSampler` sample every 2 s. Until 0.4 its GPU part held one `System.Diagnostics.PerformanceCounter` per *GPU Engine* 3D instance and per *GPU Adapter Memory* instance (re-listed every 15 s), and every `NextValue()` re-read the whole counter category. Since 0.5 it reads kernel graphics statistics directly:

1. **Kernel statistics (`D3DKMTQueryStatistics`, gdi32), the default.** Adapters are listed once (`D3DKMTEnumAdapters2`, node metadata, adapter type; handles closed straight away). Each sample is then one call per 3D engine (running time, 100 ns units) and one per dedicated memory segment (bytes resident), addressed by adapter LUID: no handles, no process opened, no admin, ~1 KB allocated. Utilisation = growth of the engine's running time ÷ wall-clock time since the previous sample. This is the data the *GPU Engine* counters are computed from.
2. **PDH, the fallback** (e.g. if gdi32's statistics aren't available): one PDH query with `\GPU Engine(*)\Utilization Percentage` and `\GPU Adapter Memory(*)\Dedicated Usage` added once as wildcards; each sample is one `PdhCollectQueryData` plus `PdhGetFormattedCounterArray`.
3. Neither works: GPU load and VRAM are left empty, as before when the counters were unavailable. A method that throws or stops answering hands over to the next one; nothing reaches the session loop.

Measured 2026-10-06 on the reference machine (i7-13650HX, RTX 4060 Laptop GPU + Intel iGPU, hybrid; ~400 processes, 181 *GPU Engine* 3D instances out of ~580) with a WebGL load running on the RTX at ~30% 3D and the desktop on the iGPU at ~10%. Release build of a console harness that calls the same classes on a 2 s cadence for 60 s; CPU from `QueryThreadCycleTime` on the sampling thread (TSC ~2.78 GHz) and, as a cross-check, `TotalProcessorTime` of the whole process (15.6 ms ticks, includes JIT and GC).

| GPU part of one sample | CPU per sample | % of one core at 2 s | Allocated per sample |
|---|---|---|---|
| 0.4: one `PerformanceCounter` per instance | 131–161 ms (process: 126–164 ms) | **6.1–7.5%** (Track H saw ~11% with a real game's process count) | ~28 MB |
| 0.5: kernel statistics (default) | ~1.1 ms | **0.055%** (process: 0.2%) | ~1 KB |
| 0.5: PDH wildcard query (fallback) | ~0.9–1.2 ms | 0.05–0.06% (process: 0.26–0.4%) | ~130 KB |
| Whole 0.5 `Sample()` + NVML clock/throttle | ~1.2 ms | **0.06%** | ~1.4 KB |

Where the time goes (tight loop of 5,000–20,000 calls): the RTX's 3D-engine running-time query is ~0.46 ms (the NVIDIA driver answers it), the Intel one ~0.02–0.03 ms, a memory-segment query 0.4 µs, listing adapters ~25 µs (once per session, or when an adapter disappears), `GetSystemTimes` + `GlobalMemoryStatusEx` + NVML temperature together well under 0.1 ms, NVML clock + throttle reasons ~3 µs. For comparison, a separate backend audit on the same PC measured one `PerformanceCounterCategory("GPU Engine").ReadCategory()` at ~5.6 ms and 437 KB, and the 0.4 sampler at 87–125 ms and ~23.7 MB per sample: it did the equivalent of a category read for each of ~180 counters.

Robustness, from the same harness: 50,000 back-to-back samples kept the handle count flat (253–259) and private bytes flat (~34 MB; managed heap 0.27 MB after a collection). 10,000 PDH reads and 200 PDH create/dispose cycles likewise left handles flat.

**Accuracy:** per adapter, the kernel-statistics value matched the PDH *GPU Engine* counters within 0.5 points on every 2 s sample (e.g. RTX 29.1% vs 29.0%, iGPU 8.2% vs 8.3%) and dedicated memory matched *GPU Adapter Memory* to the MB. What changed is *which* number is stored; see KNOWN-LIMITATIONS (Performance data).

**Not chosen:** NVML's `nvmlDeviceGetUtilizationRates` (NVIDIA only, and it measures "any kernel running" over a driver-chosen window, so it reads higher than 3D load: 37–40% vs 30% here) — it would save ~0.45 ms per 2 s on NVIDIA, not worth a different meaning per vendor. DXGI `QueryVideoMemoryInfo` reports only the calling process's own video memory, not the game's or the adapter's.

### Startup (v0.7)

Goal: Home on screen in under a second, from a cached snapshot, then updated live.

**What changed**

- **Cached first paint.** The interface saves a compact Home view-model (hero, the games on each shelf with their already-cached cover URLs, the Library radar numbers, the theme; ~25–70 KB, at most 120 games, no notes or paths) a few seconds after the library changes and when the window is hidden. The host keeps it in `ui-state/first-paint.json`, stamped with VYSTRAL's version, and hands it to the page with a document-created script before any page script runs. Home renders from it at once and reconciles with the live library: the same component tree and keys, so cards keep their DOM nodes (Playwright checks every card survives). A missing, corrupt, oversized, older-than-45-days or other-version file is ignored and the live path runs as before; it is never used in safe mode, before onboarding, in an Immersive start or after a database reset, and it is removed after the first navigation so a renderer-crash reload takes the live path.
- **Backend in parallel with WinUI.** The backend (database open and migrate, session recovery, settings, services, bridge handlers) is built on its own thread started right after `StartupProtection`, while WinUI loads `XamlControlsResources` and creates the window, instead of afterwards on the UI thread. The WebView2 environment is created first thing in the window's constructor. Single instance, rollback and tracker mode are untouched (all of that happens before, in `Program.Main`); `app.ready` + 20 s is still the success rule and is still sent only after the *live* library.
- **First frame.** `boot.js` (a 1 KB blocking script in `<head>`) puts the snapshot's theme on `<html>` before anything is drawn, the inline background follows it, and the native window colour follows the saved theme, so a light theme never flashes dark. The Latin Geist, Geist Mono and Unbounded faces are preloaded. Home draws the hero and the first shelf on the first frame and the rows below the fold in a deferred render right after.
- **Lazy loading.** three.js (736 KB) was already loaded only by Constellation; a Playwright test now guards that startup requests no three.js or Constellation chunk. The game page's Achievements and Controls panels moved out of the startup bundle (−22 KB JS, −10 KB CSS); the new startup code adds ~7 KB, so the entry chunk is about the same size (717 → 724 KB).

**Measured 2026-10-07** on the reference machine (i7-13650HX, Windows 11). The machine was busy with other builds during the runs (CPU 55–100%), so medians over interleaved runs are given with the best run; read differences, not absolute values. The real app was **not** run: it is single-instance and uses the real data folder.

1. *WebView2 harness*: a WinForms program that hosts the real built UI exactly as `MainWindow` does (same virtual-host mapping and settings, scratch user-data folder, warm). `library.get` goes through VYSTRAL's real `BridgeDispatcher` and `LibraryRepository.LoadSnapshot` over a synthetic 300-game database, cold in each process; other bridge calls are answered instantly. 9 interleaved runs per build; ms since process start:

| Mark | Before (0.6.0 UI) | After, live | After, cached first paint |
|---|---|---|---|
| WebView2 environment ready | 180 | 176 | 176 |
| WebView2 controller ready | 419 | 421 | 421 |
| Navigation → DOMContentLoaded (bundle parsed) | 524 | 538 | 527 |
| Shell in the DOM | 539 | 554 | 579 |
| `library.get` request → reply (cold, 300 games) | 611 → 814 | 583 → 769 | 600 → 811 |
| **Home content in the DOM** | **905** (best 750) | **805** (best 683) | **579** (best 483) |
| Live Home reconciled / `app.ready` | 907 | 806 | 837 |

So Home appears ~325 ms earlier (median) and no longer waits for `app.info` and `library.get`; the live update lands ~250 ms later, keeping every card.

2. *Database parts of startup* (same synthetic library, console harness, first call in a fresh process / warm): open + migrate check 6 / 3 ms, session recovery 8 / 0.3 ms, settings 9 / 0.1 ms, `LoadSnapshot` 92 / 21 ms, JSON serialization of the 283 KB reply 54 / 5 ms. With 2,000 games: `LoadSnapshot` 92–177 ms, 1.9 MB of JSON. The cold library path is what the cached first paint takes off the critical path.
3. *WebView2 alone*: creating the environment returns in ~10–40 ms; the controller (browser and renderer processes) takes ~200–250 ms. Starting the environment earlier only overlapped ~20 ms in an experiment with 300 ms of blocking work on the UI thread, because the controller needs the window; the bigger overlap comes from building the backend during WinUI's own start (not measurable without the real app; the new timeline below logs it).
4. *UI only, Playwright* (Chromium, `vite preview` of the production build, preview backend, warm cache): Home in the DOM ~200 ms after navigation live vs ~90–170 ms from the cached snapshot; with `?slowLibrary=2500` the cached Home is up within ~60–100 ms and survives reconciliation unchanged.

**Startup timeline in the log.** Every start writes one `Startup timings (ms since the process started)` line to `logs\vystral-*.log` (local only, no telemetry): `appMain`, `protectionDone`, `backendStart`/`backendReady` (backend thread), `xamlStart`, `xamlReady`, `windowCreate`, `webviewEnvStart`/`webviewEnvReady`, `backendWait`/`backendWaitDone` (how long the UI thread still waited), `webviewReady`, `firstPaintInjected`, `navigationStart`, `domContentLoaded`, `navigationCompleted`, `appReady`, and the interface's own marks converted to the same clock: `ui:script`, `ui:firstPaint` (cached Home painted), `ui:liveHome`, `ui:ready`, `ui:fcp`. `call('diagnostics.startup')` returns the same. Use it for the real-app before/after on the reference machine.

### After-update self-check and compaction (v0.7)

- *Self-check*: runs 2 s after `app.ready` on the first start of a version; the integrity check (`PRAGMA quick_check`) and the bridge round trip run side by side. On the synthetic 300-game database `quick_check` takes 1–4 ms; the whole check normally finishes well under a second. Timeouts (20 s integrity, 30 s round trip) give *skipped*, never *failed*.
- *Compaction*: a 15-minute timer (first after 10 minutes) evaluates the schedule with three cheap calls (`GetSystemPowerStatus`, `GetLastInputInfo`, free space). In the test suite a ~3 MB file whose rows were deleted compacts to under a quarter of its size.

## Not yet measured

- Real-app startup before/after on the reference machine (timeline above; the harness numbers stand in for it).

- Frame pacing of the Living Canvas on weak iGPUs (the "auto" quality setting lowers to "low" on ≤4-core CPUs).
- Startup with 5,000+ real games: tested with preview data only.
- GPU memory of the WebView2 GPU process (WebGL plus compositor).

## Reproducing

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333"
.\artifacts\publish\Vystral.exe
cd ui; node scripts/cdp-shot.mjs out.png "performance.getEntriesByType('paint')"
```
