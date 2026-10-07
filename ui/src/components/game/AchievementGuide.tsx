import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, Eye, EyeOff, Lock, Pin, PinOff, Target, Trophy, X } from 'lucide-react';
import { call, errorMessage, on } from '../../bridge/bridge';
import type { AchievementGuide as Guide, Game, GuideAchievement } from '../../bridge/types';
import { commonness, formatPercent } from '../../lib/steamExtras';
import { spring } from '../../lib/motion';
import { useReducedMotion, useStore } from '../../state/store';
import { Skeleton } from '../ui/primitives';
import './steam-extras.css';

/** Pins (or clears) a goal and tells every surface showing it. */
async function pinGoal(gameId: string, apiName: string | null): Promise<GuideAchievement | null> {
  return call<GuideAchievement | null>('achievements.setGoal', { gameId, apiName });
}

/**
 * Track W: the achievement guide beside the Achievements tab. Locked achievements, easiest first (the
 * highest share of Steam players), hidden ones kept secret until you ask, and one pinned "Current goal"
 * that shows by the Play button. Uses the same cached achievement data as the tab.
 */
export function AchievementGuidePanel({ game }: { game: Game }) {
  const [guide, setGuide] = useState<Guide | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string | null>>({});
  const toast = useStore((s) => s.toast);
  const reduce = useReducedMotion();

  const load = useCallback(async () => {
    try {
      setGuide(await call<Guide>('achievements.guide', { gameId: game.id }, 120_000));
    } catch {
      setGuide(null);
    }
  }, [game.id]);

  useEffect(() => {
    setGuide(null);
    setRevealed({});
    void load();
    const offs = [
      on('steam.achievementsUpdated', () => void load()),
      on('achievements.goalChanged', (e) => { if (e?.gameId === game.id) setGuide((g) => (g ? { ...g, goal: e.goal } : g)); }),
    ];
    return () => offs.forEach((off) => off());
  }, [game.id, load]);

  if (!guide) {
    return (
      <aside className="achguide surface" aria-busy="true" aria-label="Loading the achievement guide">
        <Skeleton width="60%" height={16} />
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={52} radius={12} />)}
      </aside>
    );
  }
  if (guide.status !== 'ok' || guide.total === 0) return null;

  const pin = async (a: GuideAchievement | null) => {
    try {
      const goal = await pinGoal(game.id, a?.apiName ?? null);
      setGuide((g) => (g ? { ...g, goal } : g));
      if (a) toast({ tone: 'success', title: 'Current goal set', body: `${a.name} now shows by the Play button.` });
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t pin that goal', body: errorMessage(err) });
    }
  };
  const reveal = async (a: GuideAchievement) => {
    try {
      const r = await call<{ description: string | null }>('achievements.reveal', { gameId: game.id, apiName: a.apiName });
      setRevealed((m) => ({ ...m, [a.apiName]: r.description }));
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t reveal it', body: errorMessage(err) });
    }
  };

  const left = guide.total - guide.unlocked;
  return (
    <aside className="achguide surface" aria-labelledby="achguide-title">
      <header className="achguide__head">
        <span className="caps achguide__eyebrow"><Target size={13} aria-hidden /> Achievement guide</span>
        <h2 id="achguide-title" className="achguide__title">{left === 0 ? 'Everything unlocked' : 'Next to aim for'}</h2>
        <p className="achguide__sub">
          {left === 0 ? 'You have every achievement in this game.' : `${left.toLocaleString()} left · easiest first, by how many Steam players have them.`}
        </p>
      </header>

      {guide.goal && <GoalCard goal={guide.goal} onClear={() => void pin(null)} />}

      {guide.next.length > 0 && (
        <ol className="achguide__list" aria-label="Locked achievements, easiest first">
          <AnimatePresence initial={false}>
            {guide.next.map((a, i) => {
              const isGoal = guide.goal?.apiName === a.apiName;
              const secret = a.hidden && a.description == null && !(a.apiName in revealed);
              const description = a.apiName in revealed ? revealed[a.apiName] : a.description;
              const c = commonness(a.globalPercent);
              return (
                <motion.li
                  key={a.apiName}
                  className="achguide__item"
                  data-goal={isGoal || undefined}
                  layout={reduce ? false : 'position'}
                  initial={reduce ? false : { opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={reduce ? { duration: 0.15 } : { ...spring.panel, delay: Math.min(i, 10) * 0.03 }}
                >
                  <span className="achguide__icon" aria-hidden>
                    {a.icon ? <img src={a.icon} alt="" loading="lazy" draggable={false} /> : secret ? <EyeOff size={18} /> : <Lock size={16} />}
                  </span>
                  <span className="achguide__text">
                    <span className="achguide__name">
                      {a.name}
                      {a.hidden && <span className="achguide__tag">Hidden</span>}
                    </span>
                    <span className="achguide__desc">
                      {secret ? (
                        <button type="button" className="achguide__reveal" onClick={() => void reveal(a)}>
                          <Eye size={13} aria-hidden /> Reveal what it asks (spoiler)
                        </button>
                      ) : description || <em>No description</em>}
                    </span>
                    <span className="achguide__rarity" data-tone={c.tone}>
                      {a.globalPercent != null && (
                        <span className="achguide__bar" aria-hidden><span style={{ transform: `scaleX(${Math.max(0.02, Math.min(1, a.globalPercent / 100))})` }} /></span>
                      )}
                      <span>{a.globalPercent != null ? <><span className="num">{formatPercent(a.globalPercent)}</span> of players · {c.label}</> : c.label}</span>
                    </span>
                  </span>
                  <button
                    type="button"
                    className="achguide__pin"
                    aria-pressed={isGoal}
                    aria-label={isGoal ? `Unpin ${a.name} as your current goal` : `Pin ${a.name} as your current goal`}
                    title={isGoal ? 'Current goal' : 'Make this your current goal'}
                    onClick={() => void pin(isGoal ? null : a)}
                  >
                    {isGoal ? <PinOff size={15} /> : <Pin size={15} />}
                  </button>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ol>
      )}
      {guide.hiddenLocked > 0 && (
        <p className="achguide__note"><EyeOff size={12} aria-hidden /> {guide.hiddenLocked} hidden {guide.hiddenLocked === 1 ? 'achievement keeps its' : 'achievements keep their'} details secret until you reveal or unlock {guide.hiddenLocked === 1 ? 'it' : 'them'}.</p>
      )}
    </aside>
  );
}

function GoalCard({ goal, onClear }: { goal: GuideAchievement; onClear: () => void }) {
  return (
    <div className="achguide__goal" data-done={goal.achieved || undefined}>
      <span className="achguide__icon achguide__icon--goal" aria-hidden>
        {goal.icon ? <img src={goal.icon} alt="" draggable={false} /> : goal.achieved ? <Trophy size={18} /> : <Target size={18} />}
      </span>
      <span className="achguide__text">
        <span className="caps">{goal.achieved ? 'Goal reached' : 'Current goal'}</span>
        <span className="achguide__name">{goal.name}</span>
        {goal.globalPercent != null && <span className="achguide__desc"><span className="num">{formatPercent(goal.globalPercent)}</span> of players have it</span>}
      </span>
      <button type="button" className="achguide__pin" aria-label={`Clear ${goal.name} as your current goal`} title="Clear goal" onClick={onClear}>
        <X size={15} />
      </button>
    </div>
  );
}

/**
 * Track W: the pinned goal next to the Play button. Read from VYSTRAL's cache only (never asks Steam);
 * "Goal reached" once it's unlocked. Opens the Achievements tab.
 */
export function CurrentGoalChip({ game, onOpen }: { game: Game; onOpen: () => void }) {
  const [goal, setGoal] = useState<GuideAchievement | null>(null);
  const reduce = useReducedMotion();
  const isSteam = game.installations.some((i) => i.platform === 'steam');

  useEffect(() => {
    setGoal(null);
    if (!isSteam) return;
    let alive = true;
    const load = () => void call<GuideAchievement | null>('achievements.goal', { gameId: game.id }).then((g) => alive && setGoal(g)).catch(() => {});
    load();
    const offs = [
      on('achievements.goalChanged', (e) => { if (e?.gameId === game.id) setGoal(e.goal); }),
      on('steam.achievementsUpdated', load),
    ];
    return () => { alive = false; offs.forEach((off) => off()); };
  }, [game.id, isSteam]);

  return (
    <AnimatePresence>
      {goal && (
        <motion.button
          type="button"
          className="goalchip"
          data-done={goal.achieved || undefined}
          onClick={onOpen}
          aria-label={`${goal.achieved ? 'Goal reached' : 'Current goal'}: ${goal.name}${goal.globalPercent != null ? `, ${formatPercent(goal.globalPercent)} of players have it` : ''}. Open achievements`}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={reduce ? { duration: 0.15 } : spring.panel}
        >
          <span className="goalchip__icon" aria-hidden>
            {goal.icon ? <img src={goal.icon} alt="" draggable={false} /> : goal.achieved ? <Check size={14} /> : <Target size={14} />}
          </span>
          <span className="goalchip__label">{goal.achieved ? 'Goal reached' : 'Current goal'}</span>
          <span className="goalchip__name">{goal.name}</span>
          {goal.globalPercent != null && !goal.achieved && <span className="goalchip__pct num">{formatPercent(goal.globalPercent)}</span>}
        </motion.button>
      )}
    </AnimatePresence>
  );
}
