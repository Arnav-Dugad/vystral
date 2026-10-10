import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Sparkles, Wand2, X } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { SmartFilter, SmartFilterAnswer } from '../../bridge/types';
import { parseQuery } from '../../lib/search';
import { describeSmartFilter, matchesSmartFilter, missingTtbCount, smartFilterFromQuery } from '../../lib/smartFilter';
import { plural } from '../../lib/format';
import { useAiFeatureOn, useAiStatus } from '../../state/ai';
import { useTimeToBeatMap } from '../../state/recap';
import { useSubsMap } from '../../state/subs';
import { useStore } from '../../state/store';
import { Button, Skeleton } from '../ui/primitives';
import { Dialog } from '../ui/Dialog';
import { GameCover } from '../game/GameCover';
import { AiByline, AiNote, WhatWasSent } from './AiBits';
import './ai.css';

const EXAMPLES = ['Cosy games under 20 hours I haven’t finished', 'Installed racing games', 'RPGs I haven’t played in 6 months', 'Never played indie games'];

interface Built { filter: SmartFilter | null; name: string; aiLabel: string | null; note: string | null; sent: string | null; leftover: string; cloud: boolean }

/**
 * Track C5: "Smart collection from a sentence". The sentence becomes a validated filter (by the chosen AI, or by
 * VYSTRAL's own query parser without AI), shown as plain chips with a live preview, then saved as a collection
 * whose rule keeps it up to date as your library changes.
 */
