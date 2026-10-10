import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  ArrowRight, BadgeCheck, CalendarDays, CircleDashed, Clock3, ExternalLink, HardDrive, Hourglass, Info, MessageSquareText, ShieldAlert, Star,
  Tag, TrendingDown, TrendingUp, Trophy, XCircle,
} from 'lucide-react';
import type { AchievementProgress, Compat, Deals, Game, ReviewsSnapshot, Session, StoreFacts } from '../../../bridge/types';
import { DECK_LABEL, deckTone, formatHours } from '../../../lib/dataSources';
import { formatBytes, formatDate, formatDuration, formatRelative, isInstalled, plural, sizeOf } from '../../../lib/format';
import { formatMoney } from '../../../lib/wishlist';
import { compact, priceChart, pricePosition, releaseAge, reviewTone, trendText, weeklyPlay, type RatingRow } from '../../../lib/gamePage';
import { playedSeconds, ttbProgress, TTB_HINT } from '../../../lib/timeToBeat';
import type { TimeToBeat } from '../../../bridge/types';
import { useReducedMotion } from '../../../state/store';
import { ServiceLogo } from '../../ui/ServiceLogo';
import { Badge } from '../../ui/primitives';
import { Meter, Ring, StatTile, type TileTone } from './StatTile';
import '../../../views/perf/kit.css';

const checked = (iso: string | null | undefined) => (iso ? ` · checked ${formatRelative(iso).toLowerCase()}` : '');

