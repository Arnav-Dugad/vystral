import { useMemo, useState } from 'react';
import { Check, ExternalLink, Gift, RefreshCw } from 'lucide-react';
import { call } from '../../bridge/bridge';
import type { Freebie, Game } from '../../bridge/types';
import { allFailed, endsLabel, FREEBIE_STORE, isClaimable, orderFreebies, ownedMatch, startsLabel } from '../../lib/freebies';
import { formatRelative } from '../../lib/format';
import type { DiscoverCandidate } from '../../lib/recommendV2';
import { useClaim, useFreebieImage, useFreebies } from '../../state/freebies';
import { useDiscoverPicks } from '../../state/recommend';
import { useStore } from '../../state/store';
import { Button } from '../ui/primitives';
import { GameCover } from '../game/GameCover';
import { pseudoGame } from '../discover/DiscoverBits';
import { DiscoverShelf, DiscoverShelfSkeleton } from '../discover/DiscoverShelf';
import { StoreLogo } from '../ui/StoreLogo';
import './recommend.css';

const STORE_LOGO = { steam: 'steam', epic: 'epic', gog: 'gog', ubisoft: 'ubisoft', ea: 'ea', xbox: 'xbox', battlenet: 'battlenet' } as const;

/**
 * Track D5: "Free this week" — giveaways from Track D4's sources (GamerPower and Epic's free-games feed, opt-in),
 * claimable ones first and soonest ending first, ones you already own marked and moved to the end, next week's at the
 * end. Claiming always happens on the store's own page in your browser.
 * `place` = 'discover' shows an invitation while no source is on; 'home' renders nothing then (or without its row).
 */
