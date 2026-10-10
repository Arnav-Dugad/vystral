import { useId, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, BookOpen, Check, ChevronRight, CloudLightning, ShieldCheck, Sparkles, X } from 'lucide-react';
import type { AssistantCard } from '../../bridge/types';
import type { ChatAction, ChatApproval } from '../../lib/assistant';
import { pick, spring } from '../../lib/motion';
import { useReducedMotion, useStore } from '../../state/store';
import { GameCover } from '../game/GameCover';
import { JournalChart } from '../ai/JournalChart';
import { Button } from '../ui/primitives';
import { TOOL_ICONS } from './toolIcons';

/**
 * Track D3: rich cards under an answer, built from what the look-ups returned on this PC (never from the model's text):
 * game rows, the play-history chart, tonight's shortlist, sources, and a stutter summary. Every button only navigates.
 */
export function AssistantCards({ cards, compact }: { cards: { toolId: string; card: AssistantCard }[]; compact?: boolean }) {
  const reduce = useReducedMotion();
  if (!cards.length) return null;
  return (
    <div className="asx-cards">
      {cards.map(({ toolId, card }, i) => (
        <motion.div
          key={toolId}
          className="asx-card-wrap"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ ...pick(reduce, spring.panel), delay: reduce ? 0 : Math.min(i, 3) * 0.05 }}
        >
          <Card card={card} compact={compact} />
        </motion.div>
      ))}
    </div>
  );
}

function Card({ card, compact }: { card: AssistantCard; compact?: boolean }) {
  switch (card.kind) {
    case 'games': return <GamesCard card={card} compact={compact} />;
    case 'journal': return <div className="asx-card asx-card--chart"><JournalChart result={card.result} /></div>;
    case 'picks': return <PicksCard card={card} />;
    case 'sources': return <SourcesCard card={card} />;
    case 'stutter': return <StutterCard card={card} />;
    default: return null;
  }
}

