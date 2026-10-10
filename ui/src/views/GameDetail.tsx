import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertTriangle, ArrowLeft, BarChart3, Check, ChevronDown, Clock3, Eye, EyeOff, FolderOpen, FolderPlus, Heart, HardDrive,
  ImagePlus, MoreHorizontal, Play, Split, Trash2,
} from 'lucide-react';
import { call, errorMessage } from '../bridge/bridge';
import type { Game, InstallProgress, Installation, PerfSummary, Session } from '../bridge/types';
import {
  formatBytes, formatDate, formatDuration, formatRelative, importedPlaytime, isInstalled, lastPlayed, PLATFORM_NAMES, plural, primaryInstallation, sizeOf,
} from '../lib/format';
import { ease, spring } from '../lib/motion';
import { paletteFor } from '../lib/palette';
import { captureFlight, useFlightLanding } from '../lib/flight';
import { phaseLabel, progressDetail } from '../lib/installProgress';
import { useLogoTone } from '../lib/logoTone';
import { openFolder, removeManualGame, setCollection, setHidden, setNotes, setPreferred, setRating, toggleFavorite } from '../state/actions';
import { useReducedMotion, useStore } from '../state/store';
import { HoldToConfirm } from '../components/controller/HoldToConfirm';
import { GameCover } from '../components/game/GameCover';
import { GameCard } from '../components/game/GameCard';
import { PlayButton } from '../components/game/PlayButton';
import { LastSessionGhost } from '../components/game/LastSessionGhost';
import { SessionOriginChip } from '../components/game/SessionOriginChip';
import { useInstallFor } from '../state/installs';
import { StatusPicker } from '../components/game/StatusPicker';
import { HeroTrailer } from '../components/game/HeroTrailer';
import { Badge, Button, EmptyState, Field, IconButton, PlatformBadge, SectionHead, Stars, Tabs } from '../components/ui/primitives';
import { StoreLogo } from '../components/ui/StoreLogo';
import { DriverChangeCard } from './perf/DataInsightCards';
import { GameExtras, IdentityPanel } from '../components/game/GameDataPanels';
import { IdentityMatchCard } from '../components/game/IdentityMatch';
import { useIdentityStore } from '../state/identity';
import { steamLinkOf } from '../lib/identity';
import { TimeToBeatPanel } from '../components/game/TimeToBeatBar';
import { CompletionForecastPanel } from '../components/game/CompletionForecast';
import { HardwareTimeline } from './perf/HardwareTimeline';
import { RollUp } from '../components/ui/RollUp';
import { AntiCheatNote } from '../components/game/AntiCheatNote';
import { UpdateSpaceChip } from '../components/game/UpdateSpaceChip';
import { CloudPlayButton } from '../components/cloud/CloudPlayButton';
import { SubsGamePills } from '../components/subs/SubsBits';
import { ArtSlotActions, useUserArt } from '../components/game/ArtPicker';
import { Menu, type MenuEntry } from '../components/ui/Menu';
import { Dialog } from '../components/ui/Dialog';
import { HeroDock } from '../components/game/HeroDock';
import { takeGameTab } from '../lib/gameTab';
import { FilesPanel } from '../components/game/FilesPanel';
import { UninstallAdvisor } from '../components/game/UninstallAdvisor';
import { AchievementGuidePanel, CurrentGoalChip } from '../components/game/AchievementGuide';
import { FriendsPlayedChip } from '../components/game/FriendsPlayedChip';
import { PatchNotes } from '../components/game/PatchNotes';
import { PackageFacts } from '../components/game/NotOwned';
// Track C4: the "At a glance" stat tiles, community tags and the franchise timeline.
import { CommunityTags, FranchiseTimeline, GameInsights } from '../components/game/insights/lazy';

// Track AA: tab panels that aren't on the first screen load when their tab opens (not at startup).
const AchievementsPanel = lazy(() => import('../components/game/AchievementsPanel').then((m) => ({ default: m.AchievementsPanel })));
const ControlsPanel = lazy(() => import('../components/game/ControlsPanel').then((m) => ({ default: m.ControlsPanel })));
import './detail.css';

type Tab = 'overview' | 'achievements' | 'news' | 'sessions' | 'versions' | 'artwork' | 'controls' | 'files';
const TABS: Tab[] = ['overview', 'achievements', 'news', 'sessions', 'versions', 'artwork', 'controls', 'files'];

