import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CalendarClock, CalendarDays, Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Sparkles, TrendingDown } from 'lucide-react';
import type { WishlistItem } from '../../bridge/types';
import { pushPadHandler } from '../../lib/input';
import { exit, reduced, spring } from '../../lib/motion';
import { titleHue } from '../../lib/palette';
import { formatMoney } from '../../lib/wishlist';
import {
  agendaWhen, dayKey, dayWords, firstDayOfWeek, gridMove, indexWishlist, markersOf, monthAgenda, monthCounts, monthGrid, nearestMonthWithReleases, nextRelease,
  precisionNote, releaseLanes, releaseWords, weekdayNames, type GridKey, type Lane, type Placed,
} from '../../lib/wishlistCalendar';
import { useReducedMotion } from '../../state/store';
import { Button, IconButton, Kbd, PadHint } from '../../components/ui/primitives';
import { openSteamApp } from '../../components/discover/DiscoverBits';
import './calendar.css';

type Ym = { year: number; month: number };

/** The month you were looking at, so Back from a game page returns to it (this app session only). */
let remembered: Ym | null = null;

const monthTitle = (ym: Ym) => new Date(ym.year, ym.month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const shortMonth = (m: number) => new Date(2023, m, 1).toLocaleDateString(undefined, { month: 'short' });
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const step = (ym: Ym, by: number): Ym => { const d = new Date(ym.year, ym.month + by, 1); return { year: d.getFullYear(), month: d.getMonth() }; };

/** "$29.99, 50% off" / "free to play" / "not for sale yet" — always through the shared price helper. */
function priceWords(item: WishlistItem): string {
  if (item.isFree) return 'free to play';
  if (item.notSold || item.priceCents == null) return item.comingSoon ? 'not for sale yet' : 'no price on Steam';
  return `${formatMoney(item.priceCents, item.currency)}${item.discount > 0 ? `, ${item.discount}% off` : ''}`;
}

function spoken(p: Placed, when: string): string {
  const m = markersOf(p.item);
  return [
    p.item.name, when, priceWords(p.item),
    m.lowest ? (m.belowLowest ? 'new lowest price ever' : 'lowest price ever') : null,
    p.item.gameId ? 'in your library' : null,
  ].filter(Boolean).join(', ');
}

function whenOf(p: Placed, today: Date): string {
  if (p.release.precision === 'day' && p.release.day) return dayWords(p.item, p.release.day, today);
  return `${releaseWords(p.release, p.item.comingSoon)} (${precisionNote(p.release.precision)})`;
}

/**
 * Track D2: the wishlist as a release calendar. A month grid with each day's covers, a year strip to move across
 * months, this month's agenda with the next release, and lanes for games Steam gives only a month, quarter, season,
 * year or no date. Every game opens its VYSTRAL page (yours when you own it).
 */
export function WishlistCalendar({ items, filtered }: { items: WishlistItem[]; filtered: boolean }) {
  const reduce = useReducedMotion();
  const [today] = useState(() => new Date());
  const [view, setViewState] = useState<Ym>(() => remembered ?? { year: today.getFullYear(), month: today.getMonth() });
  const [dir, setDir] = useState(0);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const firstDay = useMemo(() => firstDayOfWeek(), []);
  const index = useMemo(() => indexWishlist(items), [items]);
  const lanes = useMemo(() => releaseLanes(index.vague, today), [index, today]);
  const counts = useMemo(() => monthCounts(index, view.year), [index, view.year]);
  const agenda = useMemo(() => monthAgenda(index, view.year, view.month), [index, view.year, view.month]);
  const next = useMemo(() => nextRelease(index, today), [index, today]);
  const weeks = useMemo(() => monthGrid(view.year, view.month, firstDay, today), [view.year, view.month, firstDay, today]);
  const isNow = view.year === today.getFullYear() && view.month === today.getMonth();
  const total = agenda.days.reduce((n, d) => n + d.games.length, 0) + agenda.sometime.length;
  const title = monthTitle(view);

  const setView = useCallback((ym: Ym, direction?: number) => {
    setViewState((cur) => {
      const d = direction ?? Math.sign((ym.year - cur.year) * 12 + ym.month - cur.month);
      setDir(d);
      return ym;
    });
    setSelectedDay(null);
    remembered = ym;
  }, []);
  const go = useCallback((by: number) => setViewState((cur) => {
    const ym = step(cur, by);
    setDir(Math.sign(by));
    setSelectedDay(null);
    remembered = ym;
    return ym;
  }), []);

  // ---------- Roving focus inside the grid ----------
  const gridRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const focusAfterMove = useRef<'first' | 'last' | null>(null);
  const positions = useMemo(() => {
    const out: { row: number; col: number; key: string }[] = [];
    weeks.forEach((week, row) => week.forEach((cell, col) => {
      if (!cell.inMonth) return;
      const games = index.byDay.get(cell.key) ?? [];
      const shown = games.length > 2 ? 2 : games.length;
      for (let i = 0; i < shown; i++) out.push({ row, col, key: `${cell.key}#${i}` });
      if (games.length > 2) out.push({ row, col, key: `${cell.key}#more` });
    }));
    return out;
  }, [weeks, index]);
  const activeIndex = Math.min(active, Math.max(0, positions.length - 1));
  const focusAt = (i: number) => {
    setActive(i);
    gridRef.current?.querySelector<HTMLElement>(`[data-cal-key="${positions[i]?.key}"]`)?.focus();
  };

  // After a month change from the keyboard, focus lands on the new month's first (or last) game.
  useEffect(() => {
    const want = focusAfterMove.current;
    if (!want) return;
    focusAfterMove.current = null;
    const i = want === 'first' ? 0 : positions.length - 1;
    setActive(Math.max(0, i));
    // Wait for the entering grid to mount (the exit runs first).
    const t = window.setTimeout(() => {
      const el = gridRef.current?.querySelector<HTMLElement>(`[data-cal-key="${positions[i]?.key}"]`) ?? gridRef.current;
      el?.focus({ preventScroll: true });
    }, reduce ? 20 : 220);
    return () => window.clearTimeout(t);
  }, [positions, reduce]);

  const onGridKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, GridKey> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Home: 'home', End: 'end' };
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      focusAfterMove.current = 'first';
      go((e.key === 'PageUp' ? -1 : 1) * (e.shiftKey ? 12 : 1));
      return;
    }
    const k = keys[e.key];
    if (!k || positions.length === 0 || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    focusAt(gridMove(positions, activeIndex, k));
  };

  // Controller: LB/RB change the month while focus is in the calendar (elsewhere they keep going back/forward).
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => pushPadHandler((button, repeat) => {
    if (repeat || (button !== 'LB' && button !== 'RB')) return false;
    if (!rootRef.current?.contains(document.activeElement)) return false;
    if (gridRef.current?.contains(document.activeElement)) focusAfterMove.current = 'first';
    go(button === 'LB' ? -1 : 1);
    return true;
  }), [go]);

  const agendaRef = useRef<HTMLElement>(null);
  const showDay = (key: string) => {
    setSelectedDay(key);
    window.setTimeout(() => {
      const el = agendaRef.current?.querySelector<HTMLElement>(`[data-agenda-day="${key}"] button`);
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
    }, 0);
  };

  const later = nearestMonthWithReleases(index, view.year, view.month, 1);
  const earlier = nearestMonthWithReleases(index, view.year, view.month, -1);
  const variants = {
    enter: (d: number) => (reduce ? { opacity: 0 } : { opacity: 0, x: d * 28 }),
    center: { opacity: 1, x: 0 },
    // Exits are quicker than entrances (the next month waits for this one to leave).
    leave: (d: number) => (reduce ? { opacity: 0, transition: reduced } : { opacity: 0, x: d * -28, transition: exit }),
  };
  const weekdays = weekdayNames(firstDay);
  const weekdaysLong = weekdayNames(firstDay, 'long');

  return (
    <section className="wcal" ref={rootRef} aria-label="Release calendar">
      <YearStrip year={view.year} month={view.month} counts={counts} today={today}
        onMonth={(m) => setView({ year: view.year, month: m })}
        onYear={(by) => setView({ year: view.year + by, month: view.month }, by)} />

      <div className="wcal__body">
        <div className="wcal__main">
          <header className="wcal__head">
            <div className="wcal__title-wrap">
              <h2 className="wcal__title">{title}</h2>
              <span className="wcal__count">{total ? plural(total, 'release') : 'No releases'}{filtered ? ' (filtered)' : ''}</span>
            </div>
            <div className="wcal__nav">
              <IconButton label="Previous month" size="sm" onClick={() => go(-1)}><ChevronLeft size={17} /></IconButton>
              <Button size="sm" variant="ghost" icon={<CalendarDays size={14} />} disabled={isNow}
                onClick={() => setView({ year: today.getFullYear(), month: today.getMonth() })}>Today</Button>
              <IconButton label="Next month" size="sm" onClick={() => go(1)}><ChevronRight size={17} /></IconButton>
            </div>
          </header>
          <p className="visually-hidden" aria-live="polite">{`${title}: ${total ? plural(total, 'release') : 'no releases'}.`}</p>

          {agenda.sometime.length > 0 && (
            <div className="wcal__sometime" role="group" aria-label={`Sometime in ${title}, day not announced`}>
              <span className="caps wcal__sometime-label"><CalendarClock size={13} aria-hidden /> Sometime this month</span>
              <ul className="wcal__sometime-list">
                {agenda.sometime.map((p) => (
                  <li key={p.item.appId}>
                    <button type="button" className="wcal-chip" onClick={(e) => openSteamApp(p.item.appId, p.item.name, p.item.gameId, e.currentTarget.querySelector('.wposter, img'))}
                      aria-label={`Open the page for ${spoken(p, whenOf(p, today))}`}>
                      <Poster item={p.item} />
                      <span className="truncate">{p.item.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="wcal__frame">
            <div className="wcal__weekdays" aria-hidden>
              {weekdays.map((w, i) => <span key={i} data-weekend={[0, 6].includes((firstDay + i) % 7) || undefined}>{w}</span>)}
            </div>
            <AnimatePresence mode="wait" initial={false} custom={dir}>
              <motion.div
                key={`${view.year}-${view.month}`}
                ref={gridRef}
                className="wcal__grid"
                role="group"
                aria-label={`${title}. Arrow keys move between games, Page Up and Page Down change month.`}
                tabIndex={-1}
                onKeyDown={onGridKey}
                custom={dir}
                variants={variants}
                initial="enter"
                animate="center"
                exit="leave"
                transition={reduce ? reduced : { ...spring.page, opacity: { duration: 0.18 } }}
                style={{ ['--weeks' as string]: weeks.length }}
              >
                {weeks.map((week, row) => week.map((cell, col) => {
                  const games = cell.inMonth ? index.byDay.get(cell.key) ?? [] : [];
                  const shown = games.length > 2 ? games.slice(0, 2) : games;
                  const longDay = `${weekdaysLong[col]} ${cell.date.getDate()}`;
                  return (
                    <div key={cell.key} className="wcal-day" data-outside={!cell.inMonth || undefined} data-today={cell.isToday || undefined}
                      data-past={cell.isPast || undefined} data-n={Math.min(games.length, 3)} data-selected={selectedDay === cell.key || undefined}
                      data-row={row}>
                      <span className="wcal-day__num" aria-hidden>{cell.date.getDate()}</span>
                      {cell.isToday && <span className="wcal-day__today" aria-hidden>Today</span>}
                      {games.length > 0 && (
                        <div className="wcal-day__games">
                          {shown.map((p, i) => {
                            const key = `${cell.key}#${i}`;
                            const pos = positions.findIndex((x) => x.key === key);
                            return <CalendarGame key={p.item.appId} p={p} calKey={key} label={spoken(p, whenOf(p, today))} solo={games.length === 1}
                              tabbable={pos === activeIndex} onFocus={() => setActive(pos)} />;
                          })}
                          {games.length > 2 && (() => {
                            const key = `${cell.key}#more`;
                            const pos = positions.findIndex((x) => x.key === key);
                            return (
                              <button type="button" className="wcal-day__more" data-cal-key={key} tabIndex={pos === activeIndex ? 0 : -1}
                                onFocus={() => setActive(pos)} onClick={() => showDay(cell.key)}
                                aria-label={`${longDay}: ${games.length - 2} more ${games.length - 2 === 1 ? 'game' : 'games'}. Show the day’s list`}>
                                +{games.length - 2}
                              </button>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                  );
                }))}
              </motion.div>
            </AnimatePresence>
          </div>
          <p className="wcal__hint">
            <span className="wcal__hint-keys"><Kbd>←</Kbd><Kbd>→</Kbd><Kbd>↑</Kbd><Kbd>↓</Kbd> move between games · <Kbd>Page Up</Kbd><Kbd>Page Down</Kbd> change month</span>
            <span className="wcal__hint-pad"><PadHint button={['LB', 'RB']}>Change month</PadHint></span>
          </p>
        </div>

        <aside className="wcal__agenda" ref={agendaRef} aria-label={`Releases in ${title}`}>
          {next && <NextUp p={next} today={today} showing={isSame(view, next.release.day!)}
            onShow={() => setView({ year: next.release.day!.getFullYear(), month: next.release.day!.getMonth() })} />}
          <h3 className="wcal-agenda__title caps">{isNow ? 'This month' : title}</h3>
          {total === 0 ? (
            <div className="wcal-agenda__empty">
              <p>{filtered ? `Nothing that matches comes out in ${title}.` : `Nothing from your wishlist comes out in ${title}.`}</p>
              <div className="wcal-agenda__jumps">
                {earlier && <Button size="sm" variant="ghost" icon={<ChevronLeft size={14} />} onClick={() => setView(earlier)}>{monthTitle(earlier)}</Button>}
                {later && <Button size="sm" variant="ghost" onClick={() => setView(later)}>{monthTitle(later)} <ChevronRight size={14} aria-hidden /></Button>}
              </div>
            </div>
          ) : (
            <ol className="wcal-agenda__days">
              {agenda.days.map((d) => (
                <li key={dayKey(d.date)} data-agenda-day={dayKey(d.date)} data-selected={selectedDay === dayKey(d.date) || undefined}>
                  <div className="wcal-agenda__date" aria-hidden>
                    <span>{d.date.toLocaleDateString(undefined, { weekday: 'short' })}</span>
                    <b className="num">{d.date.getDate()}</b>
                  </div>
                  <ul className="wcal-agenda__games">
                    {d.games.map((p) => <li key={p.item.appId}><AgendaRow p={p} when={agendaWhen(p.item, d.date, today)} label={spoken(p, whenOf(p, today))} /></li>)}
                  </ul>
                </li>
              ))}
              {agenda.sometime.length > 0 && (
                <li data-agenda-day="sometime">
                  <div className="wcal-agenda__date wcal-agenda__date--vague" aria-hidden><CalendarClock size={16} /></div>
                  <ul className="wcal-agenda__games">
                    {agenda.sometime.map((p) => <li key={p.item.appId}><AgendaRow p={p} when={`Sometime in ${title}`} label={spoken(p, whenOf(p, today))} /></li>)}
                  </ul>
                </li>
              )}
            </ol>
          )}
        </aside>
      </div>

      <Lanes lanes={lanes} today={today} />
    </section>
  );
}

const isSame = (ym: Ym, d: Date) => ym.year === d.getFullYear() && ym.month === d.getMonth();

function YearStrip({ year, month, counts, today, onMonth, onYear }: {
  year: number; month: number; counts: number[]; today: Date; onMonth: (m: number) => void; onYear: (by: number) => void;
}) {
  const reduce = useReducedMotion();
  const max = Math.max(1, ...counts);
  const total = counts.reduce((a, b) => a + b, 0);
  return (
    <nav className="wyear" aria-label={`Months of ${year}`}>
      <IconButton label="Previous year" size="sm" onClick={() => onYear(-1)}><ChevronsLeft size={16} /></IconButton>
      <span className="wyear__year">
        <b className="num">{year}</b>
        <span>{total ? plural(total, 'release') : 'No releases'}</span>
      </span>
      <ol className="wyear__months">
        {counts.map((n, m) => {
          const selected = m === month;
          const now = year === today.getFullYear() && m === today.getMonth();
          const label = `${new Date(year, m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}, ${n ? plural(n, 'release') : 'no releases'}${now ? ', this month' : ''}`;
          return (
            <li key={m}>
              <button type="button" className="wyear__month" aria-label={label} aria-current={selected ? 'date' : undefined}
                data-now={now || undefined} data-has={n > 0 || undefined} onClick={() => onMonth(m)}>
                {selected && <motion.span layoutId="wyear-pill" className="wyear__pill" transition={reduce ? { duration: 0 } : spring.focus} aria-hidden />}
                <span className="wyear__name">
                  {shortMonth(m)}
                  {now && <span className="wyear__now" aria-hidden />}
                  {n > 0 && <span className="wyear__n num" aria-hidden>{n}</span>}
                </span>
                <span className="wyear__heat" aria-hidden style={{ ['--heat' as string]: n / max }} />
              </button>
            </li>
          );
        })}
      </ol>
      <IconButton label="Next year" size="sm" onClick={() => onYear(1)}><ChevronsRight size={16} /></IconButton>
    </nav>
  );
}

/** A cover (portrait), else the wide header cropped, else VYSTRAL's own poster with the title. Never a blank icon. */
export function Poster({ item, wide = false }: { item: WishlistItem; wide?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  const preferred = wide ? item.header ?? item.cover : item.cover ?? item.header;
  const src = preferred && preferred !== failed ? preferred : null;
  if (src) {
    return <img className="wposter-img" src={src} alt="" loading="lazy" decoding="async" draggable={false}
      data-crop={(wide ? !item.header : !item.cover) || undefined} onError={() => setFailed(src)} />;
  }
  return (
    <span className="wposter" style={{ ['--wish-hue' as string]: titleHue(item.name) }} aria-hidden>
      <span className="wposter__title">{item.name}</span>
    </span>
  );
}

function Marks({ item, compact = false }: { item: WishlistItem; compact?: boolean }) {
  const m = markersOf(item);
  if (!m.cut && !m.lowest && !item.gameId) return null;
  return (
    <span className="wmarks" aria-hidden data-compact={compact || undefined}>
      {m.cut != null && <span className="wmark wmark--cut num">−{m.cut}%</span>}
      {m.lowest && <span className="wmark wmark--low" title={m.belowLowest ? 'New lowest price ever' : 'Lowest price ever'}><TrendingDown size={11} />{compact ? null : m.belowLowest ? ' New low' : ' Lowest'}</span>}
      {item.gameId && <span className="wmark wmark--owned" title="In your library"><Check size={11} /></span>}
    </span>
  );
}

function CalendarGame({ p, calKey, label, solo, tabbable, onFocus }: { p: Placed; calKey: string; label: string; solo: boolean; tabbable: boolean; onFocus: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button type="button" ref={ref} className="wcal-game" data-cal-key={calKey} data-solo={solo || undefined} tabIndex={tabbable ? 0 : -1}
      data-out={!p.item.comingSoon || undefined} onFocus={onFocus} aria-label={`Open the page for ${label}`}
      onClick={() => openSteamApp(p.item.appId, p.item.name, p.item.gameId, ref.current)}>
      <Poster item={p.item} />
      <Marks item={p.item} compact />
      <span className="wcal-game__name" aria-hidden>{p.item.name}</span>
    </button>
  );
}

function AgendaRow({ p, when, label }: { p: Placed; when: string; label: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const m = markersOf(p.item);
  return (
    <button type="button" ref={ref} className="wcal-row" aria-label={`Open the page for ${label}`}
      onClick={() => openSteamApp(p.item.appId, p.item.name, p.item.gameId, ref.current?.querySelector('img, .wposter'))}>
      <span className="wcal-row__art"><Poster item={p.item} wide /></span>
      <span className="wcal-row__text">
        <span className="wcal-row__name truncate">{p.item.name}</span>
        <span className="wcal-row__when">{when}</span>
        <span className="wcal-row__price">
          <PriceShort item={p.item} />
          {m.lowest && <span className="wmark wmark--low"><TrendingDown size={11} aria-hidden /> {m.belowLowest ? 'New lowest' : 'Lowest ever'}</span>}
          {p.item.gameId && <span className="wmark wmark--owned"><Check size={11} aria-hidden /> Owned</span>}
        </span>
      </span>
    </button>
  );
}

function PriceShort({ item }: { item: WishlistItem }) {
  if (item.isFree) return <span className="wprice">Free to play</span>;
  if (item.notSold || item.priceCents == null) return <span className="wprice wprice--muted">{item.comingSoon ? 'Not for sale yet' : 'No price on Steam'}</span>;
  return (
    <span className="wprice num">
      {formatMoney(item.priceCents, item.currency)}
      {item.discount > 0 && <span className="wmark wmark--cut">−{item.discount}%</span>}
    </span>
  );
}

function NextUp({ p, today, showing, onShow }: { p: Placed; today: Date; showing: boolean; onShow: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const day = p.release.day!;
  const when = dayWords(p.item, day, today);
  return (
    <div className="wnext" style={{ ['--wish-hue' as string]: titleHue(p.item.name) }}>
      <button type="button" ref={ref} className="wnext__card" aria-label={`Next up: open the page for ${spoken(p, when)}`}
        onClick={() => openSteamApp(p.item.appId, p.item.name, p.item.gameId, ref.current?.querySelector('img, .wposter'))}>
        <span className="wnext__art"><Poster item={p.item} wide /></span>
        <span className="wnext__text">
          <span className="caps wnext__eyebrow"><Sparkles size={12} aria-hidden /> Next up</span>
          <span className="wnext__name truncate">{p.item.name}</span>
          <span className="wnext__when">{when}</span>
        </span>
      </button>
      {!showing && <Button size="sm" variant="ghost" className="wnext__show" onClick={onShow}>Show {day.toLocaleDateString(undefined, { month: 'long' })}</Button>}
    </div>
  );
}

const LANE_CAP = 24;

function Lanes({ lanes, today }: { lanes: Lane[]; today: Date }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  if (lanes.length === 0) return null;
  return (
    <section className="wlanes" aria-labelledby="wlanes-title">
      <div className="wlanes__head">
        <h2 id="wlanes-title" className="wlanes__title">Coming, no exact day yet</h2>
        <p className="wlanes__lede">Steam gives only a month, a quarter, a season or a year for these, or no date at all. VYSTRAL shows exactly what’s known.</p>
      </div>
      {lanes.map((lane) => {
        const all = open.has(lane.id);
        const list = all ? lane.items : lane.items.slice(0, LANE_CAP);
        return (
          <section key={lane.id} className="wlane" data-lane={lane.id} aria-labelledby={`wlane-${lane.id}`}>
            <header className="wlane__head">
              <h3 id={`wlane-${lane.id}`} className="wlane__title">{lane.title}</h3>
              <span className="wlane__sub">{lane.sub}</span>
              <span className="wlane__n">{plural(lane.items.length, 'game')}</span>
            </header>
            <ul className="wlane__row">
              {list.map((p) => <li key={p.item.appId}><LaneCard p={p} today={today} /></li>)}
            </ul>
            {lane.items.length > LANE_CAP && (
              <Button size="sm" variant="ghost" className="wlane__all" aria-expanded={all}
                onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(lane.id)) n.delete(lane.id); else n.add(lane.id); return n; })}>
                {all ? 'Show fewer' : `Show all ${lane.items.length}`}
              </Button>
            )}
          </section>
        );
      })}
    </section>
  );
}

function LaneCard({ p, today }: { p: Placed; today: Date }) {
  const ref = useRef<HTMLButtonElement>(null);
  const words = releaseWords(p.release, p.item.comingSoon);
  return (
    <button type="button" ref={ref} className="wlane-card" data-precision={p.release.precision}
      aria-label={`Open the page for ${spoken(p, whenOf(p, today))}`}
      onClick={() => openSteamApp(p.item.appId, p.item.name, p.item.gameId, ref.current?.querySelector('img, .wposter'))}>
      <span className="wlane-card__art">
        <Poster item={p.item} />
        <Marks item={p.item} />
      </span>
      <span className="wlane-card__name truncate">{p.item.name}</span>
      <span className="wlane-card__when" title={precisionNote(p.release.precision)}>
        <CalendarClock size={12} aria-hidden /> {words}
      </span>
      <span className="wlane-card__price"><PriceShort item={p.item} /></span>
    </button>
  );
}

