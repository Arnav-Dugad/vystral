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
