/**
 * Track P preview handlers: friends playing now and the update-space forecast. Everything here is
 * fictional; avatars are drawn locally as SVG data URIs (preview never touches the network).
 *
 * URL switches:
 * - `?friends` turns the (opt-in) Home card on with friends in three games; `?friends=empty` has
 *   nobody online; `?friends=invalid` simulates a rejected key.
 * - `?friendsPrivate` turns it on with a private friends list.
 * - `?diskTight` makes D: too full for two pending updates (Home warning, game-page chip, Storage Studio).
 *
 * Tests can move friends between games through `window.__vystralPreviewFriends.next()`.
 */
import type { DiskForecast, DriveInfo, Friend, FriendsActivity, Game, PersonaState, PendingUpdate, Settings, SteamApiStatus } from './types';

export const TRACK_P_DEFAULT_SETTINGS: Pick<Settings, 'home.friendsActivity' | 'notifications.diskSpace'> = {
  'home.friendsActivity': false,
  'notifications.diskSpace': true,
};

declare global {
  interface Window {
    __vystralPreviewFriends?: { next(): void; calls: number };
  }
}

const GB = 1024 ** 3;

/** A soft two-tone gradient disc with an initial, like a real avatar at a glance. */
function avatar(name: string, hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 58%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360} 65% 32%)"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><text x="32" y="42" font-family="Segoe UI, sans-serif" font-size="28" font-weight="600" text-anchor="middle" fill="rgba(255,255,255,.92)">${name[0]}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

interface PreviewFriend {
  key: string;
  name: string;
  hue: number | null;
  state: PersonaState;
  game: string | null; // a library title, or a game not in the library
}

const PEOPLE: PreviewFriend[] = [
  { key: 'f0a1b2c3d4e5f601', name: 'Juniper', hue: 280, state: 'online', game: 'Nebula Drift' },
  { key: 'f0a1b2c3d4e5f602', name: 'Rook', hue: 200, state: 'online', game: 'Nebula Drift' },
  { key: 'f0a1b2c3d4e5f603', name: 'Saffron', hue: 30, state: 'busy', game: 'Nebula Drift' },
  { key: 'f0a1b2c3d4e5f604', name: 'Atlas', hue: 150, state: 'online', game: 'Ashen Crown' },
  { key: 'f0a1b2c3d4e5f605', name: 'Wren', hue: null, state: 'play', game: 'Skyward Relay' },
  { key: 'f0a1b2c3d4e5f606', name: 'Quill', hue: 330, state: 'online', game: null },
  { key: 'f0a1b2c3d4e5f607', name: 'Moss', hue: 100, state: 'away', game: null },
  { key: 'f0a1b2c3d4e5f608', name: 'Echo', hue: 240, state: 'snooze', game: null },
];

