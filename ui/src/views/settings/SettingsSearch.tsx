import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronRight, CornerDownLeft, SearchX } from 'lucide-react';
import type { SettingsHit } from '../../lib/settingsSearch';
import './settings-search.css';

export const RESULTS_ID = 'settings-search-results';
export const optionId = (i: number) => `settings-result-${i}`;

function Marked({ text, marks }: { text: string; marks: [number, number][] }) {
  if (!marks.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  marks.forEach(([a, b], i) => {
    if (a > at) out.push(text.slice(at, a));
    out.push(<mark key={i}>{text.slice(a, b)}</mark>);
    at = b;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

/**
 * Track D6: the Settings search results, in the content column while a search is open. A listbox driven from the
 * search field (arrow keys move, Enter opens, Escape clears); each result shows where it lives.
 */
export function SettingsSearchResults({ query, hits, active, sectionLabel, onActive, onChoose }: {
  query: string;
  hits: SettingsHit[];
  active: number;
  sectionLabel: (id: string) => string;
  onActive: (i: number) => void;
  onChoose: (hit: SettingsHit) => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`#${optionId(active)}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <section className="ssearch" aria-labelledby="ssearch-title" data-testid="settings-results">
      <h2 className="ssearch__title" id="ssearch-title" aria-live="polite">
        {hits.length ? `${hits.length} ${hits.length === 1 ? 'setting matches' : 'settings match'} “${query.trim()}”` : `Nothing in Settings matches “${query.trim()}”`}
      </h2>
      {hits.length ? (
        <>
          <ul className="ssearch__list surface" role="listbox" id={RESULTS_ID} aria-labelledby="ssearch-title" ref={list}>
            {hits.map((h, i) => (
              <li
                key={`${h.entry.section}:${h.row}`}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                className="ssearch__item"
                onMouseMove={() => i !== active && onActive(i)}
                onClick={() => onChoose(h)}
              >
                <div className="ssearch__main">
                  <span className="ssearch__label"><Marked text={h.entry.label} marks={h.marks} /></span>
                  {h.entry.hint && <span className="ssearch__hint">{h.entry.hint}</span>}
                </div>
                <span className="ssearch__path">
                  {sectionLabel(h.entry.section)}
                  {h.entry.group !== h.entry.label && <><ChevronRight size={12} aria-hidden />{h.entry.group}</>}
                </span>
                {i === active && <CornerDownLeft size={14} className="ssearch__enter" aria-hidden />}
              </li>
            ))}
          </ul>
          <p className="ssearch__keys" aria-hidden><kbd>↑</kbd><kbd>↓</kbd> to move · <kbd>Enter</kbd> to open · <kbd>Esc</kbd> to clear</p>
        </>
      ) : (
        <div className="ssearch__empty surface">
          <SearchX size={22} aria-hidden />
          <p>Try another word, like “currency”, “cache”, “trailers” or “controller”.</p>
        </div>
      )}
    </section>
  );
}

/** Keyboard handling for the search field (returns true when it handled the key). */
export function searchKeys(e: KeyboardEvent<HTMLInputElement>, n: number, active: number, set: (i: number) => void, choose: () => void, clear: () => void): boolean {
  if (e.key === 'ArrowDown' && n) { set((active + 1) % n); return true; }
  if (e.key === 'ArrowUp' && n) { set((active - 1 + n) % n); return true; }
  if (e.key === 'Home' && n && e.ctrlKey) { set(0); return true; }
  if (e.key === 'End' && n && e.ctrlKey) { set(n - 1); return true; }
  if (e.key === 'Enter' && n) { choose(); return true; }
  if (e.key === 'Escape' && e.currentTarget.value) { clear(); return true; }
  return false;
}
