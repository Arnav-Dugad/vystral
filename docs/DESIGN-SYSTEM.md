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

Game page:
- **Morphing Play button** (`components/game/PlayButton.tsx`, states in `playState.ts`): one button that becomes Launching (learned progress arc) → Playing (live timer; click switches to the game, ■ stops tracking) → Installing/Updating (ring + soft fill from Steam's manifests) → Install / Install in store / Rescan. It reserves the width of the widest label it can show, keeps the same `<button>` (focus never drops; busy states are `aria-disabled`, not `disabled`), and announces state changes politely.
- **Last-session ghost** (`LastSessionGhost.tsx`, `lib/ghost.ts`): a faint replay of the last tracked session's FPS (else CPU, else GPU), ≤120 points (LTTB, gaps kept), monotone-smoothed so it never overshoots, revealed left to right over 2.5 s with a travelling head; static under reduced motion; hidden while the trailer shows; nothing at all without recorded samples.

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
- **Follows the trailer** (`canvas.followTrailer`, default on): while a hero trailer is visibly playing, a 32×18 copy of the frame is read ~3×/s (`lib/trailer/tint.ts`). Black fades, white flashes and flat cards are ignored; ambient colours are clamped dark and low-chroma (L 0.16–0.40, C ≤ 0.08); the accent is capped and re-checked for ≥4.5:1 contrast. A third palette layer eases toward it (time constant 1.4 s, never faster than 0.16 OKLab/s, so scene cuts can't strobe) at up to 80% weight, nudges `--game` at most every 2.6 s (half-way between artwork and trailer), and eases back over ~2 s when the trailer pauses, ends or leaves view. Off under reduced motion, low quality, safe mode, or with the Living Canvas off.

## Store logos

`StoreLogo` / `StoreLogos` (`components/ui/StoreLogo.tsx`, marks in `lib/storeMarks.ts`) are the only way a store is shown. Steam, Epic Games, GOG, EA, Ubisoft and Battle.net use their official marks (Simple Icons drawings, CC0; see THIRD-PARTY-NOTICES). There is no licensed Xbox/Microsoft Store mark, so Xbox is a neutral rounded-square **X monogram** — deliberately not the sphere — and games you added get a folder-plus glyph. Never invent or imitate a mark.

- **Colour:** `currentColor` by default. The store's hue (`--p-*`) appears only on hover/focus of the thing it labels, on pressed/selected states, or with `brand`; in Light it is darkened to keep 3:1; in High contrast and forced colours it is always the text colour.
- **Optical sizes:** drawn at 14, 16, 20 or 24 px (other sizes snap). Square-filling marks (Steam's disc, GOG's box, Ubisoft's swirl) get a small viewBox inset so they balance wide marks; halved at 14 px where detail matters more. Monogram strokes get heavier as they shrink.
- **Names:** a mark on its own is `role="img"` with the store name (and a `<title>` tooltip). Next to a written name it is decorative. `PlatformBadge` = decorative mark + name (name visually hidden but present when `compact`).
- **Where:** card meta lines and landscape tiles (marks only), hero/detail/versions/Storage legends and tooltips/Settings/onboarding (`PlatformBadge`), command bar results, Immersive meta, Library search chips, Now Playing, the launch status line, and the pre-flight Steam-update check.
- **Draw-on motion** (`motion` prop; kind chosen in `lib/logoMotion.ts`, CSS in `store-logo.css`): only where the mark sits in something interactive — Library store filters, Settings store cards, a game's version rows, the Library value store filter (cards opt in with `.logo-host`). On hover, focus or selection an ink copy of the mark draws itself in the store's hue over the monochrome mark: **draw** for stroked marks (Xbox monogram, added-by-you glyph: one dash per stroke via `pathLength="1"`), **trace** for simple filled marks (outline draws in 460 ms, fill fades in 280 ms after 180 ms), **sweep** for busy filled marks (Epic, GOG: a 520 ms left-to-right colour wipe, because a traced outline is noise at 14–20 px). It fades back to monochrome in 200 ms on blur; the dash resets only after the fade, so the next hover draws again. CSS transitions only (no JS, no layout); reduced motion makes it an instant colour change; never in High contrast or forced colours. Marks in running text and decorative card meta stay still.

## Live tiles

Home tiles (`components/game/LiveTile.tsx`, rules in `lib/liveTiles.ts`) play Steam's silent ~8 s micro-trailer over the cover while the tile is ≥50% on screen: muted, looped, crossfading in over 650 ms from a 1.02 scale. **Two at most**: a hovered/focused tile always gets a slot, what already plays keeps playing (no flicker), then the least recently played in reading order; after 24 s a tile hands over to one that's waiting and rests 40 s. Hover-out pauses. Nothing plays with the setting off, Data saver (incl. metered), Offline mode, reduced motion, Low quality, safe mode, a hidden window or a running game. Tiles without a loop (or without a turn) get a slow 14 s Ken Burns on the **hovered** tile only, so the page stays calm. Videos are unmounted after fading out, so idle Home holds no decoders.

**Director** (`lib/director.ts`, `lib/director.worker.ts`, `components/game/liveDirector.ts`): after a clip has played for 1.2 s, it is analysed once — one clip at a time, between idle moments, only while tiles may play at all. An offscreen `<video>` seeks through it ~6 times a second (at most 72 frames); 48×27 frames go to a worker, which scores every 2 s window: motion (mean luma change, hard cuts capped and penalised) 50%, colour 30%, contrast 20%, scaled down by the share of dull frames (black/fade, flat, or title-card/logo frames — sharp colourless edges on a plain background), minus a seam penalty when the last frame doesn't resemble the first. The best window (score ≥ 0.12) is stored natively against a hash of the clip's bytes (`liveTile.setLoop`); otherwise — clip under 2.75 s, nothing good enough, or analysis failed — the whole clip loops as before. The segment loops on the same single decoder: at its end the last frame is frozen on a canvas, the video jumps back, and the canvas dissolves (280 ms) into the restarted segment. Layers expose `data-director="segment|full|analysing"` and `data-loop-start/end`.

## Art packs

`components/artpacks/ArtPacksDialog.tsx` (opened from the Library header, Settings › Library & stores, or the art picker's **Apply this style to…**): style cards drawn in CSS (no real art), slot checkboxes that grey out what a style doesn't offer, a scope select with counts, *Replace my picks* (off), a live plan summary, an 8-game preview that shows the new art with the current art underneath (hover or *Compare with current art*), then a job panel with progress, ETA, Pause/Resume/Cancel and, when done, *Restore previous art*. The job runs natively and keeps going when the dialog closes; a toast reports the result with an undo action.

## Sound

`lib/sound.ts` (UI clicks) and `lib/ambient.ts` (ambient layer), all synthesized with Web Audio. Ambient sound (`sound.ambient`, off) needs interface sounds on and is silent while a game starts or runs, the window is hidden or another window has focus (the AudioContext is then suspended). Each Living Canvas mood has a voice: root, scale, waveform, low-pass, noise bed, synthesized reverb and density — Drift (A3 major pentatonic, open), Velocity (B3 minor pentatonic, brighter, busier), Cosmos (F3 lydian, long tails), Ember (G3 dorian, faint crackle), Dread (A2 semitone/tritone, dark, sparse, rumble), Tide (C4 major, surf noise). The bed walks the scale in small steps (deterministic per seed, ≥30% of the mood's spacing between notes, each note ≤0.09 gain). Focus moves are a short tone panned to where focus landed (−0.8…0.8) and pitched by height; selects are a soft fifth. Mood changes glide over ~2 s.

## Achievement shimmer

One light sweep (`components/ui/shimmer.css`, tiers in `lib/shimmer.ts`) across the unlock toast and each of its icons (staggered), timeline rows you haven't seen yet, and newly unlocked rows on the game page (with a "New" badge): **common** soft silver, **rare** (≤5%) gold, **ultra rare** (≤1%) prismatic and twice. "New" means unlocked after your last visit to that surface (first visit: the last day; never older than 14 days). Transform/opacity only; reduced motion and Performance Mode show a static tint; High contrast shows nothing extra.

## Library sort animation

`components/game/useFlipGrid.ts` + `lib/flip.ts`. When sort, filter or search changes the order, cards visible before **and** after glide (FLIP via the Web Animations API, transform only, 200–420 ms by distance, `cubic-bezier(0.2, 0.8, 0.2, 1)`); cards arriving from off screen or new ones fade in; cards leaving the screen fade out as cover-only ghosts (220 ms). Positions are computed from indices and grid geometry, never measured, so a 5,000-game re-sort plans only the visible slice. Resizes cross-fade; more than 80 movers fade only; reduced motion cross-fades the grid. The list view uses the same hook (rows keep their virtualizer transform).

## Empty-state illustrations

`EmptyState` draws a 168×120 procedural scene (`components/ui/EmptyArt.tsx`, geometry and palette in `lib/illustration.ts`) — constellation, layered hills, orbit rings, tide lines, a fanned shelf or a trophy wreath — with the state's icon in a tile at its centre. Tones come from the live accent (`--game`): chroma capped at 0.16, a hue-shifted mid tone, an ink tone pushed to ≥3:1 against the theme's panel; Light uses dark inks and pale fills; High contrast is flat white/yellow strokes. Twinkle/spin/drift stop under reduced motion, Low quality and Performance Mode. Errors use `art="none"` (the plain icon tile).

## Components

`Button` (primary / secondary / ghost / danger; sm / md / lg / xl; loading), `IconButton` (always labelled), `Toggle` (role=switch), `Segmented` (radiogroup, arrow keys), `Tabs` (tablist, arrow keys, animated indicator), `Slider`, `Dialog` (focus moves in, Tab trapped, Escape/B closes, focus restored), `Menu` (arrow keys, Escape, ContextMenu key or Shift+F10), `Toaster` (polite/alert live region), `ProgressBar` (aria values), `Skeleton`, `EmptyState` (illustrated; see above), `Badge`, `PlatformBadge` (store mark plus name, never colour alone), `StoreLogo`, `Stars`, `Field`, `Kbd`, `PadGlyph`, `GameCover` (artwork or original generated cover), `GameCard` (tilt + glow + context menu), `Shelf`, `HoldToConfirm` (radial ring that fills over ~0.9s while A, Enter/Space or the pointer is held; early release springs back; used for every destructive confirmation, and as a controller-only hold on one-click actions like Stop tracking, Separate and Clear all), `OnScreenKeyboard` (Immersive search: one travelling ring over keys, word completions and matching games from the library).

**Haptics.** Controllers vibrate only with named native patterns (`tick`, `edge`, `confirm`, `hold`, `error`) that are short, capped at 60% motor strength and rate-limited natively; never while a game runs, never unless *Gentle vibration feedback* is on, and only when the last input came from the controller. `edge` marks running into the end of a row or list, `tick` a section switch or selection, `confirm` Play and completed holds.

## Accessibility rules (WCAG 2.2 AA intent)

- Every interactive element is a real `button`/`input` with a name, and every icon-only control has `aria-label` and a tooltip.
- Focus is always visible (`--focus-ring`); controllers move focus geometrically; dialogs and menus capture focus and always release it.
- Status never relies on colour alone; text pairs are contrast-checked; hit targets are ≥30px (≥48px in Immersive).
- Text scales with the root size; layouts reflow down to 960×600.
- Automated `axe` checks run on the main pages in CI (no serious or critical violations allowed).
