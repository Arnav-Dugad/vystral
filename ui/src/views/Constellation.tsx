import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight, Crosshair, Gamepad2, Info, LayoutList, Minus, Orbit, Pause, Play, Plus, Telescope, X } from 'lucide-react';
import { Badge, Button, EmptyState, IconButton, Kbd, Segmented, Skeleton } from '../components/ui/primitives';
import { GameCover } from '../components/game/GameCover';
import { useGameRunning, useReducedMotion, useStore } from '../state/store';
import type { Game } from '../bridge/types';
import { PLATFORM_NAMES, formatDuration, importedMinutes, isInstalled, plural, primaryInstallation } from '../lib/format';
import { titleHue } from '../lib/palette';
import { lchToRgb } from '../lib/color';
import { pick, spring } from '../lib/motion';
import { pushPadHandler } from '../lib/input';
import { clusterGames, cycle, layoutGalaxy, starSize, type Cluster, type GalaxyLayout, type GroupBy, type StarInput } from './constellation/layout';
import type { ConstellationScene, PauseLevel, StarAttributes } from './constellation/scene';
import './constellation/constellation.css';

type ViewMode = 'map' | 'list';

const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: 'genre', label: 'Genre' },
  { value: 'platform', label: 'Platform' },
  { value: 'collection', label: 'Collection' },
];

/** Combined playtime: VYSTRAL's tracked time, or the store's imported figure when larger. */
function playSecondsOf(game: Game): number {
  return Math.max(game.trackedSeconds, (importedMinutes(game) ?? 0) * 60);
}

function playLabel(seconds: number): string {
  return seconds > 0 ? `${formatDuration(seconds)} played` : 'Not played yet';
}

function clusterHue(cluster: Cluster): number {
  return cluster.key === '~none' ? 260 : titleHue(cluster.label);
}

interface Model {
  clusters: Cluster[];
  layout: GalaxyLayout;
  attrs: StarAttributes;
  indexOf: Map<string, number>;
}

function buildModel(games: Game[], groupBy: GroupBy, collectionName: (id: string) => string | undefined): Model {
  const inputs: StarInput[] = games.map((g) => ({
    id: g.id,
    title: g.title,
    genres: g.genres,
    platform: primaryInstallation(g)?.platform ?? null,
    collections: g.collections,
    playSeconds: playSecondsOf(g),
    installed: isInstalled(g),
  }));
  const byId = new Map(inputs.map((s) => [s.id, s]));
  const clusters = clusterGames(inputs, groupBy, { platform: (p) => PLATFORM_NAMES[p], collection: collectionName });
  const layout = layoutGalaxy(clusters);
  const n = layout.order.length;
  const colors = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  const brightness = new Float32Array(n);
  const indexOf = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const id = layout.order[i];
    const s = byId.get(id)!;
    const base = clusterHue(clusters[layout.clusterOf[i]]);
    const hue = (base + (titleHue(s.title) % 44) - 22 + 360) % 360;
    const [r, g, b] = lchToRgb([s.installed ? 0.84 : 0.72, s.installed ? 0.13 : 0.06, hue]);
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
    sizes[i] = starSize(s.playSeconds);
    // Dense clusters would blow out to white under additive blending; dim them gently.
    const count = clusters[layout.clusterOf[i]].ids.length;
    const density = Math.min(1, Math.max(0.42, 1.15 - 0.13 * Math.log2(Math.max(1, count / 16))));
    brightness[i] = (s.installed ? 1 : 0.42) * density;
    indexOf.set(id, i);
  }
  return { clusters, layout, attrs: { colors, sizes, brightness }, indexOf };
}

