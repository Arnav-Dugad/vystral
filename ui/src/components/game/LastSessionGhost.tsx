import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { animate, motion, useMotionValue, useTransform } from 'motion/react';
import { call } from '../../bridge/bridge';
import type { Game, InsightSample, PerfSample, PerfSummary, Session } from '../../bridge/types';
import { chooseGhost, ghostCaption, ghostYAt, smoothPath, type Ghost } from '../../lib/ghost';
import { useHeroTrailer } from '../../lib/trailer/tint';
import { parsePerfSummary } from '../../views/perf/series';
import { useReducedMotion } from '../../state/store';
import './ghost.css';

interface GhostData {
  sessionId: string;
  ghost: Ghost;
  caption: string;
}

const VB_W = 1000;
const VB_H = 300;
/** A replay, not a chart: slow in, slow out. */
const REVEAL = { duration: 2.5, delay: 0.45, ease: [0.45, 0, 0.15, 1] as const };

const cache = new Map<string, GhostData | null>();

async function loadGhost(gameId: string): Promise<GhostData | null> {
  const list = await call<Session[]>('sessions.list', { gameId, limit: 8 });
  const last = (Array.isArray(list) ? list : [])
    .filter((s) => s.source === 'tracked' && s.end && s.durationSeconds > 0)
    .sort((a, b) => b.start.localeCompare(a.start))[0];
  if (!last) return null;
  if (cache.has(last.id)) return cache.get(last.id) ?? null;
  const summary: PerfSummary | null = parsePerfSummary(last.perfSummary);
  if (!summary) {
    cache.set(last.id, null);
    return null; // metrics weren't collected: nothing to replay
  }
  const insight = summary.fpsAvg != null ? await call<InsightSample[]>('sessions.insightSamples', { sessionId: last.id }).catch(() => null) : null;
  let ghost = chooseGhost({ summary, insight });
  if (!ghost) {
    const samples = await call<PerfSample[]>('sessions.samples', { sessionId: last.id }).catch(() => null);
    ghost = chooseGhost({ summary: { ...summary, fpsAvg: null }, samples });
  }
  const data = ghost ? { sessionId: last.id, ghost, caption: ghostCaption(last.durationSeconds, ghost.metric, summary) } : null;
  if (cache.size > 40) cache.delete(cache.keys().next().value as string);
  cache.set(last.id, data);
  return data;
}

/**
 * A faint replay of the last session's frame rate (or CPU/GPU load) behind the game page hero.
 * Drawn once, left to right over ~2.5 s, then still. Only real recorded samples are drawn; with
 * none, nothing appears. It steps aside while the hero trailer plays.
 */
export function LastSessionGhost({ game }: { game: Game }) {
  const reduce = useReducedMotion();
  const trailerVisible = useHeroTrailer((s) => s.visibleFor === game.id);
  const [data, setData] = useState<GhostData | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    loadGhost(game.id)
      .then((d) => alive && setData(d))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
    // A finished session changes these; refetch so the ghost is always the latest one.
  }, [game.id, game.sessionCount, game.lastTrackedPlay]);

  if (!data) return null;
  return <GhostPlot key={data.sessionId} data={data} reduce={reduce} hidden={trailerVisible} />;
}

function GhostPlot({ data, reduce, hidden }: { data: GhostData; reduce: boolean; hidden: boolean }) {
  const { ghost } = data;
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const paths = useMemo(() => ghost.segments.map((s) => smoothPath(s, VB_W, VB_H)).join(''), [ghost]);
  const plotRef = useRef<HTMLDivElement>(null);
  const size = useRef({ w: 0, h: 0 });
  const progress = useMotionValue(reduce ? 1 : 0);
  const [done, setDone] = useState(reduce);

  useLayoutEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      size.current = { w: r.width, h: r.height };
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (reduce) {
      progress.jump(1);
      setDone(true);
      return;
    }
    const controls = animate(progress, 1, { ...REVEAL, onComplete: () => setDone(true) });
    return () => controls.stop();
  }, [reduce, progress]);

  const clip = useTransform(progress, (p) => `inset(-24px ${((1 - p) * 100).toFixed(2)}% -24px -24px)`);
  const headX = useTransform(progress, (p) => p * size.current.w);
  const headY = useTransform(progress, (p) => (ghostYAt(ghost, p) ?? ghost.end.y) * size.current.h);
  const headOpacity = useTransform(progress, [0, 0.04, 0.9, 1], [0, 1, 1, 0]);

  return (
    <motion.div
      className="ghost"
      data-metric={ghost.metric}
      initial={false}
      animate={{ opacity: hidden ? 0 : 1 }}
      transition={reduce ? { duration: 0.15 } : { duration: hidden ? 0.6 : 1.1, ease: 'easeOut' }}
    >
      <div className="ghost__plot" ref={plotRef} aria-hidden>
        <motion.div className="ghost__clip" style={{ clipPath: clip }}>
          <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" focusable="false">
            <defs>
              <linearGradient id={`${uid}-g`} x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" stopColor="currentColor" stopOpacity="0" />
                <stop offset="0.3" stopColor="currentColor" stopOpacity="0.7" />
                <stop offset="1" stopColor="currentColor" stopOpacity="1" />
              </linearGradient>
            </defs>
            <path className="ghost__glow" d={paths} vectorEffect="non-scaling-stroke" />
            <path className="ghost__line" d={paths} stroke={`url(#${uid}-g)`} vectorEffect="non-scaling-stroke" />
          </svg>
        </motion.div>
        {!reduce && !done && <motion.span className="ghost__head" style={{ x: headX, y: headY, opacity: headOpacity }} />}
        <motion.span
          className="ghost__end"
          style={{ left: `${ghost.end.x * 100}%`, top: `${ghost.end.y * 100}%` }}
          initial={false}
          animate={{ opacity: done ? 1 : 0, scale: done ? 1 : 0.4 }}
          transition={reduce ? { duration: 0.15 } : { type: 'spring', visualDuration: 0.5, bounce: 0.3 }}
        />
      </div>
      <motion.p
        className="ghost__caption"
        initial={reduce ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reduce ? { duration: 0.15 } : { duration: 0.8, delay: REVEAL.delay + 0.6, ease: 'easeOut' }}
      >
        <span className="ghost__swatch" aria-hidden />
        {data.caption}
      </motion.p>
    </motion.div>
  );
}
