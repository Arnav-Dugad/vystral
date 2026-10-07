import { useDeferredValue, useMemo } from 'react';
import { motion } from 'motion/react';
import { Clock3, FilePlus2, Heart, Info, Layers, Play, RefreshCw, Sparkles } from 'lucide-react';
import type { Game, PlatformKey } from '../bridge/types';
import { StoreLogo } from '../components/ui/StoreLogo';
import { NeverPlayedSection } from './home/NeverPlayed';
import { AwayCard } from './home/AwayCard';
import { FriendsCard } from './home/FriendsCard';
import { DiskForecastCard } from './home/DiskForecastCard';
import { formatDuration, formatRelative, importedPlaytime, isInstalled, lastPlayed, PLATFORM_NAMES, plural } from '../lib/format';
import { ease, spring } from '../lib/motion';
import { buildHomeModel, gamesFor, type HomeModel } from '../lib/homeModel';
import { useStartupMark } from '../state/startup';
import { addManualGame, toggleFavorite } from '../state/actions';
import { setLaunchOrigin } from '../lib/flight';
import { haptic } from '../lib/haptics';
import { useReducedMotion, useStore } from '../state/store';
import { GameCover } from '../components/game/GameCover';
import { Shelf } from '../components/game/Shelf';
import { Badge, Button, EmptyState, IconButton, PlatformBadge, Skeleton } from '../components/ui/primitives';
import { useLogoTone } from '../lib/logoTone';
import './home.css';

