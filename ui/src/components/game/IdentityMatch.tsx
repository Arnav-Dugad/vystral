import { useEffect, useId, useState } from 'react';
import { AlertTriangle, Check, ExternalLink, Link2, RefreshCw, Search, Wand2 } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { Game, IdCandidate, ResolvedId, ResolvedIdentity, SteamSearchHit } from '../../bridge/types';
import { formatRelative } from '../../lib/format';
import { confidencePercent, identitySummary, isSteamGame, LEVEL_LABEL, matchedVia, SOURCE_LABEL } from '../../lib/identity';
import { loadIdentity, useIdentityStore, useResolvedIdentity } from '../../state/identity';
import { useStore } from '../../state/store';
import { Badge, Button, Skeleton } from '../ui/primitives';
import { Dialog } from '../ui/Dialog';
import './identity-match.css';

const STATUS_BADGE: Record<ResolvedIdentity['status'], { tone?: 'ok' | 'warn' | 'accent'; text: string }> = {
  native: { tone: 'ok', text: 'Steam game' },
  matched: { tone: 'ok', text: 'Matched' },
  pinned: { tone: 'accent', text: 'Chosen by you' },
  notOnSteam: { text: 'Not on Steam' },
  suggested: { tone: 'warn', text: 'Needs a look' },
  conflict: { tone: 'warn', text: 'Sources disagree' },
  none: { text: 'No match' },
  notChecked: { text: 'Not checked' },
};

const ID_STATUS: Record<ResolvedId['status'], string> = {
  native: 'Store ID', pinned: 'Your choice', matched: 'Used', suggested: 'Suggestion, not used', conflict: 'Disputed, not used',
};

const toast = (title: string, tone: 'info' | 'success' | 'danger' = 'info', body?: string) => useStore.getState().toast({ tone, title, body });

/**
 * Track D4: the "Matched IDs" card (Versions tab). Shows the same game's Steam app, IGDB, RAWG, GOG and Wikidata IDs, how
 * each was found and how sure VYSTRAL is — and lets you confirm, correct or reject the Steam match. Steam data for a
 * non-Steam game is only ever used through what this card shows.
 */
