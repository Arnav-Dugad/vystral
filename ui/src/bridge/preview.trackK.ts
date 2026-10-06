/**
 * Track K preview handlers: live tiles and ambient-sound settings. Preview never touches the
 * network — every Steam game's "micro-trailer" is the same tiny local loop bundled with the
 * preview code (a 3 s, 192×108 VP8 file of drifting light).
 */
import type { Game, LiveLoop, LiveTileInfo, Settings } from './types';
import liveTileLoop from './preview-assets/live-tile.webm?url';

export const TRACK_K_DEFAULT_SETTINGS: Pick<Settings, 'home.liveTiles' | 'sound.ambient' | 'sound.ambientVolume'> = {
  'home.liveTiles': true,
  'sound.ambient': false,
  'sound.ambientVolume': 0.35,
};

export function trackKPreviewHandlers(ctx: { lib: { games: Game[] }; settings: () => Settings; liveTileRequests: string[] }) {
  const loops = new Map<string, LiveLoop | null>();
  return {
    'liveTile.get': (p: { gameId: string }): LiveTileInfo => {
      ctx.liveTileRequests.push(p.gameId);
      const s = ctx.settings();
      const g = ctx.lib.games.find((x) => x.id === p.gameId);
      if (!s['home.liveTiles']) return { gameId: p.gameId, src: null, reason: 'off' };
      if (!g || !g.installations.some((i) => i.platform === 'steam')) return { gameId: p.gameId, src: null, reason: 'noSteamApp' };
      if (s['privacy.localOnly']) return { gameId: p.gameId, src: null, reason: 'offline' };
      if (s['dataSaver.enabled']) return { gameId: p.gameId, src: null, reason: 'dataSaver' };
      // Every third Steam game has no trailer, like real libraries (tools, old games).
      const steamIndex = ctx.lib.games.filter((x) => x.installations.some((i) => i.platform === 'steam')).indexOf(g);
      if (steamIndex % 3 === 2) return { gameId: p.gameId, src: null, reason: 'none' };
      const directed = loops.has(p.gameId);
      return { gameId: p.gameId, src: `${liveTileLoop}#${p.gameId.slice(0, 8)}`, reason: null, loop: loops.get(p.gameId) ?? null, directed };
    },
    // Track N: the live-tile director's pick for a game's clip (the native side keys it by the clip's bytes).
    'liveTile.setLoop': (p: { gameId: string; start: number | null; duration: number | null }) => {
      loops.set(p.gameId, p.start == null || p.duration == null ? null : { start: p.start, duration: p.duration });
      return true;
    },
    'liveTile.clearCache': () => {
      loops.clear();
      return { freedBytes: 0 };
    },
    // Lets UI tests check that tiles only ask for (and play) what is on screen.
    'preview.liveTileRequests': () => [...ctx.liveTileRequests],
  };
}
