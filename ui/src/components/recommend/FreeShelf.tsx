import { useMemo, useState } from 'react';
import { Check, ExternalLink, Gift, RefreshCw } from 'lucide-react';
import type { FreebieItem, Game } from '../../bridge/types';
import { claimHost, endsLabel, FREEBIE_STORE, orderFreebies, ownedMatch } from '../../lib/freebies';
import { formatRelative } from '../../lib/format';
import type { DiscoverCandidate } from '../../lib/recommendV2';
import { useClaim, useFreebies } from '../../state/freebies';
import { useDiscoverPicks } from '../../state/recommend';
import { useStore } from '../../state/store';
import { Badge, Button } from '../ui/primitives';
import { GameCover } from '../game/GameCover';
import { pseudoGame } from '../discover/DiscoverBits';
import { DiscoverShelf, DiscoverShelfSkeleton } from '../discover/DiscoverShelf';
import { StoreLogo } from '../ui/StoreLogo';
import './recommend.css';

const STORE_LOGO = { steam: 'steam', epic: 'epic', gog: 'gog', ubisoft: 'ubisoft', ea: 'ea', xbox: 'xbox', battlenet: 'battlenet' } as const;

/**
 * Track D5: "Free this week" — public giveaways (from GamerPower, opt-in), soonest ending first, ones you already own
 * marked and moved to the end. Claiming always happens on the store's own page in your browser.
 * `place` = 'discover' shows an invitation while the opt-in is off; 'home' renders nothing then.
 */
export function FreeShelf({ place }: { place: 'discover' | 'home' }) {
  const { data, loading, error, enabled, load } = useFreebies();
  const games = useStore((s) => s.library.games);
  const homeRow = useStore((s) => !!s.settings?.['freebies.homeRow']);
  const offline = useStore((s) => !!s.settings?.['privacy.localOnly']);
  const now = useMemo(() => Date.now(), [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // recommend.v2 orders what's left by how well each giveaway fits your taste.
  const candidates = useMemo<DiscoverCandidate[]>(() => (data?.items ?? []).map((i) => ({
    key: `free:${i.id}`, title: i.title, genres: [], via: ['free'], freeOn: FREEBIE_STORE[i.platform], freeUntil: i.endDate ?? null,
  })), [data]);
  const picks = useDiscoverPicks(candidates, 60);
  const rank = useMemo(() => new Map(picks.map((p) => [p.id, p.match])), [picks]);
  const items = useMemo(() => orderFreebies(data?.items ?? [], games, now, (id) => rank.get(`free:${id}`) ?? 0), [data, games, now, rank]);

  if (place === 'home' && (!enabled || !homeRow)) return null;
  if (!enabled) return place === 'discover' && !offline ? <FreeInvite /> : null;
  if (!data) {
    if (loading) return <DiscoverShelfSkeleton id="free-week" cards={6} />;
    if (error && place === 'discover') {
      return (
        <div className="disc-banner disc-banner--soft surface" data-free-state="error" role="status">
          <Gift size={20} aria-hidden />
          <div><strong>Free games couldn’t be checked</strong><p>{error}</p></div>
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void load(true)}>Try again</Button>
        </div>
      );
    }
    return null; // no giveaways client in this build: nothing to show
  }
  if (data.state === 'off') return place === 'discover' ? <FreeInvite /> : null;
  if (!items.length) {
    if (place === 'home') return null;
    return (
      <div className="disc-banner disc-banner--soft surface" data-free-state={data.state}>
        <Gift size={20} aria-hidden />
        <div>
          <strong>{data.state === 'failed' ? 'Free games couldn’t be checked' : data.state === 'offline' ? 'Offline mode is on' : 'No giveaways right now'}</strong>
          <p>{data.state === 'failed' ? 'GamerPower didn’t answer. VYSTRAL tries again later.' : data.state === 'offline' ? 'Free this week is checked only while VYSTRAL is online.' : 'Nothing is free to keep at the moment. New giveaways usually appear every few days.'}</p>
        </div>
        {data.state !== 'offline' && <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} loading={loading} onClick={() => void load(true)}>Check again</Button>}
      </div>
    );
  }
  const stale = data.state === 'stale';
  return (
    <>
      <DiscoverShelf
        id="free-week"
        title="Free this week"
        icon={<Gift size={18} aria-hidden />}
        count={items.length}
        reason={`Games you can keep for free on ${[...new Set(items.map((i) => FREEBIE_STORE[i.platform]))].slice(0, 3).join(', ')}${items.length > 3 ? ' and more' : ''}. Claim them on the store’s own page.`}
        action={data.preview ? <Badge tone="warn">Preview</Badge> : undefined}
      >
        {items.map((it, i) => <FreeCard key={it.id} item={it} games={games} now={now} index={i} />)}
      </DiscoverShelf>
      <p className="free-note">
        From GamerPower’s public giveaway list{data.fetchedAt ? `, checked ${formatRelative(data.fetchedAt).toLowerCase()}` : ''}{stale ? ' (an older copy)' : ''}. VYSTRAL never claims, signs in or buys anything.
      </p>
    </>
  );
}