function GamesCard({ card, compact }: { card: Extract<AssistantCard, { kind: 'games' }>; compact?: boolean }) {
  const gamesById = useStore((s) => s.gamesById);
  const navigate = useStore((s) => s.navigate);
  const max = compact ? 5 : 8;
  const [all, setAll] = useState(false);
  const items = all ? card.items : card.items.slice(0, max);
  return (
    <section className="asx-card asx-games" aria-label={card.title}>
      <h4 className="asx-card__title">{card.title}</h4>
      <ul className="asx-games__list">
        {items.map((it) => {
          const g = gamesById.get(it.id);
          return (
            <li key={it.id}>
              <button type="button" className="asx-game" onClick={() => navigate({ name: 'game', id: it.id })} data-game-id={it.id}>
                <span className="asx-game__cover" aria-hidden>{g ? <GameCover game={g} /> : <span className="asx-game__ph">{it.title.slice(0, 1)}</span>}</span>
                <span className="asx-game__text">
                  <span className="asx-game__title">{it.title}</span>
                  {it.sub && <span className="asx-game__sub">{it.sub}</span>}
                </span>
                <ChevronRight size={15} className="asx-game__go" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
      {card.items.length > max && (
        <button type="button" className="asx-card__more" aria-expanded={all} onClick={() => setAll((a) => !a)}>
          {all ? 'Show fewer' : `Show all ${card.items.length}`}
        </button>
      )}
    </section>
  );
}

function PicksCard({ card }: { card: Extract<AssistantCard, { kind: 'picks' }> }) {
  const gamesById = useStore((s) => s.gamesById);
  const navigate = useStore((s) => s.navigate);
  return (
    <section className="asx-card asx-picks" aria-label={`VYSTRAL’s shortlist: ${card.title}`}>
      <h4 className="asx-card__title"><Sparkles size={13} aria-hidden /> VYSTRAL’s shortlist · {card.title}</h4>
      <ol className="asx-picks__list">
        {card.items.map((p, i) => {
          const g = p.gameId ? gamesById.get(p.gameId) : undefined;
          return (
            <li key={`${p.gameId ?? p.productId ?? p.title}`} className="asx-pick" data-first={i === 0 || undefined}>
              <span className="asx-pick__cover" aria-hidden>{g ? <GameCover game={g} /> : <span className="asx-game__ph">{p.title.slice(0, 1)}</span>}</span>
              <span className="asx-pick__body">
                <span className="asx-pick__title">{p.title}</span>
                <span className="asx-pick__facts">{p.facts.slice(0, 2).join(' · ')}{p.plan ? ` · ${p.plan}` : ''}</span>
              </span>
              {p.gameId && (
                <Button size="sm" variant={i === 0 ? 'primary' : 'secondary'} onClick={() => navigate({ name: 'game', id: p.gameId! })} aria-label={`Open ${p.title}`}>
                  Open
                </Button>
              )}
            </li>
          );
        })}
      </ol>
      <p className="asx-card__foot">Opening a game shows its page. Nothing is launched.</p>
    </section>
  );
}

function SourcesCard({ card }: { card: Extract<AssistantCard, { kind: 'sources' }> }) {
  return (
    <section className="asx-card asx-sources" aria-label={card.title}>
      <h4 className="asx-card__title"><BookOpen size={13} aria-hidden /> Sources</h4>
      <ul className="asx-sources__list">
        {card.items.map((s) => (
          <li key={s.source} title={s.label}>{s.source}</li>
        ))}
      </ul>
    </section>
  );
}

function StutterCard({ card }: { card: Extract<AssistantCard, { kind: 'stutter' }> }) {
  const navigate = useStore((s) => s.navigate);
  const stat = (label: string, value: number | null, unit: string) => (
    <div className="asx-stat">
      <dt>{label}</dt>
      <dd className="num">{value == null ? '—' : `${Math.round(value * 10) / 10}`}<span>{value == null ? '' : unit}</span></dd>
    </div>
  );
  return (
    <section className="asx-card asx-stutter" aria-label={card.title ?? 'Stutter check'}>
      <h4 className="asx-card__title"><CloudLightning size={13} aria-hidden /> {card.title ?? 'Stutter check'}</h4>
      <dl className="asx-stats">
        {stat('Average', card.fpsAvg, ' fps')}
        {stat('1% low', card.fps1Low, ' fps')}
        {stat('99th pct frame', card.p99, ' ms')}
        {stat('Stutters', card.stutters, '')}
      </dl>
      {card.spikes.length > 0 && (
        <ul className="asx-spikes" aria-label="Worst moments">
          {card.spikes.map((s) => <li key={s.at}><span className="num">{s.at}</span><span className="num">{s.ms} ms</span></li>)}
        </ul>
      )}
      {card.sessionId && (
        <button type="button" className="asx-card__more" onClick={() => navigate({ name: 'performance', sessionId: card.sessionId, tab: 'sessions' })}>
          Open this session <ArrowRight size={13} aria-hidden />
        </button>
      )}
    </section>
  );
}

/** Before look-up results go to a cloud AI: exactly what, and the user's choice. */
export function ApprovalCard({ approval, onAnswer }: { approval: ChatApproval; onAnswer: (allow: boolean, always: boolean) => void }) {
  const [always, setAlways] = useState(false);
  const [details, setDetails] = useState(false);
  const id = useId();
  if (approval.state !== 'pending') {
    return (
      <p className="asx-approval-done" data-state={approval.state}>
        {approval.state === 'allowed' ? <Check size={13} aria-hidden /> : <X size={13} aria-hidden />}
        {approval.state === 'allowed' ? `Shared with ${approval.company}` : approval.state === 'declined' ? 'Not shared' : 'Nothing was shared'}
        {' · '}{approval.items.map((i) => i.label).join(', ')}
      </p>
    );
  }
  return (
    <section className="asx-approval" aria-labelledby={`${id}-t`} role="group">
      <div className="asx-approval__head">
        <span className="asx-approval__icon" aria-hidden><ShieldCheck size={16} /></span>
        <div>
          <h4 id={`${id}-t`} className="asx-approval__title">Share what I found with {approval.company}?</h4>
          <p className="asx-approval__sub">To answer, {approval.engine.split(' · ')[0]} needs these results from your PC. Nothing is sent until you choose.</p>
        </div>
      </div>
      <ul className="asx-approval__items">
        {approval.items.map((it) => {
          const Icon = TOOL_ICONS[it.tool] ?? ShieldCheck;
          return (
            <li key={it.tool + it.summary}>
              <Icon size={13} aria-hidden />
              <span><strong>{it.label}</strong> · {it.summary}</span>
            </li>
          );
        })}
      </ul>
      <button type="button" className="asx-sent__toggle" aria-expanded={details} aria-controls={`${id}-d`} onClick={() => setDetails((d) => !d)}>
        <ChevronRight size={12} aria-hidden data-open={details || undefined} /> Exactly what’s included
      </button>
      {details && (
        <ul id={`${id}-d`} className="asx-approval__details">
          {approval.items.map((it) => <li key={`${it.tool}-d`}><strong>{it.label}:</strong> {it.sends}</li>)}
        </ul>
      )}
      <label className="asx-approval__always">
        <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
        <span>Don’t ask again in this conversation</span>
      </label>
      <div className="asx-approval__actions">
        <Button size="sm" variant="primary" icon={<Check size={14} aria-hidden />} onClick={() => onAnswer(true, always)}>Share</Button>
        <Button size="sm" variant="ghost" onClick={() => onAnswer(false, false)}>Don’t share</Button>
      </div>
    </section>
  );
}

/** A change the assistant prepared. It happens only when the user presses the button. */
export function ActionCard({ action, onConfirm, onDismiss }: { action: ChatAction; onConfirm: () => void; onDismiss: () => void }) {
  const reduce = useReducedMotion();
  const Icon = TOOL_ICONS[action.tool] ?? Sparkles;
  return (
    <section className="asx-action" data-state={action.state} aria-label={`Suggested: ${action.title}`}>
      <span className="asx-action__icon" aria-hidden><Icon size={16} /></span>
      <div className="asx-action__body">
        <h4 className="asx-action__title">{action.title}</h4>
        <p className="asx-action__detail">{action.state === 'failed' ? action.result ?? 'That didn’t work.' : action.detail}</p>
      </div>
      <div className="asx-action__buttons">
        <AnimatePresence mode="popLayout" initial={false}>
          {action.state === 'pending' || action.state === 'running' ? (
            <motion.div key="ask" className="asx-action__ask" exit={{ opacity: 0 }} transition={pick(reduce, spring.effect)}>
              <Button size="sm" variant="ghost" onClick={onDismiss} disabled={action.state === 'running'}>Not now</Button>
              <Button size="sm" variant="primary" onClick={onConfirm} loading={action.state === 'running'}>{action.confirm}</Button>
            </motion.div>
          ) : (
            <motion.span
              key="done"
              className="asx-action__state"
              role="status"
              initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={pick(reduce, spring.panel)}
            >
              {action.state === 'done' ? <><Check size={14} aria-hidden /> Done</> : action.state === 'dismissed' ? 'Skipped' : <><X size={14} aria-hidden /> Didn’t work</>}
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}

