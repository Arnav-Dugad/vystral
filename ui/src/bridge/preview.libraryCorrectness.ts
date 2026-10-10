/**
 * Track C1 preview data (fictional): games Steam no longer lists, and an Xbox game read thoroughly.
 * - `?refunded`: two not-installed Steam games left the owned list (one with play history and notes kept),
 *   plus a game merged with Epic whose Steam copy left; the "no longer in your Steam library" toast shows once.
 * - `?xbox`: an installed Xbox game with a measured size, version, install date and a last-played date that is
 *   only estimated from save data (no VYSTRAL sessions).
 */
import type { Game, Installation, OwnershipNotice } from './types';

const DAY = 86_400_000;

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const hex32 = (r: () => number) => Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16)).join('');

function inst(r: () => number, p: Partial<Installation> & Pick<Installation, 'platform' | 'platformGameId' | 'title' | 'state'>): Installation {
  return {
    id: hex32(r), installPath: null, drive: null, sizeBytes: null, clientRequired: p.platform === 'steam' || p.platform === 'epic',
    launchKind: p.platform === 'xbox' ? 'PackagedApp' : 'Uri', importedLastPlayed: null, importedPlaytimeMinutes: null, userLaunchArgs: null,
    manualLink: false, lastSeen: new Date().toISOString(), ...p,
  };
}

function game(r: () => number, title: string, genres: string[], installations: Installation[], extra: Partial<Game> = {}): Game {
  return {
    id: hex32(r), title, sortTitle: title.toLowerCase(), description: 'Fictional preview entry.', developer: 'Preview Studio', publisher: 'Preview Studio',
    releaseDate: '2023', genres, favorite: false, hidden: false, userRating: null, notes: null, preferredInstallationId: null, metadataSource: 'Preview data',
    palette: null, art: { cover: null, hero: null, logo: null, header: null, icon: null }, installations, collections: [], trackedSeconds: 0, sessionCount: 0,
    lastTrackedPlay: null, added: new Date(Date.now() - 90 * DAY).toISOString(), ...extra,
  };
}

/** Adds the `?refunded` / `?xbox` fixtures to the preview library. */
export function decorateLibraryCorrectness(lib: { games: Game[] }, params: URLSearchParams): void {
  const now = Date.now();
  if (params.has('refunded')) {
    const r = seeded(4401);
    const since = new Date(now - 2 * 3600_000).toISOString();
    lib.games.push(
      game(r, 'Lantern Drift', ['Adventure'], [inst(r, { platform: 'steam', platformGameId: '910001', title: 'Lantern Drift', state: 'notinstalled', noLongerOwned: since, importedPlaytimeMinutes: 74 })], {
        hidden: true, notOwned: true, userHidden: false, notes: 'Refunded: ran badly on the laptop.', userRating: 2,
        trackedSeconds: 4200, sessionCount: 2, lastTrackedPlay: new Date(now - 3 * DAY).toISOString(),
      }),
      game(r, 'Saltwind Harbor', ['Simulation'], [inst(r, { platform: 'steam', platformGameId: '910002', title: 'Saltwind Harbor', state: 'notinstalled', noLongerOwned: since })], {
        hidden: true, notOwned: true, userHidden: false,
      }),
      // Also on Epic: the game stays, only its Steam copy is marked.
      game(r, 'Copperline', ['Strategy'], [
        inst(r, { platform: 'steam', platformGameId: '910003', title: 'Copperline', state: 'notinstalled', noLongerOwned: since }),
        inst(r, { platform: 'epic', platformGameId: 'Copperline', title: 'Copperline', state: 'installed', installPath: 'D:\\Epic\\Copperline', drive: 'D:', sizeBytes: 14 * 1024 ** 3 }),
      ]),
    );
  }
  if (params.has('xbox')) {
    const r = seeded(5502);
    lib.games.push(
      game(r, 'Coastline Rally 4', ['Racing'], [inst(r, {
        platform: 'xbox', platformGameId: 'Preview.CoastlineRally_8wekyb3d8bbwe', title: 'Coastline Rally 4', state: 'installed',
        installPath: 'C:\\Program Files\\WindowsApps\\Preview.CoastlineRally_1.478.564.2_x64__8wekyb3d8bbwe', drive: 'C:',
        sizeBytes: Math.round(79.4 * 1024 ** 3), version: '1.478.564.2', installedAt: new Date(now - 210 * DAY).toISOString(),
        importedLastPlayed: new Date(now - 26 * 3600_000).toISOString(), lastPlayedSource: 'saveData', clientRequired: false,
      })], { publisher: 'Preview Studios', developer: 'Preview Studios', added: new Date(now - 200 * DAY).toISOString() }),
    );
  }
}

/** The once-only toast: pending with `?refunded` until read. */
export function libraryCorrectnessPreviewHandlers(params: URLSearchParams) {
  let pending: OwnershipNotice | null = params.has('refunded') ? { count: 2, at: new Date().toISOString() } : null;
  return {
    'steam.ownershipNotice': (): OwnershipNotice | null => {
      const n = pending;
      pending = null;
      return n;
    },
  };
}