export function ConstellationView() {
  const games = useStore((s) => s.library.games);
  const collections = useStore((s) => s.library.collections);
  const loaded = useStore((s) => s.libraryLoaded);
  const [groupBy, setGroupBy] = useState<GroupBy>('genre');
  const [mode, setMode] = useState<ViewMode>('map');
  const [webglFailed, setWebglFailed] = useState(false);

  const visible = useMemo(() => games.filter((g) => !g.hidden), [games]);
  const collectionName = useMemo(() => {
    const names = new Map(collections.map((c) => [c.id, c.name]));
    return (id: string) => names.get(id);
  }, [collections]);
  const model = useMemo(() => buildModel(visible, groupBy, collectionName), [visible, groupBy, collectionName]);

  const effectiveMode: ViewMode = webglFailed ? 'list' : mode;

  return (
    <div className="page cst-page">
      <header className="cst-head">
        <div>
          <div className="caps">Your library, mapped</div>
          <h1 className="cst-title">Constellation</h1>
          <p className="cst-sub">
            {loaded ? (
              <>
                <span className="num">{visible.length.toLocaleString()}</span> {visible.length === 1 ? 'game' : 'games'} in{' '}
                <span className="num">{model.clusters.length.toLocaleString()}</span> {model.clusters.length === 1 ? 'cluster' : 'clusters'} · brighter stars are installed, larger stars
                have more playtime
              </>
            ) : (
              'Loading your library…'
            )}
          </p>
        </div>
        <div className="cst-toolbar">
          <Segmented label="Group stars by" value={groupBy} options={GROUP_OPTIONS} onChange={setGroupBy} />
          <Segmented
            label="View"
            value={effectiveMode}
            onChange={(v) => {
              if (v === 'map' && webglFailed) return;
              setMode(v);
            }}
            options={[
              { value: 'map', label: 'Map', icon: <Orbit size={14} aria-hidden /> },
              { value: 'list', label: 'List view', icon: <LayoutList size={14} aria-hidden /> },
            ]}
          />
        </div>
      </header>

      {webglFailed && (
        <div className="cst-notice" role="status">
          <Info size={16} aria-hidden />
          3D graphics aren’t available right now, so the Constellation is shown as a list.
        </div>
      )}

      {!loaded ? (
        <Skeleton className="cst-skeleton" height={520} radius={22} />
      ) : visible.length === 0 ? (
        <EmptyState
          art="constellation"
          icon={<Telescope size={36} aria-hidden />}
          title="No stars yet"
          body="Once VYSTRAL finds games on this PC, they appear here as a map of your library."
          actions={
            <Button variant="primary" onClick={() => useStore.getState().navigate({ name: 'library' })}>
              Go to library
            </Button>
          }
        />
      ) : effectiveMode === 'map' ? (
        <MapStage model={model} groupBy={groupBy} onFail={() => setWebglFailed(true)} />
      ) : (
        <ClusterList model={model} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */

const ACCENT_RGB = lchToRgb([0.7, 0.17, 292]);

function MapStage({ model, groupBy, onFail }: { model: Model; groupBy: GroupBy; onFail: () => void }) {
  const gamesById = useStore((s) => s.gamesById);
  const reduce = useReducedMotion();
  const running = useGameRunning();
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ConstellationScene | null>(null);
  const labelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const hoverRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusCluster, setFocusCluster] = useState<number | null>(null);
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus());
  const [inView, setInView] = useState(true);

  const { clusters, layout, attrs, indexOf } = model;
  const selectedIndex = selectedId != null ? indexOf.get(selectedId) ?? null : null;
  const selectedGame = selectedId ? gamesById.get(selectedId) ?? null : null;
  const hoverGame = hover != null ? gamesById.get(layout.order[hover]) ?? null : null;

  // Latest values for imperative callbacks without re-creating the renderer.
  const latest = useRef({ model, selectedId });
  useLayoutEffect(() => {
    latest.current = { model, selectedId };
  });

  // ---- Create the renderer (three.js is code-split and loaded here) ----
  useEffect(() => {
    let cancelled = false;
    let scene: ConstellationScene | null = null;
    const host = stageRef.current;
    if (!host) return;
    void (async () => {
      try {
        const [THREE, mod] = await Promise.all([import('three'), import('./constellation/scene')]);
        if (cancelled) return;
        scene = mod.createConstellationScene(THREE, host, ACCENT_RGB, {
          onHover: (i) => setHover(i),
          onPick: (i) => {
            const id = i == null ? null : latest.current.model.layout.order[i] ?? null;
            setSelectedId(id);
            if (id == null) setFocusCluster(null);
          },
        });
        sceneRef.current = scene;
        setReady(true);
      } catch (err) {
        console.warn('[constellation] WebGL unavailable', err);
        if (!cancelled) onFail();
      }
    })();
    return () => {
      cancelled = true;
      scene?.dispose();
      sceneRef.current = null;
    };
  }, [onFail]);

  // ---- Data ----
  useEffect(() => {
    const scene = sceneRef.current;
    if (!ready || !scene) return;
    scene.setData(layout, attrs);
    scene.setOverlay({ labels: labelRefs.current.slice(0, clusters.length), hover: hoverRef.current, selected: selectedRef.current });
    setHover(null);
    setFocusCluster(null);
    const sel = latest.current.selectedId;
    if (sel != null && !indexOf.has(sel)) setSelectedId(null);
  }, [ready, layout, attrs, clusters.length, indexOf]);

  useEffect(() => sceneRef.current?.setHover(hover), [hover, ready]);
  useEffect(() => sceneRef.current?.setSelected(selectedIndex), [selectedIndex, ready]);
  useEffect(() => sceneRef.current?.focusCluster(focusCluster), [focusCluster, ready]);
  useEffect(() => sceneRef.current?.setReducedMotion(reduce), [reduce, ready]);

  // ---- Pause: hidden window or running game → no GPU work; unfocused/offscreen → no loop ----
  useEffect(() => {
    const onVis = () => setHidden(document.visibilityState === 'hidden');
    const onFocus = () => setWindowFocused(true);
    const onBlur = () => setWindowFocused(false);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.02 });
    if (stageRef.current) io.observe(stageRef.current);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      io.disconnect();
    };
  }, []);
  const pauseLevel: PauseLevel = hidden || running || !inView ? 'hard' : !windowFocused ? 'soft' : 'none';
  useEffect(() => sceneRef.current?.setPaused(pauseLevel), [pauseLevel, ready]);

  // ---- Keyboard / controller navigation ----
  const cursor = useMemo(() => {
    if (selectedIndex == null) return null;
    const c = layout.clusterOf[selectedIndex];
    return { cluster: c, star: selectedIndex - layout.clusterStart[c] };
  }, [selectedIndex, layout]);

  const moveTo = useCallback(
    (clusterIndex: number, starIndex: number) => {
      const cluster = clusters[clusterIndex];
      if (!cluster) return;
      const s = Math.max(0, Math.min(cluster.ids.length - 1, starIndex));
      setSelectedId(cluster.ids[s]);
      setFocusCluster(clusterIndex);
    },
    [clusters],
  );

  const navigate = useCallback(
    (dir: 'left' | 'right' | 'up' | 'down') => {
      if (!clusters.length) return;
      if (!cursor) {
        moveTo(focusCluster ?? 0, 0);
        return;
      }
      if (dir === 'left' || dir === 'right') moveTo(cycle(cursor.cluster, dir === 'right' ? 1 : -1, clusters.length), 0);
      else moveTo(cursor.cluster, cycle(cursor.star, dir === 'down' ? 1 : -1, clusters[cursor.cluster].ids.length));
    },
    [clusters, cursor, focusCluster, moveTo],
  );

  const openSelected = useCallback(() => {
    const id = latest.current.selectedId;
    if (id) useStore.getState().navigate({ name: 'game', id });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedId(null);
    setFocusCluster(null);
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const keys: Record<string, () => void> = {
      ArrowLeft: () => navigate('left'),
      ArrowRight: () => navigate('right'),
      ArrowUp: () => navigate('up'),
      ArrowDown: () => navigate('down'),
      Enter: openSelected,
      ' ': () => (selectedId ? openSelected() : navigate('right')),
      '+': () => sceneRef.current?.zoom(0.8),
      '=': () => sceneRef.current?.zoom(0.8),
      '-': () => sceneRef.current?.zoom(1.25),
      Home: clearSelection,
    };
    if (e.key === 'Escape' && (selectedId || focusCluster != null)) {
      e.preventDefault();
      e.stopPropagation();
      clearSelection();
      return;
    }
    const fn = keys[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };

  const padRef = useRef({ navigate, openSelected, clearSelection, hasSelection: false });
  useLayoutEffect(() => {
    padRef.current = { navigate, openSelected, clearSelection, hasSelection: !!selectedId || focusCluster != null };
  });
  useEffect(
    () =>
      pushPadHandler((button, repeat) => {
        const stage = stageRef.current;
        if (!stage || document.activeElement !== stage) return false;
        const p = padRef.current;
        switch (button) {
          case 'Left': p.navigate('left'); return true;
          case 'Right': p.navigate('right'); return true;
          case 'Up': p.navigate('up'); return true;
          case 'Down': p.navigate('down'); return true;
          case 'A':
            if (!repeat) p.openSelected();
            return true;
          case 'B':
            if (repeat) return true;
            if (p.hasSelection) p.clearSelection();
            else document.querySelector<HTMLElement>('.cst-toolbar [role=radio][aria-checked=true]')?.focus();
            return true;
          default:
            return false;
        }
      }),
    [],
  );

  const selectedCluster = selectedIndex != null ? clusters[layout.clusterOf[selectedIndex]] : null;
  const announce = selectedGame && selectedCluster && cursor
    ? `${selectedGame.title}. ${selectedCluster.label}, ${cursor.star + 1} of ${selectedCluster.ids.length}. ${playLabel(playSecondsOf(selectedGame))}.`
    : focusCluster != null && clusters[focusCluster]
      ? `${clusters[focusCluster].label}, ${plural(clusters[focusCluster].ids.length, 'game')}`
      : '';

  return (
    <div className="cst-stage-wrap">
      <div
        ref={stageRef}
        className="cst-stage"
        tabIndex={0}
        role="application"
        aria-roledescription="library map"
        aria-label={`Constellation map grouped by ${groupBy}. Left and Right arrows move between clusters, Up and Down between games, Enter opens the game.`}
        aria-describedby="cst-hint"
        data-ready={ready}
        onKeyDown={onKeyDown}
      >
        {!ready && <div className="cst-loading" aria-hidden><span className="spinner" /></div>}
        <div className="cst-overlay" aria-hidden>
          {clusters.map((c, i) => (
            <div
              key={c.key}
              ref={(el) => {
                labelRefs.current[i] = el;
              }}
              className="cst-label"
              data-focused={focusCluster === i}
              style={{ ['--h' as string]: clusterHue(c) }}
              data-no-orbit
              onClick={() => {
                setFocusCluster(focusCluster === i ? null : i);
                setSelectedId(null);
              }}
            >
              <span className="cst-label__name">{c.label}</span>
              <span className="cst-label__count num">{c.ids.length.toLocaleString()}</span>
            </div>
          ))}
          <div ref={selectedRef} className="cst-marker cst-marker--selected" style={{ opacity: 0 }} />
          <div ref={hoverRef} className="cst-marker cst-marker--hover" style={{ opacity: 0 }}>
            {hoverGame && hover !== selectedIndex && (
              <div className="cst-tip">
                <span className="cst-tip__title">{hoverGame.title}</span>
                <span className="cst-tip__meta">
                  {playLabel(playSecondsOf(hoverGame))} · {isInstalled(hoverGame) ? 'Installed' : 'Not installed'}
                </span>
              </div>
            )}
          </div>
        </div>

        {running && (
          <div className="cst-paused" data-no-orbit>
            <Badge tone="glass" icon={<Pause size={12} aria-hidden />}>Paused while you play</Badge>
          </div>
        )}

        <div className="cst-controls" data-no-orbit>
          <IconButton size="sm" label="Zoom in" onClick={() => sceneRef.current?.zoom(0.8)}><Plus size={16} /></IconButton>
          <IconButton size="sm" label="Zoom out" onClick={() => sceneRef.current?.zoom(1.25)}><Minus size={16} /></IconButton>
          <IconButton size="sm" label="Show whole library" onClick={clearSelection}><Crosshair size={16} /></IconButton>
        </div>

        <AnimatePresence>
          {selectedGame && selectedCluster && <StarCard key={selectedGame.id} game={selectedGame} cluster={selectedCluster} onClose={clearSelection} />}
        </AnimatePresence>
      </div>

      <div className="cst-hint" id="cst-hint">
        <span>Drag to orbit · Scroll to zoom</span>
        <span className="cst-hint__keys">
          <Kbd>←</Kbd><Kbd>→</Kbd> clusters <Kbd>↑</Kbd><Kbd>↓</Kbd> games <Kbd>Enter</Kbd> open <Kbd>Esc</Kbd> zoom out
        </span>
      </div>
      <div className="visually-hidden" aria-live="polite">{announce}</div>
    </div>
  );
}

function StarCard({ game, cluster, onClose }: { game: Game; cluster: Cluster; onClose: () => void }) {
  const reduce = useReducedMotion();
  const installed = isInstalled(game);
  const imported = importedMinutes(game);
  return (
    <motion.aside
      className="cst-card glass"
      aria-label={`${game.title} details`}
      initial={reduce ? { opacity: 0 } : { opacity: 0, x: 24, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, x: 16, transition: { duration: 0.14 } }}
      transition={pick(reduce, spring.panel)}
      data-no-orbit
    >
      <div className="cst-card__cover">
        <GameCover game={game} kind="header" />
        <IconButton className="cst-card__close" size="sm" label="Close" onClick={onClose}><X size={16} /></IconButton>
      </div>
      <div className="cst-card__body">
        <div className="caps cst-card__cluster" style={{ ['--h' as string]: clusterHue(cluster) }}>{cluster.label}</div>
        <h2 className="cst-card__title">{game.title}</h2>
        <dl className="cst-card__stats">
          <div>
            <dt className="caps">Tracked</dt>
            <dd className="num">{formatDuration(game.trackedSeconds)}</dd>
          </div>
          <div>
            <dt className="caps">Imported</dt>
            <dd className="num">{imported != null ? formatDuration(imported * 60) : '—'}</dd>
          </div>
          <div>
            <dt className="caps">Status</dt>
            <dd>{installed ? 'Installed' : 'Not installed'}</dd>
          </div>
        </dl>
        <div className="cst-card__actions">
          {installed && (
            <Button variant="primary" icon={<Play size={16} aria-hidden />} onClick={() => void useStore.getState().launchGame(game.id)}>
              Play
            </Button>
          )}
          <Button variant="secondary" icon={<Gamepad2 size={16} aria-hidden />} onClick={() => useStore.getState().navigate({ name: 'game', id: game.id })}>
            Details
          </Button>
        </div>
      </div>
    </motion.aside>
  );
}

/* ------------------------------------------------------------------------------------------ */

const LIST_PREVIEW = 48;

function ClusterList({ model }: { model: Model }) {
  const gamesById = useStore((s) => s.gamesById);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  return (
    <div className="cst-list">
      {model.clusters.map((c) => {
        const open = expanded.has(c.key);
        const ids = open ? c.ids : c.ids.slice(0, LIST_PREVIEW);
        const headingId = `cst-g-${c.key.replace(/[^a-z0-9]/gi, '-')}`;
        return (
          <section key={c.key} className="cst-group" aria-labelledby={headingId} style={{ ['--h' as string]: clusterHue(c) }}>
            <h2 className="cst-group__title" id={headingId}>
              <span className="cst-group__dot" aria-hidden />
              {c.label}
              <span className="cst-group__count num">{c.ids.length.toLocaleString()}</span>
            </h2>
            <ul className="cst-group__items">
              {ids.map((id) => {
                const g = gamesById.get(id);
                if (!g) return null;
                const installed = isInstalled(g);
                const secs = playSecondsOf(g);
                return (
                  <li key={id}>
                    <button type="button" className="cst-row" onClick={() => useStore.getState().navigate({ name: 'game', id })} data-installed={installed}>
                      <span className="cst-row__star" style={{ ['--s' as string]: `${Math.round(starSize(secs) / 3.2)}px`, ['--sh' as string]: titleHue(g.title) }} aria-hidden />
                      <span className="cst-row__title truncate">{g.title}</span>
                      <span className="cst-row__meta num">{secs > 0 ? formatDuration(secs, { short: true }) : '—'}</span>
                      <span className="cst-row__state">{installed ? 'Installed' : 'Not installed'}</span>
                      <ChevronRight size={14} aria-hidden className="cst-row__chev" />
                    </button>
                  </li>
                );
              })}
            </ul>
            {c.ids.length > LIST_PREVIEW && (
              <Button
                variant="ghost"
                size="sm"
                className="cst-group__more"
                onClick={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (open) next.delete(c.key);
                    else next.add(c.key);
                    return next;
                  })
                }
              >
                {open ? 'Show fewer' : `Show all ${c.ids.length.toLocaleString()}`}
              </Button>
            )}
          </section>
        );
      })}
    </div>
  );
}
