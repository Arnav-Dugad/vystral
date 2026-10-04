import { useMemo } from 'react';
import { motion } from 'motion/react';
import { Clock3, FilePlus2, Heart, Info, Layers, Play, RefreshCw, Sparkles } from 'lucide-react';
import type { Game } from '../bridge/types';
import { formatDuration, formatRelative, importedMinutes, isInstalled, lastPlayed, PLATFORM_NAMES, plural } from '../lib/format';
import { ease, spring } from '../lib/motion';
import { featuredGame, suggestGames } from '../lib/recommend';
import { addManualGame, toggleFavorite } from '../state/actions';
import { useReducedMotion, useStore } from '../state/store';
import { GameCover } from '../components/game/GameCover';
import { Shelf } from '../components/game/Shelf';
import { Badge, Button, EmptyState, IconButton, PlatformBadge, Skeleton } from '../components/ui/primitives';
import './home.css';

export function HomeView() {
  const games = useStore((s) => s.library.games);
  const loaded = useStore((s) => s.libraryLoaded);
  const scan = useStore((s) => s.scan);
  const adapters = useStore((s) => s.adapters);
  const scanLibrary = useStore((s) => s.scanLibrary);

  const visible = useMemo(() => games.filter((g) => !g.hidden), [games]);
  const featured = useMemo(() => featuredGame(visible), [visible]);
  const now = Date.now();

  const continuePlaying = useMemo(
    () =>
      visible
        .filter((g) => isInstalled(g) && lastPlayed(g).at)
        .sort((a, b) => lastPlayed(b).at!.localeCompare(lastPlayed(a).at!))
        .filter((g) => g.id !== featured?.id)
        .slice(0, 12),
    [visible, featured],
  );
  const favorites = useMemo(() => visible.filter((g) => g.favorite).sort((a, b) => a.sortTitle.localeCompare(b.sortTitle)), [visible]);
  const recent = useMemo(() => [...visible].sort((a, b) => b.added.localeCompare(a.added)).filter((g) => now - Date.parse(g.added) < 30 * 86400000).slice(0, 16), [visible, now]);
  const suggestions = useMemo(() => suggestGames(visible, now, 12), [visible, now]);
  const unplayed = useMemo(() => visible.filter((g) => isInstalled(g) && !lastPlayed(g).at && g.trackedSeconds === 0), [visible]);

  if (!loaded) return <HomeSkeleton />;

  if (visible.length === 0) {
    const available = adapters.filter((a) => a.status === 'Available');
    return (
      <div className="page">
        <EmptyState
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
    <div className="home">
      {featured && <Hero game={featured} />}
      <div className="page home__rows">
        <Shelf title="Continue playing" games={continuePlaying} variant="landscape" />
        {suggestions.length > 0 && (
          <Shelf
            title={<span className="home__title-icon"><Sparkles size={16} /> Picked from your library</span>}
            meta="Based on what you play — no AI, no cloud"
            games={suggestions.map((s) => s.game)}
            caption={(g) => suggestions.find((s) => s.game.id === g.id)?.reason}
          />
        )}
        <Shelf title="Favorites" meta={plural(favorites.length, 'game')} games={favorites} />
        <Shelf title="Recently added" games={recent} />
        <Shelf title="Ready and unplayed" meta={plural(unplayed.length, 'game')} games={unplayed.slice(0, 24)} />
        <LibraryPulse games={visible} />
      </div>
    </div>
  );
}

function Hero({ game }: { game: Game }) {
  const navigate = useStore((s) => s.navigate);
  const launchGame = useStore((s) => s.launchGame);
  const reduce = useReducedMotion();
  const lp = lastPlayed(game);
  const imported = importedMinutes(game);
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
        {game.art.logo ? <img className="hero__logo" src={game.art.logo} alt={game.title} /> : <h1 className="hero__title">{game.title}</h1>}
        <div className="hero__meta">
          {platforms.map((p) => <PlatformBadge key={p} platform={p} />)}
          {lp.at && <span><Clock3 size={13} aria-hidden /> Played {formatRelative(lp.at)}</span>}
          {game.trackedSeconds > 0 && <span>{formatDuration(game.trackedSeconds)} tracked</span>}
          {imported != null && imported > 0 && <span title="Reported by the store">{formatDuration(imported * 60)} in {PLATFORM_NAMES[game.installations.find((i) => i.importedPlaytimeMinutes != null)?.platform ?? 'steam']}</span>}
        </div>
        {game.description && <p className="hero__desc selectable">{game.description}</p>}
        <div className="hero__actions">
          <Button variant="primary" size="xl" icon={<Play size={22} fill="currentColor" />} disabled={!installed} onClick={() => void launchGame(game.id)} data-autofocus>
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
function LibraryPulse({ games }: { games: Game[] }) {
  const navigate = useStore((s) => s.navigate);
  const setCommandOpen = useStore((s) => s.setCommandOpen);
  const installed = games.filter(isInstalled);
  const missing = games.filter((g) => g.installations.some((i) => i.state === 'missing') && !isInstalled(g));
  const needsClient = installed.filter((g) => g.installations.every((i) => i.state !== 'installed' || i.clientRequired));
  const byPlatform = new Map<string, number>();
  for (const g of installed) for (const p of new Set(g.installations.map((i) => i.platform))) byPlatform.set(p, (byPlatform.get(p) ?? 0) + 1);

  const tiles = [
    { label: 'Installed', value: installed.length, go: () => navigate({ name: 'library' }) },
    { label: 'Need their store app', value: needsClient.length },
    { label: 'Missing from disk', value: missing.length, tone: missing.length ? 'warn' : undefined },
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
            <span className="platform-badge__dot" style={{ ['--pc' as string]: `var(--p-${p})`, width: 7, height: 7, borderRadius: 4, background: `var(--p-${p})` }} />
            {PLATFORM_NAMES[p as keyof typeof PLATFORM_NAMES]} · {n}
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
