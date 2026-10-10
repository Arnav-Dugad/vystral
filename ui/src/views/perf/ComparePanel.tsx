/**
 * Track C2: the Compare tab — any two sessions side by side: system averages, frame rate and lows, and their
 * frame-time distributions as paired columns. Differences under the run-to-run noise read "about the same".
 */
import { useMemo, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { ArrowDown, ArrowLeftRight, ArrowUp, Equal, Info } from 'lucide-react';
import type { Game, PerfSummary } from '../../bridge/types';
import { IconButton, SectionHead } from '../../components/ui/primitives';
import { formatDuration } from '../../lib/format';
import { spring } from '../../lib/motion';
import { useReducedMotion } from '../../state/store';
import { gameTitle } from './text';
import { histogramBuckets } from './insight';
import { HealthPip } from './PerfSummaryBand';
import { HEALTH_LABEL, healthOf, type PerfEntry } from './overview';
import { METRICS, NOISE_PCT, compareCandidates, compareValues, formatMetric, summaryValue } from './series';

const fmtDateTime = (ms: number) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
const fmtDate = (ms: number) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(ms);

interface Row {
  key: string;
  label: string;
  a: number | null;
  b: number | null;
  fmt: (v: number) => string;
  diff: (v: number) => string;
  /** Which direction reads as better, when one does. */
  better?: 'higher' | 'lower';
}

const fpsRows = (a: PerfSummary, b: PerfSummary): Row[] => {
  const fps = (v: number) => `${Math.round(v)} fps`;
  const dFps = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(Math.abs(v) < 10 ? 1 : 0)} fps`;
  const ms = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)} ms`;
  const dMs = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)} ms`;
  return [
    { key: 'fpsAvg', label: 'Average frame rate', a: a.fpsAvg ?? null, b: b.fpsAvg ?? null, fmt: fps, diff: dFps, better: 'higher' },
    { key: 'fps1Low', label: '1% low', a: a.fps1Low ?? null, b: b.fps1Low ?? null, fmt: fps, diff: dFps, better: 'higher' },
    { key: 'fps01Low', label: '0.1% low', a: a.fps01Low ?? null, b: b.fps01Low ?? null, fmt: fps, diff: dFps, better: 'higher' },
    { key: 'p99', label: 'Frame time p99', a: a.frameTimeP99Ms ?? null, b: b.frameTimeP99Ms ?? null, fmt: ms, diff: dMs, better: 'lower' },
  ];
};

export function ComparePanel({
  entries,
  a,
  b,
  gamesById,
  onPickA,
  onPickB,
  onSwap,
}: {
  entries: PerfEntry[];
  a: PerfEntry;
  b: PerfEntry | null;
  gamesById: Map<string, Game>;
  onPickA: (id: string) => void;
  onPickB: (id: string) => void;
  onSwap: () => void;
}) {
  const candidates = useMemo(() => compareCandidates(entries, a), [entries, a]);
  const label = (e: PerfEntry) => `${gameTitle(gamesById.get(e.gameId))} — ${fmtDateTime(e.startMs)} · ${formatDuration(e.session.durationSeconds)}`;

  const rows: Row[] = useMemo(() => {
    if (!b) return [];
    const sys: Row[] = METRICS.map((m) => ({
      key: m.key,
      label: m.label,
      a: summaryValue(a.summary, m, 'avg'),
      b: summaryValue(b.summary, m, 'avg'),
      fmt: (v: number) => formatMetric(v, m.unit),
      diff: (v: number) => {
        const sign = v > 0 ? '+' : v < 0 ? '−' : '±';
        const abs = Math.abs(v);
        if (m.unit === 'GB') return `${sign}${abs.toFixed(abs >= 10 ? 1 : 2)} GB`;
        if (m.unit === '°C') return `${sign}${abs.toFixed(1)} °C`;
        return `${sign}${abs.toFixed(1)} pts`;
      },
    }));
    return [...fpsRows(a.summary, b.summary).filter((r) => r.a != null || r.b != null), ...sys];
  }, [a, b]);

  return (
    <div className="pf-stack">
      <section className="surface vx-card pf-compare" aria-labelledby="pf-compare-title">
        <SectionHead title={<span id="pf-compare-title">Compare two sessions</span>} meta="Averages over each whole session" />
        <div className="pf-compare__pickers">
          <SessionPick id="pf-compare-a" label="This session" tone="a" value={a.id} entries={entries} gamesById={gamesById} onPick={onPickA} format={label} />
          <IconButton label="Swap the two sessions" size="sm" onClick={onSwap} disabled={!b}>
            <ArrowLeftRight size={15} />
          </IconButton>
          <SessionPick id="pf-compare-b" label="Compared with" tone="b" value={b?.id ?? ''} entries={candidates} gamesById={gamesById} onPick={onPickB} format={label} sameGameId={a.gameId} />
        </div>

        {b ? (
          <>
            <div className="pf-compare__heads" aria-hidden>
              <CompareHead e={a} tone="a" game={gamesById.get(a.gameId)} />
              <CompareHead e={b} tone="b" game={gamesById.get(b.gameId)} />
            </div>
            <div className="pf-table-wrap" tabIndex={0} role="region" aria-label="Session comparison">
              <table className="pf-table">
                <thead>
                  <tr>
                    <th scope="col">Metric</th>
                    <th scope="col">This session<span className="pf-table__sub">{fmtDate(a.startMs)}</span></th>
                    <th scope="col">Compared<span className="pf-table__sub">{fmtDate(b.startMs)}</span></th>
                    <th scope="col">Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => <CompareRow key={r.key} r={r} />)}
                </tbody>
              </table>
            </div>
            <p className="vx-note pf-compare__note">
              <Info size={14} aria-hidden />
              <span>
                Differences under ~{NOISE_PCT}% are within normal run-to-run variation — background apps, scenes, settings and session length all move these numbers.
                {a.gameId !== b.gameId && ' These sessions are from different games, so most of the difference comes from the games themselves.'}
              </span>
            </p>
          </>
        ) : (
          <p className="pf-muted">Record at least two sessions with metrics to compare them.</p>
        )}
      </section>

      {b && <HistogramCompare a={a.summary} b={b.summary} />}
    </div>
  );
}

function SessionPick({
  id, label, tone, value, entries, gamesById, onPick, format, sameGameId,
}: {
  id: string; label: string; tone: 'a' | 'b'; value: string; entries: PerfEntry[]; gamesById: Map<string, Game>;
  onPick: (id: string) => void; format: (e: PerfEntry) => string; sameGameId?: string;
}) {
  const same = sameGameId ? entries.filter((e) => e.gameId === sameGameId) : [];
  const rest = sameGameId ? entries.filter((e) => e.gameId !== sameGameId) : entries;
  return (
    <label className="pf-filter pf-compare__pick" htmlFor={id}>
      <span className="caps"><span className="pf-tone" data-tone={tone} aria-hidden />{label}</span>
      <select id={id} className="input vx-select" value={value} onChange={(e) => onPick(e.target.value)}>
        {same.length > 0 && (
          <optgroup label={`${gameTitle(gamesById.get(sameGameId!))} (same game)`}>
            {same.map((c) => <option key={c.id} value={c.id}>{format(c)}</option>)}
          </optgroup>
        )}
        {sameGameId ? (
          rest.length > 0 && (
            <optgroup label="Other games">
              {rest.slice(0, 300).map((c) => <option key={c.id} value={c.id}>{format(c)}</option>)}
            </optgroup>
          )
        ) : (
          rest.slice(0, 400).map((c) => <option key={c.id} value={c.id}>{format(c)}</option>)
        )}
      </select>
    </label>
  );
}

function CompareHead({ e, tone, game }: { e: PerfEntry; tone: 'a' | 'b'; game: Game | undefined }) {
  const h = healthOf(e);
  return (
    <div className="pf-compare__head" data-tone={tone}>
      <span className="pf-tone" data-tone={tone} />
      <span className="pf-compare__game truncate">{gameTitle(game)}</span>
      <span className="pf-compare__meta"><HealthPip level={h.level} size={10} />{HEALTH_LABEL[h.level]} · {formatDuration(e.session.durationSeconds)}</span>
    </div>
  );
}

function CompareRow({ r }: { r: Row }) {
  // Difference is "this session" relative to the compared one.
  const d = compareValues(r.b, r.a);
  let cell: ReactNode;
  if (d.direction === 'unknown') cell = <span className="pf-muted">Unavailable on {r.a == null && r.b == null ? 'both' : r.a == null ? 'this session' : 'compared session'}</span>;
  else {
    const same = d.withinNoise || d.direction === 'same';
    const Icon = same ? Equal : d.direction === 'higher' ? ArrowUp : ArrowDown;
    const verdict = same || !r.better ? null : (d.direction === 'higher') === (r.better === 'higher') ? 'better' : 'worse';
    const word = same ? 'about the same' : verdict ?? d.direction;
    cell = (
      <span className="pf-delta" data-noise={same || undefined} data-verdict={verdict ?? undefined}>
        <Icon size={14} aria-hidden />
        <span className="num">{r.diff(d.diff!)}</span>
        {d.pct != null && <span className="num pf-muted">({d.pct > 0 ? '+' : ''}{d.pct.toFixed(Math.abs(d.pct) < 10 ? 1 : 0)}%)</span>}
        <span className="pf-delta__word">{word}</span>
      </span>
    );
  }
  return (
    <tr>
      <th scope="row">
        {r.label}
      </th>
      <td className="num">{r.a == null ? <span className="pf-muted">Unavailable</span> : r.fmt(r.a)}</td>
      <td className="num">{r.b == null ? <span className="pf-muted">Unavailable</span> : r.fmt(r.b)}</td>
      <td>{cell}</td>
    </tr>
  );
}

/** Both sessions' frame-time distributions as paired columns (this session, then the compared one) per bucket. */
function HistogramCompare({ a, b }: { a: PerfSummary; b: PerfSummary }) {
  const reduce = useReducedMotion();
  const ha = useMemo(() => histogramBuckets(a.frameTimeHistogram ?? null), [a]);
  const hb = useMemo(() => histogramBuckets(b.frameTimeHistogram ?? null), [b]);
  if (!ha.length && !hb.length) return null;
  const labels = (ha.length ? ha : hb).map((x) => ({ label: x.label, fpsLabel: x.fpsLabel }));
  const max = Math.max(...ha.map((x) => x.share), ...hb.map((x) => x.share), 0.0001);
  const pct = (s: number | undefined) => (s == null ? '—' : s >= 0.001 ? `${(s * 100).toFixed(s < 0.1 ? 1 : 0)}%` : s > 0 ? '<0.1%' : '0%');
  return (
    <section className="surface vx-card pf-histcmp" aria-labelledby="pf-histcmp-title">
      <SectionHead title={<span id="pf-histcmp-title">Frame-time distribution</span>} meta="Share of frames by frame time in milliseconds · shorter is smoother" />
      <ul className="pf-legend" aria-label="Sessions">
        <li><span className="pf-swatch" data-tone="a" aria-hidden />This session{ha.length ? '' : ' (not measured)'}</li>
        <li><span className="pf-swatch" data-tone="b" aria-hidden />Compared{hb.length ? '' : ' (not measured)'}</li>
      </ul>
      <ol className="pf-histcmp__bars">
        {labels.map((l, i) => (
          <li key={l.label} className="pf-histcmp__bucket">
            <span className="pf-histcmp__pair" aria-hidden>
              {[ha[i], hb[i]].map((x, j) => (
                <span key={j} className="pf-histcmp__track" title={x ? `${j === 0 ? 'This session' : 'Compared'}: ${pct(x.share)} of frames at ${l.label} ms` : undefined}>
                  {x && (
                    <motion.span
                      className="pf-histcmp__fill"
                      data-tone={j === 0 ? 'a' : 'b'}
                      initial={reduce ? false : { scaleY: 0 }}
                      animate={{ scaleY: Math.max(x.share / max, x.count > 0 ? 0.02 : 0) }}
                      transition={reduce ? { duration: 0 } : { ...spring.panel, delay: i * 0.02 }}
                    />
                  )}
                </span>
              ))}
            </span>
            <span className="pf-histcmp__label">{l.label}</span>
            <span className="visually-hidden">ms ({l.fpsLabel}): this session {pct(ha[i]?.share)}, compared {pct(hb[i]?.share)} of frames.</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