function FreeCard({ item, games, now, index }: { item: FreebieItem; games: readonly Game[]; now: number; index: number }) {
  const claim = useClaim();
  const owned = ownedMatch(item, games);
  const ends = endsLabel(item.endDate, now);
  const host = claimHost(item.url);
  const store = FREEBIE_STORE[item.platform];
  const cover = useMemo(() => pseudoGame(`free:${item.id}`, item.title, { cover: item.image }), [item.id, item.title, item.image]);
  const logo = STORE_LOGO[item.platform as keyof typeof STORE_LOGO];
  const label = [
    `${item.title}, free to keep on ${store}`,
    item.kind === 'dlc' ? 'add-on' : item.kind === 'loot' ? 'in-game items' : null,
    item.worth ? `usually ${item.worth}` : null,
    ends?.text ?? null,
    owned ? (owned.sameStore ? `you already own it on ${store}` : 'you own it on another store') : null,
    `opens ${host ?? 'the store'} in your browser`,
  ].filter(Boolean).join(', ');
  return (
    <div className="shelf__item free-card" role="listitem" data-shelf-card data-free-id={item.id} style={{ ['--i' as string]: Math.min(index, 10) }}>
      <button type="button" className="free-card__btn" aria-label={label} onClick={() => void claim(item.id, item.title)}>
        <div className="free-card__cover">
          <GameCover game={cover} kind="cover" />
          <span className="free-card__ribbon"><Gift size={12} aria-hidden /> {item.kind === 'dlc' ? 'Free add-on' : item.kind === 'loot' ? 'Free items' : 'Free'}</span>
          <span className="free-card__store" aria-hidden>{logo ? <StoreLogo platform={logo} size={16} decorative /> : store.slice(0, 2)}</span>
          {owned && <span className="free-card__owned"><Check size={12} aria-hidden /> {owned.sameStore ? 'In your library' : 'Own it elsewhere'}</span>}
        </div>
        <span className="free-card__title">{item.title}</span>
        <span className="free-card__meta">
          {item.worth && <span className="free-card__worth num">{item.worth}</span>}
          {ends && <span className="free-card__ends" data-soon={ends.soon || undefined}>{ends.text}</span>}
        </span>
        <span className="free-card__claim">Claim on {store} <ExternalLink size={11} aria-hidden /></span>
      </button>
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
        <p>Games you can keep for free on Epic, Steam, GOG, Prime Gaming and more, from GamerPower’s public list. Checked a few times a day while this is on; nothing about you is sent, and claiming always happens on the store’s own page.</p>
      </div>
      <Button variant="primary" loading={busy} onClick={() => { setBusy(true); void Promise.resolve(setSetting('freebies.enabled', true)).finally(() => setBusy(false)); }}>
        Show free games
      </Button>
    </div>
  );
}