export function GameDetailView({ id }: { id: string }) {
  const game = useStore((s) => s.gamesById.get(id));
  const loaded = useStore((s) => s.libraryLoaded);
  const navigate = useStore((s) => s.navigate);
  const setFocusGame = useStore((s) => s.setFocusGame);
  const identity = useIdentityStore((s) => s.byGame[id] ?? null); // Track D4: a matched Steam app brings Steam news too
  // Track Q: another page can ask for a tab ("See versions" from the health check).
  const [tab, setTab] = useState<Tab>(() => {
    const requested = takeGameTab(id);
    return TABS.find((t) => t === requested) ?? 'overview';
  });

  useEffect(() => {
    if (game) {
      setFocusGame(game.id);
      void paletteFor(game);
    }
  }, [game, setFocusGame]);

  if (!game) {
    return (
      <div className="page">
        <EmptyState
          art="none"
          icon={<AlertTriangle size={32} />}
          title={loaded ? 'This game is no longer in your library' : 'Loading…'}
          body={loaded ? 'It may have been merged with another entry or removed.' : ''}
          actions={loaded ? <Button onClick={() => navigate({ name: 'library' })}>Go to library</Button> : undefined}
        />
      </div>
    );
  }

  return (
    <div className="detail">
      <DetailHero game={game} onOpenAchievements={() => setTab('achievements')} />
      <div className="page detail__body">
        <StatsRow game={game} />
        <div className="detail__tabbar">
          <Tabs
            label="Game sections"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'overview', label: 'Overview' },
              { value: 'achievements', label: 'Achievements' },
              ...(steamLinkOf(game, identity) ? [{ value: 'news' as const, label: 'News' }] : []), // Track W: patch notes and announcements (Track D4: also a matched Steam app's)
              { value: 'sessions', label: `Sessions${game.sessionCount ? ` · ${game.sessionCount}` : ''}` },
              { value: 'versions', label: `Versions${game.installations.length > 1 ? ` · ${game.installations.length}` : ''}` },
              { value: 'artwork', label: 'Artwork' },
              { value: 'controls', label: 'Controls' },
              { value: 'files', label: 'Files' }, // Track X: save locations and mods
            ]}
          />
        </div>
        <div className="detail__panel">
          {tab === 'overview' && <Overview game={game} onOpenAchievements={() => setTab('achievements')} />}
          {tab === 'sessions' && <Sessions game={game} />}
          {tab === 'versions' && <Versions game={game} />}
          {tab === 'artwork' && <ArtworkTab game={game} />}
          {tab === 'achievements' && <Suspense fallback={null}>{isSteamGame(game)
            ? <div className="ach-with-guide"><AchievementsPanel game={game} /><AchievementGuidePanel game={game} /></div>
            : <AchievementsPanel game={game} />}</Suspense>}
          {tab === 'news' && <PatchNotes game={game} />}
          {tab === 'controls' && <Suspense fallback={null}><ControlsPanel game={game} /></Suspense>}
          {tab === 'files' && <FilesPanel game={game} />}
        </div>
        <Related game={game} />
      </div>
    </div>
  );
}

const isSteamGame = (game: Game) => game.installations.some((i) => i.platform === 'steam');

