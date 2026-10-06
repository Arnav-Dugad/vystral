import { describe, expect, it } from 'vitest';
import type { Friend, FriendsActivity, Game } from '../bridge/types';
import { cardVisible, friendNames, friendsHeadline, groupFriends, initials, statusCopy, stateTone } from './friends';

const f = (name: string, patch: Partial<Friend> = {}): Friend => ({
  key: name.toLowerCase().padEnd(16, '0'), name, state: 'online', avatar: null, appId: null, gameName: null, gameId: null, lastOnline: null, ...patch,
});
const game = (id: string, title: string) => ({ id, title } as Game);
const lib = new Map<string, Game>([['g1', game('g1', 'Nebula Drift')], ['g2', game('g2', 'Ashen Crown')]]);

describe('groupFriends', () => {
  it('groups by game, biggest group first, library games before others at equal size, names sorted inside', () => {
    const { playing, online } = groupFriends([
      f('Wren', { appId: '9', gameName: 'Skyward Relay' }),
      f('Rook', { appId: '1', gameName: 'Nebula Drift', gameId: 'g1' }),
      f('atlas', { appId: '2', gameName: 'Ashen Crown', gameId: 'g2' }),
      f('Juniper', { appId: '1', gameName: 'Nebula Drift', gameId: 'g1' }),
      f('Quill'),
      f('Moss', { state: 'away' }),
      f('Ghost', { state: 'offline' }),
    ], lib);
    expect(playing.map((g) => g.title)).toEqual(['Nebula Drift', 'Ashen Crown', 'Skyward Relay']);
    expect(playing[0].friends.map((x) => x.name)).toEqual(['Juniper', 'Rook']);
    expect(playing[0].gameId).toBe('g1');
    expect(playing[2].gameId).toBeNull();
    expect(online.map((x) => x.name)).toEqual(['Quill', 'Moss']);
  });

  it('uses the library title over Steam’s name and ignores a gameId the library doesn’t have', () => {
    const { playing } = groupFriends([f('A', { appId: '1', gameName: 'NEBULA DRIFT™', gameId: 'g1' }), f('B', { appId: '3', gameName: 'Gone', gameId: 'zz' })], lib);
    expect(playing.map((g) => [g.title, g.gameId])).toEqual([['Nebula Drift', 'g1'], ['Gone', null]]);
  });

  it('keeps non-Steam games (no appid) grouped by name', () => {
    const { playing } = groupFriends([f('A', { gameName: 'Custom Mod' }), f('B', { gameName: 'custom mod' })], lib);
    expect(playing).toHaveLength(1);
    expect(playing[0].friends).toHaveLength(2);
  });
});

describe('copy', () => {
  it('lists names naturally', () => {
    expect(friendNames([])).toBe('');
    expect(friendNames([{ name: 'A' }])).toBe('A');
    expect(friendNames([{ name: 'A' }, { name: 'B' }])).toBe('A and B');
    expect(friendNames([{ name: 'A' }, { name: 'B' }, { name: 'C' }])).toBe('A, B and C');
    expect(friendNames([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' }])).toBe('A, B and 3 others');
  });

  it('headlines', () => {
    const { playing } = groupFriends([f('Rook', { gameId: 'g1', appId: '1' })], lib);
    expect(friendsHeadline(playing, 0)).toBe('Rook is playing Nebula Drift');
    const two = groupFriends([f('Rook', { gameId: 'g1', appId: '1' }), f('Juniper', { gameId: 'g1', appId: '1' })], lib).playing;
    expect(friendsHeadline(two, 2)).toBe('2 friends are playing Nebula Drift');
    const many = groupFriends([f('Rook', { gameId: 'g1', appId: '1' }), f('Atlas', { gameId: 'g2', appId: '2' })], lib).playing;
    expect(friendsHeadline(many, 0)).toBe('2 friends are playing 2 games');
    expect(friendsHeadline([], 3)).toBe('3 friends are online, nobody’s in a game');
    expect(friendsHeadline([], 0)).toBe('None of your friends are online right now');
  });

  it('initials', () => {
    expect(initials('Juniper')).toBe('J');
    expect(initials('lone wolf')).toBe('LW');
    expect(initials('😀 smile')).toBe('😀S');
    expect(initials('  ')).toBe('?');
  });

  it('ring tones never treat an in-game friend as merely online', () => {
    expect(stateTone('online', true)).toBe('playing');
    expect(stateTone('busy', false)).toBe('busy');
    expect(stateTone('snooze', false)).toBe('away');
    expect(stateTone('offline', true)).toBe('offline');
  });
});

describe('status handling', () => {
  const a = (status: FriendsActivity['status'], message: string | null = null): FriendsActivity =>
    ({ status, message, fetchedAt: null, friendCount: 0, friends: [], recentlyOnline: [], stale: false, retryAt: null });

  it('shows the card only when switched on with a key and an account', () => {
    expect(cardVisible(null)).toBe(false);
    expect(cardVisible(a('off'))).toBe(false);
    expect(cardVisible(a('notConnected'))).toBe(false);
    expect(cardVisible(a('noAccount'))).toBe(false);
    expect(cardVisible(a('ok'))).toBe(true);
    expect(cardVisible(a('private'))).toBe(true);
    expect(cardVisible(a('offline'))).toBe(true);
  });

  it('explains each problem with the right action', () => {
    expect(statusCopy(a('ok'))).toBeNull();
    expect(statusCopy(a('private', 'Make it public'))).toEqual({ title: 'Your friends list is private', body: 'Make it public', action: 'retry' });
    expect(statusCopy(a('invalidKey'))?.action).toBe('settings');
    expect(statusCopy(a('offline'))?.action).toBe('settings');
    expect(statusCopy(a('unavailable'))?.action).toBe('retry');
  });
});
