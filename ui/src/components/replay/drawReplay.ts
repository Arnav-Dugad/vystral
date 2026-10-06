/**
 * Track M: draws a session replay card on a 2D canvas at time t (0..REPLAY_SECONDS). The same code
 * draws the on-screen animation and the 1920×1080 PNG (its final frame), so the saved image is
 * exactly what was shown. Only real numbers are drawn; missing data is left out, never invented.
 */
import { formatDuration } from '../../lib/format';
import { formatPercent } from '../../lib/achievements';
import {
  achievementAt, CARD_H, CARD_W, clamp01, counterValue, easeOutCubic, phase, REPLAY_SECONDS, seriesMax, TIMELINE, type ReplayModel,
} from '../../lib/replay';

export interface ReplayImages {
  backdrop: ImageBitmap | null;
  logo: ImageBitmap | null;
  icons: Map<string, ImageBitmap>;
}

export interface ReplayTheme {
  accent: string;
  fontDisplay: string;
  fontUi: string;
}

const TIER_RING: Record<'common' | 'rare' | 'ultra', string> = {
  common: 'rgba(255,255,255,0.28)',
  rare: 'rgba(242,201,92,0.95)',
  ultra: 'rgba(196,148,255,0.95)',
};

function coverFit(ctx: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, w: number, h: number, scale: number) {
  const r = Math.max(w / img.width, h / img.height) * scale;
  const dw = img.width * r;
  const dh = img.height * r;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function truncate(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Draws the card in a 1920×1080 coordinate space onto a canvas of any size (scaled to fit). */
export function drawReplay(ctx: CanvasRenderingContext2D, model: ReplayModel, images: ReplayImages, theme: ReplayTheme, tIn: number) {
  const t = Math.min(REPLAY_SECONDS, Math.max(0, tIn));
  const canvas = ctx.canvas;
  ctx.save();
  ctx.setTransform(canvas.width / CARD_W, 0, 0, canvas.height / CARD_H, 0, 0);
  ctx.clearRect(0, 0, CARD_W, CARD_H);

  // ---- backdrop: game art (or an accent wash), slowly settling, under a cinematic scrim ----
  ctx.fillStyle = '#07070c';
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  const bd = easeOutCubic(phase(t, ...TIMELINE.backdrop));
  if (images.backdrop) {
    ctx.save();
    ctx.globalAlpha = 0.85 * bd;
    coverFit(ctx, images.backdrop, CARD_W, CARD_H, 1.08 - 0.06 * easeOutCubic(t / REPLAY_SECONDS));
    ctx.restore();
  }
  ctx.save();
  ctx.globalAlpha = 0.55 * bd + 0.2;
  const glow = ctx.createRadialGradient(CARD_W * 0.78, CARD_H * 0.1, 40, CARD_W * 0.78, CARD_H * 0.1, CARD_W * 0.75);
  glow.addColorStop(0, theme.accent);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  ctx.restore();
  const scrim = ctx.createLinearGradient(0, 0, CARD_W, 0);
  scrim.addColorStop(0, 'rgba(5,5,10,0.92)');
  scrim.addColorStop(0.55, 'rgba(5,5,10,0.62)');
  scrim.addColorStop(1, 'rgba(5,5,10,0.35)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  const floor = ctx.createLinearGradient(0, CARD_H * 0.45, 0, CARD_H);
  floor.addColorStop(0, 'rgba(5,5,10,0)');
  floor.addColorStop(1, 'rgba(5,5,10,0.9)');
  ctx.fillStyle = floor;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // ---- eyebrow, logo or title ----
  const ti = easeOutCubic(phase(t, ...TIMELINE.title));
  ctx.save();
  ctx.globalAlpha = ti;
  ctx.translate(0, 24 * (1 - ti));
  ctx.fillStyle = 'rgba(255,255,255,0.62)';
  ctx.font = `600 26px ${theme.fontUi}`;
  ctx.textBaseline = 'alphabetic';
  const when = new Date(model.start);
  const dateText = Number.isFinite(when.getTime()) ? when.toLocaleDateString(undefined, { dateStyle: 'long' }) : '';
  ctx.fillText(`SESSION REPLAY${dateText ? `  ·  ${dateText.toUpperCase()}` : ''}`, 120, 128);
  if (images.logo) {
    const maxW = 640;
    const maxH = 210;
    const r = Math.min(maxW / images.logo.width, maxH / images.logo.height);
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 24;
    ctx.drawImage(images.logo, 120, 160, images.logo.width * r, images.logo.height * r);
    ctx.shadowBlur = 0;
  } else {
    ctx.fillStyle = '#fff';
    ctx.font = `800 96px ${theme.fontDisplay}`;
    ctx.fillText(truncate(ctx, model.title, 1100), 116, 260);
  }
  ctx.restore();

  // ---- duration counter ----
  const ci = phase(t, TIMELINE.counter[0] - 0.3, TIMELINE.counter[0]);
  ctx.save();
  ctx.globalAlpha = ci;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = `600 24px ${theme.fontUi}`;
  ctx.fillText('PLAYED', 120, 432);
  ctx.fillStyle = '#fff';
  ctx.font = `800 112px ${theme.fontDisplay}`;
  const shown = counterValue(t, model.durationSeconds);
  ctx.fillText(shown > 0 ? formatDuration(shown) : '0m', 112, 548);
  ctx.restore();

  // ---- stats ----
  const stats: [string, string][] = [];
  if (model.fpsAvg != null) stats.push(['FPS AVERAGE', `${Math.round(model.fpsAvg)}`]);
  if (model.fps1Low != null) stats.push(['1% LOW', `${Math.round(model.fps1Low)}`]);
  if (model.cpuAvg != null) stats.push(['CPU AVERAGE', `${Math.round(model.cpuAvg)}%`]);
  if (model.gpuAvg != null) stats.push(['GPU AVERAGE', `${Math.round(model.gpuAvg)}%`]);
  const si = easeOutCubic(phase(t, ...TIMELINE.stats));
  // Laid out from the right edge so wide values never collide.
  const shownStats = stats.slice(0, 4);
  const widths = shownStats.map(([label, value]) => {
    ctx.font = `600 20px ${theme.fontUi}`;
    const lw = ctx.measureText(label).width;
    ctx.font = `700 60px ${theme.fontDisplay}`;
    return Math.max(lw, ctx.measureText(value).width);
  });
  let sx = CARD_W - 120 - widths.reduce((a, b) => a + b, 0) - 64 * Math.max(0, widths.length - 1);
  shownStats.forEach(([label, value], i) => {
    ctx.save();
    ctx.globalAlpha = clamp01(si * 1.4 - i * 0.12);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = `600 20px ${theme.fontUi}`;
    ctx.fillText(label, sx, 432);
    ctx.fillStyle = '#fff';
    ctx.font = `700 60px ${theme.fontDisplay}`;
    ctx.fillText(value, sx, 506);
    ctx.restore();
    sx += widths[i] + 64;
  });

  // ---- the session line(s) ----
  const chart = { x: 120, y: 650, w: 1680, h: 180 };
  const lp = easeOutCubic(phase(t, ...TIMELINE.line));
  const series: { values: number[]; color: string; width: number; fill: boolean; label: string }[] = [];
  if (model.fps) series.push({ values: model.fps, color: theme.accent, width: 5, fill: true, label: 'FPS' });
  if (model.cpu) series.push({ values: model.cpu, color: model.fps ? 'rgba(255,255,255,0.55)' : theme.accent, width: model.fps ? 3 : 5, fill: !model.fps, label: 'CPU %' });
  if (series.length) {
    ctx.save();
    ctx.globalAlpha = clamp01(phase(t, TIMELINE.line[0] - 0.4, TIMELINE.line[0]));
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    for (let g = 0; g <= 2; g++) {
      const y = Math.round(chart.y + (chart.h * g) / 2) + 0.5;
      ctx.beginPath();
      ctx.moveTo(chart.x, y);
      ctx.lineTo(chart.x + chart.w, y);
      ctx.stroke();
    }
    ctx.font = `600 20px ${theme.fontUi}`;
    series.forEach((s, i) => {
      ctx.fillStyle = s.color;
      ctx.fillRect(chart.x + i * 140, chart.y - 38, 22, 6);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillText(s.label, chart.x + 32 + i * 140, chart.y - 28);
    });
    ctx.restore();
    for (const s of [...series].reverse()) {
      const max = seriesMax(s.values);
      const pts = s.values.map((v, i) => [chart.x + (i / (s.values.length - 1)) * chart.w, chart.y + chart.h - (v / max) * chart.h] as const);
      ctx.save();
      ctx.beginPath();
      ctx.rect(chart.x - 10, chart.y - 20, (chart.w + 20) * lp, chart.h + 40);
      ctx.clip();
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (s.fill) {
        ctx.save();
        ctx.lineTo(chart.x + chart.w, chart.y + chart.h);
        ctx.lineTo(chart.x, chart.y + chart.h);
        ctx.closePath();
        const fill = ctx.createLinearGradient(0, chart.y, 0, chart.y + chart.h);
        fill.addColorStop(0, s.color);
        fill.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.restore();
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      }
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.shadowColor = s.color;
      ctx.shadowBlur = s.fill ? 18 : 0;
      ctx.stroke();
      ctx.restore();
      if (lp > 0 && lp < 1 && s.fill) {
        const idx = Math.min(pts.length - 1, Math.round(lp * (pts.length - 1)));
        ctx.save();
        ctx.fillStyle = '#fff';
        ctx.shadowColor = s.color;
        ctx.shadowBlur = 24;
        ctx.beginPath();
        ctx.arc(pts[idx][0], pts[idx][1], 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  } else {
    ctx.save();
    ctx.globalAlpha = clamp01(phase(t, ...TIMELINE.line) * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = `500 26px ${theme.fontUi}`;
    ctx.fillText('No performance samples were recorded for this session.', chart.x, chart.y + chart.h / 2);
    ctx.restore();
  }

  // ---- achievements, popping in with a rarity shimmer ----
  const row = { x: 120, y: 862, size: 104, gap: 168 };
  model.achievements.forEach((a, i) => {
    const st = achievementAt(i, t);
    if (st.scale <= 0) return;
    const x = row.x + i * row.gap;
    const cx = x + row.size / 2;
    const cy = row.y + row.size / 2;
    ctx.save();
    ctx.globalAlpha = st.opacity;
    ctx.translate(cx, cy);
    ctx.scale(st.scale, st.scale);
    ctx.translate(-cx, -cy);
    roundRect(ctx, x, row.y, row.size, row.size, 20);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fill();
    ctx.save();
    ctx.clip();
    const icon = images.icons.get(a.key);
    if (icon) ctx.drawImage(icon, x, row.y, row.size, row.size);
    else {
      ctx.fillStyle = 'rgba(255,214,102,0.9)';
      ctx.font = `700 56px ${theme.fontUi}`;
      ctx.textAlign = 'center';
      ctx.fillText('🏆', cx, cy + 20);
      ctx.textAlign = 'start';
    }
    if (st.shimmer > 0 && st.shimmer < 1) {
      const sx = x - row.size + st.shimmer * row.size * 3;
      const sh = ctx.createLinearGradient(sx - 60, row.y, sx + 60, row.y + row.size);
      const c = a.tier === 'ultra' ? 'rgba(214,170,255,0.7)' : a.tier === 'rare' ? 'rgba(255,224,130,0.75)' : 'rgba(255,255,255,0.4)';
      sh.addColorStop(0, 'rgba(255,255,255,0)');
      sh.addColorStop(0.5, c);
      sh.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sh;
      ctx.fillRect(x, row.y, row.size, row.size);
    }
    ctx.restore();
    roundRect(ctx, x, row.y, row.size, row.size, 20);
    ctx.strokeStyle = TIER_RING[a.tier];
    ctx.lineWidth = a.tier === 'common' ? 2 : 4;
    if (a.tier !== 'common') {
      ctx.shadowColor = TIER_RING[a.tier];
      ctx.shadowBlur = 20;
    }
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = st.opacity;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = `600 19px ${theme.fontUi}`;
    ctx.fillText(truncate(ctx, a.name, row.gap - 16), x, row.y + row.size + 34);
    if (a.percent != null) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = `500 17px ${theme.fontUi}`;
      ctx.fillText(`${formatPercent(a.percent)} of players`, x, row.y + row.size + 58);
    }
    ctx.restore();
  });
  if (model.moreAchievements > 0) {
    const st = achievementAt(model.achievements.length, t);
    ctx.save();
    ctx.globalAlpha = st.opacity;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = `700 36px ${theme.fontDisplay}`;
    ctx.fillText(`+${model.moreAchievements}`, row.x + model.achievements.length * row.gap + 10, row.y + 66);
    ctx.restore();
  }

  // ---- peak temperature chip ----
  if (model.peakTempC != null) {
    const p = easeOutCubic(phase(t, ...TIMELINE.temps));
    ctx.save();
    ctx.globalAlpha = p;
    const text = `PEAK GPU  ${Math.round(model.peakTempC)}°C`;
    ctx.font = `700 24px ${theme.fontUi}`;
    const w = ctx.measureText(text).width + 48;
    const x = CARD_W - 120 - w;
    const hot = model.peakTempC >= 83;
    roundRect(ctx, x, 96, w, 52, 26);
    ctx.fillStyle = hot ? 'rgba(255,120,80,0.18)' : 'rgba(255,255,255,0.1)';
    ctx.fill();
    ctx.strokeStyle = hot ? 'rgba(255,140,100,0.6)' : 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = hot ? '#ffb199' : '#fff';
    ctx.fillText(text, x + 24, 131);
    ctx.restore();
  }

  // ---- brand ----
  const b = phase(t, ...TIMELINE.brand);
  ctx.save();
  ctx.globalAlpha = 0.75 * b;
  ctx.fillStyle = '#fff';
  ctx.font = `800 30px ${theme.fontDisplay}`;
  ctx.textAlign = 'right';
  ctx.fillText('VYSTRAL', CARD_W - 120, CARD_H - 64);
  ctx.restore();

  ctx.restore();
}