function DetailHero({ game, onOpenAchievements }: { game: Game; onOpenAchievements: () => void }) {
  const goBack = useStore((s) => s.goBack);
  const launchGame = useStore((s) => s.launchGame);
  const collections = useStore((s) => s.library.collections);
  const reduce = useReducedMotion();
  const coverRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  useFlightLanding(game.id, coverRef, !reduce);
  // Leaving the page, the cover becomes the start of the flight back into its card.
  useEffect(() => {
    const el = coverRef.current;
    return () => {
      // Only a real departure (the route changed) starts a return flight — not a re-render
      // or React's development double-mount.
      const r = useStore.getState().route;
      if (r.name !== 'game' || r.id !== game.id) captureFlight(game.id, el);
    };
  }, [game.id]);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [chooseAt, setChooseAt] = useState<{ x: number; y: number } | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [advisorOpen, setAdvisorOpen] = useState(false); // Track X
  const moreRef = useRef<HTMLButtonElement>(null);
  const chooserRef = useRef<HTMLButtonElement>(null);

  const installed = game.installations.filter((i) => i.state === 'installed');
  const primary = primaryInstallation(game);
  const manual = game.installations.every((i) => i.platform === 'manual');
  const install = useInstallFor(game.id);
  const logoTone = useLogoTone(game.art.logo);

  const status = describeStatus(game, primary, install);

  const more: MenuEntry[] = [
    { label: game.favorite ? 'Remove from favorites' : 'Add to favorites', icon: <Heart size={16} />, onSelect: () => void toggleFavorite(game) },
    { label: 'Open install folder', icon: <FolderOpen size={16} />, onSelect: () => void openFolder(game), disabled: !installed.length },
    ...installed.filter((i) => i.platform !== 'manual').map<MenuEntry>((i) => ({
      label: `Open in ${PLATFORM_NAMES[i.platform]}`,
      icon: <StoreLogo platform={i.platform} size={16} decorative />,
      onSelect: () => void call('game.openInStore', { installationId: i.id }).catch((err) => useStore.getState().toast({ tone: 'info', title: errorMessage(err) })),
    })),
    // Track X: the uninstall advisor, before the store's own uninstall.
    ...(installed.some((i) => i.platform !== 'manual')
      ? [{ label: 'Before you uninstall…', icon: <Trash2 size={16} />, onSelect: () => setAdvisorOpen(true) } as MenuEntry]
      : []),
    { kind: 'separator' },
    ...(collections.some((c) => !c.rule) // Track C5: smart collections fill themselves
      ? collections.filter((c) => !c.rule).map<MenuEntry>((c) => ({
          label: c.name,
          icon: game.collections.includes(c.id) ? <Check size={16} /> : <FolderPlus size={16} />,
          onSelect: () => void setCollection(game, c.id, !game.collections.includes(c.id)),
        }))
      : []),
    { label: 'New collection…', icon: <FolderPlus size={16} />, onSelect: () => window.dispatchEvent(new CustomEvent('vystral:new-collection')) },
    { kind: 'separator' },
    // Track C1: a game Steam no longer lists stays out of the library until it's bought again.
    game.notOwned
      ? { label: 'No longer in your Steam library', icon: <EyeOff size={16} />, onSelect: () => {}, disabled: true }
      : game.hidden
      ? { label: 'Show in library', icon: <Eye size={16} />, onSelect: () => void setHidden(game, false) }
      : { label: 'Hide from library', icon: <EyeOff size={16} />, onSelect: () => void setHidden(game, true) },
    ...(manual ? [{ label: 'Remove from VYSTRAL…', icon: <Trash2 size={16} />, danger: true, onSelect: () => setRemoveOpen(true) } as MenuEntry] : []),
  ];

  return (
    <>
      {/* Track Z: the fluid header — Back lives in its sticky bar; the cover, title and Play dock into it as you scroll. */}
      <HeroDock
        game={game}
        hero={heroRef}
        cover={coverRef}
        title={titleRef}
        back={
          <Button variant="ghost" size="sm" icon={<ArrowLeft size={16} />} onClick={goBack} className="dhero__back">
            Back
          </Button>
        }
      />
      <section className="dhero" ref={heroRef}>
        <div className="dhero__stage dk">
          <motion.div className="dhero__art" initial={reduce ? false : { opacity: 0, scale: 1.04 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.9, ease: ease.cinematic }}>
            <GameCover game={game} kind="hero" eager />
            <HeroTrailer game={game} active />
          </motion.div>
        </div>
        <div className="dhero__scrim" />
        <LastSessionGhost game={game} />
        <motion.div className="dhero__content" initial={reduce ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring.hero, delay: 0.05 }}>
          <div className="dhero__cover-slot dk">
            <div className="dhero__cover" data-game-id={game.id} ref={coverRef}>
              <GameCover game={game} eager />
            </div>
          </div>
          <div className="dhero__info">
            <div className="dhero__titlebox dk" ref={titleRef}>
              <div className="dhero__titlecurve dk">
                <div className="dhero__titlescale dk">
                  {game.art.logo ? <img className="dhero__logo" src={game.art.logo} alt={game.title} data-logo-tone={logoTone ?? undefined} /> : <h1 className="dhero__title">{game.title}</h1>}
                </div>
              </div>
            </div>
            {game.art.logo && <h1 className="visually-hidden">{game.title}</h1>}
            <div className="dhero__meta dk">
              <div className="dhero__badges">
                {[...new Set(game.installations.map((i) => i.platform))].map((p) => <PlatformBadge key={p} platform={p} />)}
                {game.genres.slice(0, 3).map((g) => <Badge key={g}>{g}</Badge>)}
              </div>
              <div className={`dhero__status dhero__status--${status.tone}`} role="status">
                {status.tone === 'warn' ? <AlertTriangle size={15} aria-hidden /> : <HardDrive size={15} aria-hidden />}
                <span>{status.text}</span>
              </div>
              <UpdateSpaceChip game={game} />{/* Track P: room the next Steam update needs */}
              <SubsGamePills gameId={game.id} />{/* Track V: included with your plans, leaving soon */}
              <FriendsPlayedChip game={game} />{/* Track W: friends who played this recently (opt-in) */}
              <div className="dhero__actions">
                <div className="split-btn">
                  <PlayButton game={game} autoFocus joined={installed.length > 1} />
                  {installed.length > 1 && (
                    <button
                      ref={chooserRef}
                      className="split-btn__more"
                      aria-label="Choose which store to play from"
                      onClick={() => {
                        const r = chooserRef.current!.getBoundingClientRect();
                        setChooseAt({ x: r.left, y: r.bottom + 6 });
                      }}
                    >
                      <ChevronDown size={18} />
                    </button>
                  )}
                </div>
                {/* Track O: Play in the cloud (renders nothing unless cloud play is on and a service lists this game). */}
                <CloudPlayButton game={game} />
                <IconButton label={game.favorite ? 'Remove from favorites' : 'Add to favorites'} pressed={game.favorite} onClick={() => void toggleFavorite(game)} className="dhero__icon">
                  <Heart size={19} fill={game.favorite ? 'currentColor' : 'none'} />
                </IconButton>
                <IconButton
                  ref={moreRef}
                  label="More actions"
                  className="dhero__icon"
                  onClick={() => {
                    const r = moreRef.current!.getBoundingClientRect();
                    setMenuAt({ x: r.left, y: r.bottom + 6 });
                  }}
                >
                  <MoreHorizontal size={19} />
                </IconButton>
              </div>
              <CurrentGoalChip game={game} onOpen={onOpenAchievements} />{/* Track W: the pinned achievement goal */}
            </div>
          </div>
        </motion.div>
        <Menu at={menuAt} entries={more} onClose={() => setMenuAt(null)} label="Game actions" />
        <Menu
          at={chooseAt}
          onClose={() => setChooseAt(null)}
          label="Play from"
          entries={[
            { kind: 'label', label: 'Play from' },
            ...installed.map<MenuEntry>((i) => ({
              label: `${PLATFORM_NAMES[i.platform]}${i.id === game.preferredInstallationId ? ' (preferred)' : ''}`,
              icon: <Play size={16} />,
              onSelect: () => void launchGame(game.id, i.id),
            })),
            { kind: 'separator' },
            ...installed.map<MenuEntry>((i) => ({
              label: `Always use ${PLATFORM_NAMES[i.platform]}`,
              icon: i.id === game.preferredInstallationId ? <Check size={16} /> : <span style={{ width: 16 }} />,
              onSelect: () => void setPreferred(game, i.id),
            })),
          ]}
        />
        <UninstallAdvisor game={game} open={advisorOpen} onClose={() => setAdvisorOpen(false)} />
        <Dialog
          open={removeOpen}
          onClose={() => setRemoveOpen(false)}
          title={`Remove ${game.title} from VYSTRAL?`}
          actions={<><Button variant="ghost" onClick={() => setRemoveOpen(false)}>Cancel</Button><HoldToConfirm onConfirm={() => { setRemoveOpen(false); void removeManualGame(game); }}>Remove from VYSTRAL</HoldToConfirm></>}
        >
          VYSTRAL forgets this entry and its tracked sessions. The program and its files on your PC are not touched.
        </Dialog>
      </section>
    </>
  );
}

