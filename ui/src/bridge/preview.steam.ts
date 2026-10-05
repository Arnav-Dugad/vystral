/**
 * Preview handlers for Track A (Steam Web API, achievements, store installs). Everything here is
 * fictional sample data so the UI can be designed and tested in a browser.
 */
import type {
  Achievement, AchievementsResult, Game, InstallPhase, InstallProgress, Installation, Settings, SteamApiStatus, SteamTestResult,
} from './types';
import { BridgeError } from './bridge';

type Emit = (name: string, payload: unknown) => void;

interface Ctx {
  lib: { games: Game[] };
  emit: () => Emit;
  settings: () => Settings;
  timers: number[];
}

const ADJ = ['First', 'Silent', 'Long', 'Bright', 'Hollow', 'Iron', 'Last', 'Wandering', 'Patient', 'Lucky', 'Burning', 'Quiet'];
const NOUN = ['Step', 'Signal', 'Road', 'Harvest', 'Echo', 'Promise', 'Light', 'Detour', 'Spark', 'Tide', 'Ledger', 'Orbit'];
const OWNED_EXTRA: [string, string[], string][] = [
  ['Saltglass', ['Adventure', 'Indie'], 'A glassblower’s apprentice sails a sea that remembers.'],
  ['Thornwake', ['RPG', 'Fantasy'], 'A briar-bound kingdom wakes one thorn at a time.'],
  ['Halcyon Drift II', ['Racing', 'Sci-fi'], 'The sequel to the anti-gravity circuit, now with tides of light.'],
];

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
}

const hex32 = (r: () => number) => Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16)).join('');

function sampleAchievements(game: Game): Achievement[] {
  const r = seeded([...game.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7));
  const count = 14 + Math.floor(r() * 26);
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => {
    const pct = Math.round(Math.pow(r(), 1.8) * 9000) / 100;
    const achieved = r() < 0.18 + pct / 130;
    const hidden = r() < 0.15;
    const name = `${ADJ[Math.floor(r() * ADJ.length)]} ${NOUN[Math.floor(r() * NOUN.length)]}`;
    return {
      apiName: `ACH_${i}`,
      name,
      description: hidden && !achieved ? null : `Sample achievement ${i + 1} for ${game.title}.`,
      hidden,
      achieved,
      unlockedAt: achieved ? new Date(now - Math.floor(r() * 500) * 86400000).toISOString() : null,
      globalPercent: pct,
      icon: null,
    };
  });
}

