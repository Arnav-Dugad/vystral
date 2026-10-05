/**
 * Track H preview: games started outside VYSTRAL. A few fictional sessions are marked as noticed in the
 * background or while open, and `?detected` simulates a game started outside VYSTRAL (title-bar chip,
 * stop tracking). Nothing here watches real processes.
 */
import type { Game, LaunchState, Session, Settings, TrackingStatus } from './types';
import { BridgeError } from './bridge';

type Emit = (name: string, payload: unknown) => void;

export const TRACKING_DEFAULT_SETTINGS: Pick<Settings, 'tracking.background'> = {
  'tracking.background': false,
};

/** Marks the newest fictional session as recorded by the background tracker and the second newest as detected. */
export function decorateTrackingSessions(sessions: Session[]): void {
  const newest = [...sessions].sort((a, b) => b.start.localeCompare(a.start));
  if (newest[0]) newest[0].source = 'background';
  if (newest[1]) newest[1].source = 'detected';
}

export function trackingPreviewHandlers(ctx: {
  lib: { games: Game[]; sessions: Session[] };
  emit: () => Emit;
  settings: () => Settings;
  setLaunch: (s: LaunchState) => void;
  timers: number[];
}) {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const ignored = new Set<string>();
  const build: TrackingStatus['build'] = params.has('devbuild') ? 'development' : 'installed';

  if (params.has('detected')) {
    ctx.timers.push(window.setTimeout(() => {
      const game = ctx.lib.games.find((g) => g.installations.some((i) => i.state === 'installed'));
      if (!game) return;
      const installation = game.installations.find((i) => i.state === 'installed')!;
      ctx.setLaunch({
        ticket: 'preview-detected', gameId: game.id, installationId: installation.id, platform: installation.platform, phase: 'running',
        message: null, sessionId: 'preview-detected-session', durationSeconds: null, perfSummary: null,
        startedAt: new Date(Date.now() - 95_000).toISOString(), source: 'detected',
      });
    }, 900));
  }

  const status = (): TrackingStatus => {
    const enabled = ctx.settings()['tracking.background'];
    const last = ctx.lib.sessions
      .filter((s) => s.source === 'background' || s.source === 'detected')
      .sort((a, b) => b.start.localeCompare(a.start))[0];
    const title = (id: string) => ctx.lib.games.find((g) => g.id === id)?.title ?? 'Unknown game';
    return {
      enabled,
      available: true,
      safeMode: false,
      build,
      autostart: build !== 'installed' ? 'unavailable' : enabled ? 'on' : 'off',
      helperRunning: enabled && build === 'installed',
      detecting: enabled,
      owner: true,
      watchedGames: ctx.lib.games.filter((g) => g.installations.some((i) => i.state === 'installed') && !ignored.has(g.id)).length,
      pollSeconds: 4,
      savingPollSeconds: 15,
      minSessionSeconds: 60,
      lastSeen: last ? { gameId: last.gameId, title: title(last.gameId), source: last.source, start: last.start, end: last.end, durationSeconds: last.durationSeconds } : null,
      ignored: [...ignored].map((gameId) => ({ gameId, title: title(gameId) })),
    };
  };

  return {
    'tracking.status': (): TrackingStatus => status(),
    'tracking.setIgnored': (p: { gameId: string; ignored: boolean }): TrackingStatus => {
      if (!ctx.lib.games.some((g) => g.id === p.gameId)) throw new BridgeError('notFound', 'That game is no longer in your library.');
      if (p.ignored) ignored.add(p.gameId);
      else ignored.delete(p.gameId);
      return status();
    },
  } satisfies Record<string, (p: never) => unknown>;
}