function describeStatus(game: Game, primary: Installation | undefined, install?: InstallProgress): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  // Steam is working on it: the Play button shows the ring, this line says exactly what Steam reports.
  if (install && install.phase !== 'removed' && (install.watching || install.phase === 'installed')) {
    const detail = progressDetail(install);
    if (!(install.kind === 'update' && install.phase === 'installed')) return { text: detail ? `${phaseLabel(install)} · ${detail}` : phaseLabel(install), tone: 'muted' };
  }
  if (!isInstalled(game)) {
    if (game.notOwned) return { text: 'No longer in your Steam library (refunded or removed). Its play history, notes and rating are kept.', tone: 'warn' };
    const missing = game.installations.find((i) => i.state === 'missing');
    return missing
      ? { text: `Not found during the last scan of ${PLATFORM_NAMES[missing.platform]}. Reinstall it there or rescan.`, tone: 'warn' }
      : { text: 'Not installed on this PC', tone: 'muted' };
  }
  const parts: string[] = ['Installed'];
  if (primary?.drive) parts.push(`on ${primary.drive}`);
  const size = sizeOf(game);
  if (size) parts.push(`· ${formatBytes(size)}`);
  if (primary?.clientRequired) parts.push(`· starts through ${PLATFORM_NAMES[primary.platform]}`);
  else if (primary) parts.push('· launches directly');
  return { text: parts.join(' '), tone: 'ok' };
}