export function HomeView() {
  const games = useStore((s) => s.library.games);
  const gamesById = useStore((s) => s.gamesById);
  const loaded = useStore((s) => s.libraryLoaded);
  // Track AA: last start's snapshot, until the live library arrives (same tree, same keys: no flicker).
  const cached = useStore((s) => (s.libraryLoaded ? null : s.firstPaint));
  const scan = useStore((s) => s.scan);
  const adapters = useStore((s) => s.adapters);
  const scanLibrary = useStore((s) => s.scanLibrary);

  const visible = useMemo(() => games.filter((g) => !g.hidden), [games]);
  // One timestamp per library change, so the rows below don't re-sort on every render.
  const now = useMemo(() => Date.now(), [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = useMemo(() => (loaded ? buildHomeModel(visible, now) : null), [loaded, visible, now]);
  const model = live ?? cached?.model ?? null;
  useStartupMark(live ? 'liveHome' : cached ? 'firstPaint' : null);
  // Track AA: the hero and the first shelf are on the first frame; the rows below the fold follow right after
  // (a deferred render), so the first paint isn't held up by forty cards nobody can see yet.
  const belowFold = useDeferredValue(!!model, false);

  const featured = model?.featuredId ? gamesById.get(model.featuredId) ?? null : null;
  const continuePlaying = useMemo(() => gamesFor(model?.continueIds ?? [], gamesById), [model, gamesById]);
  const favorites = useMemo(() => gamesFor(model?.favoriteIds ?? [], gamesById), [model, gamesById]);
  const recent = useMemo(() => gamesFor(model?.recentIds ?? [], gamesById), [model, gamesById]);
  const suggestions = useMemo(() => (model?.suggestions ?? []).flatMap((s) => {
    const game = gamesById.get(s.id);
    return game ? [{ game, reason: s.reason }] : [];
  }), [model, gamesById]);

  if (!model) return <HomeSkeleton />;

  if (model.visibleCount === 0) {
    const available = adapters.filter((a) => a.status === 'Available');
    return (
      <div className="page">
        <EmptyState
          art="orbits"
          icon={<Layers size={36} />}
          title={scan.running ? 'Looking for your games…' : 'Your universe is waiting'}
          body={
            scan.running
              ? 'VYSTRAL is reading your installed stores. This usually takes a few seconds.'
              : available.length
                ? `VYSTRAL checked ${available.map((a) => a.displayName).join(', ')} and didn’t find installed games yet. Install a game in one of those apps, rescan, or add any program yourself.`
                : 'No supported store apps were found on this PC. You can still add any game or program yourself.'
          }
          actions={
            <>
              <Button variant="primary" icon={<RefreshCw size={16} />} loading={scan.running} onClick={() => void scanLibrary()}>
                Rescan stores
              </Button>
              <Button icon={<FilePlus2 size={16} />} onClick={() => void addManualGame()}>
                Add a game
              </Button>
            </>
          }
        />
      </div>
    );
  }

  return (
    <div className="home" data-first-paint={cached ? '' : undefined}>
      {featured && <Hero game={featured} />}
      <div className="page home__rows">
        {/* Track M: games played while VYSTRAL was closed or in the background (renders nothing otherwise). */}
        <AwayCard />
        {/* Track P: an update that won't fit (renders nothing otherwise); friends playing now (opt-in). */}
        <DiskForecastCard />
        <FriendsCard />
        <Shelf title="Continue playing" games={continuePlaying} variant="landscape" live />
        {belowFold && suggestions.length > 0 && (
          <Shelf
            title={<span className="home__title-icon"><Sparkles size={16} /> Picked from your library</span>}
            meta="Based on what you play — no AI, no cloud"
            games={suggestions.map((s) => s.game)}
            caption={(g) => suggestions.find((s) => s.game.id === g.id)?.reason}
            live
          />
        )}
        {belowFold && (
          <>
            <Shelf title="Favorites" meta={plural(model.favoriteCount, 'game')} games={favorites} live />
            <Shelf title="Recently added" games={recent} live />
            <NeverPlayedSection never={model.never} byId={gamesById} live />
            <LibraryPulse pulse={model.pulse} />
          </>
        )}
      </div>
    </div>
  );
}

function Hero({ game }: { game: Game }) {
  const navigate = useStore((s) => s.navigate);
  const launchGame = useStore((s) => s.launchGame);
  const reduce = useReducedMotion();
  const lp = lastPlayed(game);
  const imported = importedPlaytime(game);
  const installed = isInstalled(game);
  const platforms = [...new Set(game.installations.map((i) => i.platform))];

  return (
    <section className="hero" aria-label={`Featured: ${game.title}`}>
      <motion.div
        className="hero__art"
        initial={reduce ? false : { scale: 1.06, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 1.1, ease: ease.cinematic }}
      >
        <GameCover game={game} kind="hero" eager />
      </motion.div>
      <div className="hero__scrim" />
      <motion.div
        className="hero__content"
        initial={reduce ? false : { opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...spring.hero, delay: 0.1 }}
      >
        <div className="hero__eyebrow caps">{lp.at ? 'Jump back in' : 'Ready when you are'}</div>
        {game.art.logo ? <HeroLogo src={game.art.logo} alt={game.title} /> : <h1 className="hero__title">{game.title}</h1>}
        <div className="hero__meta">
          {platforms.map((p) => <PlatformBadge key={p} platform={p} />)}
          {lp.at && <span><Clock3 size={13} aria-hidden /> Played {formatRelative(lp.at).toLowerCase()}</span>}
          {game.trackedSeconds > 0 && <span>{formatDuration(game.trackedSeconds)} tracked</span>}
          {imported != null && imported.minutes > 0 && <span title="Reported by the store">{formatDuration(imported.minutes * 60)} in {PLATFORM_NAMES[imported.platform]}</span>}
        </div>
        {game.description && <p className="hero__desc selectable">{game.description}</p>}
        <div className="hero__actions">
          <Button variant="primary" size="xl" icon={<Play size={22} fill="currentColor" />} disabled={!installed} onClick={(e) => { setLaunchOrigin(game.id, e.currentTarget); haptic('confirm'); void launchGame(game.id); }} data-autofocus>
            {installed ? 'Play' : 'Not installed'}
          </Button>
          <Button size="lg" icon={<Info size={18} />} onClick={() => navigate({ name: 'game', id: game.id })}>
            Details
          </Button>
          <IconButton label={game.favorite ? 'Remove from favorites' : 'Add to favorites'} pressed={game.favorite} onClick={() => void toggleFavorite(game)}>
            <Heart size={18} fill={game.favorite ? 'currentColor' : 'none'} />
          </IconButton>
        </div>
      </motion.div>
    </section>
  );
}

/** Library Radar: quick facts that lead straight into a filtered library. */
function LibraryPulse({ pulse }: { pulse: HomeModel['pulse'] }) {
  const navigate = useStore((s) => s.navigate);
  const setCommandOpen = useStore((s) => s.setCommandOpen);
  const byPlatform = new Map<string, number>(pulse.platforms);

  const tiles = [
    { label: 'Installed', value: pulse.installed, go: () => navigate({ name: 'library', quick: 'installed' }) },
    { label: 'Need their store app', value: pulse.needsClient, go: () => navigate({ name: 'library', quick: 'client' }) },
    { label: 'Missing from disk', value: pulse.missing, tone: pulse.missing ? 'warn' : undefined, go: () => navigate({ name: 'library', quick: 'missing' }) },
    { label: 'Stores', value: byPlatform.size },
  ];
  return (
    <section className="pulse surface" aria-label="Library radar">
      <div className="pulse__head">
        <h2 className="section-head__title">Library radar</h2>
        <Button size="sm" variant="ghost" onClick={() => setCommandOpen(true)}>Ask your library…</Button>
      </div>
      <div className="pulse__tiles">
        {tiles.map((t) => (
          <button key={t.label} className="pulse__tile" onClick={t.go ?? (() => navigate({ name: 'library' }))}>
            <span className="pulse__value num" data-tone={t.tone}>{t.value.toLocaleString()}</span>
            <span className="pulse__label">{t.label}</span>
          </button>
        ))}
      </div>
      <div className="pulse__platforms">
        {[...byPlatform.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => (
          <Badge key={p}>
            <StoreLogo platform={p as PlatformKey} size={14} decorative />
            {PLATFORM_NAMES[p as PlatformKey]} · {n}
          </Badge>
        ))}
      </div>
    </section>
  );
}

function HomeSkeleton() {
  return (
    <div className="home" aria-hidden>
      <div className="hero" style={{ background: 'var(--bg-1)' }} />
      <div className="page">
        <Skeleton width={220} height={22} />
        <div style={{ display: 'flex', gap: 20, marginTop: 16 }}>
          {[0, 1, 2].map((i) => <Skeleton key={i} width={360} height={200} radius={16} />)}
        </div>
      </div>
    </div>
  );
}

/** Store logos are often black lettering; on the dark hero those get a soft light halo. */
function HeroLogo({ src, alt }: { src: string; alt: string }) {
  const tone = useLogoTone(src);
  return <img className="hero__logo" src={src} alt={alt} data-logo-tone={tone ?? undefined} />;
}
