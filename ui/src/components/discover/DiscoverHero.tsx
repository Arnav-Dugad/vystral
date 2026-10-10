import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowRight, Check, ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import { cardPrice, releaseLabel, type HeroPick } from '../../lib/discover';
import { useReducedMotion } from '../../state/store';
import { Button, IconButton, Skeleton } from '../ui/primitives';
import { DiscoverCover, openResult } from './DiscoverBits';
import './discover-browse.css';

const ADVANCE_MS = 8000;

/**
 * Track C3: the featured-picks carousel at the top of Discover. One slide at a time (the next one is mounted to
 * preload its art); it moves on by itself every 8 s unless you hover, focus or pause it, and never under reduced motion
 * or in a hidden window. Left/Right while focused, dots and arrow buttons for everyone, and a Pause button (WCAG 2.2.2).
 */
export function DiscoverHero({ picks }: { picks: HeroPick[] }) {
  const reduce = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [held, setHeld] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const n = picks.length;
  const at = n ? index % n : 0;

  useEffect(() => { if (index >= n && n > 0) setIndex(0); }, [index, n]);

  const go = useCallback((to: number) => setIndex(((to % n) + n) % n), [n]);

  // A hidden or minimised window never moves on.
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  const auto = n > 1 && !paused && !held && !reduce && visible;
  useEffect(() => {
    if (!auto) return;
    const t = window.setTimeout(() => go(at + 1), ADVANCE_MS);
    return () => window.clearTimeout(t);
  }, [auto, at, go]);

  if (n === 0) return null;
  const pick = picks[at];

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT') return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      // Arrow keys between slides only from the carousel's own controls (cards elsewhere keep theirs).
      if (!(e.target as HTMLElement).closest('[data-hero-controls]')) return;
      e.preventDefault();
      go(at + (e.key === 'ArrowRight' ? 1 : -1));
    }
  };

  return (
    <section
      ref={rootRef}
      className="dhero"
      aria-roledescription="carousel"
      aria-label="Featured picks"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => { if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setHeld(false); }}
      onKeyDown={onKeyDown}
    >
      <div className="dhero__stage">
        {picks.map((p, i) => {
          const active = i === at;
          const near = active || i === (at + 1) % n || i === (at - 1 + n) % n;
          if (!near) return null;
          return <Slide key={p.result.key} pick={p} active={active} index={i} count={n} />;
        })}
      </div>
      <div className="dhero__controls" data-hero-controls>
        <IconButton label="Previous pick" size="sm" onClick={() => go(at - 1)} disabled={n < 2}><ChevronLeft size={16} /></IconButton>
        <div className="dhero__dots" role="group" aria-label="Choose a pick">
          {picks.map((p, i) => (
            <button key={p.result.key} type="button" className="dhero__dot" aria-label={`Pick ${i + 1} of ${n}: ${p.result.title}`}
              aria-current={i === at ? 'true' : undefined} onClick={() => go(i)}>
              <span className="dhero__dot-fill" data-run={i === at && auto ? 'true' : undefined} style={{ ['--hero-ms' as string]: `${ADVANCE_MS}ms` }} />
            </button>
          ))}
        </div>
        <IconButton label="Next pick" size="sm" onClick={() => go(at + 1)} disabled={n < 2}><ChevronRight size={16} /></IconButton>
        {n > 1 && !reduce && (
          <IconButton label={paused ? 'Play the featured picks' : 'Pause the featured picks'} size="sm" onClick={() => setPaused((v) => !v)} aria-pressed={paused}>
            {paused ? <Play size={14} /> : <Pause size={14} />}
          </IconButton>
        )}
      </div>
      {/* Announced only when you move it yourself; a carousel that moves on its own stays quiet. */}
      <span className="visually-hidden" aria-live="polite">{!auto && held ? `${pick.eyebrow}: ${pick.result.title}` : ''}</span>
    </section>
  );
}

function Slide({ pick, active, index, count }: { pick: HeroPick; active: boolean; index: number; count: number }) {
  const artRef = useRef<HTMLDivElement>(null);
  const r = pick.result;
  const price = cardPrice(r);
  const release = releaseLabel(r);
  const facts = [r.genres.slice(0, 2).join(' · ') || null, release ?? (r.year ? String(r.year) : null)].filter(Boolean);
  return (
    <div className="dhero__slide" data-active={active || undefined} role="group" aria-roledescription="slide"
      aria-label={`${index + 1} of ${count}: ${r.title}`} aria-hidden={!active || undefined} inert={!active}>
      <div className="dhero__art" ref={artRef}>
        <DiscoverCover itemKey={r.key} title={r.title} known={null} kind="hero" eager={active} genres={r.genres} />
      </div>
      <div className="dhero__scrim" aria-hidden />
      <div className="dhero__copy">
        <span className="dhero__eyebrow">{pick.eyebrow}</span>
        <h2 className="dhero__title">{r.title}</h2>
        {facts.length > 0 && <p className="dhero__facts">{facts.join(' · ')}</p>}
        <div className="dhero__actions">
          <Button variant="primary" icon={<ArrowRight size={16} />} onClick={() => openResult(r, artRef.current)}>See the game</Button>
          {r.libraryGameId
            ? <span className="dhero__price"><Check size={14} aria-hidden /> In your library</span>
            : price && (
              <span className="dhero__price num">
                {price.cut > 0 && <span className="dhero__cut">−{price.cut}%</span>}
                {price.was && <s aria-label={`was ${price.was}`}>{price.was}</s>}
                <b>{price.now}</b>
              </span>
            )}
        </div>
      </div>
    </div>
  );
}

/** The hero's shape while picks load. */
export function DiscoverHeroSkeleton() {
  return (
    <div className="dhero dhero--loading" aria-hidden>
      <Skeleton className="dhero__skel" height="100%" radius={0} />
      <div className="dhero__copy">
        <Skeleton width={160} height={12} radius={4} />
        <Skeleton width="min(420px, 70%)" height={34} radius={8} />
        <Skeleton width={140} height={40} radius={12} />
      </div>
    </div>
  );
}