/** Size card: the installed size, or for games that aren't installed only sizes a store actually reported. */
function sizeStat(game: Game, install: InstallProgress | undefined): { value: string; hint?: string } {
  if (isInstalled(game)) return { value: formatBytes(sizeOf(game)), hint: game.installations.length > 1 ? 'largest installed version' : undefined };
  if (install?.kind === 'install' && install.bytesTotal > 0 && install.phase !== 'removed') return { value: 'Not installed', hint: `${formatBytes(install.bytesTotal)} download, reported by Steam` };
  const known = game.installations.map((i) => i.sizeBytes).filter((b): b is number => b != null && b > 0);
  if (known.length) return { value: 'Not installed', hint: `${formatBytes(Math.max(...known))} when last installed` };
  return { value: 'Not installed', hint: 'The store shows the size when you install' };
}

function StatsRow({ game }: { game: Game }) {
  const install = useInstallFor(game.id);
  const size = sizeStat(game, install);
  const lp = lastPlayed(game);
  const importedStore = importedPlaytime(game);
  const imported = importedStore?.minutes ?? null;
  const importedFrom = importedStore?.platform;
  const stats = [
    { label: 'Last played', value: lp.at ? formatRelative(lp.at) : 'Never', hint: lp.source === 'imported' ? 'from the store' : lp.source === 'estimated' ? 'estimated from save data' : lp.source === 'tracked' ? 'tracked by VYSTRAL' : undefined },
    { label: 'Tracked by VYSTRAL', value: game.trackedSeconds ? formatDuration(game.trackedSeconds) : '—', hint: game.sessionCount ? plural(game.sessionCount, 'session') : 'No sessions yet' },
    { label: importedFrom ? `${PLATFORM_NAMES[importedFrom]} playtime` : 'Store playtime', value: imported != null ? formatDuration(imported * 60) : '—', hint: imported != null ? 'reported by the store' : 'not available from this store' },
    { label: 'Size on disk', value: size.value, hint: size.hint },
  ];
  return (
    <div className="stats-row">
      {stats.map((s) => (
        <div key={s.label} className="stat">
          <div className="caps">{s.label}</div>
          <div className="stat__value"><RollUp id={`game.${game.id}.${s.label}`}>{s.value}</RollUp></div>
          {s.hint && <div className="stat__hint">{s.hint}</div>}
        </div>
      ))}
    </div>
  );
}

/**
 * Debounced notes autosave: one request at a time, newer text queued while a save is in flight,
 * "Saved" only once the latest text reached the backend, pending text flushed on unmount or game
 * switch, and no automatic retry loop when a save fails (the next edit tries again).
 */
function useNotesAutosave(game: Game) {
  const [status, setStatus] = useState<'saved' | 'pending' | 'saving' | 'failed'>('saved');
  const pending = useRef<{ game: Game; text: string } | null>(null);
  const inFlight = useRef(false);
  const timer = useRef(0);
  const alive = useRef(true);

  const [flush] = useState(() => {
    const run = async (): Promise<void> => {
      window.clearTimeout(timer.current);
      const p = pending.current;
      if (!p || inFlight.current) return;
      pending.current = null;
      inFlight.current = true;
      if (alive.current) setStatus('saving');
      const ok = await setNotes(p.game, p.text);
      inFlight.current = false;
      if (pending.current) void run();
      else if (alive.current) setStatus(ok ? 'saved' : 'failed');
    };
    return run;
  });

  // Switching games or leaving the page saves whatever is still waiting for the debounce.
  useEffect(() => {
    alive.current = true;
    setStatus('saved');
    return () => {
      alive.current = false;
      void flush();
    };
  }, [game.id, flush]);

  const edit = (text: string) => {
    pending.current = { game, text };
    setStatus('pending');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 700);
  };
  return { status, edit };
}