/** Width of an element, kept up to date (charts draw at their real size, so strokes and dots stay crisp). */
function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(120, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

// ---------- Playtime vs time to beat ----------

export function PlaytimeTile({ game, ttb, index }: { game: Game; ttb: TimeToBeat | null | undefined; index: number }) {
  const played = playedSeconds(game);
  const pr = ttbProgress(played, ttb);
  const reduce = useReducedMotion();
  const pct = pr?.next ? Math.round((pr.played / pr.next.seconds) * 100) : null;
  return (
    <StatTile
      index={index} testId="tile-playtime" label="Playtime" icon={<Clock3 size={15} />}
      value={played > 0 ? formatDuration(played) : 'Not played yet'}
      tone={pr?.state === 'pastEstimate' ? 'ok' : undefined}
      sub={!pr ? 'No time-to-beat estimate for this game' : pr.state === 'notStarted' ? `About ${formatHours(pr.targetSeconds)} to the credits`
        : pr.next ? `${pct}% of the ${pr.next.label.toLowerCase()} estimate` : 'Past every time-to-beat estimate'}
      visual={pr ? (
        <div className="gi-ttb" role="img" aria-label={pr.markers.map((m) => `${m.label} ${formatHours(m.seconds)}${m.reached ? ', reached' : ''}`).join('; ')}>
          <span className="gi-ttb__track">
            <span className="gi-ttb__fill" style={{ transform: `scaleX(${pr.fill})`, transition: reduce ? 'none' : undefined }} />
            {pr.markers.map((m) => <span key={m.key} className="gi-ttb__tick" data-reached={m.reached || undefined} style={{ left: `${m.pos * 100}%` }} title={`${m.label}: ${TTB_HINT[m.key]}`} />)}
          </span>
          <span className="gi-ttb__legend" aria-hidden>
            {pr.markers.map((m) => <span key={m.key} data-reached={m.reached || undefined}>{m.label.split(' ')[0]} <b className="num">{formatHours(m.seconds)}</b></span>)}
          </span>
        </div>
      ) : undefined}
      source={pr ? 'Your time: tracked by VYSTRAL or reported by the store, whichever is larger · Estimates: IGDB players' : 'Tracked by VYSTRAL or reported by the store, whichever is larger'}
    />
  );
}

// ---------- Sessions sparkline ----------

export function SessionsTile({ sessions, index }: { sessions: Session[]; index: number }) {
  const weeks = useMemo(() => weeklyPlay(sessions, 12), [sessions]);
  const total = weeks.reduce((s, w) => s + w.seconds, 0);
  const count = weeks.reduce((s, w) => s + w.sessions, 0);
  const max = Math.max(...weeks.map((w) => w.seconds), 1);
  const [active, setActive] = useState<number | null>(null);
  const id = useId();
  const [ref, width] = useWidth<HTMLDivElement>(200);
  const h = 44;
  const gap = 3;
  const bw = Math.min(16, (width - gap * (weeks.length - 1)) / weeks.length);
  const span = bw * weeks.length + gap * (weeks.length - 1);
  const x0 = width - span;
  const busiest = weeks.reduce((b, w) => (w.seconds > b.seconds ? w : b), weeks[0]);
  const weekLabel = (start: string) => new Date(`${start}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const describe = (i: number) => `Week of ${weekLabel(weeks[i].start)}: ${weeks[i].seconds ? `${formatDuration(weeks[i].seconds)}, ${plural(weeks[i].sessions, 'session')}` : 'not played'}`;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      setActive((a) => Math.max(0, Math.min(weeks.length - 1, (a ?? weeks.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1))));
    } else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(weeks.length - 1);
  };
  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - x0 + gap / 2) / (bw + gap));
    setActive(i >= 0 && i < weeks.length ? i : null);
  };
  return (
    <StatTile
      index={index} testId="tile-sessions" label="Last 12 weeks" icon={<CalendarDays size={15} />}
      value={total ? formatDuration(total) : 'Not played'}
      sub={total ? `${plural(count, 'session')} · busiest week ${weekLabel(busiest.start)}` : 'No sessions in the last 12 weeks'}
      visual={
        <div className="vx-chart gi-spark" ref={ref} tabIndex={0} role="img" aria-roledescription="chart" aria-describedby={`${id}-read`}
          aria-label={`Play time per week for the last 12 weeks. ${total ? `${formatDuration(total)} in total.` : 'Not played.'} Use the arrow keys to read each week.`}
          onKeyDown={onKey} onBlur={() => setActive(null)}>
          <svg width={width} height={h} aria-hidden focusable="false">
            <line className="vx-chart__baseline" x1={x0} x2={width} y1={h - 0.5} y2={h - 0.5} />
            {weeks.map((w, i) => {
              const bh = w.seconds ? Math.max(3, (w.seconds / max) * (h - 4)) : 0;
              return bh ? (
                <path key={w.start} className="gi-spark__bar" data-current={i === weeks.length - 1 || undefined} data-active={active === i || undefined}
                  d={roundTop(x0 + i * (bw + gap), h - 1, bw, bh, Math.min(3, bw / 2))} />
              ) : null;
            })}
            <rect className="vx-chart__hit" x={0} y={0} width={width} height={h} onPointerMove={onMove} onPointerLeave={() => setActive(null)} />
          </svg>
          {active != null && (
            <div className="vx-tip" style={{ left: Math.min(width - 150, Math.max(0, x0 + active * (bw + gap) - 60)), top: -54 }} aria-hidden>
              <strong>{weeks[active].seconds ? formatDuration(weeks[active].seconds) : 'Not played'}</strong>
              Week of {weekLabel(weeks[active].start)}{weeks[active].sessions ? ` · ${plural(weeks[active].sessions, 'session')}` : ''}
            </div>
          )}
          <span id={`${id}-read`} className="visually-hidden" aria-live="polite">{active != null ? describe(active) : ''}</span>
        </div>
      }
      source="Sessions VYSTRAL tracked on this PC, by the week they started"
    />
  );
}

/** A column with a 3 px rounded top, square at the baseline. */
function roundTop(x: number, base: number, w: number, h: number, r: number) {
  const top = base - h;
  const rr = Math.min(r, h);
  return `M${x},${base} V${top + rr} Q${x},${top} ${x + rr},${top} H${x + w - rr} Q${x + w},${top} ${x + w},${top + rr} V${base} Z`;
}

// ---------- Achievements ----------

export function AchievementsTile({ p, onOpen, index }: { p: AchievementProgress; onOpen?: () => void; index: number }) {
  const frac = p.total ? p.unlocked / p.total : 0;
  return (
    <StatTile
      index={index} testId="tile-achievements" label="Achievements" icon={<Trophy size={15} />}
      tone={p.total > 0 && p.unlocked === p.total ? 'ok' : undefined}
      value={<span className="gi-split"><span>{p.unlocked}<span className="gi-of"> / {p.total}</span></span><Ring value={frac} label={`${Math.round(frac * 100)}% of achievements unlocked`} size={56} /></span>}
      sub={p.unlocked === p.total && p.total ? 'Every achievement unlocked' : p.rarestName && p.rarestPercent != null ? <>Rarest: {p.rarestName} <span className="num">({p.rarestPercent.toFixed(1)}% of players)</span></> : `${p.total - p.unlocked} still to unlock`}
      action={onOpen && <button className="gi-link" onClick={onOpen}>See all <ArrowRight size={12} aria-hidden /></button>}
      source={`Steam, as last saved by VYSTRAL${checked(p.fetchedAt)}`}
    />
  );
}

// ---------- Review snapshot ----------

const TREND_ICON = { up: TrendingUp, down: TrendingDown, steady: ArrowRight } as const;

export function ReviewsTile({ r, onOpen, index }: { r: ReviewsSnapshot; onOpen?: () => void; index: number }) {
  const all = r.allTime!;
  const tone = reviewTone(all.percent);
  const recentTone = reviewTone(r.recent?.percent);
  const trend = trendText(r);
  const TrendIcon = r.trend ? TREND_ICON[r.trend] : null;
  return (
    <StatTile
      index={index} testId="tile-reviews" label="Steam reviews" icon={<MessageSquareText size={15} />} tone={tone ?? undefined}
      value={<>{all.percent != null ? `${Math.round(all.percent)}%` : '—'}<span className="gi-of"> positive</span></>}
      sub={<><span className="gi-verdict" data-tone={tone ?? undefined}>{all.label}</span> · <span className="num">{compact(all.total)}</span> {all.total === 1 ? 'review' : 'reviews'}</>}
      action={onOpen && <button className="gi-link" onClick={onOpen} aria-label="Read reviews on Steam (opens your browser)">Read <ExternalLink size={11} aria-hidden /></button>}
      visual={
        <div className="gi-rev">
          <div className="gi-rev__row">
            <span className="gi-rev__k">All time</span>
            <Meter value={(all.percent ?? 0) / 100} tone={tone ?? undefined} label={`All time: ${all.percent ?? 0}% positive of ${all.total.toLocaleString()} reviews`} />
            <span className="gi-rev__v num">{all.percent != null ? `${Math.round(all.percent)}%` : '—'}</span>
          </div>
          {r.recent && r.recent.total > 0 && (
            <div className="gi-rev__row">
              <span className="gi-rev__k">30 days</span>
              <Meter value={(r.recent.percent ?? 0) / 100} tone={recentTone ?? undefined} label={`Last 30 days: ${r.recent.percent ?? 0}% positive of ${r.recent.total.toLocaleString()} reviews`} />
              <span className="gi-rev__v num">{r.recent.percent != null ? `${Math.round(r.recent.percent)}%` : '—'}</span>
            </div>
          )}
          <p className="gi-trend" data-trend={r.trend ?? 'unknown'}>
            {TrendIcon && <TrendIcon size={14} aria-hidden />}
            {trend ?? (r.recent && r.recent.total > 0 ? `Too few recent reviews (${r.recent.total}) to call a trend` : 'No reviews in the last 30 days')}
          </p>
        </div>
      }
      source={<>Steam user reviews, all languages{checked(r.fetchedAt)}{r.stale ? ' · couldn’t refresh, showing saved reviews' : ''}</>}
    />
  );
}

// ---------- Ratings ----------

export function RatingsTile({ rows, index }: { rows: RatingRow[]; index: number }) {
  const lead = rows[0];
  return (
    <StatTile
      index={index} testId="tile-ratings" label="Ratings" icon={<Star size={15} />}
      value={<>{lead.display}<span className="gi-of"> {lead.key === 'users' && lead.display.includes('/') ? '' : lead.key === 'steam' ? 'positive' : '/ 100'}</span></>}
      sub={`${lead.label}${lead.count ? ` · ${compact(lead.count)} ${lead.key === 'critics' ? 'reviews' : 'ratings'}` : ''}`}
      visual={
        <ul className="gi-ratings">
          {rows.map((row) => (
            <li key={row.key} title={`${row.source}${row.count ? ` (${row.count.toLocaleString()})` : ''}`}>
              <span className="gi-ratings__k">{row.label}</span>
              <Meter value={row.value / 100} label={`${row.label}: ${row.display}${row.key === 'users' && row.display.includes('/') ? '' : row.key === 'steam' ? ' positive' : ' out of 100'}. ${row.source}.`} />
              <span className="gi-ratings__v num">{row.display}</span>
            </li>
          ))}
        </ul>
      }
      source={rows.map((r) => r.source).join(' · ')}
    />
  );
}

// ---------- Price ----------

export function PriceTile({ facts, deals, fallback, index }: {
  facts: StoreFacts | null;
  deals: Deals | null;
  /** Discover pages: the Steam price the page already knows, when store facts are off. */
  fallback?: { text: string | null; initial: string | null; discount: number; comingSoon: boolean; free: boolean } | null;
  index: number;
}) {
  const id = useId();
  const [ref, width] = useWidth<HTMLDivElement>(360);
  const [active, setActive] = useState<number | null>(null);
  const sold = !!facts?.sold && facts.priceCents != null;
  const currency = facts?.currency ?? null;
  const quotes = deals?.quotes.filter((q) => q.offers.length || q.historicalLow != null) ?? [];
  const sameLow = quotes.find((q) => q.currency && q.currency === currency && q.historicalLow != null);
  const lowCents = sameLow ? Math.round(sameLow.historicalLow! * 100) : null;
  const anyLow = sameLow ?? quotes.find((q) => q.historicalLow != null);
  const bestQuote = quotes.find((q) => q.currency === currency && q.offers.length) ?? quotes.find((q) => q.offers.length);
  const best = bestQuote ? { q: bestQuote, o: bestQuote.offers[0] } : undefined;
  const h = 92;
  const chart = sold && facts ? priceChart(facts.history, width, h, lowCents) : null;
  const pos = sold && facts ? pricePosition(facts.priceCents, lowCents, facts.regularCents) : null;
  const atLowest = sold && lowCents != null && facts!.priceCents! <= lowCents;
  const discount = sold ? facts!.discount : fallback?.discount ?? 0;
  const headline = sold ? formatMoney(facts!.priceCents!, currency) : facts?.comingSoon || fallback?.comingSoon ? 'Coming soon' : fallback?.free ? 'Free to play' : fallback?.text ?? (facts?.status === 'ok' ? 'Not sold on its own' : '—');
  const regular = sold && facts!.regularCents && facts!.regularCents > facts!.priceCents! ? formatMoney(facts!.regularCents, currency) : !sold && fallback?.discount ? fallback.initial : null;

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    if (!chart) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    let best = 0;
    chart.points.forEach((p, i) => { if (p.x <= x + 1) best = i; });
    setActive(best);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!chart) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      setActive((a) => Math.max(0, Math.min(chart.points.length - 1, (a ?? chart.points.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1))));
    }
  };
  const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const point = active != null && chart ? chart.points[active] : null;

  return (
    <StatTile
      wide index={index} testId="tile-price" label={facts?.country ? `Price in your region (${facts.country})` : 'Price'} icon={<Tag size={15} />}
      tone={atLowest ? 'ok' : undefined}
      value={
        <span className="gi-price">
          <span>{headline}</span>
          {discount > 0 && <Badge tone="ok" icon={<Tag size={12} />}>On sale −{discount}%</Badge>}
          {atLowest && <Badge tone="ok" icon={<BadgeCheck size={12} />}>Lowest ever</Badge>}
          {regular && <span className="gi-price__was">was <s>{regular}</s></span>}
        </span>
      }
      sub={pos != null && !atLowest ? (pos < 0.34 ? 'Close to its lowest price ever' : pos > 0.85 ? 'At or near its regular price' : 'Between its lowest and regular price') : sold && !chart ? 'VYSTRAL keeps a price history from the first time it saw this price' : undefined}
      visual={
        <div className="gi-pricebox" ref={ref}>
          {chart && (
            <div className="vx-chart gi-pchart" tabIndex={0} role="img" aria-roledescription="chart" aria-describedby={`${id}-read`} onKeyDown={onKey} onBlur={() => setActive(null)}
              aria-label={`Steam price seen by VYSTRAL over ${plural(chart.days, 'day')}: between ${formatMoney(chart.min, currency)} and ${formatMoney(chart.max, currency)}${lowCents != null ? `; lowest ever ${formatMoney(lowCents, currency)}` : ''}. Use the arrow keys to read each change.`}>
              <svg width={width} height={h} aria-hidden focusable="false">
                {chart.ticks.map((t) => <line key={t.cents} className="vx-chart__grid" x1={0} x2={width} y1={Math.round(t.y) + 0.5} y2={Math.round(t.y) + 0.5} />)}
                {chart.lowY != null && <line className="gi-pchart__low" x1={0} x2={width} y1={chart.lowY} y2={chart.lowY} />}
                <path className="gi-pchart__area" d={chart.area} />
                <path className="vx-chart__line gi-pchart__line" d={chart.line} />
                {point && <line className="vx-chart__cross" x1={point.x} x2={point.x} y1={0} y2={h} />}
                <circle className="vx-chart__dot gi-pchart__dot" cx={(point ?? chart.points[chart.points.length - 1]).x} cy={(point ?? chart.points[chart.points.length - 1]).y} r={4} />
                <rect className="vx-chart__hit" x={0} y={0} width={width} height={h} onPointerMove={onMove} onPointerLeave={() => setActive(null)} />
              </svg>
              <span className="gi-pchart__tick gi-pchart__tick--hi num" aria-hidden>{formatMoney(chart.ticks[0].cents, currency)}</span>
              {chart.lowY != null && <span className="gi-pchart__lowlabel" style={{ top: chart.lowY - 16 }} aria-hidden>Lowest ever</span>}
              {point && (
                <div className="vx-tip" style={{ left: Math.min(width - 160, Math.max(0, point.x - 70)), top: -50 }} aria-hidden>
                  <strong>{formatMoney(point.cents, currency)}</strong>From {dayLabel(point.day)}
                </div>
              )}
              <span id={`${id}-read`} className="visually-hidden" aria-live="polite">{point ? `${formatMoney(point.cents, currency)} from ${dayLabel(point.day)}` : ''}</span>
            </div>
          )}
          {!chart && pos != null && (
            <div className="gi-ppos" role="img" aria-label={`Today’s price sits ${Math.round(pos * 100)}% of the way from its lowest ever to its regular price`}>
              <span className="gi-ppos__track"><span className="gi-ppos__mark" style={{ left: `${pos * 100}%` }} /></span>
              <span className="gi-ppos__ends" aria-hidden><span>Lowest {formatMoney(lowCents!, currency)}</span><span>Regular {formatMoney(facts!.regularCents!, currency)}</span></span>
            </div>
          )}
          <dl className="gi-regions">
            {(sold || fallback?.text) && <div><dt>Steam · {facts?.country ?? 'store'}</dt><dd className="num">{sold ? facts!.priceText ?? headline : fallback?.text}</dd></div>}
            {best && <div><dt>Best deal now</dt><dd><span className="num">{formatMoney(Math.round(best.o.price * 100), best.q.currency)}</span> at {best.o.shop}{best.o.cut > 0 ? ` (−${best.o.cut}%)` : ''}</dd></div>}
            {anyLow && <div><dt>Lowest ever</dt><dd><span className="num">{formatMoney(Math.round(anyLow.historicalLow! * 100), anyLow.currency)}</span>{anyLow.historicalLowAt ? ` · ${formatDate(anyLow.historicalLowAt, { month: 'short', year: 'numeric' })}` : ''}</dd></div>}
          </dl>
        </div>
      }
      source={<>
        {sold ? `Steam store price for ${facts!.country}${checked(facts!.fetchedAt)}` : fallback?.text ? 'Steam store price' : 'Steam store'}
        {chart ? ' · history: prices VYSTRAL saw on this PC' : ''}
        {quotes.length ? ` · deals and lowest ever from ${[...new Set(quotes.map((q) => (q.provider === 'itad' ? 'IsThereAnyDeal' : 'CheapShark')))].join(' and ')}${quotes.some((q) => q.currency && q.currency !== currency) ? ` (${[...new Set(quotes.map((q) => q.currency).filter(Boolean))].join(', ')})` : ''}` : ''}
        {facts?.stale ? ' · couldn’t refresh, showing the last price' : ''}
      </>}
    />
  );
}

// ---------- Compatibility ----------

export function CompatTile({ deck, antiCheat, index }: { deck: Compat['deck']; antiCheat: Compat['antiCheat']; index: number }) {
  const tone = deck ? deckTone(deck.category) : undefined;
  const DeckIcon = deck?.category === 'verified' ? BadgeCheck : deck?.category === 'playable' ? Info : deck?.category === 'unsupported' ? XCircle : CircleDashed;
  const counts = deck ? (['pass', 'note', 'fail'] as const).map((k) => [k, deck.tests.filter((t) => t.kind === k).length] as const).filter(([, n]) => n > 0) : [];
  return (
    <StatTile
      index={index} testId="tile-compat" label="Steam Deck and anti-cheat" icon={<ServiceLogo service="steamdeck" size={15} decorative />}
      tone={antiCheat?.kernel ? 'warn' : (tone as TileTone | undefined)}
      value={deck ? <span className="gi-deck" data-tone={tone}><DeckIcon size={20} aria-hidden /> {DECK_LABEL[deck.category]}</span> : 'Not rated for Deck'}
      sub={antiCheat
        ? <span className="gi-ac" data-kernel={antiCheat.kernel || undefined}><ShieldAlert size={13} aria-hidden /> {antiCheat.kernel ? 'Kernel anti-cheat' : 'Anti-cheat'}: {antiCheat.names.join(', ') || 'unnamed'}</span>
        : 'No anti-cheat listed'}
      visual={counts.length ? (
        <ul className="gi-tests" aria-label="Valve’s test results">
          {counts.map(([k, n]) => <li key={k} data-kind={k}>{n} {k === 'pass' ? 'passed' : k === 'note' ? (n === 1 ? 'note' : 'notes') : 'failed'}</li>)}
        </ul>
      ) : antiCheat ? <p className="gi-note">{antiCheat.statusLabel}</p> : undefined}
      source={[deck ? `Steam Deck results reported by Valve${checked(deck.fetched)}` : null, antiCheat ? 'anti-cheat per AreWeAntiCheatYet' : null].filter(Boolean).join(' · ') || 'Valve and AreWeAntiCheatYet'}
    />
  );
}

// ---------- Disk ----------

export function DiskTile({ game, update, freeBytes, totalBytes, drive, index }: {
  game: Game; update: { needBytes: number | null; fit: string } | null; freeBytes: number | null; totalBytes: number | null; drive: string | null; index: number;
}) {
  const installed = isInstalled(game);
  const size = sizeOf(game);
  const used = totalBytes && freeBytes != null ? totalBytes - freeBytes : null;
  const tone: TileTone | undefined = update?.fit === 'short' ? 'danger' : update?.fit === 'tight' ? 'warn' : undefined;
  return (
    <StatTile
      index={index} testId="tile-disk" label="Size on disk" icon={<HardDrive size={15} />} tone={tone}
      value={installed && size ? formatBytes(size) : 'Not installed'}
      sub={update ? (update.needBytes ? `Next update needs ${formatBytes(update.needBytes)}${update.fit === 'short' ? ' — it won’t fit' : update.fit === 'tight' ? ' — space is tight' : ''}` : 'An update is pending')
        : installed && drive ? `On ${drive}${freeBytes != null ? ` · ${formatBytes(freeBytes)} free` : ''}` : installed ? 'No update pending' : undefined}
      visual={installed && size && totalBytes && used != null ? (
        <div className="gi-disk" role="img" aria-label={`${drive}: this game ${formatBytes(size)}, other files ${formatBytes(Math.max(0, used - size))}, free ${formatBytes(freeBytes)}${update?.needBytes ? `, next update ${formatBytes(update.needBytes)}` : ''}`}>
          <span className="gi-disk__bar">
            <span className="gi-disk__other" style={{ width: `${(Math.max(0, used - size) / totalBytes) * 100}%` }} />
            <span className="gi-disk__game" style={{ width: `${Math.max(1, (size / totalBytes) * 100)}%` }} />
            {update?.needBytes ? <span className="gi-disk__update" data-fit={update.fit} style={{ width: `${Math.max(1, Math.min(update.needBytes, freeBytes ?? 0) / totalBytes * 100)}%` }} /> : null}
          </span>
          <span className="gi-disk__legend" aria-hidden><span><i className="gi-key gi-key--game" />This game</span>{update?.needBytes ? <span><i className="gi-key gi-key--update" />Update</span> : null}<span><i className="gi-key gi-key--other" />Other</span></span>
        </div>
      ) : undefined}
      source={update ? 'Installed size from your store app · update size reported by Steam' : 'Reported by your store app'}
    />
  );
}

// ---------- Release ----------

export function ReleaseTile({ date, storeText, comingSoon, developer, publisher, source, index }: {
  date: string | null; storeText?: string | null; comingSoon?: boolean; developer?: string | null; publisher?: string | null; source: string; index: number;
}) {
  const full = date && /^\d{4}-\d{2}-\d{2}/.test(date);
  const value = full ? formatDate(date, { dateStyle: 'medium' }) : storeText ?? date?.slice(0, 4) ?? 'Unknown';
  const age = releaseAge(date ?? null);
  const studio = [developer, publisher && publisher !== developer ? publisher : null].filter(Boolean).join(' · ');
  return (
    <StatTile
      index={index} testId="tile-release" label={comingSoon || age?.startsWith('in ') || age === 'coming soon' ? 'Release' : 'Released'} icon={<CalendarDays size={15} />}
      value={value}
      sub={[age ? age[0].toUpperCase() + age.slice(1) : null, studio || null].filter(Boolean).join(' · ') || undefined}
      source={source}
    />
  );
}

// ---------- Time to beat (games you don't own) ----------

export function TtbTile({ ttb, index }: { ttb: { hastilySeconds: number | null; normallySeconds: number | null; completelySeconds: number | null; count: number }; index: number }) {
  const rows = [
    { label: 'Main story', s: ttb.hastilySeconds },
    { label: 'Main + extras', s: ttb.normallySeconds },
    { label: 'Completionist', s: ttb.completelySeconds },
  ].filter((r) => r.s);
  const max = Math.max(...rows.map((r) => r.s ?? 0), 1);
  return (
    <StatTile
      index={index} testId="tile-ttb" label="Time to beat" icon={<Hourglass size={15} />}
      value={formatHours(rows[0]?.s) ?? '—'}
      sub={rows[0]?.label}
      visual={
        <ul className="gi-ratings">
          {rows.map((r) => (
            <li key={r.label}>
              <span className="gi-ratings__k">{r.label}</span>
              <Meter value={(r.s ?? 0) / max} label={`${r.label}: ${formatHours(r.s)}`} />
              <span className="gi-ratings__v num">{formatHours(r.s)}</span>
            </li>
          ))}
        </ul>
      }
      source={`IGDB player estimates${ttb.count ? ` · ${ttb.count.toLocaleString()} ${ttb.count === 1 ? 'player' : 'players'}` : ''}`}
    />
  );
}
