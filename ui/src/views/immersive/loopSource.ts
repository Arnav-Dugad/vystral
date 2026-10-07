import { call } from '../../bridge/bridge';
import type { LiveTileInfo } from '../../bridge/types';

const loops = new Map<string, Promise<string | null>>();

/**
 * A game's silent micro-trailer (the live-tile pipeline: Steam's clip through the app's media
 * host), asked once per game per session and shared by the hero stage and the screensaver.
 * Transient refusals (offline, Data saver…) are asked again next time.
 */
export function loopFor(gameId: string): Promise<string | null> {
  let p = loops.get(gameId);
  if (!p) {
    p = call<LiveTileInfo>('liveTile.get', { gameId }, 120_000)
      .then((i) => i.src)
      .catch(() => null);
    loops.set(gameId, p);
    void p.then((src) => !src && loops.delete(gameId));
  }
  return p;
}