export function SmartCollectionDialog({ open, onClose, initial }: { open: boolean; onClose: () => void; initial?: string }) {
  const status = useAiStatus();
  const featureOn = useAiFeatureOn('smartCollections');
  const games = useStore((s) => s.library.games);
  const drives = useStore((s) => s.drives);
  const toast = useStore((s) => s.toast);
  const ttb = useTimeToBeatMap();
  const subs = useSubsMap();
  const [sentence, setSentence] = useState(initial ?? '');
  const [built, setBuilt] = useState<Built | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'build' | 'save' | null>(null);
  const seq = useRef(0);
  const inputId = useId();
  const nameId = useId();
  const useAi = !!status?.active.ready && featureOn;

  useEffect(() => {
    if (!open) return;
    setSentence(initial ?? '');
    setBuilt(null);
    setName('');
  }, [open, initial]);

  const ctx = useMemo(() => ({ ttb: ttb?.games ?? null, subs: subs as Record<string, unknown[]> | null }), [ttb, subs]);
  const matches = useMemo(() => (built?.filter ? games.filter((g) => matchesSmartFilter(g, built.filter!, ctx)) : []), [games, built, ctx]);
  const noTtb = useMemo(() => (built?.filter ? missingTtbCount(games, built.filter, ctx) : 0), [games, built, ctx]);

  const local = (s: string, note: string | null): Built => {
    const genres = [...new Set(games.flatMap((g) => g.genres))];
    const { filter, leftover } = smartFilterFromQuery(parseQuery(s, { genres, drives }), s);
    return { filter, name: s.slice(0, 40), aiLabel: null, note, sent: null, leftover, cloud: false };
  };

  const build = async () => {
    const s = sentence.trim();
    if (!s) return;
    const mine = ++seq.current;
    setBusy('build');
    try {
      let next: Built;
      if (useAi) {
        const r = await call<SmartFilterAnswer>('aix.smartFilter', { sentence: s }, 150_000);
        next = r.filter
          ? { filter: r.filter, name: r.name ?? s.slice(0, 40), aiLabel: r.aiLabel, note: r.dropped.length ? `Left out (not genres in your library): ${r.dropped.join(', ')}.` : r.note, sent: r.sent, leftover: '', cloud: r.engine.cloud }
          : local(s, r.note);
      } else {
        next = local(s, null);
      }
      if (mine !== seq.current) return;
      setBuilt(next);
      setName(next.name.charAt(0).toUpperCase() + next.name.slice(1));
    } catch (err) {
      if (mine === seq.current) setBuilt({ ...local(s, errorMessage(err)) });
    } finally {
      if (mine === seq.current) setBusy(null);
    }
  };

  const save = async () => {
    if (!built?.filter || !name.trim()) return;
    setBusy('save');
    try {
      const id = await call<string>('collections.create', { name: name.trim().slice(0, 60), icon: null, rule: built.filter });
      await useStore.getState().refreshLibrary();
      onClose();
      useStore.getState().navigate({ name: 'library', collectionId: id });
      toast({ tone: 'success', title: `“${name.trim()}” created`, body: 'It’s a smart collection: games join and leave it as your library changes.' });
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t create the collection', body: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const chips = built?.filter ? describeSmartFilter(built.filter) : [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title="New smart collection"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Wand2 size={15} />} loading={busy === 'save'} disabled={!built?.filter || !name.trim() || !!busy} onClick={() => void save()}>
            Save collection
          </Button>
        </>
      }
    >
      <div className="ai-smart">
        <p className="ai-smart__lead">
          Describe the games you want. {useAi ? <><span className="ai-ask__engine">{status!.active.label}</span> turns it into a filter that VYSTRAL checks;</> : 'VYSTRAL reads it with its own filter words;'} you see exactly what it means before saving.
        </p>
        <form className="ai-ask__form" onSubmit={(e) => { e.preventDefault(); void build(); }}>
          <label htmlFor={inputId} className="visually-hidden">Describe the collection</label>
          <input id={inputId} className="input ai-ask__input" value={sentence} maxLength={200} onChange={(e) => setSentence(e.target.value)} placeholder="Cosy games under 20 hours I haven’t finished" data-autofocus />
          <Button type="submit" size="sm" icon={<Sparkles size={14} />} loading={busy === 'build'} disabled={!sentence.trim() || !!busy}>Build</Button>
        </form>
        {!built && busy !== 'build' && (
          <div className="ai-ask__chips" role="group" aria-label="Examples">
            {EXAMPLES.map((x) => <button key={x} type="button" className="ai-chip" onClick={() => setSentence(x)}>{x}</button>)}
          </div>
        )}
        {busy === 'build' && <Skeleton height={140} radius={14} />}
        {built && busy !== 'build' && (
          <div className="ai-smart__result" aria-live="polite">
            {built.filter ? (
              <>
                <h3 className="ai-smart__h">The filter</h3>
                <ul className="ai-query__chips ai-smart__chips">{chips.map((c) => <li key={c}>{c}</li>)}</ul>
                <div className="ai-ask__meta">
                  <AiByline label={built.aiLabel} cloud={built.cloud} />
                  {built.leftover && <span className="ai-ask__note">Not understood: “{built.leftover}”</span>}
                </div>
                {built.note && <AiNote>{built.note}</AiNote>}
                <h3 className="ai-smart__h">{plural(matches.length, 'game')} right now</h3>
                {matches.length ? (
                  <ul className="ai-smart__covers">
                    {matches.slice(0, 12).map((g) => <li key={g.id} title={g.title}><GameCover game={g} /><span className="visually-hidden">{g.title}</span></li>)}
                    {matches.length > 12 && <li className="ai-smart__more">+{matches.length - 12}</li>}
                  </ul>
                ) : <p className="ai-ask__fine">Nothing matches yet. Saved anyway, the collection fills itself as games come to fit.</p>}
                {noTtb > 0 && <p className="ai-ask__fine">{plural(noTtb, 'game')} would match but have no time-to-beat estimate, so they’re left out (estimates come from IGDB with your own key).</p>}
                <label htmlFor={nameId} className="ai-connect__label">Name</label>
                <input id={nameId} className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
                <WhatWasSent sent={built.sent} compact />
              </>
            ) : (
              <AiNote>
                {built.note ? <>{built.note} </> : null}
                VYSTRAL couldn’t find any filter words in that. Try genres, stores, “installed”, “never played”, “under 20 hours” or “not finished”.
                <button type="button" className="ai-inline-x" aria-label="Clear" onClick={() => setBuilt(null)}><X size={12} /></button>
              </AiNote>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
