import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { ArrowDownToLine, Clock3, Gamepad2, HardDrive, Heart, ImageOff, Info, Play, Store, Timer, Trophy, History, Images, Lock, EyeOff } from 'lucide-react';
import { call } from '../../bridge/bridge';
import type { AchievementsResult, Game, GamepadButton, MediaItem, Session } from '../../bridge/types';
import {
  formatBytes, formatDate, formatDuration, formatRelative, importedMinutes, lastPlayed, PLATFORM_NAMES, sizeOf,
} from '../../lib/format';
import { haptic } from '../../lib/haptics';
import { pushPadHandler } from '../../lib/input';
import { ease, pick, spring } from '../../lib/motion';
import { moveFocus, type Dir } from '../../lib/spatial';
import { sound } from '../../lib/sound';
import { setLaunchOrigin } from '../../lib/flight';
import { formatPercent } from '../../lib/achievements';
import { shimmerTier } from '../../lib/shimmer';
import { isObserved } from '../../lib/sessions';
import { STATUS_META } from '../../lib/status';
import { toggleFavorite } from '../../state/actions';
import { useReducedMotion, useStore } from '../../state/store';
import { GameCover } from '../../components/game/GameCover';
import { GameLogo } from '../../components/game/GameLogo';
import { LastSessionGhost } from '../../components/game/LastSessionGhost';
import { SessionOriginChip } from '../../components/game/SessionOriginChip';
import { openInStore } from '../../components/game/InstallButton';
import { PadGlyph, PadHint } from '../../components/ui/primitives';
import { StoreLogo } from '../../components/ui/StoreLogo';
import '../../components/ui/shimmer.css';
import { playBurst } from './PlayBurst';

export type PageTab = 'overview' | 'achievements' | 'sessions' | 'media';
const TABS: { id: PageTab; label: string; icon: typeof Info }[] = [
  { id: 'overview', label: 'Overview', icon: Info },
  { id: 'achievements', label: 'Achievements', icon: Trophy },
  { id: 'sessions', label: 'Sessions', icon: History },
  { id: 'media', label: 'Media', icon: Images },
];

const KEY_DIRS: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

/**
 * The Immersive game page (Track L): a full-height sheet over the hero stage with four tabs —
 * Overview (Play, favourite, facts), Achievements (rarity shimmer on your rare unlocks),
 * Sessions (the last session's ghost line and recent sessions) and Media (your screenshots of
 * it, else its artwork). LB/RB (or Q/E) switch tabs, the D-pad/arrow keys move between controls,
 * Tab is trapped inside, B/Escape closes. It reads the game from the store, so favourite and
 * status changes show at once, and while it animates out it takes no input at all.
 */
