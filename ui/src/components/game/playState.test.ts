import { describe, expect, it } from 'vitest';
import type { Game, InstallProgress, Installation, LaunchState } from '../../bridge/types';
import { derivePlayState, familyLabels, formatSessionTimer, learnedFraction, spokenDuration } from './playState';

const NOW = Date.parse('2026-10-05T12:00:00Z');

function inst(p: Partial<Installation> = {}): Installation {
  return {
    id: 'i1', platform: 'steam', platformGameId: '1234', title: 'Nebula Drift', state: 'installed', installPath: 'D:\\Games\\Nebula', drive: 'D:',
    sizeBytes: 1e9, clientRequired: true, launchKind: 'Uri', importedLastPlayed: null, importedPlaytimeMinutes: null, userLaunchArgs: null,
    manualLink: false, lastSeen: '2026-10-01T00:00:00Z', ...p,
  };
}

function game(installations: Installation[] = [inst()], p: Partial<Game> = {}): Game {
  return {
    id: 'g1', title: 'Nebula Drift', sortTitle: 'nebula drift', description: null, developer: null, publisher: null, releaseDate: null, genres: [],
    favorite: false, hidden: false, userRating: null, notes: null, preferredInstallationId: null, metadataSource: null, palette: null,
    art: { cover: null, hero: null, logo: null, header: null, icon: null }, installations, collections: [], trackedSeconds: 0, sessionCount: 0,
    lastTrackedPlay: null, added: '2026-01-01T00:00:00Z', ...p,
  };
}

function launch(phase: LaunchState['phase'], p: Partial<LaunchState> = {}): LaunchState {
  return { ticket: 't', gameId: 'g1', installationId: 'i1', platform: 'steam', phase, message: null, sessionId: null, durationSeconds: null, perfSummary: null, startedAt: null, ...p };
}

function progress(kind: InstallProgress['kind'], phase: InstallProgress['phase'], p: Partial<InstallProgress> = {}): InstallProgress {
  return { gameId: 'g1', appId: '1234', kind, phase, bytesDone: 0, bytesTotal: 0, rate: null, watching: true, ...p };
}

const derive = (g: Game, l: LaunchState | null = null, i?: InstallProgress) => derivePlayState({ game: g, launch: l, install: i, now: NOW });

