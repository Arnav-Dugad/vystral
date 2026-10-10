import { useId, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, Clock, ExternalLink, MoonStar, RefreshCw, Sparkles, TriangleAlert } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { TonightAnswer, TonightMood } from '../../bridge/types';
import { pick, spring } from '../../lib/motion';
import { useAiStatus } from '../../state/ai';
import { useReducedMotion, useStore } from '../../state/store';
import { Button, Segmented, Skeleton, Toggle } from '../ui/primitives';
import { GameCover } from '../game/GameCover';
import { AiByline, AiNote, WhatWasSent } from './AiBits';
import './ai.css';

const MOODS: { value: TonightMood; label: string }[] = [
  { value: 'any', label: 'Anything' },
  { value: 'chill', label: 'Chill' },
  { value: 'intense', label: 'Intense' },
  { value: 'story', label: 'Story' },
  { value: 'brainy', label: 'Brainy' },
  { value: 'social', label: 'With friends' },
];
const TIMES: { value: string; label: string }[] = [
  { value: '30', label: '30 min' },
  { value: '60', label: '1 h' },
  { value: '120', label: '2 h' },
  { value: '240', label: 'All evening' },
];

interface Turn { id: number; mood: TonightMood; minutes: number; note: string; answer: TonightAnswer | null; error: string | null }

/**
 * Track C5: "What should I play tonight?". VYSTRAL shortlists games from your library (and what your subscriptions
 * include) using your mood, time, time-to-beat and your own session lengths; the chosen AI only picks from that
 * shortlist and explains why. "Open" goes to the game's page. Nothing is ever launched from here.
 */
