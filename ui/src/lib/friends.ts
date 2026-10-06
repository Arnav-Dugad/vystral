import type { Friend, FriendsActivity, Game, PersonaState } from '../bridge/types';

/** Track P: how often Home asks for friends' status while it is visible (the native side never asks Steam more than every 100 s). */
export const FRIENDS_POLL_MS = 150_000;

/** One game friends are in right now. */
export interface FriendGroup {
  key: string;
  title: string;
  /** The VYSTRAL game when it's in this library (opens its page). */
  gameId: string | null;
  appId: string | null;
  friends: Friend[];
}

export const STATE_LABEL: Record<PersonaState, string> = {
  online: 'Online',
  busy: 'Busy',
  away: 'Away',
  snooze: 'Snoozing',
  trade: 'Looking to trade',
  play: 'Looking to play',
  offline: 'Offline',
};

/** Ring colour tone per persona state (CSS maps it to tokens; never the only signal). */
export function stateTone(state: PersonaState, playing: boolean): 'playing' | 'online' | 'busy' | 'away' | 'offline' {
  if (state === 'offline') return 'offline';
  if (playing) return 'playing';
  if (state === 'busy') return 'busy';
  if (state === 'away' || state === 'snooze') return 'away';
  return 'online';
}

export const isPlaying = (f: Friend) => !!(f.gameName || f.appId || f.gameId);

/**
 * Friends grouped by the game they're in: most friends first, then games in your library, then by
 * title. Friends are in a stable order inside a group so the list doesn't shuffle between refreshes.
 */
export function groupFriends(friends: Friend[], gamesById: Map<string, Game>): { playing: FriendGroup[]; online: Friend[] } {
  const groups = new Map<string, FriendGroup>();
  const online: Friend[] = [];
  for (const f of friends) {
    if (f.state === 'offline') continue;
    if (!isPlaying(f)) {
      online.push(f);
      continue;
    }
    const key = f.gameId ? `g:${f.gameId}` : f.appId ? `a:${f.appId}` : `n:${(f.gameName ?? '').toLowerCase()}`;
    let g = groups.get(key);
    if (!g) {
      const game = f.gameId ? gamesById.get(f.gameId) : undefined;
      g = { key, title: game?.title ?? f.gameName ?? 'A game', gameId: game ? f.gameId : null, appId: f.appId, friends: [] };
      groups.set(key, g);
    }
    g.friends.push(f);
  }
  const byName = (a: Friend, b: Friend) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.key.localeCompare(b.key);
  const playing = [...groups.values()];
  for (const g of playing) g.friends.sort(byName);
  playing.sort((a, b) => b.friends.length - a.friends.length || Number(!!b.gameId) - Number(!!a.gameId) || a.title.localeCompare(b.title));
  const rank = (s: PersonaState) => (s === 'online' || s === 'play' || s === 'trade' ? 0 : s === 'busy' ? 1 : 2);
  online.sort((a, b) => rank(a.state) - rank(b.state) || byName(a, b));
  return { playing, online };
}

/** "Juniper", "Juniper and Rook", "Juniper, Rook and Saffron", "Juniper, Rook and 3 others". */
export function friendNames(friends: { name: string }[], max = 3): string {
  const names = friends.map((f) => f.name);
  if (names.length <= 1) return names[0] ?? '';
  if (names.length <= max) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const shown = names.slice(0, max - 1);
  const rest = names.length - shown.length;
  return `${shown.join(', ')} and ${rest} others`;
}

/** The card's one-line summary. */
export function friendsHeadline(playing: FriendGroup[], online: number): string {
  const inGames = playing.reduce((s, g) => s + g.friends.length, 0);
  if (inGames === 0) return online > 0 ? `${online} ${online === 1 ? 'friend is' : 'friends are'} online, nobody’s in a game` : 'None of your friends are online right now';
  if (playing.length === 1) return `${inGames === 1 ? `${playing[0].friends[0].name} is` : `${inGames} friends are`} playing ${playing[0].title}`;
  return `${inGames} friends are playing ${playing.length} games`;
}

/** What to tell the person for each status the native side can report; null = render friends. */
export function statusCopy(a: FriendsActivity | null): { title: string; body: string; action?: 'settings' | 'retry' } | null {
  if (!a) return null;
  switch (a.status) {
    case 'ok':
      return null;
    case 'private':
      return { title: 'Your friends list is private', body: a.message ?? 'Make your friends list public in Steam’s privacy settings.', action: 'retry' };
    case 'invalidKey':
      return { title: 'Steam didn’t accept your key', body: a.message ?? 'Check your Steam Web API key in Settings.', action: 'settings' };
    case 'offline':
      return { title: 'Offline mode is on', body: a.message ?? 'VYSTRAL doesn’t contact Steam in Offline mode.', action: 'settings' };
    case 'dataSaver':
      return { title: 'Paused by Data saver', body: a.message ?? 'Friends refresh only when you ask.', action: 'retry' };
    case 'rateLimited':
      return { title: 'Steam asked VYSTRAL to slow down', body: a.message ?? 'VYSTRAL will try again in a few minutes.', action: 'retry' };
    case 'unavailable':
      return { title: 'Steam couldn’t be reached', body: a.message ?? 'VYSTRAL will try again in a few minutes.', action: 'retry' };
    default:
      return null;
  }
}

/** The card shows only when it's switched on and a key and an account exist. */
export const cardVisible = (a: FriendsActivity | null) => !!a && a.status !== 'off' && a.status !== 'notConnected' && a.status !== 'noAccount';

/** Up to two letters for an avatar without a picture. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const chars = parts.length > 1 ? [parts[0], parts[parts.length - 1]].map((p) => [...p][0]) : [...(parts[0] ?? '?')].slice(0, 1);
  return chars.join('').toUpperCase();
}