export function IdentityMatchCard({ game }: { game: Game }) {
  const { identity, loading, error } = useResolvedIdentity(game);
  const [fixing, setFixing] = useState(false);
  const [busy, setBusy] = useState(false);
  const steamGame = isSteamGame(game);
  const titleId = useId();

  if (!identity && error)
    return (
      <section className="surface idm" aria-label="Matched IDs" role="alert">
        <p className="idm__muted"><AlertTriangle size={13} aria-hidden /> Couldn’t check this game’s IDs: {error}</p>
        <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void loadIdentity(game.id, true)}>Try again</Button>
      </section>
    );
  if (!identity) return <div className="surface idm" aria-busy="true" aria-label="Checking this game’s IDs"><Skeleton height={18} width="40%" /><Skeleton height={44} /><Skeleton height={44} /></div>;

  const badge = STATUS_BADGE[identity.status];
  const unpin = async () => {
    setBusy(true);
    try {
      useIdentityStore.getState().set(await call<ResolvedIdentity>('identity.unpin', { gameId: game.id, kind: 'steam' }));
      toast('Back to automatic matching');
    } catch (err) {
      toast('Couldn’t change the match', 'danger', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const confirm = async (value: string) => {
    setBusy(true);
    try {
      useIdentityStore.getState().set(await call<ResolvedIdentity>('identity.pin', { gameId: game.id, kind: 'steam', value }));
      toast('Steam match confirmed', 'success');
    } catch (err) {
      toast('Couldn’t confirm the match', 'danger', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const ids = identity.ids;

  return (
    <section className="surface idm" aria-labelledby={titleId} data-testid="identity-card">
      <header className="idm__head">
        <h3 id={titleId}><Link2 size={15} aria-hidden /> Matched IDs</h3>
        <Badge tone={badge.tone}>{badge.text}</Badge>
        <span className="idm__spacer" />
        {!steamGame && (
          <Button size="sm" variant="ghost" loading={loading} icon={<RefreshCw size={13} />} disabled={!identity.canCheck}
            title={identity.canCheck ? 'Look this game up again' : undefined} aria-label="Check this game’s IDs again"
            onClick={() => void loadIdentity(game.id, true)} />
        )}
      </header>
      <p className="idm__summary">{identitySummary(identity)}</p>
      {identity.reason === 'offline' && <p className="idm__muted">Offline mode is on, so nothing is looked up. Saved matches still apply.</p>}
      {identity.reason === 'gameRunning' && <p className="idm__muted">Paused while you play.</p>}

      {ids.length > 0 && (
        <ul className="idm__list">
          {ids.map((id) => (
            <li key={id.kind} className="idm__row" data-status={id.status} data-kind={id.kind}>
              <span className="idm__kind">{id.label}</span>
              <span className="idm__value">
                <span className="idm__name">{id.name ?? (id.kind === 'wikidata' ? 'Wikidata item' : `${id.label} entry`)}</span>
                <span className="num selectable idm__id">{id.value}</span>
              </span>
              <span className="idm__how">
                <span className="idm__conf" data-level={id.level} title={`${LEVEL_LABEL[id.level]} (${confidencePercent(id)})`}>
                  {LEVEL_LABEL[id.level]} · <span className="num">{confidencePercent(id)}</span>
                </span>
                <span className="idm__via">{matchedVia(id)} · {ID_STATUS[id.status]}</span>
              </span>
              <span className="idm__actions">
                {id.kind === 'steam' && id.status === 'suggested' && (
                  <Button size="sm" variant="ghost" icon={<Check size={13} />} loading={busy} onClick={() => void confirm(id.value)}>It’s this one</Button>
                )}
                {id.link && (
                  <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} aria-label={`Open on ${id.label} (opens your browser)`}
                    onClick={() => void call('identity.openId', { gameId: game.id, kind: id.kind }).catch((err) => toast(errorMessage(err)))} />
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {!steamGame && (
        <div className="idm__foot">
          <Button size="sm" variant={identity.status === 'conflict' || identity.status === 'suggested' ? 'primary' : 'secondary'} icon={<Wand2 size={13} />} onClick={() => setFixing(true)}>
            {identity.status === 'conflict' || identity.status === 'suggested' ? 'Choose the Steam game' : 'Fix match'}
          </Button>
          {(identity.status === 'pinned' || identity.status === 'notOnSteam') && (
            <Button size="sm" variant="ghost" loading={busy} onClick={() => void unpin()}>Use automatic matching</Button>
          )}
          <span className="idm__muted">
            {identity.asked.length ? `Asked ${identity.asked.map((s) => SOURCE_LABEL[s]).join(', ')}` : 'Only this PC’s data was used'}
            {identity.checkedAt ? ` · checked ${formatRelative(identity.checkedAt).toLowerCase()}` : ''}
          </span>
        </div>
      )}
      <FixMatchDialog game={game} identity={identity} open={fixing} onClose={() => setFixing(false)} />
    </section>
  );
}

type Choice = { kind: 'app'; appId: string } | { kind: 'none' };

/**
 * "Which Steam game is this?" — the candidates the sources found, a Steam store search, or "It isn't on Steam". Your
 * choice is final until you go back to automatic matching.
 */
export function FixMatchDialog({ game, identity, open, onClose }: { game: Game; identity: ResolvedIdentity; open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState(game.title);
  const [hits, setHits] = useState<SteamSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [saving, setSaving] = useState(false);
  const offline = useStore((s) => !!s.settings?.['privacy.localOnly']);
  const group = useId();

  useEffect(() => {
    if (!open) return;
    setQuery(game.title);
    setHits(null);
    setSearchError(null);
    const s = identity.steam;
    setChoice(identity.status === 'notOnSteam' ? { kind: 'none' } : s ? { kind: 'app', appId: s.value } : null);
  }, [open, game.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const search = async () => {
    setSearching(true);
    setSearchError(null);
    try {
      setHits(await call<SteamSearchHit[]>('identity.searchSteam', { gameId: game.id, query: query.trim() }));
    } catch (err) {
      setSearchError(errorMessage(err));
    } finally {
      setSearching(false);
    }
  };

  const save = async () => {
    if (!choice) return;
    setSaving(true);
    try {
      const r = await call<ResolvedIdentity>('identity.pin', { gameId: game.id, kind: 'steam', value: choice.kind === 'none' ? null : choice.appId });
      useIdentityStore.getState().set(r);
      toast(choice.kind === 'none' ? 'Marked as not on Steam' : 'Steam match saved', 'success');
      onClose();
    } catch (err) {
      toast('Couldn’t save the match', 'danger', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const candidates: (IdCandidate | (SteamSearchHit & { searched: true }))[] = [
    ...identity.steamCandidates,
    ...(hits ?? []).filter((h) => !identity.steamCandidates.some((c) => c.value === h.appId)).map((h) => ({ ...h, searched: true as const })),
  ];
  const valueOf = (c: (typeof candidates)[number]) => ('searched' in c ? c.appId : c.value);
  const selected = (v: string) => choice?.kind === 'app' && choice.appId === v;

  return (
    <Dialog open={open} onClose={onClose} title="Which Steam game is this?" wide
      actions={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={saving} disabled={!choice} onClick={() => void save()}>Save</Button>
      </>}>
      <p className="idm__lede">
        VYSTRAL shows Steam reviews, tags, trailers, prices and news for <strong>{game.title}</strong> through the Steam game you pick, always labelled as Steam data.
      </p>
      <form className="idm-search" role="search" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <label className="visually-hidden" htmlFor={`${group}-q`}>Search the Steam store</label>
        <input id={`${group}-q`} className="input" value={query} maxLength={100} onChange={(e) => setQuery(e.target.value)} placeholder="Search the Steam store" disabled={offline} />
        <Button type="submit" variant="secondary" icon={<Search size={14} />} loading={searching} disabled={offline || query.trim().length < 2}>Search</Button>
      </form>
      {offline && <p className="idm__muted">Offline mode is on, so the Steam store can’t be searched. The candidates below were found earlier.</p>}
      {searchError && <p className="idm__muted" role="alert"><AlertTriangle size={12} aria-hidden /> {searchError}</p>}
      <div className="idm-choices" role="radiogroup" aria-label="Steam game">
        {candidates.length === 0 && hits === null && <p className="idm__muted">No candidates yet. Search the Steam store above.</p>}
        {hits !== null && hits.length === 0 && <p className="idm__muted">Steam’s store search found nothing for that.</p>}
        {candidates.map((c) => {
          const v = valueOf(c);
          return (
            <label key={v} className="idm-choice" data-selected={selected(v) || undefined}>
              <input type="radio" name={group} checked={selected(v)} onChange={() => setChoice({ kind: 'app', appId: v })} />
              <span className="idm-choice__text">
                <span className="idm-choice__name">{'searched' in c ? c.name : c.name ?? `Steam app ${c.value}`}{!('searched' in c) && c.year ? <span className="idm-choice__year"> · {c.year}</span> : null}</span>
                <span className="idm-choice__meta">
                  App <span className="num">{v}</span>
                  {'searched' in c ? ' · from your search' : ` · ${c.sources.map((s) => SOURCE_LABEL[s]).join(', ')} · ${Math.min(99, Math.round(c.confidence * 100))}%`}
                </span>
              </span>
            </label>
          );
        })}
        <label className="idm-choice" data-selected={choice?.kind === 'none' || undefined}>
          <input type="radio" name={group} checked={choice?.kind === 'none'} onChange={() => setChoice({ kind: 'none' })} />
          <span className="idm-choice__text">
            <span className="idm-choice__name">It isn’t on Steam</span>
            <span className="idm-choice__meta">No Steam data is shown for this game.</span>
          </span>
        </label>
      </div>
    </Dialog>
  );
}
