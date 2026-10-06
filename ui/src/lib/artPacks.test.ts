import { describe, expect, it } from 'vitest';
import type { ArtPackJob, ArtPackPreset, CollectionInfo, Game } from '../bridge/types';
import {
  effectiveKinds, formatEta, isActive, jobFraction, jobStatusLine, jobSummary, presetForStyle, previewKind, scopeLabel, scopeOptions,
} from './artPacks';

const blurred: ArtPackPreset = { id: 'blurred', label: 'Blurred', description: '', styles: { cover: ['blurred'], hero: ['blurred'] } };

const game = (id: string, platform: Game['installations'][number]['platform'], opts: { hidden?: boolean; installed?: boolean; collections?: string[] } = {}) =>
  ({
    id, title: id, hidden: !!opts.hidden, collections: opts.collections ?? [],
    installations: [{ platform, state: opts.installed === false ? 'missing' : 'installed' }],
  }) as unknown as Game;

const job = (patch: Partial<ArtPackJob> = {}): ArtPackJob => ({
  id: 'x', presetId: 'blurred', presetLabel: 'Blurred', kinds: ['cover'], scope: 'all', replaceHandPicked: false, state: 'running', reason: null,
  total: 10, done: 4, applied: 3, kept: 1, noMatch: 0, noArt: 0, failed: 0, started: '', finished: null, etaSeconds: 200, current: 'Nebula Drift', resumeAt: null,
  ...patch,
});

describe('art packs', () => {
  it('applies only the slots the preset offers, in a stable order', () => {
    expect(effectiveKinds(blurred, ['logo', 'hero', 'cover'])).toEqual(['cover', 'hero']);
    expect(effectiveKinds(blurred, ['logo'])).toEqual([]);
    expect(previewKind(['hero', 'logo'])).toBe('hero');
    expect(previewKind([])).toBeNull();
  });

  it('offers every non-empty selection with its size, never counting hidden games', () => {
    const games = [game('a', 'steam'), game('b', 'epic', { installed: false, collections: ['c1'] }), game('c', 'steam', { hidden: true })];
    const collections = [{ id: 'c1', name: 'Couch' }, { id: 'c2', name: 'Empty' }] as CollectionInfo[];
    expect(scopeOptions(games, collections)).toEqual([
      { value: 'all', label: 'All games', count: 2 },
      { value: 'installed', label: 'Installed games', count: 1 },
      { value: 'collection:c1', label: 'Collection: Couch', count: 1 },
      { value: 'platform:steam', label: 'Steam games', count: 1 },
      { value: 'platform:epic', label: 'Epic Games games', count: 1 },
    ]);
    expect(scopeLabel('collection:c1', collections)).toBe('Couch');
    expect(scopeLabel('platform:gog', collections)).toBe('GOG games');
  });

  it('maps a style picked in the art picker to the pack that uses it', () => {
    expect(presetForStyle('cover', 'no_logo')).toBe('minimal');
    expect(presetForStyle('cover', 'white_logo')).toBe('white');
    expect(presetForStyle('cover', null)).toBe('official');
    expect(presetForStyle('hero', 'blurred')).toBe('blurred');
    expect(presetForStyle('logo', 'custom')).toBe('alternate');
    expect(presetForStyle('logo', 'black')).toBeNull(); // no pack uses black logos
    expect(presetForStyle('icon', 'official')).toBeNull();
  });

  it('describes progress, waiting and the outcome', () => {
    expect(jobFraction(job())).toBeCloseTo(0.4);
    expect(jobFraction(job({ total: 0 }))).toBe(0);
    expect(jobStatusLine(job())).toBe('4 of 10 · about 3 min left');
    expect(jobStatusLine(job({ state: 'waiting', reason: 'gameRunning' }))).toBe('Waiting until your game closes');
    expect(jobStatusLine(job({ state: 'paused' }))).toBe('Paused at 4 of 10');
    expect(jobSummary(job({ noMatch: 2, noArt: 1 }))).toBe('Updated 3 · 1 kept as you chose · 2 without a confident match · 1 without this style');
    expect(isActive(job({ state: 'waiting' }))).toBe(true);
    expect(isActive(job({ state: 'done' }))).toBe(false);
    expect(isActive(null)).toBe(false);
  });

  it('formats remaining time loosely', () => {
    expect(formatEta(20)).toBe('under a minute');
    expect(formatEta(180)).toBe('about 3 min');
    expect(formatEta(4800)).toBe('about 1 h 20 min');
    expect(formatEta(null)).toBeNull();
  });
});
