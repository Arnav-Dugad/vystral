/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk, 2000) plus geometric keyboard navigation
 * between tiles. Pure functions: no DOM, fully unit-tested.
 */

export interface TreemapItem<T = unknown> {
  id: string;
  value: number;
  data: T;
}

export interface TreemapRect<T = unknown> extends TreemapItem<T> {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Pending<T> {
  item: TreemapItem<T>;
  area: number;
}

/** Worst (largest) aspect ratio of a row laid out along a side of length `side`. */
function worst(areas: number[], side: number): number {
  let sum = 0;
  let max = 0;
  let min = Infinity;
  for (const a of areas) {
    sum += a;
    if (a > max) max = a;
    if (a < min) min = a;
  }
  if (sum <= 0 || side <= 0) return Infinity;
  const s2 = sum * sum;
  const side2 = side * side;
  return Math.max((side2 * max) / s2, s2 / (side2 * min));
}

/**
 * Lays out items (largest first) inside the rectangle so that tiles are as close to square as
 * possible. Items with a non-positive or non-finite value are left out. The result covers the
 * rectangle exactly (up to floating-point rounding) and keeps each tile's area proportional to
 * its value.
 */
export function squarify<T>(items: readonly TreemapItem<T>[], width: number, height: number, x0 = 0, y0 = 0): TreemapRect<T>[] {
  if (!(width > 0) || !(height > 0)) return [];
  const valid = items.filter((i) => Number.isFinite(i.value) && i.value > 0).sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
  const total = valid.reduce((s, i) => s + i.value, 0);
  if (total <= 0) return [];
  const scale = (width * height) / total;
  const queue: Pending<T>[] = valid.map((item) => ({ item, area: item.value * scale }));

  const out: TreemapRect<T>[] = [];
  let rect = { x: x0, y: y0, w: width, h: height };
  let row: Pending<T>[] = [];

  const flush = (last: boolean) => {
    if (!row.length) return;
    const rowArea = row.reduce((s, r) => s + r.area, 0);
    if (rect.w >= rect.h) {
      // Column along the left edge.
      const colW = last ? rect.w : Math.min(rect.w, rowArea / rect.h);
      let y = rect.y;
      row.forEach((r, i) => {
        const h = i === row.length - 1 ? rect.y + rect.h - y : r.area / colW;
        out.push({ ...r.item, x: rect.x, y, w: colW, h });
        y += h;
      });
      rect = { x: rect.x + colW, y: rect.y, w: rect.w - colW, h: rect.h };
    } else {
      // Row along the top edge.
      const rowH = last ? rect.h : Math.min(rect.h, rowArea / rect.w);
      let x = rect.x;
      row.forEach((r, i) => {
        const w = i === row.length - 1 ? rect.x + rect.w - x : r.area / rowH;
        out.push({ ...r.item, x, y: rect.y, w, h: rowH });
        x += w;
      });
      rect = { x: rect.x, y: rect.y + rowH, w: rect.w, h: rect.h - rowH };
    }
    row = [];
  };

  for (let i = 0; i < queue.length; i++) {
    const next = queue[i];
    const side = Math.min(rect.w, rect.h);
    if (!row.length || worst([...row.map((r) => r.area), next.area], side) <= worst(row.map((r) => r.area), side)) {
      row.push(next);
    } else {
      flush(false);
      row.push(next);
    }
  }
  flush(true);
  return out;
}

export type Direction = 'left' | 'right' | 'up' | 'down';

/**
 * Index of the tile to move focus to from `from` in `dir`, or `from` when there is none.
 * Candidates must lie in that direction; among them the nearest edge wins, with overlap on
 * the cross axis strongly preferred so focus moves the way the eye expects.
 */
export function neighbor(rects: readonly { x: number; y: number; w: number; h: number }[], from: number, dir: Direction): number {
  const a = rects[from];
  if (!a) return from;
  const eps = 0.5;
  let best = from;
  let bestScore = Infinity;
  rects.forEach((b, i) => {
    if (i === from) return;
    let gap: number;
    let overlap: number;
    let cross: number;
    switch (dir) {
      case 'right':
        if (b.x < a.x + a.w - eps) return;
        gap = b.x - (a.x + a.w);
        overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        cross = Math.abs(b.y + b.h / 2 - (a.y + a.h / 2));
        break;
      case 'left':
        if (b.x + b.w > a.x + eps) return;
        gap = a.x - (b.x + b.w);
        overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        cross = Math.abs(b.y + b.h / 2 - (a.y + a.h / 2));
        break;
      case 'down':
        if (b.y < a.y + a.h - eps) return;
        gap = b.y - (a.y + a.h);
        overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        cross = Math.abs(b.x + b.w / 2 - (a.x + a.w / 2));
        break;
      case 'up':
        if (b.y + b.h > a.y + eps) return;
        gap = a.y - (b.y + b.h);
        overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        cross = Math.abs(b.x + b.w / 2 - (a.x + a.w / 2));
        break;
    }
    const score = Math.max(0, gap) * 4 + cross + (overlap > eps ? 0 : 100000);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}