export function steamPreviewHandlers(ctx: Ctx): Record<string, (p: any) => unknown> {
  let configured = true;
  let steamId: string | null = '76561197960287930';
  let lastSync: string | null = new Date(Date.now() - 3 * 3600_000).toISOString();
  let lastTest: SteamTestResult | null = { outcome: 'ok', message: 'Steam lists 31 games on this account.', gameCount: 31, at: lastSync };
  const installs = new Map<string, InstallProgress>();
  const accounts = [
    { steamId: '76561197960287930', personaName: 'Nova (preview)', mostRecent: true },
    { steamId: '76561197960287931', personaName: 'Couch co-op (preview)', mostRecent: false },
  ];

  const emitProgress = (p: InstallProgress) => {
    if (p.watching) installs.set(p.gameId, p);
    else installs.delete(p.gameId);
    ctx.emit()('install.progress', p);
  };

  const status = (): SteamApiStatus => ({
    localOnly: ctx.settings()['privacy.localOnly'],
    steamInstalled: true,
    configured,
    keyMasked: configured ? '••••9F3A' : null,
    accounts,
    steamId: configured ? steamId : accounts[0].steamId,
    lastSync,
    ownedCount: configured ? ctx.lib.games.filter((g) => g.installations.some((i) => i.platform === 'steam')).length : 0,
    lastTest,
    syncing: false,
  });

  const requireOnline = () => {
    if (ctx.settings()['privacy.localOnly']) throw new BridgeError('forbidden', 'Offline mode is on (Settings → Privacy), so VYSTRAL doesn’t contact Steam.');
  };

  const addOwned = () => {
    let added = 0;
    for (const [title, genres, description] of OWNED_EXTRA) {
      if (ctx.lib.games.some((g) => g.title === title)) continue;
      const r = seeded(title.length * 97);
      const inst: Installation = {
        id: hex32(r), platform: 'steam', platformGameId: String(900000 + added), title, state: 'notinstalled', installPath: null, drive: null,
        sizeBytes: null, clientRequired: true, launchKind: 'Uri', importedLastPlayed: added === 0 ? new Date(Date.now() - 400 * 86400000).toISOString() : null,
        importedPlaytimeMinutes: added === 0 ? 312 : null, userLaunchArgs: null, manualLink: false, lastSeen: new Date().toISOString(),
      };
      ctx.lib.games.push({
        id: hex32(r), title, sortTitle: title.toLowerCase(), description, developer: 'Preview Studio', publisher: 'Preview Studio', releaseDate: '2024',
        genres, favorite: false, hidden: false, userRating: null, notes: null, preferredInstallationId: null, metadataSource: 'Preview data', palette: null,
        art: { cover: null, hero: null, logo: null, header: null, icon: null }, installations: [inst], collections: [], trackedSeconds: 0, sessionCount: 0,
        lastTrackedPlay: null, added: new Date().toISOString(),
      } as Game);
      added++;
    }
    return added;
  };

  const sync = (): SteamTestResult => {
    const added = addOwned();
    lastSync = new Date().toISOString();
    ctx.emit()('library.changed', { reason: 'steamOwned' });
    const owned = ctx.lib.games.filter((g) => g.installations.some((i) => i.platform === 'steam')).length;
    lastTest = { outcome: 'ok', message: `Steam lists ${owned} games on this account.${added ? ` ${added} not-installed games were added to your library.` : ''}`, gameCount: owned, at: lastSync };
    return lastTest;
  };

  // A Steam update already in progress for one installed game, so the badge is visible in preview.
  const updating = ctx.lib.games.find((g) => g.installations.some((i) => i.platform === 'steam' && i.state === 'installed'));
  if (updating) {
    let done = 0;
    const total = 3.4 * 1024 ** 3;
    const appId = updating.installations.find((i) => i.platform === 'steam')!.platformGameId;
    const tick = () => {
      done = Math.min(total, done + 28e6 + Math.random() * 6e6);
      const phase: InstallPhase = done >= total ? 'installed' : done > total * 0.85 ? 'staging' : 'downloading';
      emitProgress({ gameId: updating.id, appId, kind: 'update', phase, bytesDone: done, bytesTotal: total, rate: phase === 'installed' ? null : 30e6, watching: phase !== 'installed' });
      if (phase !== 'installed') ctx.timers.push(window.setTimeout(tick, 1000));
    };
    ctx.timers.push(window.setTimeout(tick, 1500));
  }

  const findGame = (id: string) => {
    const g = ctx.lib.games.find((x) => x.id === id);
    if (!g) throw new BridgeError('notFound', 'That item no longer exists.');
    return g;
  };

  return {
    'steam.status': status,
    'steam.connect': (p: { key: string; steamId?: string | null }) => {
      requireOnline();
      const key = (p.key ?? '').trim().toUpperCase();
      if (!/^[0-9A-F]{32}$/.test(key)) throw new BridgeError('invalid', 'A Steam Web API key is 32 characters, using only 0–9 and A–F.');
      if (key.startsWith('0000')) {
        lastTest = { outcome: 'invalidKey', message: 'Steam didn’t accept this Web API key. Check that you copied all 32 characters from steamcommunity.com/dev/apikey.', gameCount: null, at: new Date().toISOString() };
        return { result: lastTest, status: status() };
      }
      if (key.startsWith('FFFF')) {
        configured = true;
        lastTest = { outcome: 'privateProfile', message: 'Your Steam profile’s game details are private, so Steam won’t list your games. In Steam, open Profile → Edit Profile → Privacy Settings and set “Game details” to Public, then test again.', gameCount: null, at: new Date().toISOString() };
        return { result: lastTest, status: status() };
      }
      configured = true;
      if (p.steamId) steamId = p.steamId;
      return { result: sync(), status: status() };
    },
    'steam.test': () => { requireOnline(); return { result: sync(), status: status() }; },
    'steam.sync': () => { requireOnline(); return { result: sync(), status: status() }; },
    'steam.disconnect': () => { configured = false; lastSync = null; lastTest = null; return status(); },
    'steam.selectAccount': (p: { steamId: string }) => {
      if (!accounts.some((a) => a.steamId === p.steamId)) throw new BridgeError('invalid', 'That Steam account hasn’t signed in on this PC.');
      steamId = p.steamId;
      lastSync = null;
      return status();
    },
    'steam.achievements': async (p: { gameId: string }): Promise<AchievementsResult> => {
      const g = findGame(p.gameId);
      const empty = (s: AchievementsResult['status'], message: string | null = null): AchievementsResult => ({ status: s, message, fetchedAt: null, achievements: [], unlocked: 0, total: 0 });
      if (!g.installations.some((i) => i.platform === 'steam')) return empty('notSteam');
      if (!configured) return empty('notConnected');
      if (ctx.settings()['privacy.localOnly']) return empty('localOnly');
      await new Promise((r) => setTimeout(r, 650));
      if (g.title === 'Last Signal') return empty('private', 'Your Steam profile’s game details are private, so Steam won’t share achievements.');
      if (g.title === 'Glasswing') return empty('none');
      const list = sampleAchievements(g);
      return { status: 'ok', message: null, fetchedAt: new Date(Date.now() - 40 * 60_000).toISOString(), achievements: list, unlocked: list.filter((a) => a.achieved).length, total: list.length };
    },
    'steam.install': (p: { gameId: string }) => {
      const g = findGame(p.gameId);
      const inst = g.installations.find((i) => i.platform === 'steam');
      if (!inst) throw new BridgeError('unsupported', 'This game isn’t from Steam.');
      const total = (6 + Math.random() * 30) * 1024 ** 3;
      const base = { gameId: g.id, appId: inst.platformGameId, kind: 'install' as const };
      let done = 0;
      emitProgress({ ...base, phase: 'queued', bytesDone: 0, bytesTotal: 0, rate: null, watching: true });
      const tick = () => {
        done = Math.min(total, done + total / 14 + Math.random() * 2e8);
        const phase: InstallPhase = done >= total ? 'installed' : done > total * 0.82 ? 'staging' : 'downloading';
        if (phase === 'installed') {
          inst.state = 'installed';
          inst.installPath = `D:\\SteamLibrary\\steamapps\\common\\${g.title}`;
          inst.drive = 'D:';
          inst.sizeBytes = Math.round(total);
          ctx.emit()('library.changed', { reason: 'platformScan' });
        }
        emitProgress({ ...base, phase, bytesDone: done, bytesTotal: total, rate: phase === 'installed' ? null : total / 14, watching: phase !== 'installed' });
        if (phase !== 'installed') ctx.timers.push(window.setTimeout(tick, 1000));
      };
      ctx.timers.push(window.setTimeout(tick, 1800));
      return { appId: inst.platformGameId };
    },
    'steam.uninstall': (p: { gameId: string }) => {
      const g = findGame(p.gameId);
      const inst = g.installations.find((i) => i.platform === 'steam' && i.state === 'installed');
      if (!inst) throw new BridgeError('invalid', 'This game isn’t installed.');
      emitProgress({ gameId: g.id, appId: inst.platformGameId, kind: 'uninstall', phase: 'unknown', bytesDone: 0, bytesTotal: 0, rate: null, watching: true });
      ctx.timers.push(window.setTimeout(() => {
        inst.state = 'notinstalled';
        inst.installPath = null;
        inst.drive = null;
        emitProgress({ gameId: g.id, appId: inst.platformGameId, kind: 'uninstall', phase: 'removed', bytesDone: 0, bytesTotal: 0, rate: null, watching: false });
        ctx.emit()('library.changed', { reason: 'platformScan' });
      }, 3500));
      return { appId: inst.platformGameId };
    },
    'steam.installs': () => [...installs.values()],
    'steam.forgetInstall': (p: { gameId: string }) => {
      const cur = installs.get(p.gameId);
      if (cur) emitProgress({ ...cur, watching: false });
      return true;
    },
    'library.scanPlatform': () => ({ added: 0, updated: ctx.lib.games.length, markedMissing: 0, merged: 0, restored: 0 }),
  };
}