function Overview({ game, onOpenAchievements }: { game: Game; onOpenAchievements: () => void }) {
  const [notes, setNotesText] = useState(game.notes ?? '');
  const notesSave = useNotesAutosave(game);
  useEffect(() => {
    setNotesText(game.notes ?? '');
  }, [game.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const facts = [
    ['Developer', game.developer],
    ['Publisher', game.publisher],
    ['Released', game.releaseDate],
    ['Genres', game.genres.join(', ') || null],
  ].filter(([, v]) => v);

  return (
    <>
    <GameInsights game={game} onOpenAchievements={onOpenAchievements} />
    <div className="overview">
      <div className="overview__main">
        {game.description ? <p className="overview__desc selectable">{game.description}</p> : <p className="overview__desc" style={{ color: 'var(--text-3)' }}>No description available. VYSTRAL only shows information it can source reliably.</p>}
        <CommunityTags params={{ gameId: game.id }} cacheKey={game.id} />
        {/* Track I: compatibility badges, IGDB/RAWG facts and deals, each with its source. */}
        {/* Track M: playtime vs IGDB time to beat, and an informative kernel anti-cheat note (each renders nothing without data). */}
        <div className="gd-recap"><TimeToBeatPanel game={game} /><CompletionForecastPanel game={game} /><AntiCheatNote game={game} /></div>
        <GameExtras game={game} />
        <div style={{ marginTop: 'var(--s-6)' }}>
          <Field label="Your notes" hint={notesSave.status === 'saved' ? 'Saved on this PC' : notesSave.status === 'failed' ? 'Not saved. Keep typing to try again.' : 'Saving…'} htmlFor="notes">
            <textarea id="notes" className="input selectable" value={notes} maxLength={20000} placeholder="Where you left off, tips, codes, mods…" onChange={(e) => { setNotesText(e.target.value); notesSave.edit(e.target.value); }} />
          </Field>
        </div>
      </div>
      <aside className="overview__side surface">
        <StatusPicker game={game} />
        <div className="field__label" style={{ marginBottom: 8 }}>Your rating</div>
        <Stars value={game.userRating} onChange={(v) => void setRating(game, v)} label="Your rating" />
        <dl className="facts">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt className="caps">{k}</dt>
              <dd className="selectable">{v}</dd>
            </div>
          ))}
          <div>
            <dt className="caps">Added to VYSTRAL</dt>
            <dd>{formatDate(game.added)}</dd>
          </div>
        </dl>
        <p className="provenance">
          {game.metadataSource ? <>Details from {game.metadataSource}.</> : <>Details come from your store apps.</>} Artwork and descriptions belong to their respective owners.
        </p>
      </aside>
    </div>
    <FranchiseTimeline params={{ gameId: game.id }} cacheKey={game.id} />
    </>
  );
}

