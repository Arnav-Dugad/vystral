/**
 * Track Y: how your genre mix changed over the past 12 months, by tracked hours.
 *
 * Multi-genre games split their hours equally: two hours of an "RPG, Fantasy" game add one hour to
 * each, so every hour is counted exactly once and the stream's height is your real playtime. Games
 * without genre information are left out (and counted, so the footnote can say how much). Sessions are
 * split at local midnights, so play past midnight on the last day of a month counts for the next one.
 * The six genres with the most hours over the year keep their own colour; the rest fold into "Other".
 */
import { splitAcrossDays, startOfMonth, type JSession } from './stats';

export const OTHER = 'Other';
export const MAX_GENRES = 6;

export interface GenreDrift {
  /** Local month starts, oldest first. */
  months: number[];
  /** Genre keys in legend order (by total hours, "Other" last). */
  genres: string[];
  /** Hours per genre (same order) per month. */
  hours: number[][];
  /** Hours per month across all shown genres. */
  monthTotals: number[];
  totalHours: number;
  /** Hours from games without genres in the window (not shown). */
  untaggedHours: number;
}

export function monthStarts(now: number, count: number): number[] {
  const d = new Date(startOfMonth(now));
  const out: number[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(new Date(d.getFullYear(), d.getMonth() - i, 1).getTime());
  return out;
}

export function genreDrift(
  sessions: readonly JSession[],
  genresOf: (gameId: string) => readonly string[] | undefined,
  now: number,
  count = 12,
  maxGenres = MAX_GENRES,
): GenreDrift {
  const months = monthStarts(now, count);
  const first = months[0];
  const index = new Map(months.map((m, i) => [m, i]));
  const perGenre = new Map<string, number[]>();
  // Genre names are merged case-insensitively ("RPG" from one store, "Rpg" from another); the first spelling wins.
  const display = new Map<string, string>();
  let untagged = 0;

  for (const s of sessions) {
    if (s.startMs + s.seconds * 1000 < first) continue;
    const raw = genresOf(s.gameId) ?? [];
    const genres = [...new Set(raw.map((g) => g.trim()).filter(Boolean).map((g) => {
      const key = g.toLocaleLowerCase();
      if (!display.has(key)) display.set(key, g);
      return display.get(key)!;
    }))];
    for (const part of splitAcrossDays(s.startMs, s.seconds)) {
      const i = index.get(startOfMonth(part.dayStart));
      if (i === undefined || part.seconds <= 0) continue;
      const h = part.seconds / 3600;
      if (!genres.length) {
        untagged += h;
        continue;
      }
      const share = h / genres.length;
      for (const g of genres) {
        let row = perGenre.get(g);
        if (!row) perGenre.set(g, (row = new Array<number>(count).fill(0)));
        row[i] += share;
      }
    }
  }

  const ranked = [...perGenre.entries()]
    .map(([g, row]) => ({ g, row, total: row.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total || a.g.localeCompare(b.g));
  const keep = ranked.length > maxGenres ? ranked.slice(0, maxGenres - 1) : ranked;
  const rest = ranked.slice(keep.length);
  const genres = keep.map((k) => k.g);
  const hours = keep.map((k) => k.row);
  if (rest.length) {
    genres.push(OTHER);
    hours.push(months.map((_, i) => rest.reduce((a, r) => a + r.row[i], 0)));
  }
  const monthTotals = months.map((_, i) => hours.reduce((a, row) => a + row[i], 0));
  return { months, genres, hours, monthTotals, totalHours: monthTotals.reduce((a, b) => a + b, 0), untaggedHours: untagged };
}

/* ------------------------------------------------------------------ stream layout */

export interface StreamLayer {
  /** Index into the input series. */
  key: number;
  lower: number[];
  upper: number[];
}

export interface StreamLayout {
  /** Layers bottom to top. */
  layers: StreamLayer[];
  min: number;
  max: number;
}

/**
 * Inside-out order (Byron & Wattenberg): series that peak earliest sit in the middle, the rest are
 * added to whichever side is lighter, so big, late-peaking layers end up at the edges and the middle
 * stays calm. Returns series indices bottom to top.
 */
export function insideOutOrder(series: readonly (readonly number[])[]): number[] {
  const peaks = series.map((row, i) => {
    let at = 0;
    for (let j = 1; j < row.length; j++) if (row[j] > row[at]) at = j;
    return { i, at, sum: row.reduce((a, b) => a + b, 0) };
  });
  peaks.sort((a, b) => a.at - b.at || b.sum - a.sum || a.i - b.i);
  const top: number[] = [];
  const bottom: number[] = [];
  let topSum = 0;
  let bottomSum = 0;
  for (const p of peaks) {
    if (topSum < bottomSum) {
      top.push(p.i);
      topSum += p.sum;
    } else {
      bottom.push(p.i);
      bottomSum += p.sum;
    }
  }
  return [...bottom.reverse(), ...top];
}

/**
 * Stacks the series with the "wiggle" baseline (Byron & Wattenberg 2008), which minimises how much the
 * layers' slopes change from month to month, so each genre reads as a smooth ribbon. Layer thickness is
 * exactly the series value at every month.
 */
export function streamLayout(series: readonly (readonly number[])[], order = insideOutOrder(series)): StreamLayout {
  const m = series[0]?.length ?? 0;
  if (!series.length || !m) return { layers: [], min: 0, max: 0 };
  const g = new Array<number>(m).fill(0);
  for (let j = 1; j < m; j++) {
    let total = 0;
    let weighted = 0;
    let below = 0; // Σ of the slopes of the layers under the current one
    for (const i of order) {
      const v = series[i][j] || 0;
      const dv = v - (series[i][j - 1] || 0);
      weighted += (below + dv / 2) * v;
      below += dv;
      total += v;
    }
    g[j] = g[j - 1] - (total > 0 ? weighted / total : 0);
  }
  // Centre the whole stream on zero so it never drifts off the plot.
  const tops = g.map((base, j) => base + order.reduce((a, i) => a + (series[i][j] || 0), 0));
  let lo = Math.min(...g);
  let hi = Math.max(...tops);
  const shift = -(lo + hi) / 2;
  const layers: StreamLayer[] = [];
  const cursor = g.map((v) => v + shift);
  for (const i of order) {
    const lower = cursor.slice();
    const upper = cursor.map((c, j) => c + (series[i][j] || 0));
    layers.push({ key: i, lower, upper });
    for (let j = 0; j < m; j++) cursor[j] = upper[j];
  }
  lo += shift;
  hi += shift;
  return { layers, min: lo, max: hi };
}

/**
 * Monotone cubic (Fritsch–Carlson) path through the points, never overshooting between months.
 * Returns the commands after the first point (the caller adds M or L to it).
 */
export function monotoneSegments(xs: readonly number[], ys: readonly number[]): string {
  const n = xs.length;
  if (n < 2) return '';
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(xs[i + 1] - xs[i]);
    slope.push((ys[i + 1] - ys[i]) / (dx[i] || 1));
  }
  const t: number[] = new Array(n).fill(0);
  t[0] = slope[0];
  t[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / slope[i];
    const b = t[i + 1] / slope[i];
    const h = a * a + b * b;
    if (h > 9) {
      const s = 3 / Math.sqrt(h);
      t[i] = s * a * slope[i];
      t[i + 1] = s * b * slope[i];
    }
  }
  const f = (v: number) => Math.round(v * 100) / 100;
  let d = '';
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${f(xs[i] + h)},${f(ys[i] + t[i] * h)} ${f(xs[i + 1] - h)},${f(ys[i + 1] - t[i + 1] * h)} ${f(xs[i + 1])},${f(ys[i + 1])}`;
  }
  return d;
}

/** A closed area between two boundaries (upper left→right, lower right→left). */
export function areaPath(xs: readonly number[], upper: readonly number[], lower: readonly number[]): string {
  if (!xs.length) return '';
  const f = (v: number) => Math.round(v * 100) / 100;
  const rx = [...xs].reverse();
  const rl = [...lower].reverse();
  return `M${f(xs[0])},${f(upper[0])}${monotoneSegments(xs, upper)}L${f(rx[0])},${f(rl[0])}${monotoneSegments(rx, rl)}Z`;
}