export function FreeShelf({ place }: { place: 'discover' | 'home' }) {
  const { data, loading, error, enabled, load } = useFreebies();
  const games = useStore((s) => s.library.games);
  const homeRow = useStore((s) => !!s.settings?.['freebies.homeRow']);
  const offline = useStore((s) => !!s.settings?.['privacy.localOnly']);
  const now = useMemo(() => Date.now(), [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // recommend.v2 orders what's left by how well each giveaway fits your taste.
  const candidates = useMemo<DiscoverCandidate[]>(() => (data?.items ?? []).map((i) => ({
    key: `free:${i.id}`, title: i.title, genres: [], via: ['free'], freeOn: FREEBIE_STORE[i.store], freeUntil: i.endsAt ?? null,
  })), [data]);
  const picks = useDiscoverPicks(candidates, 60);
  const rank = useMemo(() => new Map(picks.map((p) => [p.id, p.match])), [picks]);
  const items = useMemo(() => orderFreebies(data?.items ?? [], games, now, (id) => rank.get(`free:${id}`) ?? 0), [data, games, now, rank]);

  if (place === 'home' && (!enabled || !homeRow)) return null;
  if (!enabled) return place === 'discover' && !offline ? <FreeInvite /> : null;
  if (!data) {
    if (loading) return <DiscoverShelfSkeleton id="free-week" cards={6} />;
    if (error && place === 'discover') return <FreeProblem text={error} onRetry={() => void load(true)} />;
    return null; // a build without the giveaways client: nothing to show
  }
  if (data.reason === 'off') return place === 'discover' ? <FreeInvite /> : null;
  if (!items.length) {
    if (place === 'home') return null;
    if (allFailed(data)) return <FreeProblem text="The giveaway lists didn’t answer. VYSTRAL tries again later." onRetry={() => void load(true)} busy={loading} />;
    return (
      <div className="disc-banner disc-banner--soft surface" data-free-state={data.reason ?? 'empty'} role="status">
        <Gift size={20} aria-hidden />
        <div>
          <strong>{data.reason === 'offline' ? 'Offline mode is on' : 'No giveaways right now'}</strong>
          <p>{data.reason === 'offline' ? 'Free this week is checked only while VYSTRAL is online.' : 'Nothing is free to keep at the moment. New giveaways usually appear every few days.'}</p>
        </div>
      </div>
    );
  }
  const on = data.sources.filter((s) => s.enabled);
  const fetched = on.map((s) => s.fetchedAt).filter((x): x is string => !!x).sort()[0] ?? null;
  const stale = on.some((s) => s.stale) || data.reason === 'offline';
  const stores = [...new Set(items.map((i) => FREEBIE_STORE[i.store]).filter((s) => s !== 'its store'))];
  return (
    <>
      <DiscoverShelf
        id="free-week"
        title="Free this week"
        icon={<Gift size={18} aria-hidden />}
        count={items.length}
        reason={`Games you can keep for free${stores.length ? ` on ${stores.slice(0, 3).join(', ')}${stores.length > 3 ? ' and more' : ''}` : ''}. Claim them on the store’s own page.`}
      >
        {items.map((it, i) => <FreeCard key={it.id} item={it} games={games} now={now} index={i} />)}
      </DiscoverShelf>
      <p className="free-note">
        {on.map((s, i) => (
          <span key={s.id}>
            {i > 0 ? ' · ' : ''}
            {s.id === 'gamerpower'
              ? <button type="button" className="free-note__link" onClick={() => void call('dataSources.openLink', { provider: 'gamerpower', link: 'home' }).catch(() => {})}>{s.attribution}</button>
              : s.attribution}
          </span>
        ))}
        {fetched ? `, checked ${formatRelative(fetched).toLowerCase()}` : ''}{stale ? ' (an older copy)' : ''}. VYSTRAL never claims, signs in or buys anything.
      </p>
    </>
  );
}

function FreeCard({ item, games, now, index }: { item: Freebie; games: readonly Game[]; now: number; index: number }) {
  const claim = useClaim();
  const owned = ownedMatch(item, games);
  const claimable = isClaimable(item, now);
  const ends = claimable ? endsLabel(item.endsAt, now) : null;
  const starts = claimable ? null : startsLabel(item.startsAt, now);
  const store = FREEBIE_STORE[item.store];
  const { ref, url } = useFreebieImage(item.id, item.image, item.hasImage);
  const cover = useMemo(() => pseudoGame(`free:${item.id}`, item.title, { cover: url ?? null }), [item.id, item.title, url]);
  const logo = STORE_LOGO[item.store as keyof typeof STORE_LOGO];
  const what = item.kind === 'loot' ? 'Free items' : item.kind === 'beta' ? 'Free beta' : 'Free';
  const label = [
    `${item.title}, ${item.kind === 'loot' ? 'free in-game items' : item.kind === 'beta' ? 'free beta access' : 'free to keep'} on ${store}`,
    item.worth ? `usually ${item.worth}` : null,
    starts ?? ends?.text ?? null,
    owned ? (owned.sameStore ? `you already own it on ${store}` : 'you own it on another store') : null,
    'opens the store page in your browser',
  ].filter(Boolean).join(', ');
  return (
    <div className="shelf__item free-card" role="listitem" data-shelf-card data-free-id={item.id} data-upcoming={!claimable || undefined} style={{ ['--i' as string]: Math.min(index, 10) }}>
      <button type="button" className="free-card__btn" aria-label={label} onClick={() => void claim(item.id, item.title)}>
        <div className="free-card__cover" ref={ref}>
          <GameCover game={cover} kind="cover" />
          <span className="free-card__ribbon"><Gift size={12} aria-hidden /> {claimable ? what : 'Soon'}</span>
          <span className="free-card__store" aria-hidden>{logo ? <StoreLogo platform={logo} size={16} decorative /> : store.slice(0, 2)}</span>
          {owned && <span className="free-card__owned"><Check size={12} aria-hidden /> {owned.sameStore ? 'In your library' : 'Own it elsewhere'}</span>}
        </div>
        <span className="free-card__title">{item.title}</span>
        <span className="free-card__meta">
          {item.worth && <span className="free-card__worth num">{item.worth}</span>}
          {starts && <span className="free-card__ends">{starts}</span>}
          {ends && <span className="free-card__ends" data-soon={ends.soon || undefined}>{ends.text}</span>}
        </span>
        <span className="free-card__claim">{claimable ? `Claim on ${store}` : `See it on ${store}`} <ExternalLink size={11} aria-hidden /></span>
      </button>
    </div>
  );
}

function FreeProblem({ text, onRetry, busy }: { text: string; onRetry: () => void; busy?: boolean }) {
  return (
    <div className="disc-banner disc-banner--soft surface" data-free-state="failed" role="status">
      <Gift size={20} aria-hidden />
      <div><strong>Free games couldn’t be checked</strong><p>{text}</p></div>
      <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} loading={busy} onClick={onRetry}>Try again</Button>
    </div>
  );
}

function FreeInvite() {
  const setSetting = useStore((s) => s.setSetting);
  const [busy, setBusy] = useState(false);
  return (
    <div className="free-invite surface" data-invite="free">
      <div className="free-invite__art" aria-hidden><Gift size={24} /></div>
      <div className="free-invite__text">
        <strong>See what’s free this week</strong>
        <p>Games you can keep for free on Steam, Epic, GOG and more, from GamerPower’s public giveaway list. Checked at most every few hours while this is on; nothing about you is sent, and claiming always happens on the store’s own page. Epic’s own free-games list can be added in Settings → Library &amp; stores → Data sources.</p>
      </div>
      <Button variant="primary" loading={busy} onClick={() => { setBusy(true); void Promise.resolve(setSetting('dataSources.gamerpower', true)).finally(() => setBusy(false)); }}>
        Show free games
      </Button>
    </div>
  );
}
