import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeftRight, FileText, FolderOpen, Gauge, History, Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { call } from '../../bridge/bridge';
import type { Game, ModsList, NewsFeed, Session, VersionHistoryEntry } from '../../bridge/types';
import { formatDuration, plural } from '../../lib/format';
import { exit, pick, spring } from '../../lib/motion';
import {
  buildTimeline, domainOf, LANES, laneOf, markersFor, panView, recentView, sessionRadius, stepMarker, ticksFor, zoomView,
  type Lane, type Marker, type TimelineEvent, type View,
} from '../../lib/modTimeline';
import { HEALTH_LABEL } from '../../views/perf/overview';
import { useReducedMotion, useStore } from '../../state/store';
import { Button, IconButton, SectionHead, Skeleton } from '../ui/primitives';
import './mod-timeline.css';

const LANE_H = 46;
const AXIS_H = 26;
const LANE_LABEL: Record<Lane, string> = { updates: 'Updates', mods: 'Mods', sessions: 'Sessions' };
const RANGES = [
  { days: 90, label: '3 months' },
  { days: 365, label: 'Year' },
  { days: 0, label: 'All' },
] as const;

const dateFmt = (t: number, withTime = false) =>
  new Intl.DateTimeFormat(undefined, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(t);

interface Data {
  sessions: Session[] | null;
  versions: VersionHistoryEntry[] | null;
  news: NewsFeed | null;
  mods: ModsList | null;
  modsLoading: boolean;
  loading: boolean;
}

/** One line for a marker: what it is and when (tooltips and screen readers). */
function describe(e: TimelineEvent): string {
  if (e.kind === 'update') return `${e.title}${e.version && e.source === 'news' ? ` (${e.version})` : ''}, ${dateFmt(e.t)}`;
  if (e.kind === 'mod') return `${e.name} ${e.action === 'installed' ? 'installed' : 'updated'}, ${dateFmt(e.t)}`;
  const health = e.health === 'unmeasured' ? 'frame rate not measured' : `${HEALTH_LABEL[e.health].toLowerCase()}${e.fps ? `, ${Math.round(e.fps)} fps average` : ''}`;
  return `Session of ${formatDuration(e.seconds)}, ${dateFmt(e.t, true)}, ${health}${e.afterUpdate ? `. First session after ${e.afterUpdate.title}` : ''}`;
}

function markerLabel(m: Marker): string {
  if (m.events.length === 1) return describe(m.events[0]);
  const first = m.events[0];
  const what = first.kind === 'mod' ? plural(m.events.length, 'mod change') : plural(m.events.length, 'update');
  return `${what}, ${dateFmt(first.t)} to ${dateFmt(m.events[m.events.length - 1].t)}`;
}

/**
 * Track D1: game updates, your mod installs and your sessions on one horizontal timeline (game page › Sessions).
 * Zoom and pan with the buttons, Ctrl+scroll, dragging or the keyboard; arrows move between markers; Enter shows details.
 */
export function ModTimeline({ game, onOpenNews, onOpenFiles }: { game: Game; onOpenNews?: () => void; onOpenFiles?: () => void }) {
  const reduce = useReducedMotion();
  const navigate = useStore((s) => s.navigate);
  const steam = game.installations.some((i) => i.platform === 'steam');
  const [data, setData] = useState<Data>({ sessions: null, versions: null, news: null, mods: null, modsLoading: true, loading: true });

  useEffect(() => {
    let live = true;
    setData({ sessions: null, versions: null, news: null, mods: null, modsLoading: true, loading: true });
    void Promise.allSettled([
      call<Session[]>('sessions.list', { gameId: game.id, limit: 2000 }),
      call<VersionHistoryEntry[]>('versions.history', { gameId: game.id }),
      steam ? call<NewsFeed>('news.get', { gameId: game.id }, 60_000) : Promise.resolve(null),
    ]).then(([s, v, n]) => {
      if (!live) return;
      setData((d) => ({
        ...d,
        loading: false,
        sessions: s.status === 'fulfilled' && Array.isArray(s.value) ? s.value : [],
        versions: v.status === 'fulfilled' && Array.isArray(v.value) ? v.value : [],
        news: n.status === 'fulfilled' ? n.value : null,
      }));
    });
    // Mods read folders on disk, so they come in on their own.
    call<ModsList>('mods.list', { gameId: game.id }, 120_000)
      .then((m) => live && setData((d) => ({ ...d, mods: m, modsLoading: false })))
      .catch(() => live && setData((d) => ({ ...d, modsLoading: false })));
    return () => { live = false; };
  }, [game.id, steam]);

  const events = useMemo(
    () => buildTimeline({ sessions: data.sessions, versions: data.versions, news: data.news?.status === 'ok' ? data.news.posts : null, mods: data.mods }),
    [data.sessions, data.versions, data.news, data.mods],
  );
  const [now] = useState(() => Date.now());
  const domain = useMemo(() => domainOf(events, now), [events, now]);
  const [range, setRange] = useState<number>(365);
  const [view, setView] = useState<View>(() => recentView(domain, 365, now));
  // A new history (data arrived) re-frames the window on the chosen range.
  useEffect(() => {
    if (range >= 0) setView(range ? recentView(domain, range, now) : domain);
  }, [domain, range, now]);

  const plot = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useLayoutEffect(() => {
    const el = plot.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [data.loading]);

  const lanes = useMemo(() => Object.fromEntries(LANES.map((l) => [l, markersFor(events, l, view, width)])) as Record<Lane, Marker[]>, [events, view, width]);
  const ticks = useMemo(() => ticksFor(view, width), [view, width]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [pinned, setPinned] = useState<Marker | null>(null);
  const pinnedId = pinned?.id ?? null;
  const allMarkers = useMemo(() => LANES.flatMap((l) => lanes[l]), [lanes]);
  const markerOf = (id: string | null) => allMarkers.find((m) => m.id === id) ?? null;
  const tabStop = markerOf(focusId)?.id ?? lanes.sessions.at(-1)?.id ?? allMarkers.at(-1)?.id ?? null;

  const zoom = useCallback((factor: number, anchor?: number) => { setRange(-1); setView((v) => zoomView(v, domain, factor, anchor)); }, [domain]);
  const pan = useCallback((fraction: number) => { setRange(-1); setView((v) => panView(v, domain, (v.to - v.from) * fraction)); }, [domain]);

  const focusMarker = (id: string | null) => {
    if (!id) return;
    setFocusId(id);
    requestAnimationFrame(() => plot.current?.querySelector<HTMLElement>(`[data-marker="${CSS.escape(id)}"]`)?.focus());
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const id = target.dataset.marker ?? null;
    if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      pan(e.key === 'ArrowLeft' ? -0.2 : 0.2);
      return;
    }
    if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
      e.preventDefault();
      const m = markerOf(id);
      zoom(e.key === '-' || e.key === '_' ? 1.6 : 1 / 1.6, m ? m.events[0].t : undefined);
      return;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      focusMarker(stepMarker(lanes, id, e.key as 'ArrowLeft'));
    } else if (e.key === 'Escape' && pinnedId) {
      e.preventDefault();
      e.stopPropagation();
      setPinned(null);
    }
  };

  // Drag to pan (on the background, not on a marker).
  const drag = useRef<{ x: number; view: View } | null>(null);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-marker]')) return;
    drag.current = { x: e.clientX, view };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const span = d.view.to - d.view.from;
    setRange(-1);
    setView(panView(d.view, domain, (-(e.clientX - d.x) / width) * span));
  };
  const endDrag = () => { drag.current = null; setDragging(false); };
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    const rect = plot.current?.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      const anchor = rect ? view.from + ((e.clientX - rect.left) / width) * (view.to - view.from) : undefined;
      zoom(e.deltaY > 0 ? 1.25 : 0.8, anchor);
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      pan(((e.shiftKey ? e.deltaY : e.deltaX) / width) * 1);
    }
  };
  // Ctrl+wheel must not zoom the whole page.
  useEffect(() => {
    const el = plot.current;
    if (!el) return;
    const stop = (e: globalThis.WheelEvent) => { if (e.ctrlKey || e.metaKey || e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) e.preventDefault(); };
    el.addEventListener('wheel', stop, { passive: false });
    return () => el.removeEventListener('wheel', stop);
  }, [data.loading]);

  if (data.loading) {
    return (
      <section className="mtl" aria-busy="true" aria-label="Loading the timeline">
        <SectionHead title="Updates, mods and sessions" />
        <Skeleton height={LANE_H * 3 + AXIS_H} radius={16} />
      </section>
    );
  }

  const counts = { updates: events.filter((e) => e.kind === 'update' && e.source !== 'firstSeen').length, mods: events.filter((e) => e.kind === 'mod').length, sessions: events.filter((e) => e.kind === 'session').length };
  const empty = events.length === 0;
  const laneY = (l: Lane) => LANES.indexOf(l) * LANE_H + LANE_H / 2;
  const connectors = lanes.sessions.flatMap((m) => {
    const s = m.events[0];
    if (s.kind !== 'session' || !s.afterUpdate) return [];
    const u = events.find((e) => e.id === s.afterUpdate!.updateId);
    if (!u || u.t < view.from) return [];
    return [{ id: s.id, x1: Math.max(0, ((u.t - view.from) / (view.to - view.from)) * width), x2: m.x }];
  });
  const notes: string[] = [];
  if (!steam) notes.push('Patch notes come from Steam, so only builds VYSTRAL saw are shown for this game.');
  else if (data.news?.status === 'off') notes.push('Patch notes are off (Settings › Data sources), so only builds VYSTRAL saw are shown.');
  else if (data.news && data.news.status !== 'ok' && data.news.status !== 'none') notes.push('Patch notes couldn’t be loaded right now.');
  if (data.modsLoading) notes.push('Looking for mods…');

  const showTip = markerOf(hoverId ?? (focusId && document.activeElement?.getAttribute('data-marker') === focusId ? focusId : null));

  return (
    <section className="mtl" aria-labelledby={`mtl-${game.id}`}>
      <SectionHead
        title={<span id={`mtl-${game.id}`}>Updates, mods and sessions</span>}
        meta={empty ? undefined : [counts.updates && plural(counts.updates, 'update'), counts.mods && plural(counts.mods, 'mod change'), counts.sessions && plural(counts.sessions, 'session')].filter(Boolean).join(' · ')}
        action={!empty && (
          <div className="mtl__controls">
            <div className="mtl__ranges" role="group" aria-label="Show">
              {RANGES.map((r) => (
                <button key={r.label} type="button" className="chip" aria-pressed={range === r.days} onClick={() => { setRange(r.days); setView(r.days ? recentView(domain, r.days, now) : domain); }}>{r.label}</button>
              ))}
            </div>
            <IconButton label="Zoom out" size="sm" onClick={() => zoom(1.6)}><ZoomOut size={15} /></IconButton>
            <IconButton label="Zoom in" size="sm" onClick={() => zoom(1 / 1.6)}><ZoomIn size={15} /></IconButton>
            <IconButton label="Show everything" size="sm" onClick={() => { setRange(0); setView(domain); }}><Maximize2 size={14} /></IconButton>
          </div>
        )}
      />
      {empty ? (
        <div className="mtl__empty">
          <History size={22} aria-hidden />
          <p>Nothing on the timeline yet. Updates appear when Steam posts patch notes or VYSTRAL notices a new build after a scan; your mods and sessions show up here too.</p>
        </div>
      ) : (
        <>
          <div className="mtl__frame">
            <div className="mtl__labels" aria-hidden>
              {LANES.map((l) => <span key={l} style={{ height: LANE_H }}>{LANE_LABEL[l]}</span>)}
            </div>
            <div
              className="mtl__plot"
              ref={plot}
              data-dragging={dragging || undefined}
              data-reduce={reduce || undefined}
              style={{ height: LANE_H * 3 + AXIS_H }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onWheel={onWheel}
            >
              <svg className="mtl__svg" width={width} height={LANE_H * 3 + AXIS_H} aria-hidden>
                {LANES.map((l, i) => <line key={l} className="mtl__lane-line" x1={0} x2={width} y1={laneY(l)} y2={laneY(l)} data-lane={i} />)}
                {ticks.map((t) => {
                  const x = ((t.t - view.from) / (view.to - view.from)) * width;
                  return (
                    <g key={t.t}>
                      <line className="mtl__grid" data-major={t.major || undefined} x1={x} x2={x} y1={0} y2={LANE_H * 3} />
                      <text className="mtl__tick" x={x + 4} y={LANE_H * 3 + 17}>{t.label}</text>
                    </g>
                  );
                })}
                {now >= view.from && now <= view.to && (
                  <line className="mtl__now" x1={((now - view.from) / (view.to - view.from)) * width} x2={((now - view.from) / (view.to - view.from)) * width} y1={0} y2={LANE_H * 3} />
                )}
                {connectors.map((c) => (
                  <path key={c.id} className="mtl__link" d={`M${c.x1},${laneY('updates') + 7} C${c.x1},${laneY('mods')} ${c.x2},${laneY('mods')} ${c.x2},${laneY('sessions') - 12}`} />
                ))}
              </svg>
              <div className="mtl__markers" role="group" aria-label="Timeline. Arrow keys move between markers, Enter shows details, plus and minus zoom, Shift with arrows pans." onKeyDown={onKey}>
                {LANES.flatMap((l) => lanes[l].map((m) => {
                  const e = m.events[0];
                  const size = e.kind === 'session' ? sessionRadius(e.seconds) * 2 : 14;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      className="mtl__m"
                      data-marker={m.id}
                      data-lane={l}
                      data-kind={e.kind === 'update' ? e.source : e.kind === 'mod' ? e.action : e.health}
                      data-after={(e.kind === 'session' && !!e.afterUpdate) || undefined}
                      data-count={m.events.length > 1 ? m.events.length : undefined}
                      data-pinned={pinnedId === m.id || undefined}
                      tabIndex={tabStop === m.id ? 0 : -1}
                      style={{ left: m.x, top: laneY(l), width: size, height: size }}
                      aria-label={markerLabel(m)}
                      aria-expanded={pinnedId === m.id}
                      onFocus={() => setFocusId(m.id)}
                      onMouseEnter={() => setHoverId(m.id)}
                      onMouseLeave={() => setHoverId((h) => (h === m.id ? null : h))}
                      onClick={() => { setFocusId(m.id); setPinned((p) => (p?.id === m.id ? null : m)); }}
                    >
                      {m.events.length > 1 && <span className="mtl__count">{m.events.length}</span>}
                    </button>
                  );
                }))}
              </div>
              <AnimatePresence>
                {showTip && (
                  <motion.div
                    key={showTip.id}
                    className="mtl__tip"
                    role="presentation"
                    style={{ left: Math.min(Math.max(showTip.x, 110), width - 110), top: laneY(showTip.lane) - 22 }}
                    initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, transition: exit }}
                    transition={pick(reduce, spring.micro)}
                  >
                    {markerLabel(showTip)}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
          <Legend />
          <AnimatePresence initial={false}>
            {pinned && (
              <motion.div
                key={pinned.id}
                className="mtl__detail"
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: exit }}
                transition={pick(reduce, spring.panel)}
                aria-live="polite"
              >
                <ul>
                  {pinned.events.slice(0, 12).map((e) => (
                    <li key={e.id}>
                      <span className="mtl__dot" data-lane={laneOf(e)} data-kind={e.kind === 'update' ? e.source : e.kind === 'mod' ? e.action : e.health} aria-hidden />
                      <span className="mtl__detail-text">{describe(e)}</span>
                      {e.kind === 'session' && e.afterUpdate?.compareWith && (
                        <Button size="sm" variant="primary" icon={<ArrowLeftRight size={14} />} onClick={() => navigate({ name: 'performance', sessionId: e.id, tab: 'compare', compareWith: e.afterUpdate!.compareWith! })}>
                          Compare frame rate before and after
                        </Button>
                      )}
                      {e.kind === 'session' && (
                        <Button size="sm" variant="ghost" icon={<Gauge size={14} />} onClick={() => navigate({ name: 'performance', sessionId: e.id })}>Open in Performance</Button>
                      )}
                      {e.kind === 'update' && e.source === 'news' && onOpenNews && <Button size="sm" variant="ghost" icon={<FileText size={14} />} onClick={onOpenNews}>Read the patch notes</Button>}
                      {e.kind === 'mod' && onOpenFiles && <Button size="sm" variant="ghost" icon={<FolderOpen size={14} />} onClick={onOpenFiles}>See mods</Button>}
                    </li>
                  ))}
                  {pinned.events.length > 12 && <li className="mtl__more">and {plural(pinned.events.length - 12, 'more')}. Zoom in to see them one by one.</li>}
                </ul>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
      <p className="mtl__foot">
        Updates are Steam posts tagged as patch notes and builds VYSTRAL noticed on this PC (recorded from version 0.9 on; the first one seen isn’t an update). Mods use folder dates from Steam Workshop, Vortex and Mod Organizer 2. Sessions are sized by length and coloured by how smoothly they ran.
        {notes.length > 0 && <> {notes.join(' ')}</>}
      </p>
    </section>
  );
}

function Legend() {
  const items: { lane: Lane; kind: string; label: string }[] = [
    { lane: 'updates', kind: 'news', label: 'Patch notes' },
    { lane: 'updates', kind: 'build', label: 'New build seen' },
    { lane: 'mods', kind: 'installed', label: 'Mod installed' },
    { lane: 'sessions', kind: 'smooth', label: HEALTH_LABEL.smooth },
    { lane: 'sessions', kind: 'uneven', label: HEALTH_LABEL.uneven },
    { lane: 'sessions', kind: 'rough', label: HEALTH_LABEL.rough },
    { lane: 'sessions', kind: 'unmeasured', label: 'Not measured' },
  ];
  return (
    <ul className="mtl__legend" aria-label="Legend">
      {items.map((i) => (
        <li key={i.kind}><span className="mtl__dot" data-lane={i.lane} data-kind={i.kind} aria-hidden />{i.label}</li>
      ))}
      <li><span className="mtl__dot" data-lane="sessions" data-kind="smooth" data-after aria-hidden />First session after an update</li>
    </ul>
  );
}
