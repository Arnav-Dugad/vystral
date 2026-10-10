import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import {
  AlertTriangle, BadgeCheck, CircleDashed, Clock, ExternalLink, Fingerprint, Gamepad, Info, RefreshCw, ShieldAlert, Sparkles, Tag, TrendingDown, XCircle,
} from 'lucide-react';
import { call, errorMessage, on } from '../../bridge/bridge';
import type { Compat, Deals, Enrichment, EnrichmentSource, Game, Identity, PlatformKey } from '../../bridge/types';
import { formatDate, formatRelative } from '../../lib/format';
import { DECK_LABEL, deckTone, formatHours, formatMoney, matchLabel } from '../../lib/dataSources';
import { useReducedMotion, useStore } from '../../state/store';
import { Badge, Button, PlatformBadge, Skeleton } from '../ui/primitives';
import { ServiceLogo } from '../ui/ServiceLogo';
import './game-data.css';

/**
 * Loads per-game data. Only the newest request may update the state (switching games quickly never
 * shows another game's answer), and a failed refresh keeps the data already shown.
 * `reload` resolves to whether it succeeded.
 */
function useBridge<T>(method: string, gameId: string, deps: unknown[] = []): { data: T | null; error: string | null; reload: (params?: Record<string, unknown>) => Promise<boolean> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const load = async (params: Record<string, unknown> = {}) => {
    const mine = ++seq.current;
    try {
      const result = await call<T>(method, { gameId, ...params }, 60_000);
      if (mine === seq.current) {
        setData(result);
        setError(null);
      }
      return true;
    } catch (err) {
      if (mine === seq.current) setError(errorMessage(err));
      return false;
    }
  };
  useEffect(() => {
    setData(null);
    setError(null);
    void load();
    return () => {
      seq.current++;
    };
  }, [gameId, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, reload: load };
}

const openExternal = (method: string, params: unknown) => () => {
  void call(method, params).catch((err) => useStore.getState().toast({ tone: 'info', title: errorMessage(err) }));
};

// ---------- Overview extras: compatibility badges, IGDB/RAWG facts, deals ----------

/** Rendered on the Overview tab under the description. Every block says where its data comes from. */
export function GameExtras({ game }: { game: Game }) {
  return (
    <div className="gx">
      {/* Deck and anti-cheat status now live in the "At a glance" Compatibility tile. */}
      <EnrichmentFacts game={game} />
      <DealsCard game={game} />
    </div>
  );
}

/** Deck and anti-cheat badges as a row (the game page now uses the Compatibility tile instead). */
export function CompatRow({ game }: { game: Game }) {
  const settingsKey = useStore((s) => `${s.settings?.['dataSources.steamDeck']}${s.settings?.['dataSources.antiCheat']}${s.settings?.['library.fetchMetadata']}${s.settings?.['privacy.localOnly']}`);
  const { data } = useBridge<Compat>('compat.get', game.id, [settingsKey]);
  if (!data || (!data.deck && !data.antiCheat)) return null;
  return (
    <div className="gx-compat" aria-label="Compatibility">
      {data.deck && <DeckBadge deck={data.deck} />}
      {data.antiCheat && <AntiCheatBadge game={game} ac={data.antiCheat} />}
    </div>
  );
}

function Disclosure({ trigger, children, label, tone }: { trigger: ReactNode; children: ReactNode; label: string; tone?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="gx-pop" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button className={`gx-pill ${tone ? `gx-pill--${tone}` : ''}`} aria-expanded={open} aria-controls={id} aria-label={label}
        onClick={() => setOpen((o) => !o)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
        {trigger}
      </button>
      <span id={id} className="gx-pop__panel" role="region" aria-label={label} hidden={!open}>{children}</span>
    </span>
  );
}

function DeckBadge({ deck }: { deck: NonNullable<Compat['deck']> }) {
  const tone = deckTone(deck.category);
  const icon = deck.category === 'verified' ? <BadgeCheck size={14} aria-hidden /> : deck.category === 'playable' ? <Info size={14} aria-hidden /> : deck.category === 'unsupported' ? <XCircle size={14} aria-hidden /> : <CircleDashed size={14} aria-hidden />;
  // Track R: the Steam Deck mark says which device; the status icon after it says how well it runs.
  const trigger = <><ServiceLogo service="steamdeck" size={14} decorative />{DECK_LABEL[deck.category]}{icon}</>;
  return (
    <Disclosure label={`${DECK_LABEL[deck.category]}: Valve’s test results`} tone={tone} trigger={trigger}>
      <strong className="gx-pop__title">Valve’s Steam Deck test results</strong>
      {deck.tests.length ? (
        <ul className="gx-tests">
          {deck.tests.map((t, i) => <li key={i} data-kind={t.kind}>{t.text}</li>)}
        </ul>
      ) : <span className="gx-pop__muted">Valve hasn’t published test results for this game.</span>}
      <span className="gx-pop__src">As reported by Valve on the Steam store · checked {formatRelative(deck.fetched).toLowerCase()}</span>
    </Disclosure>
  );
}

function AntiCheatBadge({ game, ac }: { game: Game; ac: NonNullable<Compat['antiCheat']> }) {
  const names = ac.names.length ? ac.names.join(', ') : 'Anti-cheat';
  return (
    <Disclosure label={`Anti-cheat: ${names}`} tone={ac.kernel ? 'warn' : undefined}
      trigger={<><ShieldAlert size={14} aria-hidden />{ac.kernel ? `Kernel anti-cheat (${ac.names[0] ?? 'unknown'})` : `Anti-cheat: ${names}`}</>}>
      <strong className="gx-pop__title">{names}</strong>
      {ac.kernel && <span>Widely documented to load a kernel-mode driver on Windows while the game runs.</span>}
      <span>Linux/Steam Deck status per AreWeAntiCheatYet: <strong>{ac.statusLabel}</strong>{ac.updated ? ` (updated ${formatDate(ac.updated)})` : ''}.</span>
      <button className="gx-link" onClick={openExternal('compat.openAntiCheat', { gameId: game.id })}>AreWeAntiCheatYet <ExternalLink size={11} aria-hidden /></button>
    </Disclosure>
  );
}

function EnrichmentFacts({ game }: { game: Game }) {
  const reduce = useReducedMotion();
  const [busy, setBusy] = useState(false);
  const toast = useStore((s) => s.toast);
  const { data, reload } = useBridge<Enrichment>('enrichment.get', game.id);
  useEffect(() => on('library.changed', (p) => { if (p?.reason === 'enrichment') void reload(); }), [game.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return null;
  const matched = data.sources.filter((s) => s.matched && s.facts);
  const run = async () => {
    setBusy(true);
    try {
      const r = await call<{ filled: string[]; details: Enrichment }>('enrichment.run', { gameId: game.id }, 120_000);
      await reload();
      toast({ tone: 'success', title: r.filled.length ? `Filled ${r.filled.length} missing ${r.filled.length === 1 ? 'detail' : 'details'}` : 'Details checked', body: r.filled.length ? undefined : 'Nothing was missing, or no confident match was found.' });
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t fetch details', body: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  if (!matched.length) {
    if (!data.canFetch) return null;
    return (
      <div className="gx-card surface gx-card--quiet">
        <Sparkles size={16} aria-hidden />
        <span>More details may be available from your connected game databases.</span>
        <Button size="sm" loading={busy} icon={<RefreshCw size={14} />} onClick={() => void run()}>Fetch details</Button>
      </div>
    );
  }
  return (
    <>
      {matched.map((s) => (
        <motion.section key={s.source} className="gx-card surface" aria-labelledby={`gx-${s.source}`}
          initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
          <header className="gx-card__head">
            <h3 id={`gx-${s.source}`}>{(s.source === 'igdb' || s.source === 'rawg') && <ServiceLogo service={s.source} size={s.source === 'igdb' ? 20 : 16} decorative />}From {s.name}</h3>
            <span className="gx-card__meta">{matchLabel(s)}</span>
            {data.canFetch && <Button size="sm" variant="ghost" loading={busy} icon={<RefreshCw size={13} />} onClick={() => void run()} aria-label={`Refresh details from ${s.name}`} />}
          </header>
          <SourceFacts s={s} />
          <footer className="gx-attrib">
            {s.source === 'rawg'
              ? <>Data from <button className="gx-link" onClick={openExternal('enrichment.open', { gameId: game.id, name: 'rawg' })}>RAWG.io <ExternalLink size={11} aria-hidden /></button></>
              : <>Data from <button className="gx-link" onClick={openExternal('enrichment.open', { gameId: game.id, name: 'igdb' })}>IGDB.com <ExternalLink size={11} aria-hidden /></button></>}
            <span> · updated {formatRelative(s.fetched).toLowerCase()}</span>
          </footer>
        </motion.section>
      ))}
    </>
  );
}

function SourceFacts({ s }: { s: EnrichmentSource }) {
  const f = s.facts!;
  const ttb = f.timeToBeat;
  const rows: [string, ReactNode][] = [];
  if (f.criticRating != null) rows.push(['Critics', <Score key="c" value={f.criticRating} count={f.criticRatingCount} of={100} />]);
  if (f.totalRating != null) rows.push(['Overall rating', <Score key="t" value={f.totalRating} count={f.totalRatingCount} of={100} />]);
  if (f.userRating != null) rows.push(['RAWG users', <Score key="u" value={f.userRating} count={f.userRatingCount} of={5} />]);
  if (f.themes?.length) rows.push(['Themes', f.themes.join(', ')]);
  if (f.gameModes?.length) rows.push(['Modes', f.gameModes.join(', ')]);
  if (f.perspectives?.length) rows.push(['Perspective', f.perspectives.join(', ')]);
  if (f.series?.length || f.franchises?.length) rows.push(['Series', [...new Set([...(f.series ?? []), ...(f.franchises ?? [])])].join(', ')]);
  if (f.averagePlaytimeHours) rows.push(['Average playtime', `${formatHours(f.averagePlaytimeHours * 3600)} (RAWG users)`]);
  if (f.esrb) rows.push(['ESRB', f.esrb]);
  return (
    <div className="gx-facts">
      {ttb && (ttb.hastily || ttb.normally || ttb.completely) && (
        <div className="gx-ttb" aria-label="Time to beat">
          <Clock size={15} aria-hidden />
          {[['Rushed', ttb.hastily], ['Normal pace', ttb.normally], ['Completionist', ttb.completely]].map(([label, secs]) => (
            formatHours(secs as number | null) ? <div key={label as string}><span className="caps">{label}</span><strong className="num">{formatHours(secs as number)}</strong></div> : null
          ))}
          {ttb.count > 0 && <span className="gx-ttb__n">{ttb.count.toLocaleString()} {ttb.count === 1 ? 'player' : 'players'} reported</span>}
        </div>
      )}
      {rows.length > 0 && (
        <dl className="gx-dl">
          {rows.map(([k, v]) => <div key={k}><dt className="caps">{k}</dt><dd className="selectable">{v}</dd></div>)}
        </dl>
      )}
      {f.similar?.length ? (
        <div className="gx-similar">
          <span className="caps">Similar games</span>
          <div>{f.similar.slice(0, 8).map((t) => <Badge key={t}>{t}</Badge>)}</div>
        </div>
      ) : null}
    </div>
  );
}

function Score({ value, count, of }: { value: number; count?: number; of: number }) {
  const pct = Math.max(0, Math.min(1, value / of));
  return (
    <span className="gx-score">
      <span className="gx-score__bar" aria-hidden><span style={{ width: `${pct * 100}%` }} /></span>
      <strong className="num">{of === 100 ? Math.round(value) : value.toFixed(1)}</strong>
      <span className="gx-score__of">/ {of}{count ? ` · ${count.toLocaleString()} ${count === 1 ? 'rating' : 'ratings'}` : ''}</span>
    </span>
  );
}

function DealsCard({ game }: { game: Game }) {
  const settingsKey = useStore((s) => `${s.settings?.['dataSources.cheapshark']}${s.settings?.['privacy.localOnly']}${s.settings?.['dataSources.priceCountry']}`);
  const { data, error, reload } = useBridge<Deals>('deals.get', game.id, [settingsKey]);
  const [refreshing, setRefreshing] = useState(false);
  // Nothing to show only when the first load failed; a failed refresh keeps the prices on screen.
  if (!data) return error ? null : <div className="gx-card surface"><Skeleton height={18} width="30%" /><Skeleton height={44} /></div>;
  if (data.reason === 'noSteamId' || data.reason === 'disabled' || !data.quotes.length) return null;
  const refresh = async () => {
    setRefreshing(true);
    const ok = await reload({ refresh: true });
    setRefreshing(false);
    if (!ok) useStore.getState().toast({ tone: 'warning', title: 'Couldn’t refresh prices', body: 'Showing the last prices VYSTRAL found.' });
  };
  return (
    <section className="gx-card surface gx-deals" aria-labelledby="gx-deals-title">
      <header className="gx-card__head">
        <h3 id="gx-deals-title"><Tag size={15} aria-hidden /> Deals</h3>
        <span className="gx-card__meta">Looked up by Steam app ID · opens in your browser</span>
        <Button size="sm" variant="ghost" loading={refreshing} icon={<RefreshCw size={13} />} onClick={() => void refresh()} aria-label="Refresh prices" disabled={data.reason === 'offline'} />
      </header>
      {data.quotes.map((q) => {
        const best = q.offers[0];
        return (
          <div key={q.provider} className="gx-quote">
            {best ? (
              <div className="gx-quote__best">
                <div>
                  <span className="caps">Best price now</span>
                  <div className="gx-quote__price num">{formatMoney(best.price, q.currency)}</div>
                  <span className="gx-quote__shop">at {best.shop}{best.cut > 0 ? ` · −${best.cut}%` : ''}</span>
                </div>
                {q.historicalLow != null && (
                  <div className="gx-quote__low">
                    <span className="caps"><TrendingDown size={12} aria-hidden /> Lowest ever</span>
                    <div className="num">{formatMoney(q.historicalLow, q.currency)}</div>
                    {q.historicalLowAt && <span className="gx-quote__shop">{formatDate(q.historicalLowAt)}</span>}
                  </div>
                )}
              </div>
            ) : <p className="gx-pop__muted">{q.error ?? (data.reason === 'offline' ? 'Offline mode is on.' : 'No current deals listed.')}</p>}
            {q.offers.length > 0 && (
              <ul className="gx-offers">
                {q.offers.slice(0, 5).map((o) => (
                  <li key={o.id}>
                    <button className="gx-offer" onClick={openExternal('deals.open', { gameId: game.id, offerId: o.id })} aria-label={`${o.shop}: ${formatMoney(o.price, q.currency)}${o.cut ? `, ${o.cut}% off` : ''}. Opens in your browser.`}>
                      <span>{o.shop}</span>
                      {o.cut > 0 && <Badge tone="ok">−{o.cut}%</Badge>}
                      <span className="num">{formatMoney(o.price, q.currency)}</span>
                      <ExternalLink size={12} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="gx-attrib">
              Prices from <button className="gx-link" onClick={openExternal('dataSources.openLink', { provider: q.provider, link: 'home' })}>{q.provider === 'itad' ? 'IsThereAnyDeal.com' : 'CheapShark.com'} <ExternalLink size={11} aria-hidden /></button>
              {q.currency && ` · ${q.currency}`}
              {q.fetched && ` · as of ${formatRelative(q.fetched).toLowerCase()}`}
              {q.stale && ' · couldn’t refresh, showing the last prices'}
            </p>
          </div>
        );
      })}
    </section>
  );
}

// ---------- Versions tab: cross-store identity from Wikidata ----------

const KNOWN_PLATFORMS: PlatformKey[] = ['steam', 'xbox', 'epic', 'gog', 'ea', 'ubisoft', 'battlenet', 'manual'];

export function IdentityPanel({ game }: { game: Game }) {
  const wikidata = useStore((s) => s.settings?.['dataSources.wikidata'] ?? true);
  const { data, error, reload } = useBridge<Identity>('identity.get', game.id, [wikidata]);
  const [busy, setBusy] = useState(false);
  if (!data && error)
    return (
      <section className="gx-card surface gx-identity" aria-label="Same game elsewhere">
        <p className="gx-pop__muted"><AlertTriangle size={12} aria-hidden /> Couldn’t look up this game’s other store IDs: {error}</p>
        <Button size="sm" variant="ghost" loading={busy} icon={<RefreshCw size={13} />} onClick={async () => { setBusy(true); await reload(); setBusy(false); }}>Try again</Button>
      </section>
    );
  if (!data) return <div className="gx-card surface gx-identity"><Skeleton height={18} width="40%" /><Skeleton height={32} /></div>;
  if (data.reason === 'noStoreId') return null;
  const stores = data.ids.filter((i) => i.platform && KNOWN_PLATFORMS.includes(i.platform));
  const refs = data.ids.filter((i) => !i.platform);
  return (
    <section className="gx-card surface gx-identity" aria-labelledby="gx-identity-title">
      <header className="gx-card__head">
        <h3 id="gx-identity-title"><Fingerprint size={15} aria-hidden /> Same game elsewhere</h3>
        <span className="gx-card__meta">{data.wikidataId ? 'From Wikidata (CC0)' : data.reason === 'notFound' ? 'Wikidata has no entry for this game yet' : data.reason === 'offline' ? 'Offline mode is on' : data.reason === 'disabled' ? 'Wikidata is turned off in Settings' : 'Not checked yet'}</span>
        <Button size="sm" variant="ghost" loading={busy} icon={<RefreshCw size={13} />} aria-label="Check Wikidata again" disabled={!wikidata}
          onClick={async () => { setBusy(true); await reload({ refresh: true }); setBusy(false); }} />
      </header>
      {stores.length > 0 && (
        <ul className="gx-ids">
          {stores.map((i) => (
            <li key={i.name}>
              <PlatformBadge platform={i.platform!} />
              <span className="num selectable gx-ids__value">{i.value}</span>
              {i.link && <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={openExternal('identity.open', { gameId: game.id, name: i.name })}>Open on {i.label}</Button>}
            </li>
          ))}
        </ul>
      )}
      {refs.length > 0 && (
        <div className="gx-refs">
          {refs.map((i) => (
            <button key={i.name} className="gx-chip" onClick={openExternal('identity.open', { gameId: game.id, name: i.name })} aria-label={`Open on ${i.label} (${i.value})`}>
              <Gamepad size={12} aria-hidden /> {i.label} <ExternalLink size={11} aria-hidden />
            </button>
          ))}
        </div>
      )}
      {data.wikidataId && (
        <p className="gx-attrib">
          IDs from <button className="gx-link" onClick={openExternal('identity.open', { gameId: game.id, name: 'wikidata' })}><ServiceLogo service="wikidata" size={14} decorative /> Wikidata {data.wikidataId} <ExternalLink size={11} aria-hidden /></button>
          {data.fetched && ` · checked ${formatRelative(data.fetched).toLowerCase()}`}. Used only to suggest duplicates — VYSTRAL never merges games on its own.
        </p>
      )}
      {data.reason === 'unavailable' || data.reason === 'rateLimited' ? <p className="gx-pop__muted"><AlertTriangle size={12} aria-hidden /> Wikidata couldn’t be reached just now.</p> : null}
    </section>
  );
}
