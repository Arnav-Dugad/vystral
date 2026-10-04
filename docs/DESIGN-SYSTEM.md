# VYSTRAL design system

The source of truth is code: `ui/src/styles/tokens.css` (tokens), `ui/src/lib/motion.ts` (motion), `ui/src/components/ui/*` (components). This document explains the intent.

## Identity

- **Mark.** Two blades, electric violet and cool blue, converge into a V, with a four-point star in its mouth: two worlds (your stores) meeting at one point of light. It sits on an obsidian squircle tile. Source: `assets/brand/vystral-mark.svg`; render sizes with `npm run brand`.
- **Wordmark.** Unbounded 600, uppercase, tracking 0.32em (0.6em on the splash).
- **Voice.** Calm, precise, honest. It never blames the user, never overclaims ("Waiting for the game window…", not "Launched!"), and always labels where a number comes from (tracked by VYSTRAL vs reported by the store).

## Colour

All colours are OKLCH so that accent shifts between games interpolate perceptually.

| Token | Obsidian (flagship) | Use |
|---|---|---|
| `--bg-0` | `oklch(0.13 0.012 282)` | Window |
| `--bg-1…3` | 0.165 / 0.2 / 0.245 L | Panels, raised, inputs/hover |
| `--text-1/2/3` | 0.97 / 0.82 / 0.68 L | Primary / secondary / tertiary text (all ≥4.5:1 on `--bg-1`) |
| `--violet`, `--blue` | `oklch(0.7 0.17 292)`, `oklch(0.68 0.15 255)` | Brand |
| `--accent` = `--game` | animated | Derived from artwork by the Living Canvas, or a fixed choice in Settings |
| `--ok` `--warn` `--danger` `--info` | | Status, always paired with an icon or label |

Themes: **Obsidian**, **OLED black** (true black, fewer translucent layers), **Light**, **High contrast** (no translucency, 3px yellow focus ring, maximum text contrast).

**Artwork-derived accents** (`lib/color.ts`):
1. Downsample to 64×64 in a worker.
2. Run deterministic k-means in OKLab, centre-weighted, discounting near-black, near-white and grey.
3. Score clusters by √population × chroma.
4. Cap chroma at 0.18 and blend 60% toward brand violet, so it always feels like VYSTRAL.
5. Raise lightness until contrast against the dark surface is ≥4.5:1. Unit tests enforce this for saturated, white, black and multi-colour art.

## Type

| Role | Font | Notes |
|---|---|---|
| UI | Geist Variable | Body weight 450 (light-on-dark text looks thin at 400) |
| Numbers | Geist Mono Variable (`.num`) | Tabular figures |
| Display | Unbounded Variable | Hero titles, onboarding, generated covers |

Scale: 11 / 12 / 13 / **14 body** / 16 / 20 / 26 / 34 / 48, plus a fluid hero size. Immersive Mode rescales the root to 18–26px for 10-foot viewing. All fonts are bundled locally (OFL); nothing is fetched at runtime.

## Space, shape, elevation

- **Space:** 4px grid (`--s-1`…`--s-16`); fluid page gutter `clamp(20px, 3vw, 44px)`.
- **Radii:** 6 / 9 / 12 / 16 / 22 / 30 / pill. Cards 16, dialogs 30.
- **Elevation:** `--shadow-1…3` plus `--shadow-glow` (the accent ring). Focus and hover glows are pre-rendered on pseudo-elements and faded with opacity; box-shadow is never animated.
- **Glass:** `.glass` = 62% surface + 22px blur. Limited to a few small surfaces (blur is the most expensive effect). "Low" quality removes all blur.

## Motion

| Token | Spring | Use |
|---|---|---|
| `micro` | stiffness 1400, damping 67 | Press/hover feedback (~120ms) |
| `focus` | visualDuration 0.22, bounce 0.12 | Focus ring, nav pill, tabs |
| `panel` | 0.32, bounce 0.06 | Menus, dialogs, toasts |
| `page` | stiffness 380, damping 31 | Route changes (~440ms) |
| `hero` | 0.5, bounce 0.15 | Shared-element/hero entrances |
| `effect` | stiffness 1600, damping 80 | Opacity/colour, never bounces |

Exits are shorter and use an accelerate curve. Springs retarget mid-flight, so rapid input never queues animations. Only `transform`, `opacity` and `filter` are animated. **Reduced motion** (system or app setting) swaps every spatial animation for a 150ms fade, freezes the Living Canvas on one frame, removes tilt and parallax, and swaps the cinematic launch for a compact status pill. **Performance Mode** pauses every animation.

Signature moments:
- **Startup:** about 1.2s; the blades slide in, the star ignites and the wordmark tightens. Skippable, once per launch, and off under reduced motion.
- **Launch:** hero art expands with a slow Ken Burns drift, an accent flood, and a status line driven by real native phases.
- **Return:** a session summary toast.

## Living Canvas

One WebGL2 fragment shader (`components/shell/LivingCanvas.tsx`):
- Rendered at 40–55% resolution and capped at 30fps.
- Base layer: a domain-warped gradient of four artwork colours, dithered against banding.
- Mood overlays chosen from genre: *velocity* (light trails), *cosmos* (parallax stars), *ember* (rising motes), *dread* (fog, slower and darker), *tide* (calm bands), *drift* (base only).
- Changing game crossfades both palette and mood over 1.2s from wherever the previous blend was.
- Stops on `visibilitychange`, while a game runs, and in low quality; CSS gradient fallback without WebGL.

## Components

`Button` (primary / secondary / ghost / danger; sm / md / lg / xl; loading), `IconButton` (always labelled), `Toggle` (role=switch), `Segmented` (radiogroup, arrow keys), `Tabs` (tablist, arrow keys, animated indicator), `Slider`, `Dialog` (focus moves in, Tab trapped, Escape/B closes, focus restored), `Menu` (arrow keys, Escape, ContextMenu key or Shift+F10), `Toaster` (polite/alert live region), `ProgressBar` (aria values), `Skeleton`, `EmptyState`, `Badge`, `PlatformBadge` (colour dot plus name, never colour alone), `Stars`, `Field`, `Kbd`, `PadGlyph`, `GameCover` (artwork or original generated cover), `GameCard` (tilt + glow + context menu), `Shelf`.

## Accessibility rules (WCAG 2.2 AA intent)

- Every interactive element is a real `button`/`input` with a name, and every icon-only control has `aria-label` and a tooltip.
- Focus is always visible (`--focus-ring`); controllers move focus geometrically; dialogs and menus capture focus and always release it.
- Status never relies on colour alone; text pairs are contrast-checked; hit targets are ≥30px (≥48px in Immersive).
- Text scales with the root size; layouts reflow down to 960×600.
- Automated `axe` checks run on the main pages in CI (no serious or critical violations allowed).