function Sessions({ game }: { game: Game }) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const navigate = useStore((s) => s.navigate);
  useEffect(() => {
    let alive = true;
    call<Session[]>('sessions.list', { gameId: game.id, limit: 200 }).then((s) => alive && setSessions(s)).catch(() => alive && setSessions([]));
    return () => { alive = false; };
  }, [game.id, game.sessionCount]);

  if (!sessions) return <div className="skeleton" style={{ height: 160 }} />;
  if (!sessions.length)
    return <EmptyState icon={<Clock3 size={30} />} title="No tracked sessions yet" body="When you start this game from VYSTRAL (or anywhere else, with Settings › Launching & sessions › Games started outside VYSTRAL on), each session’s length — and, if enabled, its CPU/GPU load — is recorded here, on this PC only." />;

  return (
    <div className="sessions">
      {/* Track F: FPS before/after a GPU driver change for this game (renders nothing until there's a change). */}
      <DriverChangeCard gameId={game.id} hideWhenEmpty />
      {/* Track Y: driver and display at each session start, with changes marked (nothing until recorded). */}
      <HardwareTimeline gameId={game.id} hideWhenEmpty />
      {sessions.map((s) => {
        let perf: PerfSummary | null = null;
        try { perf = s.perfSummary ? JSON.parse(s.perfSummary) : null; } catch { perf = null; }
        return (
          <button key={s.id} className="session-row" onClick={() => perf && navigate({ name: 'performance', sessionId: s.id })} disabled={!perf}>
            <div>
              <div className="session-row__date">{formatDate(s.start, { dateStyle: 'medium', timeStyle: 'short' })}</div>
              <div className="stat__hint">{formatRelative(s.start)} <SessionOriginChip source={s.source} /></div>
            </div>
            <div className="num session-row__dur">{formatDuration(s.durationSeconds)}</div>
            <div className="session-row__perf">
              {perf?.gpuAvg != null && <Badge>GPU {Math.round(perf.gpuAvg)}%</Badge>}
              {perf?.cpuAvg != null && <Badge>CPU {Math.round(perf.cpuAvg)}%</Badge>}
              {perf?.gpuTempMaxC != null && <Badge>{Math.round(perf.gpuTempMaxC)}°C peak</Badge>}
              {perf && <BarChart3 size={16} aria-label="Open performance details" />}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function Versions({ game }: { game: Game }) {
  const toast = useStore((s) => s.toast);
  const refresh = useStore((s) => s.refreshLibrary);
  return (
    <div className="versions">
      <p className="stat__hint" style={{ marginBottom: 16 }}>
        Each store version keeps its own install details. {game.installations.length > 1 ? 'Choose which one Play uses by default.' : ''}
      </p>
      {game.installations.map((i) => (
        <VersionCard
          key={i.id}
          game={game}
          inst={i}
          onUnmerge={async () => {
            try {
              await call('game.unmerge', { installationId: i.id });
              toast({ tone: 'success', title: 'Separated into its own entry' });
              await refresh();
            } catch (err) {
              toast({ tone: 'danger', title: 'Couldn’t separate', body: errorMessage(err) });
            }
          }}
        />
      ))}
      {/* Track I: the same game's IDs on other stores, from Wikidata. */}
      <IdentityPanel game={game} />
      {/* Track D4: the same game's Steam, IGDB, RAWG, GOG and Wikidata IDs, how each was found, and "Fix match". */}
      <IdentityMatchCard game={game} />
    </div>
  );
}

function VersionCard({ game, inst, onUnmerge }: { game: Game; inst: Installation; onUnmerge: () => void }) {
  const [args, setArgs] = useState(inst.userLaunchArgs ?? '');
  const toast = useStore((s) => s.toast);
  const supportsArgs = inst.launchKind !== 'Uri' || inst.platform === 'steam';
  const preferred = game.preferredInstallationId === inst.id;
  const saveArgs = async () => {
    const value = args.trim() || null;
    try {
      const ok = await call<boolean>('game.setLaunchArgs', { installationId: inst.id, args: value });
      if (!ok) {
        toast({ tone: 'danger', title: 'Couldn’t save launch options', body: 'This version is no longer in your library. Rescan and try again.' });
        return;
      }
      // Keep the store in step so the next launch (and this card after a re-render) use the new value.
      useStore.getState().patchGame(game.id, { installations: game.installations.map((i) => (i.id === inst.id ? { ...i, userLaunchArgs: value } : i)) });
      void useStore.getState().refreshLibrary();
      toast({ tone: 'success', title: value ? 'Launch options saved' : 'Launch options cleared' });
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t save launch options', body: errorMessage(err) });
    }
  };
  return (
    <div className="version surface logo-host">
      <div className="version__head">
        <PlatformBadge platform={inst.platform} motion />
        {inst.state === 'installed' ? <Badge tone="ok">Installed</Badge> : inst.state === 'missing' ? <Badge tone="warn">Missing</Badge> : <Badge>Not installed</Badge>}
        {inst.noLongerOwned && <Badge tone="warn">No longer in your Steam library</Badge>}
        {preferred && <Badge tone="accent">Preferred</Badge>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {game.installations.length > 1 && !preferred && inst.state === 'installed' && <Button size="sm" variant="ghost" onClick={() => void setPreferred(game, inst.id)}>Make preferred</Button>}
          {game.installations.length > 1 && <HoldToConfirm size="sm" variant="ghost" holdFor="pad" icon={<Split size={14} />} onConfirm={onUnmerge}>Separate</HoldToConfirm>}
        </div>
      </div>
      <dl className="version__facts">
        <div><dt className="caps">Title in store</dt><dd>{inst.title}</dd></div>
        <div><dt className="caps">Location</dt><dd className="selectable truncate" title={inst.installPath ?? ''}>{inst.installPath ?? '—'}</dd></div>
        <div><dt className="caps">Size</dt><dd className="num">{formatBytes(inst.sizeBytes)}</dd></div>
        <div><dt className="caps">Starts via</dt><dd>{inst.launchKind === 'Uri' ? <span className="svc-name"><StoreLogo platform={inst.platform} size={14} decorative />{PLATFORM_NAMES[inst.platform]} (store app required)</span> : inst.launchKind === 'PackagedApp' ? 'Windows (Xbox app identity)' : 'Direct program launch'}</dd></div>
        <div><dt className="caps">Store ID</dt><dd className="num selectable">{inst.platformGameId}</dd></div>
        <PackageFacts inst={inst} />
        <div><dt className="caps">Last seen</dt><dd>{formatRelative(inst.lastSeen)}</dd></div>
      </dl>
      {supportsArgs && (
        <div className="version__args">
          <Field label="Launch options" hint="Passed to the game exactly as typed. Only use options the game or store documents." htmlFor={`args-${inst.id}`}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input id={`args-${inst.id}`} className="input num" value={args} maxLength={1024} placeholder="e.g. -fullscreen -dx12" onChange={(e) => setArgs(e.target.value)} />
              <Button onClick={saveArgs} disabled={(inst.userLaunchArgs ?? '') === args.trim()}>Save</Button>
            </div>
          </Field>
        </div>
      )}
    </div>
  );
}

function ArtworkTab({ game }: { game: Game }) {
  const toast = useStore((s) => s.toast);
  const refresh = useStore((s) => s.refreshLibrary);
  const userArt = useUserArt(game.id); // Track I
  const choose = async (kind: 'cover' | 'hero' | 'logo' | 'icon') => {
    try {
      if (await call<boolean>('game.chooseArtwork', { gameId: game.id, kind }, 300_000)) {
        await refresh();
        toast({ tone: 'success', title: 'Artwork updated' });
      }
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t use that image', body: errorMessage(err) });
    }
  };
  const slots: { kind: 'cover' | 'hero' | 'logo' | 'icon'; label: string; hint: string; ratio: string }[] = [
    { kind: 'cover', label: 'Cover', hint: 'Portrait, ideally 600×900', ratio: '2 / 3' },
    { kind: 'hero', label: 'Background', hint: 'Wide, ideally 1920×620 or larger', ratio: '16 / 7' },
    { kind: 'logo', label: 'Logo', hint: 'Transparent PNG', ratio: '16 / 7' },
    { kind: 'icon', label: 'Icon', hint: 'Square, ideally 256×256', ratio: '1 / 1' },
  ];
  return (
    <div className="art-slots">
      {slots.map((s) => (
        <div key={s.kind} className="art-slot">
          <div className="art-slot__preview" style={{ aspectRatio: s.ratio }}>
            {s.kind === 'logo' || s.kind === 'icon'
              ? (game.art[s.kind] ? <img src={game.art[s.kind]!} alt="" /> : <span className="stat__hint">No {s.kind}</span>)
              : <GameCover game={game} kind={s.kind} />}
          </div>
          <div className="art-slot__meta">
            <div className="field__label">{s.label}</div>
            <div className="stat__hint">{s.hint}</div>
          </div>
          <Button size="sm" icon={<ImagePlus size={14} />} onClick={() => void choose(s.kind)}>Choose image…</Button>
          <ArtSlotActions game={game} kind={s.kind} userArt={userArt} />
        </div>
      ))}
      <p className="provenance" style={{ gridColumn: '1 / -1' }}>Images you choose are copied into VYSTRAL’s private cache and always take priority. Store artwork is never replaced in the store itself.</p>
    </div>
  );
}

function Related({ game }: { game: Game }) {
  const games = useStore((s) => s.library.games);
  const related = useMemo(() => {
    const genres = new Set(game.genres);
    if (!genres.size) return [];
    return games
      .filter((g) => g.id !== game.id && !g.hidden)
      .map((g) => ({ g, score: g.genres.filter((x) => genres.has(x)).length + (isInstalled(g) ? 0.5 : 0) }))
      .filter((x) => x.score >= 1)
      .sort((a, b) => b.score - a.score || a.g.sortTitle.localeCompare(b.g.sortTitle))
      .slice(0, 6)
      .map((x) => x.g);
  }, [games, game]);
  if (!related.length) return null;
  return (
    <section style={{ marginTop: 'var(--s-12)' }}>
      <SectionHead title="More like this in your library" meta={`Sharing ${game.genres.slice(0, 2).join(' & ')}`} />
      <div className="related">
        {related.map((g) => <GameCard key={g.id} game={g} />)}
      </div>
    </section>
  );
}
