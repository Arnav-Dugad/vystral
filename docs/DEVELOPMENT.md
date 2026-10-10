# Development

## Prerequisites

- Windows 10 21H2+ / Windows 11, x64
- .NET SDK 10.0.x (no Visual Studio needed: WinUI 3 builds with the `dotnet` CLI)
- Node.js 24+
- WebView2 runtime (built into Windows 11)

## Repository layout

```
src/Vystral.Core      domain, VDF parser, matching, SQLite repository   (net10.0)
src/Vystral.Windows   adapters, launch engine, services, bridge         (net10.0-windows)
src/Vystral.App       WinUI 3 shell + WebView2 host                     (self-contained exe)
tests/Vystral.Tests   xunit v3 tests (fixtures, fake registry)
ui/                   React + TypeScript + Vite interface
  src/bridge          typed bridge client, types, preview backend
  src/state           zustand store and actions
  src/lib             search, colour science, motion, spatial nav, input, sound
  src/components      design-system primitives, shell, game components
  src/views           pages
  e2e/                Playwright end-to-end, accessibility and visual tests
build/pack.ps1        release build (UI → publish → Velopack)
docs/                 documentation
```

## Everyday commands

```powershell
# UI with sample data in a browser (hot reload). A "Preview · sample data" badge marks it.
cd ui; npm run dev            # http://localhost:5173  (?games=5000 for a big library, ?empty, ?onboarding, ?reduced)
                              # Track AA: ?firstpaint (start from the saved Home snapshot), ?slowLibrary=1500,
                              # ?selfCheckFail, ?selfCheckNone, ?compactBusy
                              # Track C2: ?caption=220 (caption-button width), ?startupSlow, ?startupNone, ?noRig

# Full app
cd ui; npm run build; cd ..
dotnet build src/Vystral.App
src\Vystral.App\bin\x64\Debug\net10.0-windows10.0.22621.0\win-x64\Vystral.exe

# Tests
dotnet test tests/Vystral.Tests
cd ui; npm test; npm run e2e
```

Debug builds keep WebView2 dev tools enabled (F12). To drive the real app from scripts, start it with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` and use `ui/scripts/cdp-shot.mjs`.

## Conventions

- C#: nullable enabled; small classes; comments explain *why* (security constraints, platform quirks), not *what*. Adapters are read-only and catch only IO/format/access exceptions.
- TypeScript: strict mode; no `any` in new code; pure logic lives in `lib/` with Vitest tests; components use design tokens only, with no hard-coded colours.
- Every bridge method is mirrored in `ui/src/bridge/types.ts` and the preview backend.
- User-facing copy: precise, calm, never blames the user, and always says where a number comes from.

## Data during development

The app stores everything in `%LOCALAPPDATA%\VYSTRAL.Data`. Delete that folder for a clean first run (onboarding appears again). Hold **Shift** while starting for safe mode.