export function trackPPreviewHandlers(ctx: { lib: { games: Game[] }; settings: () => Settings; steamStatus: () => SteamApiStatus }) {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const mode = params.has('friendsPrivate') ? 'private' : params.get('friends') === 'empty' ? 'empty' : params.get('friends') === 'invalid' ? 'invalid' : 'ok';
  const diskTight = params.has('diskTight');
  const people = PEOPLE.map((p) => ({ ...p }));
  let fetchedAt = Date.now();

  const byTitle = (title: string) => ctx.lib.games.find((g) => g.title === title);
  const steamApp = (g: Game | undefined) => g?.installations.find((i) => i.platform === 'steam')?.platformGameId ?? null;

  const hooks = {
    calls: 0,
    /** Quill joins Ashen Crown, then Juniper leaves Nebula Drift, then everyone goes back. */
    next() {
      const step = hooks.calls++ % 3;
      const quill = people.find((p) => p.name === 'Quill')!;
      const juniper = people.find((p) => p.name === 'Juniper')!;
      if (step === 0) quill.game = 'Ashen Crown';
      else if (step === 1) juniper.game = null;
      else { quill.game = null; juniper.game = 'Nebula Drift'; }
      fetchedAt = Date.now();
    },
  };
  if (typeof window !== 'undefined') window.__vystralPreviewFriends = hooks;

  const friend = (p: PreviewFriend): Friend => {
    const g = p.game ? byTitle(p.game) : undefined;
    return {
      key: p.key, name: p.name, state: p.state, avatar: p.hue == null ? null : avatar(p.name, p.hue),
      appId: p.game ? steamApp(g) ?? (p.game === 'Skyward Relay' ? '1234560' : null) : null,
      gameName: p.game, gameId: g?.id ?? null,
      lastOnline: null,
    };
  };

  const empty = (status: FriendsActivity['status'], message: string | null = null): FriendsActivity =>
    ({ status, message, fetchedAt: null, friendCount: 0, friends: [], recentlyOnline: [], stale: false, retryAt: null });

  const pending = (title: string, need: number | null, patch: Partial<PendingUpdate>): PendingUpdate | null => {
    const g = byTitle(title);
    const appId = steamApp(g);
    if (!g || !appId) return null;
    const dl = need == null ? 0 : Math.round(need * 0.45);
    return {
      appId, gameId: g.id, name: g.title, kind: 'update', phase: 'queued', needBytes: need,
      downloadRemaining: dl, stageRemaining: need == null ? 0 : need - dl, sizeOnDisk: g.installations[0]?.sizeBytes ?? 30 * GB,
      fit: 'ok', whenLaunched: false, scheduledAt: null, lastResult: null, ...patch,
    };
  };

  const forecast = (): DiskForecast => {
    const scannedAt = new Date().toISOString();
    if (diskTight) {
      const free = 9.1 * GB;
      const updates = [
        pending('Nebula Drift', 23.4 * GB, { fit: 'short', phase: 'downloading' }),
        pending('Overclock Arena', 4.2 * GB, { fit: 'ok', scheduledAt: new Date(Date.now() + 5 * 3600_000).toISOString() }),
        pending('Last Signal', null, { fit: 'unknown', whenLaunched: true }),
      ].filter((u): u is PendingUpdate => !!u);
      const need = updates.reduce((s, u) => s + (u.needBytes ?? 0), 0);
      const cUpdates = [pending('Northbound', 128.6 * GB, { fit: 'tight', kind: 'update', phase: 'paused' })].filter((u): u is PendingUpdate => !!u);
      const cFree = 140e9;
      return {
        available: true, status: 'short', scannedAt, pendingCount: updates.length + cUpdates.length,
        drives: [
          { drive: 'D:', label: 'Games', freeBytes: free, totalBytes: 1e12, needBytes: need, afterBytes: free - need, tightBelowBytes: 46.6 * GB, status: 'short', updates },
          ...(cUpdates.length ? [{ drive: 'C:', label: 'Windows', freeBytes: cFree, totalBytes: 512e9, needBytes: cUpdates[0].needBytes!, afterBytes: cFree - cUpdates[0].needBytes!, tightBelowBytes: 23.8 * GB, status: 'tight' as const, updates: cUpdates }] : []),
        ],
      };
    }
    const updates = [pending('Deep Field', 6.2 * GB, { phase: 'queued' })].filter((u): u is PendingUpdate => !!u);
    if (!updates.length) return { available: true, status: 'none', scannedAt, pendingCount: 0, drives: [] };
    const free = 380e9;
    return {
      available: true, status: 'ok', scannedAt, pendingCount: 1,
      drives: [{ drive: 'D:', label: 'Games', freeBytes: free, totalBytes: 1e12, needBytes: updates[0].needBytes!, afterBytes: free - updates[0].needBytes!, tightBelowBytes: 46.6 * GB, status: 'ok', updates }],
    };
  };

  const handlers: Record<string, (p: any) => unknown> = {
    'friends.activity': (p?: { force?: boolean }): FriendsActivity => {
      const s = ctx.settings();
      if (!s['home.friendsActivity']) return empty('off');
      const steam = ctx.steamStatus();
      if (!steam.configured) return empty('notConnected');
      if (s['privacy.localOnly']) return empty('offline', 'Offline mode is on, so VYSTRAL doesn’t ask Steam what your friends are playing.');
      if (mode === 'private') {
        return { ...empty('private', 'Steam won’t share your friends list because it isn’t public. In Steam, open your profile → Edit Profile → Privacy Settings and set “Friends List” to Public. Only your own setting matters here; your friends don’t need to change anything.'), retryAt: new Date(Date.now() + 10 * 60_000).toISOString() };
      }
      if (mode === 'invalid') return empty('invalidKey', 'Steam didn’t accept your Web API key. Check it in Settings → Library & stores.');
      if (mode === 'empty') {
        const recent = people.slice(0, 3).map((x, i) => ({ ...friend({ ...x, game: null }), state: 'offline' as const, lastOnline: new Date(Date.now() - (i + 1) * 47 * 60_000).toISOString() }));
        return { status: 'ok', message: null, fetchedAt: new Date().toISOString(), friendCount: 24, friends: [], recentlyOnline: recent, stale: false, retryAt: null };
      }
      if (s['dataSaver.enabled'] && !p?.force) {
        return { status: 'ok', message: 'Data saver is on, so friends refresh only when you ask.', fetchedAt: new Date(fetchedAt).toISOString(), friendCount: 24, friends: people.map(friend), recentlyOnline: [], stale: true, retryAt: null };
      }
      if (p?.force) fetchedAt = Date.now();
      const online = people.map(friend).sort((a, b) => Number(!!b.gameName) - Number(!!a.gameName));
      return { status: 'ok', message: null, fetchedAt: new Date(fetchedAt).toISOString(), friendCount: 24, friends: online, recentlyOnline: [], stale: false, retryAt: null };
    },
    'disk.forecast': forecast,
  };
  if (diskTight) {
    handlers['system.drives'] = (): DriveInfo[] => [
      { name: 'C:', label: 'Windows', totalBytes: 512e9, freeBytes: 140e9, isSystem: true, removable: false },
      { name: 'D:', label: 'Games', totalBytes: 1e12, freeBytes: 9.1 * GB, isSystem: false, removable: false },
    ];
  }
  return handlers;
}

/** True when the preview should start with the friends card switched on. */
export const previewFriendsOn = (params: URLSearchParams) => params.has('friends') || params.has('friendsPrivate');