export function TonightPanel() {
  const status = useAiStatus();
  const reduce = useReducedMotion();
  const navigate = useStore((s) => s.navigate);
  const gamesById = useStore((s) => s.gamesById);
  const toast = useStore((s) => s.toast);
  const [mood, setMood] = useState<TonightMood>('any');
  const [time, setTime] = useState('60');
  const [note, setNote] = useState('');
  const [subs, setSubs] = useState(true);
  const [turns, setTurns] = useState<Turn[]>([]);
  const busy = turns.some((t) => !t.answer && !t.error);
  const seq = useRef(0);
  const noteId = useId();

  const ask = async () => {
    const id = ++seq.current;
    const turn: Turn = { id, mood, minutes: Number(time), note: note.trim(), answer: null, error: null };
    setTurns((t) => [turn, ...t].slice(0, 4));
    setNote('');
    try {
      const answer = await call<TonightAnswer>('aix.tonight', { mood, minutes: Number(time), note: turn.note || null, includeSubs: subs }, 150_000);
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, answer } : x)));
    } catch (err) {
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, error: errorMessage(err) } : x)));
    }
  };

  const openStore = async (productId: string) => {
    try { await call('subs.openStore', { productId }); }
    catch (err) { toast({ tone: 'danger', title: 'Couldn’t open the store page', body: errorMessage(err) }); }
  };

  return (
    <section className="ai-tonight" aria-labelledby="ai-tonight-title">
      <header className="ai-tonight__head">
        <span className="ai-ask__orb" aria-hidden><MoonStar size={18} /></span>
        <div>
          <h1 id="ai-tonight-title" className="ai-tonight__title">What should I play tonight?</h1>
          <p className="ai-ask__sub">
            Picks come only from your library and what your subscriptions include. {status?.active.ready ? <><span className="ai-ask__engine">{status.active.label}</span> explains them.</> : 'Without AI, VYSTRAL explains its own picks.'}
          </p>
        </div>
      </header>

      <form className="ai-tonight__form surface" onSubmit={(e) => { e.preventDefault(); if (!busy) void ask(); }}>
        <div className="ai-tonight__field">
          <span className="ai-tonight__label" id="ai-mood-label">Mood</span>
          <Segmented label="Mood" value={mood} options={MOODS} onChange={setMood} />
        </div>
        <div className="ai-tonight__field">
          <span className="ai-tonight__label"><Clock size={13} aria-hidden /> Time</span>
          <Segmented label="Time available" value={time} options={TIMES} onChange={setTime} />
        </div>
        <div className="ai-tonight__field ai-tonight__field--wide">
          <label className="ai-tonight__label" htmlFor={noteId}>Anything else? <span className="ai-tonight__opt">(optional{status?.active.cloud ? `, sent to ${status.active.label.split(' · ')[0]}` : ''})</span></label>
          <input id={noteId} className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Something I can play with a controller on the sofa" />
        </div>
        <div className="ai-tonight__actions">
          <label className="ai-tonight__subs">
            <Toggle id="ai-tonight-subs" label="Include games from my subscriptions" checked={subs} onChange={setSubs} />
            <span>Include my subscriptions</span>
          </label>
          <Button type="submit" variant="primary" icon={turns.length ? <RefreshCw size={15} /> : <Sparkles size={15} />} loading={busy}>
            {turns.length ? 'Suggest again' : 'Suggest'}
          </Button>
        </div>
      </form>

      <div className="ai-tonight__log" aria-live="polite">
        <AnimatePresence initial={false}>
          {turns.map((t, ti) => (
            <motion.article
              key={t.id}
              className="ai-tonight__turn"
              data-latest={ti === 0 || undefined}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10 }}
              animate={{ opacity: ti === 0 ? 1 : 0.72, y: 0 }}
              exit={{ opacity: 0 }}
              transition={pick(reduce, spring.panel)}
              aria-busy={!t.answer && !t.error}
            >
              <p className="ai-tonight__ask">
                {MOODS.find((m) => m.value === t.mood)!.label} · {TIMES.find((x) => Number(x.value) === t.minutes)?.label}{t.note && <> · “{t.note}”</>}
              </p>
              {!t.answer && !t.error && (
                <div className="ai-tonight__picks">
                  {[0, 1, 2].map((i) => <Skeleton key={i} height={132} radius={14} />)}
                </div>
              )}
              {t.error && <p className="ai-ask__error" role="alert"><TriangleAlert size={14} aria-hidden /> {t.error}</p>}
              {t.answer && (
                <>
                  <p className="ai-tonight__intro">{t.answer.intro}</p>
                  {t.answer.picks.length > 0 && (
                    <ol className="ai-tonight__picks">
                      {t.answer.picks.map((p, i) => {
                        const g = p.gameId ? gamesById.get(p.gameId) : undefined;
                        return (
                          <li key={`${p.gameId ?? p.productId}`} className="ai-pick surface" style={{ ['--i' as string]: i }}>
                            <span className="ai-pick__cover" aria-hidden>{g ? <GameCover game={g} /> : <span className="ai-pick__placeholder">{p.title.slice(0, 1)}</span>}</span>
                            <div className="ai-pick__body">
                              <h3 className="ai-pick__title">{p.title}</h3>
                              <p className="ai-pick__reason">{p.reason}</p>
                              <p className="ai-pick__tags">
                                {p.kind === 'subscription' ? <span>Not owned · {p.plan}</span> : p.installed ? <span>Installed</span> : <span>Included with {p.plan}</span>}
                              </p>
                            </div>
                            {p.gameId ? (
                              <Button size="sm" variant={i === 0 ? 'primary' : 'secondary'} icon={<ArrowRight size={14} />} onClick={() => navigate({ name: 'game', id: p.gameId! })} aria-label={`Open ${p.title}`}>
                                Open
                              </Button>
                            ) : p.productId ? (
                              <Button size="sm" icon={<ExternalLink size={14} />} onClick={() => void openStore(p.productId!)} aria-label={`Open ${p.title} in the store`}>Open in store</Button>
                            ) : null}
                          </li>
                        );
                      })}
                    </ol>
                  )}
                  <div className="ai-ask__meta">
                    <AiByline label={t.answer.aiLabel} cloud={t.answer.engine.cloud} />
                    <span className="ai-ask__note">Chosen from {t.answer.considered} {t.answer.considered === 1 ? 'candidate' : 'candidates'} VYSTRAL shortlisted.</span>
                  </div>
                  {t.answer.note && <AiNote>{t.answer.note}</AiNote>}
                  {ti === 0 && <WhatWasSent sent={t.answer.sent} compact />}
                </>
              )}
            </motion.article>
          ))}
        </AnimatePresence>
        {turns.length === 0 && (
          <p className="ai-tonight__empty">Choose a mood and how long you have, then <strong>Suggest</strong>. You decide what to play; VYSTRAL never starts a game from here.</p>
        )}
      </div>
    </section>
  );
}
