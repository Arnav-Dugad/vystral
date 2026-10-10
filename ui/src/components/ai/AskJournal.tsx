import { useId, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowUp, ChevronDown, Settings2, Sparkles, TriangleAlert } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { JournalAnswer } from '../../bridge/types';
import { describeSpec, READY_QUESTIONS, type ReadyQuestion } from '../../lib/aiJournal';
import { pick, spring } from '../../lib/motion';
import { useAiFeatureOn, useAiStatus } from '../../state/ai';
import { useReducedMotion, useStore } from '../../state/store';
import { Button, IconButton, Skeleton } from '../ui/primitives';
import { AiByline, AiNote, WhatWasSent } from './AiBits';
import { JournalChart } from './JournalChart';
import './ai.css';

/**
 * Track C5: "Ask the Journal". A question becomes a validated query over your sessions (by the AI you chose), the
 * query runs on this PC, the chart shows exactly what it found, and the AI only words the answer. Ready-made
 * questions run entirely on this PC, with or without AI.
 */
export function AskJournal() {
  const status = useAiStatus();
  const featureOn = useAiFeatureOn('journal');
  const reduce = useReducedMotion();
  const navigate = useStore((s) => s.navigate);
  const byId = useStore((s) => s.gamesById);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [answer, setAnswer] = useState<JournalAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showQuery, setShowQuery] = useState(false);
  const seq = useRef(0);
  const inputId = useId();
  const queryId = useId();
  const canAsk = !!status?.active.ready && featureOn;

  const go = async (label: string, run: () => Promise<JournalAnswer>) => {
    const mine = ++seq.current;
    setBusy(label);
    setError(null);
    setShowQuery(false);
    try {
      const r = await run();
      if (mine === seq.current) setAnswer(r);
    } catch (err) {
      if (mine === seq.current) setError(errorMessage(err));
    } finally {
      if (mine === seq.current) setBusy(null);
    }
  };
  const ask = () => {
    const q = question.trim();
    if (!q || !canAsk) return;
    void go(q, () => call<JournalAnswer>('aix.journalAsk', { question: q }, 150_000));
  };
  const ready = (r: ReadyQuestion) => void go(r.label, () => call<JournalAnswer>('aix.journalRun', { spec: r.spec, label: r.label }));
  const result = answer?.result ?? null;

  return (
    <section className="ai-ask surface" aria-labelledby="ai-ask-title">
      <header className="ai-ask__head">
        <span className="ai-ask__orb" aria-hidden><Sparkles size={16} /></span>
        <div>
          <h2 id="ai-ask-title" className="ai-ask__title">Ask the Journal</h2>
          <p className="ai-ask__sub">
            {canAsk ? <>Ask anything about your play history. <span className="ai-ask__engine">{status!.active.label}</span> turns it into a query; the numbers come from this PC.</>
              : <>Pick a question below. Answers are calculated on this PC.</>}
          </p>
        </div>
      </header>

      <form className="ai-ask__form" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <label htmlFor={inputId} className="visually-hidden">Your question</label>
        <input
          id={inputId}
          className="input ai-ask__input"
          value={question}
          maxLength={300}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={canAsk ? 'What did I play most in August?' : 'Set up AI to ask your own questions'}
          disabled={!canAsk}
          spellCheck
        />
        {canAsk ? (
          <IconButton label="Ask" type="submit" className="ai-ask__send" disabled={!question.trim() || !!busy}>
            <ArrowUp size={16} />
          </IconButton>
        ) : (
          <Button size="sm" variant="ghost" icon={<Settings2 size={14} />} onClick={() => navigate({ name: 'settings', section: 'ai' })}>Set up AI</Button>
        )}
      </form>

      <div className="ai-ask__chips" role="group" aria-label="Ready-made questions">
        {READY_QUESTIONS.map((r) => (
          <button key={r.id} type="button" className="ai-chip" onClick={() => ready(r)} disabled={!!busy} aria-pressed={answer?.question === r.label || undefined}>
            {r.label}
          </button>
        ))}
      </div>

      <div className="ai-ask__out" aria-live="polite" aria-busy={!!busy || undefined}>
        {busy && (
          <div className="ai-ask__loading">
            <p className="ai-ask__q">“{busy}”</p>
            <Skeleton height={18} width="70%" />
            <Skeleton height={120} radius={12} />
          </div>
        )}
        {!busy && error && <p className="ai-ask__error" role="alert"><TriangleAlert size={14} aria-hidden /> {error}</p>}
        {!busy && !error && answer && (
          <motion.div
            key={answer.question}
            className="ai-ask__answer"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={pick(reduce, spring.panel)}
          >
            <p className="ai-ask__q">“{answer.question}”</p>
            {answer.needsAi ? (
              <AiNote>{answer.note ?? 'No AI is set up.'} Ready-made questions above still work without AI.</AiNote>
            ) : answer.unsupported ? (
              <AiNote>{answer.unsupported}</AiNote>
            ) : !result ? (
              <AiNote>{answer.note ?? 'That question couldn’t be turned into a query. Try rewording it.'}</AiNote>
            ) : (
              <>
                <p className="ai-ask__text selectable">{answer.answer}</p>
                <div className="ai-ask__meta">
                  <AiByline label={answer.phrasedBy} cloud={answer.engine.cloud} />
                  {answer.note && <span className="ai-ask__note">{answer.note}</span>}
                </div>
                <JournalChart result={result} />
                {result.unmatched.length > 0 && <AiNote>Not in your library, so left out: {result.unmatched.join(', ')}.</AiNote>}
                {result.notes.map((n) => <p key={n} className="ai-ask__fine">{n}</p>)}
                <button type="button" className="ai-sent__toggle" aria-expanded={showQuery} aria-controls={queryId} onClick={() => setShowQuery((s) => !s)}>
                  <ChevronDown size={12} aria-hidden data-open={showQuery || undefined} /> The query that was used
                </button>
                {showQuery && (
                  <div id={queryId} className="ai-query">
                    <ul className="ai-query__chips">
                      {describeSpec(result, (id) => byId.get(id)?.title ?? 'a game').map((c) => <li key={c}>{c}</li>)}
                      <li>{result.sessions.toLocaleString()} sessions matched</li>
                    </ul>
                    <pre className="ai-query__json num">{JSON.stringify(result.spec, null, 2)}</pre>
                    <p className="ai-ask__fine">{answer.plannedBy ? `Planned by ${answer.plannedBy}, checked by VYSTRAL, then run on this PC.` : 'A ready-made query, run on this PC.'}</p>
                  </div>
                )}
                <WhatWasSent sent={answer.sent} />
              </>
            )}
          </motion.div>
        )}
      </div>
    </section>
  );
}
