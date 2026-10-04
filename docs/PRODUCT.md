# Product requirements

**Product:** VYSTRAL, "Your Universe of Play". A universal, local-first game library and launcher for Windows 11.

**Audience:** PC gamers with libraries spread across several stores who want one beautiful, trustworthy place to browse and launch, with keyboard, mouse or controller.

## Principles (in priority order)

1. Exceptional user experience.
2. Original, refined visual quality.
3. Purposeful, interruptible, accessible motion.
4. Reliable, authorized game launching.
5. Absolute respect for game integrity, accounts and hardware.
6. Resource efficiency: never cost a game performance.
7. Privacy and local-first operation.
8. No subscriptions, paid APIs or required accounts.
9. Modular, maintainable architecture.
10. Rigorous testing and honest capability reporting.

## Non-negotiable acceptance criteria

| # | Criterion | Status in v0.1.0 |
|---|---|---|
| 1 | Launches as a real Windows desktop app | ✅ WinUI 3 + WebView2, self-contained exe |
| 2 | Core features work offline | ✅ Library, search, settings, history and launching are all local; Offline mode switch |
| 3 | Integrations import genuine data | ✅ Steam verified on real data; other adapters verified with realistic fixtures (see Known limitations) |
| 4 | Authorized, reliable launching | ✅ Store protocols, packaged activation, direct exe; validated; process-confirmed |
| 5 | No executable modification, DRM or anti-cheat interference | ✅ By design; see threat model |
| 6 | No unsafe hardware changes | ✅ Read-only counters and NVML temperature only |
| 7 | Never asks for store passwords | ✅ |
| 8 | Basic functionality doesn't depend on AI | ✅ AI is optional and off by default |
| 9 | Clear feedback for unavailable features | ✅ Capability badges, limitation text, honest empty states |
| 10 | Graceful failure handling | ✅ Isolated adapters, timeouts, recovery paths, safe mode |
| 11 | No unnecessary CPU/GPU use during gameplay | ✅ Measured 0 ms CPU over 15 s while minimized; WebView suspended during games |
| 12 | Coherent original visual identity | ✅ Mark, palette, type, motion and Living Canvas |
| 13 | Smooth, interruptible, accessibility-aware animation | ✅ Spring tokens, reduced-motion mode |
| 14 | Keyboard and mouse workflows | ✅ e2e-tested |
| 15 | Controller navigation in full-screen | ✅ Immersive Mode + spatial navigation (keyboard path e2e-tested; physical controller tested manually is pending) |
| 16 | Automated tests executed and documented | ✅ See TESTING.md and PROGRESS.md |
| 17 | Windows build and install verified | See PROGRESS.md for the release verification record |
| 18 | No paid APIs, subscriptions or infrastructure costs | ✅ GitHub Releases + free public endpoints |

## Scope by phase

See [PROGRESS.md](PROGRESS.md) for what is complete, partial and planned.
