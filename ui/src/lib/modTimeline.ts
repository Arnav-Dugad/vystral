/**
 * Track D1: the game page's update / mod / session timeline — the pure part. It merges three sources onto one time
 * axis, finds the first session after each update (and a measured session before it, for the frame-rate comparison),
 * lays the markers out for a zoom level, and moves keyboard focus between them. Unit-tested; the view only draws.
 *
 * Honesty: a version VYSTRAL saw for the first time is a "first seen" marker, never an update (it may have been
 * installed long before). An update's time is when the store says it was installed, else when VYSTRAL noticed it.
 */
import type { ModsList, NewsPost, Session, VersionHistoryEntry } from '../bridge/types';
import { isObserved } from './sessions';
import { parsePerfSummary } from '../views/perf/series';
import { sessionHealth, type HealthLevel } from '../views/perf/overview';

export type Lane = 'updates' | 'mods' | 'sessions';
export const LANES: readonly Lane[] = ['updates', 'mods', 'sessions'];

export interface UpdateEvent {
  kind: 'update';
  id: string;
  t: number;
  /** news: a Steam post tagged as patch notes; build: a version change VYSTRAL saw; firstSeen: the first version it saw. */
  source: 'news' | 'build' | 'firstSeen';
  title: string;
  /** "Build 14287654", "Version 1.5.17.0". */
  version: string | null;
  /** The news post's id (to open it in the News tab). */
  gid: string | null;
}

export interface ModEvent {
  kind: 'mod';
  id: string;
  t: number;
  action: 'installed' | 'updated';
  name: string;
  source: 'workshop' | 'vortex' | 'mo2';
}

export interface SessionEvent {
  kind: 'session';
  id: string;
  t: number;
  seconds: number;
  health: HealthLevel;
  fps: number | null;
  /** Set on the first session after an update. */
  afterUpdate: { updateId: string; title: string; compareWith: string | null } | null;
}

export type TimelineEvent = UpdateEvent | ModEvent | SessionEvent;

export const laneOf = (e: TimelineEvent): Lane => (e.kind === 'update' ? 'updates' : e.kind === 'mod' ? 'mods' : 'sessions');

const DAY = 86_400_000;
/** A build change this close to a patch-notes post is the same update. */
export const SAME_UPDATE_MS = 2 * DAY;
/** Mods kept on the timeline (newest first) — a 2,000-item Workshop folder would bury everything else. */
export const MAX_MODS = 400;

const time = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

export function versionLabel(v: Pick<VersionHistoryEntry, 'kind' | 'value'>): string {
  return v.kind === 'steamBuild' ? `Build ${v.value}` : `Version ${v.value}`;
}

export interface TimelineInput {
  sessions?: readonly Session[] | null;
  versions?: readonly VersionHistoryEntry[] | null;
  news?: readonly NewsPost[] | null;
  mods?: ModsList | null;
}

