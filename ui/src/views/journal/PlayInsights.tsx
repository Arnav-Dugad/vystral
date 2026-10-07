import { useCallback, useMemo } from 'react';
import { motion } from 'motion/react';
import type { Game } from '../../bridge/types';
import { SectionHead } from '../../components/ui/primitives';
import { FinishingSoon } from '../../components/game/CompletionForecast';
import { formatDuration } from '../../lib/format';
import { HourHeatmap } from './HourHeatmap';
import { GenreStream } from './GenreStream';
import { genreDrift } from './genreDrift';
import { RANGE_DAYS, type JSession, type Range } from './stats';

const DAY = 86_400_000;

/**
 * Track Y Journal cards: when you play (hour of week, follows the range), how your genre mix drifted
 * over the past 12 months (independent of the range), and the games you're on pace to finish.
 */
export function PlayInsights({
  scoped, all, range, rangeText, now, gamesById, reveal,
}: {
  scoped: readonly JSession[];
  all: readonly JSession[];
  range: Range;
  rangeText: string;
  now: number;
  gamesById: Map<string, Game>;
  reveal: (i: number) => object;
}) {
  const genresOf = useCallback((id: string) => gamesById.get(id)?.genres, [gamesById]);
  const drift = useMemo(() => genreDrift(all, genresOf, now), [all, genresOf, now]);
  const weeks = useMemo(() => {
    if (range !== 'all') return RANGE_DAYS[range] / 7;
    const first = all[all.length - 1]?.startMs;
    return first ? Math.max(1, (now - first) / (7 * DAY)) : null;
  }, [range, all, now]);

  return (
    <>
      <motion.section className="surface vx-card" {...reveal(5)} aria-labelledby="jr-hours-title">
        <SectionHead title={<span id="jr-hours-title">When you play</span>} meta={`Hour of the week · ${rangeText}`} />
        <HourHeatmap sessions={scoped} rangeText={rangeText} weeks={weeks} />
      </motion.section>

      <div className="jr-grid jr-grid--y">
        <motion.section className="surface vx-card" {...reveal(6)} aria-labelledby="jr-drift-title">
          <SectionHead title={<span id="jr-drift-title">Genre drift</span>} meta="Tracked hours · past 12 months" />
          {drift.totalHours >= 1 ? (
            <>
              <GenreStream drift={drift} />
              <p className="jr-footnote">
                A game with several genres splits its hours equally between them, so every hour counts once and the stream’s height is your real playtime.
                {drift.untaggedHours >= 0.1 ? ` ${formatDuration(drift.untaggedHours * 3600)} from games without genre information isn’t shown.` : ''}
              </p>
            </>
          ) : (
            <p className="jr-muted">
              {drift.untaggedHours > 0
                ? 'The games you played in the past 12 months don’t have genre information yet.'
                : 'Not enough tracked play in the past 12 months to show how your genres change.'}
            </p>
          )}
        </motion.section>
        <motion.div {...reveal(6)} className="jr-finishing">
          <FinishingSoon sessions={all} now={now} gamesById={gamesById} />
        </motion.div>
      </div>
    </>
  );
}
