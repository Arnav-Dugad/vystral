import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import {
  CalendarHeart, CalendarRange, Clapperboard, Compass, Crown, Flag, Flame, Gauge, History, Layers, Lock, Moon, Rabbit, Repeat, Shapes, Snowflake, Sofa,
  Sunrise, Tag, Timer, Trophy, Undo2,
} from 'lucide-react';
import type { Game, Session } from '../../bridge/types';
import { spring } from '../../lib/motion';
import { useReducedMotion, useStore } from '../../state/store';
import { openReplay } from '../../state/recap';
import { IconButton, Skeleton } from '../../components/ui/primitives';
import { GameThumb } from '../perf/kit';
import { gameTitle, shortDate, timeOfDay } from '../perf/text';
import { computeRecords, improvedSince, RECORD_IDS, scoresOf, unlockedSince, type PersonalRecord, type RecordId, type Records } from './records';
import { recordText } from './recordText';
import { useRecordContext } from './useRecordContext';
import { sound } from '../../lib/sound';
import './records.css';

const SEEN_KEY = 'vystral.records.seen';

const ICONS: Record<RecordId, ReactNode> = {
  longestSession: <Timer aria-hidden />,
  bestDay: <CalendarHeart aria-hidden />,
  bestWeek: <Layers aria-hidden />,
  varietyWeek: <Compass aria-hidden />,
  streak: <Flame aria-hidden />,
  nightOwl: <Moon aria-hidden />,
  earlyBird: <Sunrise aria-hidden />,
  comeback: <Undo2 aria-hidden />,
  first: <Flag aria-hidden />,
  // Track D1
  weekendWarrior: <Sofa aria-hidden />,
  marathonMonth: <CalendarRange aria-hidden />,
  gameStreak: <Repeat aria-hidden />,
  varietyMonth: <Shapes aria-hidden />,
  achievementDay: <Trophy aria-hidden />,
  speedrun: <Rabbit aria-hidden />,
  century: <Crown aria-hidden />,
  genreHours: <Tag aria-hidden />,
  oldestGame: <History aria-hidden />,
  bestFps: <Gauge aria-hidden />,
  coolest: <Snowflake aria-hidden />,
};

/** Each badge has its own hue, so the collection reads as a set of distinct medals. */
const HUE: Record<RecordId, number> = {
  longestSession: 292, bestDay: 20, bestWeek: 55, varietyWeek: 158, streak: 40, nightOwl: 262, earlyBird: 80, comeback: 200, first: 320,
  // Track D1
  weekendWarrior: 340, marathonMonth: 10, gameStreak: 30, varietyMonth: 175, achievementDay: 70, speedrun: 130, century: 88, genreHours: 305,
  oldestGame: 45, bestFps: 225, coolest: 210,
};

/** Track D1: badges whose unlock fanfare already played in this app session (it plays once). */
const fanfared = new Set<RecordId>();

function readSeen(): Partial<Record<RecordId, number>> | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function writeSeen(records: Records) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(scoresOf(records)));
  } catch {
    // storage unavailable: the "New" ribbons just show again next time
  }
}

/** When a record was set, in words: one day, a week, or a streak's span. */
function whenText(id: RecordId, r: PersonalRecord): string {
  if (id === 'streak' && r.until != null) return `${shortDate(r.at)} – ${shortDate(r.until, true)}`;
  if ((id === 'bestWeek' || id === 'varietyWeek') && r.until != null) return `Week of ${shortDate(r.at, true)}`;
  // The badge's value is already the date: say the time instead.
  if (id === 'first' || id === 'century') return `At ${timeOfDay(r.at)}`;
  // Track D1
  if (id === 'weekendWarrior') return `Weekend of ${shortDate(r.at, true)}`;
  if (id === 'gameStreak' && r.until != null) return `${shortDate(r.at)} – ${shortDate(r.until, true)}`;
  if (id === 'marathonMonth' || id === 'varietyMonth') return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(r.at);
  if (id === 'speedrun') return `Finished ${shortDate(r.at, true)}`;
  if (id === 'oldestGame') return `First played ${shortDate(r.at, true)}`;
  return shortDate(r.at, true);
}

/**
 * Track C6: personal records as collectible badges. Each earned badge mints itself in (a tasteful flip and glint),
 * names the game and the date, and opens that day in the timeline; a record beaten since your last visit wears a
 * "New" ribbon. Locked badges say how to earn them.
 */