/** All events, oldest first, with "first session after an update" worked out. */
export function buildTimeline(input: TimelineInput): TimelineEvent[] {
  const updates: UpdateEvent[] = [];
  for (const p of input.news ?? []) {
    if (!p?.patch) continue;
    const t = time(p.date);
    if (t != null) updates.push({ kind: 'update', id: `news:${p.gid}`, t, source: 'news', title: p.title?.trim() || 'Patch notes', version: null, gid: p.gid });
  }
  for (const v of input.versions ?? []) {
    const t = time(v.baseline ? v.seen : v.storeUpdated ?? v.seen);
    if (t == null) continue;
    const label = versionLabel(v);
    if (v.baseline) {
      updates.push({ kind: 'update', id: `v:${v.installationId}:${v.value}`, t, source: 'firstSeen', title: `${label} first seen`, version: label, gid: null });
      continue;
    }
    // A build that arrived with a patch-notes post is the same update: the post gets the build number.
    const post = updates.find((u) => u.source === 'news' && !u.version && Math.abs(u.t - t) <= SAME_UPDATE_MS);
    if (post) post.version = label;
    else updates.push({ kind: 'update', id: `v:${v.installationId}:${v.value}`, t, source: 'build', title: `Updated to ${label.toLowerCase()}`, version: label, gid: null });
  }

  const mods: ModEvent[] = [];
  for (const src of input.mods?.sources ?? []) {
    for (const item of src.items ?? []) {
      const name = item.title?.trim() || item.name;
      const installed = time(item.installed);
      const updated = time(item.updated);
      if (installed != null) mods.push({ kind: 'mod', id: `mod:${src.id}:${item.id}:i`, t: installed, action: 'installed', name, source: src.kind });
      // "Updated" only when it's a different moment from the install (a fresh copy has both dates the same).
      if (updated != null && (installed == null || updated - installed > 60 * 60_000))
        mods.push({ kind: 'mod', id: `mod:${src.id}:${item.id}:u`, t: updated, action: 'updated', name, source: src.kind });
    }
  }
  mods.sort((a, b) => b.t - a.t);
  mods.length = Math.min(mods.length, MAX_MODS);

  const sessions: SessionEvent[] = [];
  for (const s of input.sessions ?? []) {
    if (!isObserved(s.source) || s.end == null || !(s.durationSeconds > 0)) continue;
    const t = time(s.start);
    if (t == null) continue;
    const summary = parsePerfSummary(s.perfSummary);
    const health: HealthLevel = summary ? sessionHealth(summary, s.durationSeconds).level : 'unmeasured';
    const fps = summary?.fpsAvg != null && Number.isFinite(summary.fpsAvg) && summary.fpsAvg > 0 ? summary.fpsAvg : null;
    sessions.push({ kind: 'session', id: s.id, t, seconds: s.durationSeconds, health, fps, afterUpdate: null });
  }
  sessions.sort((a, b) => a.t - b.t);

  // The first session after each real update, and the last measured session before it (for "before and after").
  for (const u of [...updates].filter((u) => u.source !== 'firstSeen').sort((a, b) => a.t - b.t)) {
    const first = sessions.find((s) => s.t >= u.t);
    if (!first || first.afterUpdate) continue;
    const before = [...sessions].reverse().find((s) => s.t < u.t && s.fps != null);
    first.afterUpdate = { updateId: u.id, title: u.title, compareWith: first.fps != null && before ? before.id : null };
  }

  return [...updates, ...mods, ...sessions].sort((a, b) => a.t - b.t || LANES.indexOf(laneOf(a)) - LANES.indexOf(laneOf(b)) || a.id.localeCompare(b.id));
}

/* ---------------------------------------------------------------- view window */

export interface View {
  from: number;
  to: number;
}

/** Smallest span you can zoom into. */
export const MIN_SPAN = 2 * DAY;

/** The whole history with a little room at both ends; at least two weeks, always reaching `now`. */
export function domainOf(events: readonly TimelineEvent[], now: number): View {
  if (!events.length) return { from: now - 30 * DAY, to: now + DAY };
  const first = events[0].t;
  const last = Math.max(now, events[events.length - 1].t);
  const span = Math.max(14 * DAY, last - first);
  return { from: first - span * 0.04, to: last + span * 0.04 };
}

function clampView(v: View, domain: View): View {
  const domSpan = domain.to - domain.from;
  const span = Math.min(domSpan, Math.max(MIN_SPAN, v.to - v.from));
  let from = Math.max(domain.from, Math.min(v.from, domain.to - span));
  if (!Number.isFinite(from)) from = domain.from;
  return { from, to: from + span };
}

/** Zooms by `factor` (< 1 zooms in) keeping `anchor` (a time) where it is on screen. */
export function zoomView(v: View, domain: View, factor: number, anchor = (v.from + v.to) / 2): View {
  const span = v.to - v.from;
  const next = Math.min(domain.to - domain.from, Math.max(MIN_SPAN, span * factor));
  const ratio = span > 0 ? (anchor - v.from) / span : 0.5;
  return clampView({ from: anchor - ratio * next, to: anchor - ratio * next + next }, domain);
}

/** Moves the window by `delta` ms, never past the ends of the history. */
export function panView(v: View, domain: View, delta: number): View {
  return clampView({ from: v.from + delta, to: v.to + delta }, domain);
}

/** The window that shows the last `days` (or everything, when the history is shorter). */
export function recentView(domain: View, days: number, now: number): View {
  return clampView({ from: Math.min(now, domain.to) - days * DAY, to: Math.min(now, domain.to) + days * DAY * 0.03 }, domain);
}

export const xOf = (t: number, v: View, width: number) => ((t - v.from) / Math.max(1, v.to - v.from)) * width;

