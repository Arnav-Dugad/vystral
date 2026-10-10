import { useEffect, useId, useState } from 'react';
import { Table2, BarChart3 } from 'lucide-react';
import type { JournalResult } from '../../bridge/types';
import { chartBars, labelEvery } from '../../lib/aiJournal';
import { useReducedMotion, useStore } from '../../state/store';
import './ai.css';

/**
 * Track C5: the chart an "Ask the Journal" answer used. One series in the accent colour (no legend needed; the
 * caption names it), thin bars with rounded data ends anchored to the baseline, values in text colours, a hover/focus
 * tooltip on every mark, and a table view of the same rows. Bars grow in once; reduced motion shows them at once.
 */
export function JournalChart({ result }: { result: JournalResult }) {
  const reduce = useReducedMotion();
  const navigate = useStore((s) => s.navigate);
  const [table, setTable] = useState(false);
  const [grown, setGrown] = useState(reduce);
  const captionId = useId();
  const bars = chartBars(result);
  const every = labelEvery(bars.length);
  useEffect(() => {
    if (reduce) return;
    const raf = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(raf);
  }, [reduce, result]);

  if (!bars.length || bars.every((b) => b.value <= 0))
    return <p className="ai-chart__empty">Nothing to chart for {result.rangeLabel}.</p>;

  return (
    <figure className="ai-chart" aria-labelledby={captionId} data-grown={grown || undefined}>
      <figcaption id={captionId} className="ai-chart__caption">
        <span>{result.description}</span>
        <button type="button" className="ai-chart__switch" aria-pressed={table} onClick={() => setTable((t) => !t)}>
          {table ? <BarChart3 size={13} aria-hidden /> : <Table2 size={13} aria-hidden />} {table ? 'Show chart' : 'Show as table'}
        </button>
      </figcaption>

      {table ? (
        <table className="ai-chart__table">
          <thead><tr><th scope="col">{result.spec.groupBy === 'none' ? 'Total' : result.spec.groupBy[0].toUpperCase() + result.spec.groupBy.slice(1)}</th><th scope="col">Value</th></tr></thead>
          <tbody>{bars.map((b) => <tr key={b.key}><td>{b.label}</td><td className="num">{b.text}</td></tr>)}</tbody>
        </table>
      ) : result.chart === 'bar' ? (
        <ul className="ai-bars" aria-label={result.description}>
          {bars.map((b, i) => (
            <li key={b.key} className="ai-bars__row" style={{ ['--i' as string]: i }}>
              {b.gameId ? (
                <button type="button" className="ai-bars__label ai-bars__label--link" onClick={() => navigate({ name: 'game', id: b.gameId! })} title={`Open ${b.label}`}>
                  {b.label}
                </button>
              ) : <span className="ai-bars__label">{b.label}</span>}
              <span className="ai-bars__track" aria-hidden>
                <span className="ai-bars__bar" style={{ ['--share' as string]: b.share }} />
              </span>
              <span className="ai-bars__value num">{b.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="ai-cols" role="list" aria-label={result.description} style={{ ['--n' as string]: bars.length }}>
          {bars.map((b, i) => (
            <div key={b.key} className="ai-cols__col" role="listitem" tabIndex={0} aria-label={`${b.label}: ${b.text}`} style={{ ['--i' as string]: i }}>
              <span className="ai-cols__tip" aria-hidden>{b.label} · {b.text}</span>
              <span className="ai-cols__plot" aria-hidden>
                <span className="ai-cols__bar" style={{ ['--share' as string]: b.share }} data-zero={b.value <= 0 || undefined} />
              </span>
              <span className="ai-cols__label" aria-hidden>{i % every === 0 ? b.label : ''}</span>
            </div>
          ))}
        </div>
      )}
    </figure>
  );
}