export function GamePage({ gameId, tab, onTab, onClose }: { gameId: string; tab: PageTab; onTab: (t: PageTab) => void; onClose: () => void }) {
  const game = useStore((s) => s.gamesById.get(gameId) ?? null);
  const reduce = useReducedMotion();
  const present = useIsPresent();
  const uid = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const [dir, setDir] = useState(1);

  const switchTab = (next: PageTab) => {
    if (next === tab) return;
    setDir(TABS.findIndex((t) => t.id === next) > TABS.findIndex((t) => t.id === tab) ? 1 : -1);
    onTab(next);
    sound.select();
    haptic('tick');
  };
  const cycle = (d: 1 | -1) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = TABS[i + d];
    if (next) switchTab(next.id);
    else haptic('edge');
  };

  // Focus the first control of the tab (Play on Overview) once it renders.
  useEffect(() => {
    const t = window.setTimeout(() => {
      const card = cardRef.current;
      if (!card) return;
      const target = card.querySelector<HTMLElement>(`[data-tabpanel="${tab}"] [data-autofocus]`) ?? card.querySelector<HTMLElement>(`[data-tabpanel="${tab}"] button, [data-tabpanel="${tab}"] [tabindex="0"]`);
      (target ?? card.querySelector<HTMLElement>('[role=tab][aria-selected=true]'))?.focus({ preventScroll: true });
    }, 80);
    return () => window.clearTimeout(t);
  }, [tab]);

  // The page owns the controller while open: LB/RB tabs, B closes, LT/RT scroll; A and the D-pad
  // fall through to spatial navigation inside the dialog; everything else is swallowed so it can
  // never reach the hidden home rows or the desktop (command bar, history).
  const handleRef = useRef<(b: GamepadButton, repeat: boolean) => boolean>(() => true);
  useLayoutEffect(() => {
    handleRef.current = (button, repeat) => {
      if (!present) return true;
      switch (button) {
        case 'Up': case 'Down': case 'Left': case 'Right': return false;
        case 'A': return repeat;
        case 'B': if (!repeat) { sound.back(); onClose(); } return true;
        case 'LB': if (!repeat) cycle(-1); return true;
        case 'RB': if (!repeat) cycle(1); return true;
        case 'LT': case 'RT':
          cardRef.current?.querySelector<HTMLElement>('.imm-page__body')?.scrollBy({ top: (button === 'LT' ? -1 : 1) * innerHeight * 0.4, behavior: reduce ? 'auto' : 'smooth' });
          return true;
        default: return true;
      }
    };
  });
  useEffect(() => {
    if (!present) return;
    return pushPadHandler((b, r) => handleRef.current(b, r));
  }, [present]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!present) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      sound.back();
      return onClose();
    }
    if (e.key === 'Tab') return trapTab(e, cardRef.current);
    if ((e.key === 'q' || e.key === 'e') && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      return cycle(e.key === 'q' ? -1 : 1);
    }
    const d = KEY_DIRS[e.key];
    if (d) {
      e.preventDefault();
      if (!moveFocus(d)) haptic('edge');
    }
  };

  if (!game) return null;
  return (
    <motion.div
      className="imm-panel"
      data-dialog-open={present || undefined}
      inert={!present || undefined}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.2 } }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={game.title}
        className="imm-panel__card"
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 30, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.985, transition: { duration: 0.18, ease: ease.in } }}
        transition={pick(reduce, spring.hero)}
        onKeyDown={onKeyDown}
      >
        <div className="imm-panel__bg" aria-hidden>
          <GameCover game={game} kind="hero" />
        </div>
        <motion.div layoutId={`imm-cover-${game.id}`} className="imm-panel__cover" transition={pick(reduce, spring.hero)}>
          <GameCover game={game} />
        </motion.div>
        <div className="imm-panel__body">
          <div className="imm-page__head">
            {game.art.logo ? <GameLogo className="imm-panel__logo" src={game.art.logo} alt={game.title} /> : <h2 className="imm-panel__title">{game.title}</h2>}
            <div className="imm-page__tabs">
              <PadGlyph button="LB" />
              <div className="imm-page__tablist" role="tablist" aria-label="Game sections">
              {TABS.map((t) => {
                const Icon = t.icon;
                const selected = t.id === tab;
                return (
                  <button
                    key={t.id}
                    id={`${uid}-tab-${t.id}`}
                    type="button"
                    role="tab"
                    className="imm-page__tab"
                    aria-selected={selected}
                    aria-controls={`${uid}-panel`}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => switchTab(t.id)}
                  >
                    <Icon size="1em" aria-hidden /> {t.label}
                    {selected && <motion.span layoutId={`${uid}-tabbar`} className="imm-page__tabbar" transition={pick(reduce, spring.focus)} />}
                  </button>
                );
              })}
              </div>
              <PadGlyph button="RB" />
            </div>
          </div>
          <div className="imm-page__body" id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-tab-${tab}`}>
            <AnimatePresence mode="popLayout" initial={false} custom={dir}>
              <motion.div
                key={tab}
                data-tabpanel={tab}
                className="imm-page__pane"
                initial={reduce ? { opacity: 0 } : { opacity: 0, x: 40 * dir }}
                animate={{ opacity: 1, x: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, x: -30 * dir, transition: { duration: 0.14, ease: ease.in } }}
                transition={pick(reduce, spring.panel)}
              >
                {tab === 'overview' && <Overview game={game} onClose={onClose} onAchievements={() => switchTab('achievements')} />}
                {tab === 'achievements' && <Achievements game={game} />}
                {tab === 'sessions' && <Sessions game={game} />}
                {tab === 'media' && <Media game={game} />}
              </motion.div>
            </AnimatePresence>
          </div>
          <footer className="imm-page__hints" aria-hidden>
            <PadHint button="A">Select</PadHint>
            <PadHint button={['LB', 'RB']}>Sections</PadHint>
            <PadHint button="B">Back</PadHint>
          </footer>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ overview */

function Overview({ game, onClose, onAchievements }: { game: Game; onClose: () => void; onAchievements: () => void }) {
  const launchGame = useStore((s) => s.launchGame);
  // Track T: while this game runs, Play becomes Return to game (nothing new is launched).
  const running = useStore((s) => (s.launch && s.launch.gameId === game.id && ['starting', 'waiting', 'running'].includes(s.launch.phase) ? s.launch.phase : null));
  const reduce = useReducedMotion();
  const installed = game.installations.filter((i) => i.state === 'installed');
  const lp = lastPlayed(game);
  const imported = importedMinutes(game);
  const size = sizeOf(game);
  const steamInstall = game.installations.find((i) => i.platform === 'steam' && i.state !== 'installed' && /^\d{1,10}$/.test(i.platformGameId));
  const storeInst = game.installations.find((i) => i.platform !== 'manual' && i.state !== 'installed');
  const platforms = [...new Set(game.installations.map((i) => i.platform))];

  const stats = [
    { icon: <Clock3 size={18} />, label: 'Last played', value: lp.at ? formatRelative(lp.at) : 'Never' },
    { icon: <Timer size={18} />, label: 'Tracked', value: game.trackedSeconds ? formatDuration(game.trackedSeconds) : '—' },
    { icon: <Gamepad2 size={18} />, label: 'In store', value: imported ? formatDuration(imported * 60) : '—' },
    { icon: <HardDrive size={18} />, label: 'Size', value: size ? formatBytes(size) : '—' },
  ];

  return (
    <div className="imm-page__overview">
      <div className="imm__meta">
        <span className="imm__meta-stores">
          {platforms.map((p) => (
            <span key={p} className="imm__store">
              <StoreLogo platform={p} size={20} decorative />
              {PLATFORM_NAMES[p]}
            </span>
          ))}
        </span>
        {game.status && <span>{STATUS_META[game.status].label}</span>}
        {game.genres.length > 0 && <span className="imm__genres">{game.genres.slice(0, 3).join(' · ')}</span>}
      </div>
      {game.description && <p className="imm-panel__desc">{game.description}</p>}
      <div className="imm-panel__stats">
        {stats.map((s, i) => (
          <motion.div
            key={s.label}
            className="imm-panel__stat"
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...spring.panel, delay: 0.12 + i * 0.04 }}
          >
            {s.icon}
            <span className="imm-panel__stat-label">{s.label}</span>
            <span className="imm-panel__stat-value">{s.value}</span>
          </motion.div>
        ))}
      </div>
      <div className="imm-panel__actions">
        {running && (
          <button
            data-autofocus
            className="imm-btn imm-btn--primary"
            onClick={() => {
              haptic('confirm');
              if (running !== 'running') {
                useStore.getState().toast({ tone: 'info', title: `${game.title} is still starting`, body: 'It comes to the front by itself once its window opens.' });
                return;
              }
              void call<boolean>('game.focus').then((ok) => {
                if (ok === false) useStore.getState().toast({ tone: 'info', title: `Couldn’t switch to ${game.title}`, body: 'Windows didn’t let VYSTRAL bring it forward. Use Alt+Tab to switch to it.' });
              }).catch(() => {});
            }}
          >
            <Gamepad2 size="1.1em" /> {running === 'running' ? 'Return to game' : 'Starting…'}
          </button>
        )}
        {installed.length === 0 && <p className="imm__warn">This game isn’t installed on this PC.</p>}
        {!running && installed.map((i, idx) => (
          <button
            key={i.id}
            data-autofocus={idx === 0 || undefined}
            className="imm-btn imm-btn--primary"
            onClick={(e) => {
              setLaunchOrigin(game.id, e.currentTarget);
              playBurst(e.currentTarget);
              sound.launch();
              haptic('confirm');
              onClose();
              void launchGame(game.id, i.id);
            }}
          >
            <Play size="1.1em" fill="currentColor" /> {installed.length > 1 ? `Play on ${PLATFORM_NAMES[i.platform]}` : 'Play'}
          </button>
        ))}
        {installed.length === 0 && steamInstall && (
          <button
            className="imm-btn imm-btn--primary"
            data-autofocus
            onClick={() => {
              sound.select();
              void call('steam.install', { gameId: game.id }).catch((err) =>
                useStore.getState().toast({ tone: 'danger', title: 'Steam couldn’t be asked to install it', body: String((err as Error)?.message ?? err) }),
              );
            }}
          >
            <ArrowDownToLine size="1.1em" /> Install with Steam
          </button>
        )}
        {installed.length === 0 && !steamInstall && storeInst && (
          <button className="imm-btn" data-autofocus onClick={() => openInStore(storeInst)}>
            <Store size="1.1em" /> Get it in {PLATFORM_NAMES[storeInst.platform]}
          </button>
        )}
        <button
          className="imm-btn"
          data-autofocus={(installed.length === 0 && !steamInstall && !storeInst) || undefined}
          onClick={() => void toggleFavorite(game)}
          aria-pressed={game.favorite}
        >
          <Heart size="1em" fill={game.favorite ? 'currentColor' : 'none'} /> {game.favorite ? 'Favorite' : 'Add to favorites'}
        </button>
        <button className="imm-btn imm-btn--ghost" onClick={onClose}>
          <PadHint button="B">Back</PadHint>
        </button>
      </div>
      <AchievementShowcase game={game} onOpen={onAchievements} />
    </div>
  );
}

/* ------------------------------------------------------------------ achievement showcase (Track T) */

const achCache = new Map<string, { at: number; p: Promise<AchievementsResult> }>();
/** One request per game per minute, shared by the showcase and the Achievements tab. */
function achievementsFor(gameId: string): Promise<AchievementsResult> {
  const hit = achCache.get(gameId);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  const p = call<AchievementsResult>('steam.achievements', { gameId }, 120_000);
  achCache.set(gameId, { at: Date.now(), p });
  p.catch(() => achCache.delete(gameId));
  return p;
}

/** Progress ring + your three rarest unlocks, for Steam games with achievements. Nothing otherwise. */
function AchievementShowcase({ game, onOpen }: { game: Game; onOpen: () => void }) {
  const steam = game.installations.some((i) => i.platform === 'steam');
  const reduce = useReducedMotion();
  const [data, setData] = useState<AchievementsResult | null>(null);
  useEffect(() => {
    if (!steam) return;
    let alive = true;
    achievementsFor(game.id)
      .then((d) => alive && setData(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [game.id, steam]);
  const rarest = useMemo(
    () => (data?.achievements ?? []).filter((a) => a.achieved).sort((a, b) => (a.globalPercent ?? 101) - (b.globalPercent ?? 101)).slice(0, 3),
    [data],
  );
  if (!data || data.status !== 'ok' || data.total === 0) return null;
  const fraction = data.unlocked / data.total;
  const C = 2 * Math.PI * 16;
  return (
    <motion.div
      className="imm-show"
      initial={reduce ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...spring.panel, delay: 0.2 }}
    >
      <span className="imm-show__ring" role="img" aria-label={`${data.unlocked} of ${data.total} achievements unlocked`}>
        <svg viewBox="0 0 40 40" aria-hidden>
          <circle className="imm-show__track" cx="20" cy="20" r="16" />
          <motion.circle
            className="imm-show__arc"
            cx="20"
            cy="20"
            r="16"
            strokeDasharray={C}
            initial={{ strokeDashoffset: reduce ? C * (1 - fraction) : C }}
            animate={{ strokeDashoffset: C * (1 - fraction) }}
            transition={reduce ? { duration: 0 } : { duration: 1.1, ease: ease.out, delay: 0.3 }}
          />
        </svg>
        <span className="imm-show__pct num" aria-hidden>{Math.round(fraction * 100)}%</span>
      </span>
      <span className="imm-show__text">
        <span className="imm-show__title num">{data.unlocked} of {data.total} achievements</span>
        <span className="imm-show__sub">
          {rarest[0] ? `Rarest: ${rarest[0].name}${rarest[0].globalPercent != null ? ` (${formatPercent(rarest[0].globalPercent)} of players)` : ''}` : 'None unlocked yet — plenty to find.'}
        </span>
      </span>
      {rarest.length > 0 && (
        <span className="imm-show__list" aria-hidden>
          {rarest.map((a) => (
            <span key={a.apiName} className="imm-show__item" data-tier={shimmerTier(a.globalPercent) ?? undefined}>
              {a.icon ? <img src={a.icon} alt="" loading="lazy" /> : <Trophy size="1.2em" />}
            </span>
          ))}
        </span>
      )}
      <button type="button" className="imm-show__more" onClick={onOpen}>
        <Trophy size="1em" aria-hidden /> See all
      </button>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ achievements */

type Load<T> = { kind: 'loading' } | { kind: 'error' } | { kind: 'done'; data: T };

const ACH_MESSAGES: Partial<Record<AchievementsResult['status'], string>> = {
  notSteam: 'Achievements are shown for Steam games. This one isn’t from Steam.',
  notConnected: 'Connect your Steam Web API key in desktop mode (Settings › Library & stores) to see achievements here.',
  noAccount: 'Sign in to Steam once on this PC, then come back.',
  localOnly: 'Offline mode is on, and no achievements were saved on this PC for this game yet.',
  private: 'Steam only shares achievements when your profile’s Game details are public.',
  none: 'This game has no achievements on Steam.',
  error: 'Steam didn’t return achievements. Try again in a little while.',
};

function Achievements({ game }: { game: Game }) {
  const [state, setState] = useState<Load<AchievementsResult>>({ kind: 'loading' });
  const steam = game.installations.some((i) => i.platform === 'steam');
  useEffect(() => {
    let alive = true;
    if (!steam) {
      setState({ kind: 'done', data: { status: 'notSteam', message: null, fetchedAt: null, achievements: [], unlocked: 0, total: 0 } });
      return;
    }
    achievementsFor(game.id)
      .then((data) => alive && setState({ kind: 'done', data }))
      .catch(() => alive && setState({ kind: 'error' }));
    return () => {
      alive = false;
    };
  }, [game.id, steam]);

  const list = useMemo(() => {
    if (state.kind !== 'done') return [];
    // Unlocked first (rarest first), then locked by how many players have them.
    return [...state.data.achievements].sort(
      (a, b) => Number(b.achieved) - Number(a.achieved) || (a.globalPercent ?? 101) - (b.globalPercent ?? 101) || a.name.localeCompare(b.name),
    );
  }, [state]);

  if (state.kind === 'loading') return <p className="imm-page__note" role="status">Loading achievements…</p>;
  if (state.kind === 'error') return <p className="imm-page__note">{ACH_MESSAGES.error}</p>;
  const { data } = state;
  if (data.status !== 'ok' || data.total === 0) return <p className="imm-page__note">{data.message ?? ACH_MESSAGES[data.status] ?? ACH_MESSAGES.none}</p>;
  const fraction = data.total ? data.unlocked / data.total : 0;
  return (
    <div className="imm-ach">
      <div className="imm-ach__summary">
        <span className="imm-ach__count num">{data.unlocked}<span> / {data.total}</span></span>
        <span className="imm-ach__bar" role="progressbar" aria-label="Achievements unlocked" aria-valuemin={0} aria-valuemax={data.total} aria-valuenow={data.unlocked}>
          <span style={{ transform: `scaleX(${fraction})` }} />
        </span>
        <span className="imm-ach__pct num">{Math.round(fraction * 100)}%</span>
      </div>
      <div className="imm-ach__grid">
        {list.map((a, i) => {
          const tier = a.achieved ? shimmerTier(a.globalPercent) : null;
          const hidden = a.hidden && !a.achieved;
          const label = `${hidden ? 'Hidden achievement' : a.name}, ${a.achieved ? `unlocked ${a.unlockedAt ? formatDate(a.unlockedAt) : ''}` : 'locked'}${a.globalPercent != null ? `, ${formatPercent(a.globalPercent)} of players` : ''}`;
          return (
            <div
              key={a.apiName}
              tabIndex={0}
              role="group"
              aria-label={label}
              className={`imm-ach__item ${tier && tier !== 'common' ? 'shimmer' : ''}`}
              data-tier={tier ?? undefined}
              data-achieved={a.achieved}
              style={{ ['--shimmer-delay' as string]: `${0.25 + Math.min(i, 12) * 0.07}s` }}
            >
              <span className="imm-ach__icon" aria-hidden>
                {a.icon && !hidden ? <img src={a.icon} alt="" loading="lazy" /> : hidden ? <EyeOff size="1.2em" /> : a.achieved ? <Trophy size="1.2em" /> : <Lock size="1.2em" />}
              </span>
              <span className="imm-ach__text" aria-hidden>
                <span className="imm-ach__name">{hidden ? 'Hidden achievement' : a.name}</span>
                <span className="imm-ach__meta">
                  {a.globalPercent != null && <span className="num">{formatPercent(a.globalPercent)}</span>}
                  {tier === 'ultra' ? ' · Ultra rare' : tier === 'rare' ? ' · Rare' : ''}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ sessions */

function Sessions({ game }: { game: Game }) {
  const [state, setState] = useState<Load<Session[]>>({ kind: 'loading' });
  useEffect(() => {
    let alive = true;
    call<Session[]>('sessions.list', { gameId: game.id, limit: 12 })
      .then((list) => alive && setState({ kind: 'done', data: (Array.isArray(list) ? list : []).filter((s) => isObserved(s.source)) }))
      .catch(() => alive && setState({ kind: 'error' }));
    return () => {
      alive = false;
    };
  }, [game.id, game.sessionCount]);
  return (
    <div className="imm-sessions">
      <div className="imm-sessions__ghost">
        <span className="imm-sessions__caption">Last session</span>
        <LastSessionGhost game={game} />
      </div>
      {state.kind === 'loading' && <p className="imm-page__note" role="status">Loading sessions…</p>}
      {state.kind === 'error' && <p className="imm-page__note">Sessions couldn’t be loaded.</p>}
      {state.kind === 'done' && state.data.length === 0 && <p className="imm-page__note">No sessions recorded by VYSTRAL yet. Play it from here and they appear.</p>}
      {state.kind === 'done' && state.data.length > 0 && (
        <ul className="imm-sessions__list">
          {state.data.map((s) => (
            <li key={s.id} tabIndex={0} className="imm-sessions__item" aria-label={`${formatDate(s.start, { dateStyle: 'medium', timeStyle: 'short' })}, ${formatDuration(s.durationSeconds)}`}>
              <span className="imm-sessions__when">{formatRelative(s.start)}</span>
              <span className="imm-sessions__len num">{formatDuration(s.durationSeconds)}</span>
              <SessionOriginChip source={s.source} compact />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ media */

function Media({ game }: { game: Game }) {
  const momentsOn = useStore((s) => !!s.settings?.['moments.enabled']);
  const [shots, setShots] = useState<MediaItem[] | null>(null);
  useEffect(() => {
    if (!momentsOn) {
      setShots([]);
      return;
    }
    let alive = true;
    call<MediaItem[]>('media.list')
      .then((items) => alive && setShots(items.filter((i) => i.gameId === game.id && i.kind === 'image').slice(0, 24)))
      .catch(() => alive && setShots([]));
    return () => {
      alive = false;
    };
  }, [game.id, momentsOn]);

  const art = [
    game.art.hero && { src: game.art.hero, label: 'Hero art' },
    game.art.cover && { src: game.art.cover, label: 'Cover' },
    game.art.header && { src: game.art.header, label: 'Header' },
  ].filter(Boolean) as { src: string; label: string }[];

  if (shots === null) return <p className="imm-page__note" role="status">Loading media…</p>;
  const items = shots.length ? shots.map((s) => ({ src: s.thumbUrl || s.url, label: `Screenshot, ${formatRelative(s.modifiedAt)}` })) : art;
  return (
    <div className="imm-media">
      <p className="imm-page__note">
        {shots.length ? `Your screenshots of ${game.title}` : momentsOn ? 'No screenshots of this game yet — here is its artwork.' : 'Turn on Moments in desktop mode to see your screenshots here. Its artwork:'}
      </p>
      {items.length === 0 ? (
        <p className="imm-page__note"><ImageOff size="1em" aria-hidden /> No artwork for this game.</p>
      ) : (
        <div className="imm-media__grid">
          {items.map((m, i) => (
            <div key={`${m.src}-${i}`} className="imm-media__item" tabIndex={0} role="img" aria-label={m.label}>
              <img src={m.src} alt="" loading="lazy" decoding="async" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function trapTab(e: ReactKeyboardEvent, root: HTMLElement | null) {
  if (!root) return;
  const items = [...root.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), [tabindex="0"]')].filter((el) => !el.closest('[inert]'));
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