/** Dot radius for a session: grows with the square root of its length, 3–12 px. */
export function sessionRadius(seconds: number): number {
  return Math.max(3, Math.min(12, 3 + Math.sqrt(Math.max(0, seconds) / 60) * 0.85));
}

export interface Tick {
  t: number;
  label: string;
  major: boolean;
}

/** Axis ticks for the window: days, weeks, months or years, whichever gives a readable count. */
export function ticksFor(v: View, width: number, locale?: string): Tick[] {
  const span = v.to - v.from;
  const maxTicks = Math.max(2, Math.floor(width / 90));
  const out: Tick[] = [];
  const d = new Date(v.from);
  const fmt = (o: Intl.DateTimeFormatOptions, t: number) => new Intl.DateTimeFormat(locale, o).format(t);
  if (span / DAY <= maxTicks) {
    d.setHours(0, 0, 0, 0);
    for (let t = d.getTime(); t <= v.to; d.setDate(d.getDate() + 1), t = d.getTime())
      if (t >= v.from) out.push({ t, label: fmt({ month: 'short', day: 'numeric' }, t), major: d.getDate() === 1 });
    return out;
  }
  if (span / (7 * DAY) <= maxTicks) {
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
    for (let t = d.getTime(); t <= v.to; d.setDate(d.getDate() + 7), t = d.getTime())
      if (t >= v.from) out.push({ t, label: fmt({ month: 'short', day: 'numeric' }, t), major: d.getDate() <= 7 });
    return out;
  }
  const months = span / (30.44 * DAY);
  const step = [1, 2, 3, 6, 12, 24].find((m) => months / m <= maxTicks) ?? 36;
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  d.setMonth(Math.floor(d.getMonth() / Math.min(step, 12)) * Math.min(step, 12));
  for (let t = d.getTime(); t <= v.to; d.setMonth(d.getMonth() + step), t = d.getTime()) {
    if (t < v.from) continue;
    const jan = d.getMonth() === 0;
    out.push({ t, label: step >= 12 || jan ? fmt({ year: 'numeric' }, t) : fmt({ month: 'short' }, t), major: jan });
  }
  return out;
}

/* ---------------------------------------------------------------- markers */

export interface Marker {
  /** The first event's id (the cluster's id). */
  id: string;
  lane: Lane;
  x: number;
  events: TimelineEvent[];
}

/**
 * Markers for one lane: update and mod events closer than `gap` px merge into one marker ("3 mods") so they stay
 * clickable; sessions are never merged (each dot is sized by its length). Events outside the window are left out.
 */
export function markersFor(events: readonly TimelineEvent[], lane: Lane, v: View, width: number, gap = 14): Marker[] {
  const out: Marker[] = [];
  for (const e of events) {
    if (laneOf(e) !== lane || e.t < v.from || e.t > v.to) continue;
    const x = xOf(e.t, v, width);
    const last = out[out.length - 1];
    if (lane !== 'sessions' && last && x - last.x < gap) {
      last.events.push(e);
      continue;
    }
    out.push({ id: e.id, lane, x, events: [e] });
  }
  return out;
}

/** Keyboard: the next marker in time (Left/Right) within the lane, or the nearest one in the next lane (Up/Down). */
export function stepMarker(lanes: Record<Lane, Marker[]>, currentId: string | null, key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End'): string | null {
  const all = LANES.flatMap((l) => lanes[l]);
  if (!all.length) return null;
  const cur = all.find((m) => m.id === currentId);
  if (!cur) return (lanes.sessions.at(-1) ?? all[all.length - 1]).id;
  const row = lanes[cur.lane];
  const i = row.indexOf(cur);
  switch (key) {
    case 'ArrowLeft': return row[Math.max(0, i - 1)].id;
    case 'ArrowRight': return row[Math.min(row.length - 1, i + 1)].id;
    case 'Home': return row[0].id;
    case 'End': return row[row.length - 1].id;
    default: {
      const dir = key === 'ArrowDown' ? 1 : -1;
      for (let l = LANES.indexOf(cur.lane) + dir; l >= 0 && l < LANES.length; l += dir) {
        const other = lanes[LANES[l]];
        if (!other.length) continue;
        return other.reduce((best, m) => (Math.abs(m.x - cur.x) < Math.abs(best.x - cur.x) ? m : best)).id;
      }
      return cur.id;
    }
  }
}
