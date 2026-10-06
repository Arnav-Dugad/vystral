/**
 * Track M: session replay card — the ~10 s timeline, series preparation and the PNG upload format.
 * Pure and unit-tested; drawing lives in components/replay/drawReplay.ts.
 */
import type { InsightSample, PerfSample, ReplayData } from '../bridge/types';
import { rarity } from './achievements';

export const REPLAY_SECONDS = 10;
export const CARD_W = 1920;
export const CARD_H = 1080;
/** Bytes per upload chunk: a multiple of 3, so every chunk is whole base64 (147,456 bytes → 196,608 characters). */
export const CHUNK_BYTES = 147_456;
export const MAX_ACHIEVEMENTS = 6;

/** When each part of the card animates (seconds). Reduced motion draws the final frame only. */
export const TIMELINE = {
  backdrop: [0, 0.9],
  title: [0.3, 1.5],
  counter: [0.8, 3.6],
  stats: [3.0, 4.2],
  line: [2.2, 6.4],
  achievements: [5.6, 0.35, 0.55] as const, // start, stagger, pop duration
  shimmer: 0.9,
  temps: [7.2, 8.0],
  brand: [8.0, 8.8],
} as const;

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : Number.isFinite(x) ? x : 0);

/** 0..1 progress of t within [start, end]. */
export function phase(t: number, start: number, end: number): number {
  if (end <= start) return t >= end ? 1 : 0;
  return clamp01((t - start) / (end - start));
}

export const easeOutCubic = (x: number) => 1 - (1 - clamp01(x)) ** 3;

/** Overshoots a little before settling (for the achievement "pop"). */
export function easeOutBack(x: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const p = clamp01(x);
  return 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2;
}

/** The duration counter: counts up to the real duration and lands exactly on it. */
export function counterValue(t: number, durationSeconds: number): number {
  const [a, b] = TIMELINE.counter;
  const d = Math.max(0, Math.round(durationSeconds));
  return Math.round(d * easeOutCubic(phase(t, a, b)));
}

/** Scale (0 → overshoot → 1) and shimmer progress for the i-th achievement. */
export function achievementAt(i: number, t: number): { scale: number; opacity: number; shimmer: number } {
  const [start, stagger, pop] = TIMELINE.achievements;
  const t0 = start + i * stagger;
  const p = phase(t, t0, t0 + pop);
  return { scale: p === 0 ? 0 : easeOutBack(p), opacity: clamp01(p * 2), shimmer: phase(t, t0 + pop * 0.6, t0 + pop * 0.6 + TIMELINE.shimmer) };
}

/** Averages a series into at most `n` buckets, skipping missing values; null when there is nothing to draw. */
export function downsample(values: readonly (number | null | undefined)[], n = 120): number[] | null {
  const clean = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (clean.length < 2) return null;
  if (clean.length <= n) return clean;
  const out: number[] = [];
  const size = clean.length / n;
  for (let i = 0; i < n; i++) {
    const from = Math.floor(i * size);
    const to = Math.max(from + 1, Math.floor((i + 1) * size));
    let sum = 0;
    for (let j = from; j < to; j++) sum += clean[j];
    out.push(sum / (to - from));
  }
  return out;
}

/** A 0..max domain with headroom, so the line never touches the top. */
export function seriesMax(values: readonly number[]): number {
  const m = Math.max(...values);
  return m > 0 ? m * 1.12 : 1;
}

export interface ReplayAchievement {
  key: string;
  name: string;
  percent: number | null;
  tier: 'common' | 'rare' | 'ultra';
  icon: string | null;
}

export interface ReplayModel {
  sessionId: string;
  gameId: string;
  title: string;
  start: string;
  durationSeconds: number;
  source: string;
  fps: number[] | null;
  cpu: number[] | null;
  fpsAvg: number | null;
  fps1Low: number | null;
  cpuAvg: number | null;
  gpuAvg: number | null;
  peakTempC: number | null;
  achievements: ReplayAchievement[];
  moreAchievements: number;
  achievementsNote: string | null;
}

/** Builds what the card shows from the bridge answers; every number is real or absent. */
export function buildReplayModel(data: ReplayData, samples: PerfSample[], insight: InsightSample[]): ReplayModel {
  const s = data.session;
  const sorted = [...data.achievements].sort((a, b) => (a.globalPercent ?? 101) - (b.globalPercent ?? 101) || a.unlockedAt.localeCompare(b.unlockedAt));
  const achievements = sorted.slice(0, MAX_ACHIEVEMENTS).map((a) => ({
    key: `${a.gameId}:${a.apiName}`, name: a.name, percent: a.globalPercent, tier: rarity(a.globalPercent) ?? ('common' as const), icon: a.icon,
  }));
  return {
    sessionId: s.id,
    gameId: s.gameId,
    title: s.title,
    start: s.start,
    durationSeconds: s.durationSeconds,
    source: s.source,
    fps: downsample(insight.map((x) => x.fps)),
    cpu: downsample(samples.map((x) => x.cpu)),
    fpsAvg: s.perf.fpsAvg,
    fps1Low: s.perf.fps1Low,
    cpuAvg: s.perf.cpuAvg,
    gpuAvg: s.perf.gpuAvg,
    peakTempC: s.perf.peakTempC,
    achievements,
    moreAchievements: Math.max(0, sorted.length - MAX_ACHIEVEMENTS),
    achievementsNote: !data.steamGame ? null : !data.achievementsKnown ? 'Achievements weren’t checked with Steam for this game yet' : null,
  };
}

/** Plain-language summary for screen readers (the canvas itself is an image). */
export function replaySummary(m: ReplayModel, durationText: string): string {
  const parts = [`${m.title}: played ${durationText}`];
  if (m.fpsAvg != null) parts.push(`${Math.round(m.fpsAvg)} FPS average${m.fps1Low != null ? `, 1% low ${Math.round(m.fps1Low)}` : ''}`);
  if (m.cpuAvg != null) parts.push(`CPU ${Math.round(m.cpuAvg)}% average`);
  if (m.peakTempC != null) parts.push(`peak GPU temperature ${Math.round(m.peakTempC)}°C`);
  if (m.achievements.length) parts.push(`${m.achievements.length + m.moreAchievements} achievements unlocked: ${m.achievements.map((a) => a.name).join(', ')}`);
  return `${parts.join('; ')}.`;
}

/** Base64 chunks for the bridge (each well under its 256 K-character message cap). */
export function toBase64Chunks(bytes: Uint8Array, chunkBytes = CHUNK_BYTES): string[] {
  if (chunkBytes % 3 !== 0) throw new Error('Chunk size must be a multiple of 3.');
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkBytes) {
    const part = bytes.subarray(i, Math.min(bytes.length, i + chunkBytes));
    let bin = '';
    for (let j = 0; j < part.length; j += 0x8000) bin += String.fromCharCode(...part.subarray(j, j + 0x8000));
    out.push(btoa(bin));
  }
  return out;
}
