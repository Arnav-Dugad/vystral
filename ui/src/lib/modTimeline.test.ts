import { describe, expect, it } from 'vitest';
import type { ModsList, NewsPost, Session, VersionHistoryEntry } from '../bridge/types';
import {
  buildTimeline, domainOf, MAX_MODS, markersFor, MIN_SPAN, panView, recentView, sessionRadius, stepMarker, ticksFor, xOf, zoomView,
  type Lane, type Marker, type SessionEvent, type UpdateEvent,
} from './modTimeline';

const DAY = 86_400_000;
const T0 = Date.parse('2026-06-01T12:00:00Z');
const iso = (days: number) => new Date(T0 + days * DAY).toISOString();

function session(id: string, day: number, hours = 1, perf: Record<string, unknown> | null = { fpsAvg: 90, fps1Low: 70 }): Session {
  return {
    id, gameId: 'g', installationId: null, start: iso(day), end: new Date(T0 + day * DAY + hours * 3_600_000).toISOString(),
    durationSeconds: hours * 3600, source: 'tracked', perfSummary: perf ? JSON.stringify({ samples: 10, fpsStatus: '', ...perf }) : null,
  };
}
const post = (gid: string, day: number, patch = true): NewsPost => ({ gid, title: `Patch ${gid}`, author: null, date: iso(day), patch, excerpt: '', blocks: [], images: 0, imagesLoaded: 0 });
const ver = (value: string, day: number, baseline = false, storeDay: number | null = null): VersionHistoryEntry => ({
  installationId: 'i1', platform: 'steam', kind: 'steamBuild', value, seen: iso(day), storeUpdated: storeDay == null ? null : iso(storeDay), baseline,
});

describe('building the timeline', () => {
  it('puts patch notes, builds, mods and sessions on one axis, oldest first', () => {
    const mods: ModsList = {
      gameId: 'g', appId: '1', titles: 'done', missingTitles: 0, scannedAt: iso(30),
      sources: [{ id: 'workshop', kind: 'workshop', label: 'Steam Workshop', detail: null, folder: 'x', bytes: 1, count: 2, partial: false, items: [
        { id: 'm1', name: '123', title: 'Better Maps', bytes: 1, updated: iso(12), enabled: null, present: true, installed: iso(4) },
        { id: 'm2', name: 'Fresh', title: null, bytes: 1, updated: iso(6), enabled: null, present: true, installed: iso(6) },
      ] }],
    };
    const events = buildTimeline({
      sessions: [session('s1', 1), session('s2', 9), { ...session('open', 20), end: null }, { ...session('imp', 21), source: 'imported' }],
      versions: [ver('100', 0, true), ver('200', 8, false, 7)],
      news: [post('n1', 3), post('blog', 5, false)],
      mods,
    });
    expect(events.map((e) => e.id)).toEqual(['v:i1:100', 's1', 'news:n1', 'mod:workshop:m1:i', 'mod:workshop:m2:i', 'v:i1:200', 's2', 'mod:workshop:m1:u']);
    const first = events[0] as UpdateEvent;
    expect(first.source).toBe('firstSeen');
    expect(first.title).toBe('Build 100 first seen');
    // A build's time is when Steam installed it (day 7), not when VYSTRAL noticed (day 8).
    expect(events.find((e) => e.id === 'v:i1:200')!.t).toBe(T0 + 7 * DAY);
  });

  it('a build that arrived with patch notes is the same update', () => {
    const events = buildTimeline({ news: [post('n1', 10)], versions: [ver('100', 0, true), ver('200', 11)] });
    const updates = events.filter((e): e is UpdateEvent => e.kind === 'update' && e.source !== 'firstSeen');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ source: 'news', version: 'Build 200' });
  });

  it('marks the first session after each update and finds a measured session before it', () => {
    const events = buildTimeline({
      sessions: [session('before-measured', 1), session('before-unmeasured', 2, 1, null), session('after', 5), session('later', 6)],
      news: [post('n1', 3)],
      versions: [ver('1', 0, true)],
    });
    const after = events.find((e) => e.id === 'after') as SessionEvent;
    expect(after.afterUpdate).toEqual({ updateId: 'news:n1', title: 'Patch n1', compareWith: 'before-measured' });
    expect((events.find((e) => e.id === 'later') as SessionEvent).afterUpdate).toBeNull();
    // The first version seen isn't an update: no session is "after" it.
    expect((events.find((e) => e.id === 'before-measured') as SessionEvent).afterUpdate).toBeNull();
  });

  it('no comparison link when the session after the update wasn’t measured', () => {
    const events = buildTimeline({ sessions: [session('a', 1), session('b', 5, 1, null)], news: [post('n', 3)] });
    expect((events.find((e) => e.id === 'b') as SessionEvent).afterUpdate?.compareWith).toBeNull();
  });

  it('rates each session’s health and keeps only the newest mods when there are very many', () => {
    const events = buildTimeline({ sessions: [session('rough', 1, 1, { fpsAvg: 60, fps1Low: 20 }), session('none', 2, 1, null)] });
    expect((events[0] as SessionEvent).health).toBe('rough');
    expect((events[1] as SessionEvent).health).toBe('unmeasured');
    const many: ModsList = { gameId: 'g', appId: null, titles: 'none', missingTitles: 0, scannedAt: iso(0), sources: [{ id: 'vortex', kind: 'vortex', label: 'Vortex', detail: null, folder: 'x', bytes: 0, count: 600, partial: false, items: Array.from({ length: 600 }, (_, i) => ({ id: `m${i}`, name: `Mod ${i}`, title: null, bytes: null, updated: iso(i / 10), enabled: null, present: true })) }] };
    const mods = buildTimeline({ mods: many });
    expect(mods).toHaveLength(MAX_MODS);
    expect(mods[mods.length - 1].t).toBe(T0 + 59.9 * DAY);
  });
});