describe('derivePlayState', () => {
  it('ready to play', () => {
    const s = derive(game());
    expect(s).toMatchObject({ kind: 'play', label: 'Play', tone: 'primary', icon: 'play', actionable: true, family: 'installed' });
    expect(s.name).toBe('Play Nebula Drift');
  });

  it('names the store when several copies are installed', () => {
    const g = game([inst({ id: 'a', platform: 'steam' }), inst({ id: 'b', platform: 'epic' })], { preferredInstallationId: 'b' });
    expect(derive(g).label).toBe('Play · Epic Games');
  });

  it('launching shows a spinner until a learned arc exists', () => {
    expect(derive(game(), launch('starting'))).toMatchObject({ kind: 'launching', label: 'Launching…', icon: 'ring', fraction: null, actionable: false });
    const learned = derive(game(), launch('waiting', { expectedDetectMs: 10_000, acceptedAt: new Date(NOW - 5000).toISOString() }));
    expect(learned.fraction).toBeCloseTo(0.5);
    expect(derive(game(), launch('notDetected')).label).toBe('Still waiting…');
  });

  it('the learned arc never completes on its own', () => {
    expect(learnedFraction({ expectedDetectMs: 1000, acceptedAt: new Date(NOW - 60_000).toISOString() }, NOW)).toBe(0.97);
    expect(learnedFraction({ expectedDetectMs: null, acceptedAt: new Date(NOW).toISOString() }, NOW)).toBeNull();
  });

  it('running shows a live timer and switches to the game', () => {
    const s = derive(game(), launch('running', { startedAt: new Date(NOW - 125_000).toISOString() }));
    expect(s).toMatchObject({ kind: 'running', label: 'Playing', detail: '2:05', tone: 'live', actionable: true });
    expect(s.name).toBe('Playing Nebula Drift, 2 minutes. Switch to the game');
  });

  it('only reacts to launches of this game', () => {
    expect(derive(game(), launch('running', { gameId: 'other' })).kind).toBe('play');
  });

  it('failed launches offer to try again', () => {
    expect(derive(game(), launch('failed'))).toMatchObject({ kind: 'failed', label: 'Try again', actionable: true });
    expect(derive(game(), launch('ended')).kind).toBe('play');
  });

  it('Steam updates show a ring with the real percentage', () => {
    const s = derive(game(), null, progress('update', 'downloading', { bytesDone: 42, bytesTotal: 100 }));
    expect(s).toMatchObject({ kind: 'updating', label: 'Updating', detail: '42%', fraction: 0.42, tone: 'progress' });
    expect(s.store?.platform).toBe('steam');
  });

  it('queued or paused updates leave the game playable', () => {
    expect(derive(game(), null, progress('update', 'queued')).kind).toBe('play');
    expect(derive(game(), null, progress('update', 'paused', { bytesDone: 1, bytesTotal: 2 })).kind).toBe('play');
    expect(derive(game(), null, progress('update', 'installed', { watching: false })).kind).toBe('play');
  });

  it('uninstalling is not actionable', () => {
    expect(derive(game(), null, progress('uninstall', 'unknown'))).toMatchObject({ kind: 'uninstalling', actionable: false });
  });

  it('not installed: Steam installs in-app, other stores open their page', () => {
    expect(derive(game([inst({ state: 'notinstalled' })]))).toMatchObject({ kind: 'install', label: 'Install', family: 'notInstalled' });
    expect(derive(game([inst({ platform: 'epic', platformGameId: 'abc', state: 'notinstalled' })]))).toMatchObject({ kind: 'storeInstall', label: 'Install in Epic Games' });
  });

  it('installing follows Steam phases, with an indeterminate ring until a size is known', () => {
    const g = game([inst({ state: 'notinstalled' })]);
    expect(derive(g, null, progress('install', 'queued'))).toMatchObject({ kind: 'installing', label: 'Waiting for Steam…', fraction: null, detail: null });
    expect(derive(g, null, progress('install', 'downloading', { bytesDone: 1, bytesTotal: 4 }))).toMatchObject({ label: 'Downloading', detail: '25%', fraction: 0.25 });
    expect(derive(g, null, progress('install', 'staging', { bytesDone: 9, bytesTotal: 10 })).label).toBe('Installing');
    expect(derive(g, null, progress('install', 'paused', { bytesDone: 1, bytesTotal: 2 })).label).toBe('Paused in Steam');
    expect(derive(g, null, progress('install', 'installed', { watching: false })).label).toBe('Ready');
    expect(derive(g, null, progress('install', 'removed')).kind).toBe('install');
  });

  it('once the library shows it installed, a lingering finished install is just Play', () => {
    expect(derive(game(), null, progress('install', 'installed', { watching: false })).kind).toBe('play');
  });

  it('manual copies that went missing offer a rescan; nothing else is honestly unavailable', () => {
    expect(derive(game([inst({ platform: 'manual', state: 'missing' })]))).toMatchObject({ kind: 'missing', label: 'Rescan', actionable: true });
    expect(derive(game([inst({ platform: 'manual', state: 'notinstalled' })]))).toMatchObject({ kind: 'unavailable', actionable: false });
  });

  it('a launch outranks install progress', () => {
    expect(derive(game(), launch('running', { startedAt: new Date(NOW).toISOString() }), progress('update', 'downloading')).kind).toBe('running');
  });
});

describe('familyLabels reserve the widest label', () => {
  it('covers every label a family can show', () => {
    const installed = familyLabels(game(), 'installed').map((r) => r.label);
    for (const l of ['Play', 'Launching…', 'Still waiting…', 'Playing', 'Try again', 'Updating', 'Uninstalling…']) expect(installed).toContain(l);
    const steam = familyLabels(game([inst({ state: 'notinstalled' })]), 'notInstalled').map((r) => r.label);
    for (const l of ['Install', 'Waiting for Steam…', 'Downloading', 'Installing', 'Paused in Steam']) expect(steam).toContain(l);
  });

  it('every derived label is in its family', () => {
    const g = game([inst({ state: 'notinstalled' })]);
    const labels = new Set(familyLabels(g, 'notInstalled').map((r) => r.label));
    for (const ph of ['queued', 'downloading', 'staging', 'paused', 'unknown'] as const) expect(labels.has(derive(g, null, progress('install', ph)).label)).toBe(true);
  });
});

describe('timers', () => {
  it('formats the session timer compactly', () => {
    expect(formatSessionTimer(0)).toBe('0:00');
    expect(formatSessionTimer(59 * 60 + 59)).toBe('59:59');
    expect(formatSessionTimer(3600 + 12 * 60 + 30)).toBe('1h 12m');
  });

  it('speaks durations at minute granularity', () => {
    expect(spokenDuration(30)).toBe('less than a minute');
    expect(spokenDuration(60)).toBe('1 minute');
    expect(spokenDuration(3600 + 5 * 60)).toBe('1 hour 5 minutes');
  });
});

describe('accessible names read cleanly', () => {
  it('never doubles punctuation', () => {
    const g = game([inst({ state: 'notinstalled' })]);
    expect(derive(g, null, progress('install', 'queued')).name).toBe('Waiting for Steam… Show in Steam');
    expect(derive(g, null, progress('install', 'downloading', { bytesDone: 3, bytesTotal: 10 })).name).toBe('Downloading, 30 percent. Show in Steam');
  });
});
