import { describe, expect, it } from 'vitest';
import type { Achievement, InstallProgress } from '../bridge/types';
import { etaSeconds, filterAchievements, formatEta, formatRate, phaseLabel, progressDetail, progressFraction, rarityTier } from './installProgress';

const p = (over: Partial<InstallProgress>): InstallProgress => ({
  gameId: 'g', appId: '1', kind: 'install', phase: 'downloading', bytesDone: 0, bytesTotal: 0, rate: null, watching: true, ...over,
});

describe('install progress', () => {
  it('reports no fraction until Steam knows the size', () => {
    expect(progressFraction(p({ bytesTotal: 0 }))).toBeNull();
    expect(progressFraction(p({ bytesDone: 25, bytesTotal: 100 }))).toBe(0.25);
    expect(progressFraction(p({ bytesDone: 500, bytesTotal: 100 }))).toBe(1);
    expect(progressFraction(p({ phase: 'installed' }))).toBe(1);
  });

  it('estimates time left only while bytes are moving', () => {
    expect(etaSeconds(p({ bytesDone: 0, bytesTotal: 1000, rate: 100 }))).toBe(10);
    expect(etaSeconds(p({ bytesDone: 0, bytesTotal: 1000, rate: null }))).toBeNull();
    expect(etaSeconds(p({ phase: 'paused', bytesDone: 0, bytesTotal: 1000, rate: 100 }))).toBeNull();
    expect(etaSeconds(p({ phase: 'queued', bytesTotal: 1000, rate: 100 }))).toBeNull();
  });

  it('formats time left in plain language', () => {
    expect(formatEta(null)).toBeNull();
    expect(formatEta(20)).toBe('less than a minute left');
    expect(formatEta(12 * 60)).toBe('about 12m left');
    expect(formatEta(2 * 3600 + 30 * 60)).toBe('about 2h 30m left');
    expect(formatEta(3600 + 2 * 60)).toBe('about 1h left');
    expect(formatEta(5 * 86400)).toBe('about 5 days left');
  });

  it('formats rates', () => {
    expect(formatRate(null)).toBeNull();
    expect(formatRate(0)).toBeNull();
    expect(formatRate(38 * 1024 * 1024)).toBe('38.0 MB/s');
  });

  it('labels phases honestly', () => {
    expect(phaseLabel({ kind: 'install', phase: 'queued' })).toBe('Waiting for Steam…');
    expect(phaseLabel({ kind: 'install', phase: 'installed' })).toBe('Ready to play');
    expect(phaseLabel({ kind: 'install', phase: 'removed' })).toBe('Install cancelled in Steam');
    expect(phaseLabel({ kind: 'update', phase: 'downloading' })).toBe('Steam is updating');
    expect(phaseLabel({ kind: 'uninstall', phase: 'removed' })).toBe('Uninstalled by Steam');
    expect(phaseLabel({ kind: 'install', phase: 'unknown' })).toBe('Steam is working…');
  });

  it('builds a compact detail line', () => {
    const d = progressDetail(p({ bytesDone: 1024 ** 3, bytesTotal: 4 * 1024 ** 3, rate: 1024 ** 2 * 10 }));
    expect(d).toBe('1.0 GB of 4.0 GB · 10.0 MB/s · about 5m left');
    expect(progressDetail(p({ phase: 'queued' }))).toBe('');
  });
});

const a = (name: string, over: Partial<Achievement> = {}): Achievement => ({
  apiName: name, name, description: `${name} desc`, hidden: false, achieved: false, unlockedAt: null, globalPercent: null, icon: null, ...over,
});

describe('achievements', () => {
  it('classifies rarity', () => {
    expect(rarityTier(1.99)).toBe('ultra');
    expect(rarityTier(2)).toBe('rare');
    expect(rarityTier(9.9)).toBe('rare');
    expect(rarityTier(10)).toBeNull();
    expect(rarityTier(null)).toBeNull();
  });

  const list = [
    a('Common', { globalPercent: 80 }),
    a('Old win', { achieved: true, unlockedAt: '2023-01-01T00:00:00Z', globalPercent: 50 }),
    a('New win', { achieved: true, unlockedAt: '2025-01-01T00:00:00Z', globalPercent: 1.1 }),
    a('Secret', { hidden: true, description: null, globalPercent: 0.4 }),
    a('Unknown'),
  ];

  it('lists unlocked (newest first) before locked (most common first)', () => {
    expect(filterAchievements(list, 'all').map((x) => x.name)).toEqual(['New win', 'Old win', 'Common', 'Secret', 'Unknown']);
  });

  it('filters unlocked and locked', () => {
    expect(filterAchievements(list, 'unlocked').map((x) => x.name)).toEqual(['New win', 'Old win']);
    expect(filterAchievements(list, 'locked').map((x) => x.name)).toEqual(['Common', 'Secret', 'Unknown']);
  });

  it('sorts rarest first with unknown rarity last', () => {
    expect(filterAchievements(list, 'rarest').map((x) => x.name)).toEqual(['Secret', 'New win', 'Old win', 'Common', 'Unknown']);
  });

  it('searches names and visible descriptions but never hidden text', () => {
    expect(filterAchievements(list, 'all', 'win').map((x) => x.name)).toEqual(['New win', 'Old win']);
    expect(filterAchievements(list, 'all', 'secret desc')).toEqual([]);
    expect(filterAchievements(list, 'all', '  common ').map((x) => x.name)).toEqual(['Common']);
  });
});