describe('zoom, pan and layout', () => {
  const domain = { from: T0, to: T0 + 400 * DAY };

  it('zooms around an anchor, never past the history or below the smallest span', () => {
    const v = { from: T0 + 100 * DAY, to: T0 + 200 * DAY };
    const anchor = T0 + 125 * DAY;
    const z = zoomView(v, domain, 0.5, anchor);
    expect(z.to - z.from).toBe(50 * DAY);
    // The anchor stays at the same place on screen (a quarter of the way in).
    expect((anchor - z.from) / (z.to - z.from)).toBeCloseTo(0.25);
    expect(zoomView(v, domain, 1e-6).to - zoomView(v, domain, 1e-6).from).toBe(MIN_SPAN);
    expect(zoomView(v, domain, 100)).toEqual(domain);
  });

  it('pans within the history', () => {
    const v = { from: T0 + 100 * DAY, to: T0 + 200 * DAY };
    expect(panView(v, domain, 50 * DAY)).toEqual({ from: T0 + 150 * DAY, to: T0 + 250 * DAY });
    expect(panView(v, domain, 1000 * DAY)).toEqual({ from: T0 + 300 * DAY, to: T0 + 400 * DAY });
    expect(panView(v, domain, -1000 * DAY)).toEqual({ from: T0, to: T0 + 100 * DAY });
  });

  it('frames the recent months and the whole history', () => {
    const now = T0 + 380 * DAY;
    const v = recentView(domain, 90, now);
    expect(v.to - v.from).toBeCloseTo(90 * DAY * 1.03, -3);
    expect(v.to).toBeGreaterThanOrEqual(now);
    const d = domainOf(buildTimeline({ sessions: [session('a', 1), session('b', 30)] }), T0 + 40 * DAY);
    expect(d.from).toBeLessThan(T0 + DAY);
    expect(d.to).toBeGreaterThan(T0 + 40 * DAY);
  });

  it('places markers by time and merges crowded updates and mods, never sessions', () => {
    const events = buildTimeline({ sessions: [session('a', 10), session('b', 10.01)], news: [post('x', 10), post('y', 10.02), post('z', 50)] });
    const v = { from: T0, to: T0 + 100 * DAY };
    const updates = markersFor(events, 'updates', v, 1000);
    expect(updates).toHaveLength(2);
    expect(updates[0].events).toHaveLength(2);
    expect(updates[1].x).toBeCloseTo(500);
    expect(markersFor(events, 'sessions', v, 1000)).toHaveLength(2);
    expect(markersFor(events, 'sessions', { from: T0 + 20 * DAY, to: T0 + 30 * DAY }, 1000)).toHaveLength(0);
    expect(xOf(T0 + 25 * DAY, v, 1000)).toBeCloseTo(250);
  });

  it('sizes session dots by length, within bounds', () => {
    expect(sessionRadius(0)).toBe(3);
    expect(sessionRadius(3600)).toBeGreaterThan(sessionRadius(600));
    expect(sessionRadius(48 * 3600)).toBe(12);
  });

  it('chooses readable ticks for each zoom level', () => {
    const days = ticksFor({ from: T0, to: T0 + 6 * DAY }, 900, 'en-GB');
    expect(days.length).toBeGreaterThanOrEqual(5);
    const months = ticksFor({ from: T0, to: T0 + 365 * DAY }, 900, 'en-GB');
    expect(months.length).toBeLessThanOrEqual(10);
    expect(months.length).toBeGreaterThanOrEqual(4);
    expect(months.every((t, i) => i === 0 || t.t > months[i - 1].t)).toBe(true);
  });
});

describe('keyboard', () => {
  const m = (id: string, lane: Lane, x: number): Marker => ({ id, lane, x, events: [] });
  const lanes: Record<Lane, Marker[]> = {
    updates: [m('u1', 'updates', 100), m('u2', 'updates', 600)],
    mods: [],
    sessions: [m('s1', 'sessions', 90), m('s2', 'sessions', 400), m('s3', 'sessions', 610)],
  };

  it('moves along a lane, jumps to the ends, and across lanes to the nearest marker', () => {
    expect(stepMarker(lanes, null, 'ArrowRight')).toBe('s3');
    expect(stepMarker(lanes, 's2', 'ArrowRight')).toBe('s3');
    expect(stepMarker(lanes, 's3', 'ArrowRight')).toBe('s3');
    expect(stepMarker(lanes, 's2', 'ArrowLeft')).toBe('s1');
    expect(stepMarker(lanes, 's2', 'Home')).toBe('s1');
    expect(stepMarker(lanes, 'u1', 'End')).toBe('u2');
    // Up from s3 skips the empty Mods lane and lands on the nearest update.
    expect(stepMarker(lanes, 's3', 'ArrowUp')).toBe('u2');
    expect(stepMarker(lanes, 'u1', 'ArrowDown')).toBe('s1');
    expect(stepMarker(lanes, 'u1', 'ArrowUp')).toBe('u1');
  });
});