export function RecordsPanel({ sessions, status, gamesById }: { sessions: Session[]; status: 'loading' | 'ready' | 'error'; gamesById: Map<string, Game> }) {
  const reduce = useReducedMotion();
  const ctx = useRecordContext(gamesById);
  const records = useMemo(() => computeRecords(sessions, ctx), [sessions, ctx]);
  // "New since last visit" is decided once per visit, then the current scores are remembered.
  const seenAtOpen = useRef(readSeen());
  const fresh = useMemo(() => improvedSince(records, seenAtOpen.current), [records]);
  useEffect(() => {
    if (status !== 'ready') return;
    const t = window.setTimeout(() => writeSeen(records), 1200);
    return () => window.clearTimeout(t);
  }, [records, status]);
  // Track D1: a badge earned since the last visit gets a one-time fanfare — a metallic glint across it and a soft chime
  // (only with interface sounds on; reduced motion keeps the chime and drops the sweep).
  const unlocked = useMemo(() => (status === 'ready' ? unlockedSince(records, seenAtOpen.current).filter((id) => !fanfared.has(id)) : []), [records, status]);
  const [fanfare, setFanfare] = useState<ReadonlySet<RecordId>>(() => new Set());
  useEffect(() => {
    if (!unlocked.length) return;
    for (const id of unlocked) fanfared.add(id);
    setFanfare((cur) => new Set([...cur, ...unlocked]));
    writeSeen(records); // it plays once, even if the page is left at once
    const t = window.setTimeout(() => sound.chime(), reduce ? 150 : 900);
    return () => window.clearTimeout(t);
  }, [unlocked, records, reduce]);

  if (status === 'loading') {
    return (
      <div className="jr-recs__grid" role="status" aria-label="Loading your records">
        {RECORD_IDS.map((id) => <Skeleton key={id} height={232} radius={22} />)}
      </div>
    );
  }

  const earned = RECORD_IDS.filter((id) => records[id]).length;
  return (
    <section className="jr-recs" aria-labelledby="jr-recs-title">
      <header className="jr-recs__head">
        <div>
          <h2 id="jr-recs-title" className="jr-recs__title">Personal records</h2>
          <p className="jr-muted">
            {earned === 0 ? 'Your first finished session starts the collection.' : `${earned} of ${RECORD_IDS.length} badges collected. Beat one and it updates by itself.`}
          </p>
        </div>
        <div className="jr-recs__meter" role="img" aria-label={`${earned} of ${RECORD_IDS.length} badges collected`}>
          {RECORD_IDS.map((id) => <span key={id} data-on={!!records[id] || undefined} style={{ ['--hue' as string]: HUE[id] }} />)}
        </div>
      </header>
      <ol className="jr-recs__grid">
        {RECORD_IDS.map((id, i) => (
          <Badge key={id} id={id} r={records[id]} game={records[id]?.gameId ? gamesById.get(records[id]!.gameId!) : undefined} index={i} isNew={fresh.has(id)} reduce={reduce} fanfare={fanfare.has(id)} />
        ))}
      </ol>
      <p className="jr-footnote">
        Records come only from finished sessions VYSTRAL recorded, in your time zone. A game that’s still running, and playtime your stores report, don’t count. A session past midnight counts for both days.
        {' '}Achievement, genre and release-year badges also read your achievements and library; frame-rate and temperature badges count sessions of 20 minutes or more; Speedrunner compares your tracked play with IGDB’s time to beat, when you have one.
      </p>
    </section>
  );
}

function Badge({ id, r, game, index, isNew, reduce, fanfare }: { id: RecordId; r: PersonalRecord | undefined; game: Game | undefined; index: number; isNew: boolean; reduce: boolean; fanfare: boolean }) {
  const copy = recordText(id, r);
  const style = { ['--hue' as string]: HUE[id], ['--i' as string]: index } as React.CSSProperties;
  const entrance = {
    initial: reduce ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.96 },
    animate: { opacity: 1, y: 0, scale: 1 },
    transition: reduce ? { duration: 0.15 } : { ...spring.page, delay: 0.05 + index * 0.055 },
  };

  if (!r) {
    return (
      <motion.li className="jr-rec" data-locked style={style} {...entrance}>
        <div className="jr-rec__card" role="group" aria-label={`${copy.name}, not earned yet. ${copy.what}. ${copy.locked}`}>
          <span className="jr-rec__medal" aria-hidden>
            <span className="jr-rec__face">{ICONS[id]}</span>
            <span className="jr-rec__lock"><Lock /></span>
          </span>
          <span className="jr-rec__name">{copy.name}</span>
          <span className="jr-rec__what caps">{copy.what}</span>
          <span className="jr-rec__hint">{copy.locked}</span>
        </div>
      </motion.li>
    );
  }

  const title = r.gameId ? gameTitle(game) : null;
  const when = whenText(id, r);
  const openDay = () => useStore.getState().navigate({ name: 'journal', tab: 'sessions', day: r.day });
  return (
    <motion.li className="jr-rec" data-new={isNew || undefined} data-fanfare={fanfare || undefined} style={style} {...entrance}>
      {fanfare && !reduce && <span className="jr-rec__fanfare" aria-hidden />}
      <button
        type="button"
        className="jr-rec__card"
        onClick={openDay}
        aria-label={`${copy.name}${isNew ? ', new record' : ''}. ${copy.what}: ${copy.value}${title ? `, ${title}` : ''}, ${when}. Show this day in your timeline`}
      >
        <span className="jr-rec__medal" aria-hidden>
          <span className="jr-rec__face">{ICONS[id]}</span>
          <span className="jr-rec__glint" />
        </span>
        {isNew && <span className="jr-rec__new" aria-hidden>New record</span>}
        <span className="jr-rec__name">{copy.name}</span>
        <span className="jr-rec__what caps">{copy.what}</span>
        <span className="jr-rec__value num">{copy.value}</span>
        <span className="jr-rec__meta">
          {r.gameId && <GameThumb game={game} size={20} />}
          <span className="jr-rec__meta-text">
            {title && <span className="jr-rec__game truncate">{title}</span>}
            <span className="jr-rec__when num">{when}</span>
          </span>
        </span>
      </button>
      {r.sessionId && (
        <IconButton label={`Replay the session behind ${copy.name}`} size="sm" className="jr-rec__replay" onClick={() => openReplay(r.sessionId!)}>
          <Clapperboard size={14} />
        </IconButton>
      )}
    </motion.li>
  );
}

