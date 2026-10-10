import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import {
  AlertTriangle, BadgeCheck, CalendarDays, Check, Cloud, CloudOff, Compass, ExternalLink, Eye, Hourglass, LibraryBig, RefreshCw, ShieldAlert, ShoppingBag, Star, Tag,
} from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { DiscoverDetails, DiscoverLink, Game, GamepadButton } from '../../bridge/types';
import { hoursLabel } from '../../lib/discover';
import { DECK_LABEL } from '../../lib/dataSources';
import { formatDate, PLATFORM_NAMES } from '../../lib/format';
import { haptic } from '../../lib/haptics';
import { pushPadHandler } from '../../lib/input';
import { ease, pick, spring } from '../../lib/motion';
import { moveFocus, type Dir } from '../../lib/spatial';
import { sound } from '../../lib/sound';
import { voiceOver } from '../../lib/voiceover';
import { useDiscoverImage } from '../../state/discover';
import { useReducedMotion, useStore } from '../../state/store';
import { DiscoverCover, pseudoGame } from '../../components/discover/DiscoverBits';
import { HeroTrailer } from '../../components/game/HeroTrailer';
import { StoreLogo } from '../../components/ui/StoreLogo';
import { ServiceLogo } from '../../components/ui/ServiceLogo';
import { PadGlyph, PadHint } from '../../components/ui/primitives';
import { pageSummary, type DiscoverItem } from './discoverRows';
import { storeText } from '../../lib/money'; // Track D6: in the display currency
import './immersive-discover.css';

const KEY_DIRS: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

type Load = { kind: 'loading' } | { kind: 'error'; code: string; message: string } | { kind: 'done'; d: DiscoverDetails };

/**
 * Track C6: the Immersive page for a game you don't own — hero art and its trailer (live-tile rules), price, time to
 * beat, rating, compatibility and where to get it. Store pages open in your browser after you confirm; nothing is
 * bought, installed or launched. Y watches it (or stops). LT/RT scroll, B goes back.
 */
export function DiscoverPage({
  item, watching, onWatch, onOpenGame, onClose,
}: {
  item: DiscoverItem;
  watching: boolean;
  onWatch: (on: boolean) => Promise<boolean | null>;
  onOpenGame: (game: Game) => void;
  onClose: () => void;
}) {
  const reduce = useReducedMotion();
  const present = useIsPresent();
  const cardRef = useRef<HTMLDivElement>(null);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<DiscoverLink | null>(null);
  const [pulse, setPulse] = useState(0);
  const seq = useRef(0);
  const offline = useStore((s) => !!s.settings?.['privacy.localOnly']);

  const fetchDetails = useCallback(async (refresh = false) => {
    const mine = ++seq.current;
    setLoad((l) => (l.kind === 'done' ? l : { kind: 'loading' }));
    try {
      const d = await call<DiscoverDetails>('discover.details', { key: item.key, refresh }, 60_000);
      if (mine === seq.current) setLoad({ kind: 'done', d });
    } catch (err) {
      if (mine === seq.current) setLoad({ kind: 'error', code: (err as { code?: string }).code ?? 'unavailable', message: errorMessage(err) });
    }
  }, [item.key]);
  useEffect(() => { void fetchDetails(); }, [fetchDetails, offline]);

  const d = load.kind === 'done' ? load.d : null;
  const owned = useStore((s) => (d?.libraryGameId ? s.gamesById.get(d.libraryGameId) ?? null : null));
  const title = d?.title ?? item.title;
  const logo = useDiscoverImage(d?.hasLogo ? item.key : null, 'logo');
  const trailerGame = useMemo(() => (d?.trailerId ? pseudoGame(d.trailerId, title, {}, d.genres) : null), [d?.trailerId, title, d?.genres]);
  const stores = d?.links.filter((l) => l.kind === 'store') ?? [];
  const info = d?.links.filter((l) => l.kind === 'info') ?? [];

  // Say what the page is about once its details arrive.
  const said = useRef(false);
  useEffect(() => {
    if (!d || said.current) return;
    said.current = true;
    voiceOver.say(pageSummary(d, watching), 'dialog');
  }, [d, watching]);

  // Keys belong to the page from the start (Escape, Y), even before its details arrive.
  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
  }, []);

  // Focus the first action once the page has its details (or its error).
  useEffect(() => {
    if (load.kind === 'loading') return;
    const t = window.setTimeout(() => {
      const card = cardRef.current;
      if (!card || (card.contains(document.activeElement) && document.activeElement !== card)) return;
      (card.querySelector<HTMLElement>('[data-autofocus]') ?? card.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
    }, 80);
    return () => window.clearTimeout(t);
  }, [load.kind]);

  const toggleWatch = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const next = !watching;
    const r = await onWatch(next);
    setBusy(false);
    if (r === null) {
      haptic('error');
      return;
    }
    haptic('confirm');
    sound.select();
    setPulse((p) => p + 1);
  }, [busy, watching, onWatch]);

  const close = useCallback(() => {
    sound.back();
    onClose();
  }, [onClose]);

  const scroll = (dir: 1 | -1) =>
    cardRef.current?.querySelector<HTMLElement>('.imm-page__body')?.scrollBy({ top: dir * innerHeight * 0.4, behavior: reduce ? 'auto' : 'smooth' });

  // The page owns the controller: Y watches, LT/RT scroll, B closes; A and the D-pad fall through to spatial
  // navigation inside the dialog; everything else is swallowed so it never reaches the rows underneath.
  const handleRef = useRef<(b: GamepadButton, repeat: boolean) => boolean>(() => true);
  useLayoutEffect(() => {
    handleRef.current = (button, repeat) => {
      if (!present || confirm) return confirm ? false : true;
      switch (button) {
        case 'Up': case 'Down': case 'Left': case 'Right': return false;
        case 'A': return repeat;
        case 'B': if (!repeat) close(); return true;
        case 'Y': if (!repeat) void toggleWatch(); return true;
        case 'LT': scroll(-1); return true;
        case 'RT': scroll(1); return true;
        default: return true;
      }
    };
  });
  useEffect(() => {
    if (!present) return;
    return pushPadHandler((b, r) => handleRef.current(b, r));
  }, [present]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!present || confirm) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      return close();
    }
    if (e.key === 'Tab') return trapTab(e, cardRef.current);
    if ((e.key === 'y' || e.key === 'Y') && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      if (!e.repeat) void toggleWatch();
      return;
    }
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      return scroll(e.key === 'PageDown' ? 1 : -1);
    }
    const dir = KEY_DIRS[e.key];
    if (dir) {
      e.preventDefault();
      if (!moveFocus(dir)) haptic('edge');
    }
  };

  // Focus goes back to the link that asked once the confirmation closes.
  const opener = useRef<HTMLElement | null>(null);
  const restore = () => window.setTimeout(() => opener.current?.isConnected && opener.current.focus({ preventScroll: true }), 30);
  const ask = (l: DiscoverLink) => {
    opener.current = document.activeElement as HTMLElement | null;
    sound.select();
    haptic('tick');
    setConfirm(l);
  };

  const ttb = d?.timeToBeat;
  const price = d?.price;
  const stats = d ? [
    {
      icon: <Tag size={18} />, label: 'Steam price',
      value: price?.free ? 'Free to play' : storeText(price?.formatted, price?.currency) ?? (price?.comingSoon ? 'Not out yet' : d.steamAppId ? 'Not sold alone' : 'Not on Steam'),
      hint: price?.discountPercent ? `−${price.discountPercent}% · was ${storeText(price.initial, price.currency)}` : null,
    },
    {
      icon: <Hourglass size={18} />, label: 'Time to beat',
      value: hoursLabel(ttb?.hastilySeconds) ?? hoursLabel(ttb?.normallySeconds) ?? '—',
      hint: ttb ? (ttb.completelySeconds ? `${hoursLabel(ttb.completelySeconds)} to finish everything` : 'IGDB estimate') : d.notes.includes('igdb:noKey') ? 'Connect IGDB to see it' : 'Not reported',
    },
    {
      icon: <Star size={18} />, label: d.metacritic != null ? 'Metacritic' : 'Rating',
      value: d.metacritic != null ? String(d.metacritic) : d.rating != null ? `${Math.round(d.rating)} / 100` : '—',
      hint: d.metacritic == null && d.rating != null ? `${d.ratingCount.toLocaleString()} ratings on IGDB` : null,
    },
    {
      icon: <CalendarDays size={18} />, label: d.releaseDate && new Date(d.releaseDate) > new Date() ? 'Coming' : 'Released',
      value: d.releaseDate ? formatDate(d.releaseDate) : d.year ? String(d.year) : 'Unknown',
      hint: null,
    },
  ] : [];

  return (
    <motion.div
      className="imm-panel imm-dpage"
      data-dialog-open={(present && !confirm) || undefined}
      inert={!present || undefined}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.2 } }}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <motion.div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${title}, not in your library`}
        className="imm-panel__card imm-dpage__card"
        tabIndex={-1}
        inert={confirm ? true : undefined}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 30, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.985, transition: { duration: 0.18, ease: ease.in } }}
        transition={pick(reduce, spring.hero)}
        onKeyDown={onKeyDown}
      >
        <div className="imm-panel__bg imm-dpage__bg" aria-hidden>
          <DiscoverCover itemKey={item.key} title={title} kind="hero" eager genres={d?.genres ?? item.genres} />
          {trailerGame && <HeroTrailer game={trailerGame} active={!confirm} />}
        </div>
        <div className="imm-panel__cover">
          <DiscoverCover itemKey={item.key} title={title} known={item.cover} eager genres={d?.genres ?? item.genres} />
        </div>
        <div className="imm-panel__body">
          <div className="imm-page__head">
            <span className="imm-dinfo__kicker">
              <Compass size="0.95em" aria-hidden /> Discover · {owned ? 'In your library' : 'Not in your library'}
            </span>
            {logo.url ? <img className="imm-panel__logo" src={logo.url} alt={title} /> : <h2 className="imm-panel__title">{title}</h2>}
            <div className="imm__meta">
              {(d?.year ?? item.year) && <span className="num">{d?.year ?? item.year}</span>}
              {d?.developers[0] && <span>{d.developers[0]}</span>}
              {(d?.stores ?? item.stores).length > 0 && (
                <span className="imm__meta-stores">
                  {(d?.stores ?? item.stores).slice(0, 4).map((p) => <span key={p} className="imm__store"><StoreLogo platform={p} size={20} decorative />{PLATFORM_NAMES[p]}</span>)}
                </span>
              )}
              {(d?.genres ?? item.genres).length > 0 && <span className="imm__genres">{(d?.genres ?? item.genres).slice(0, 3).join(' · ')}</span>}
            </div>
          </div>

          <div className="imm-page__body">
            {load.kind === 'loading' && (
              <div className="imm-dpage__loading" role="status" aria-label="Looking this game up">
                <div className="imm-panel__stats">{[0, 1, 2, 3].map((i) => <div key={i} className="imm-panel__stat imm-dpage__skeleton" />)}</div>
                <div className="imm-dpage__skeleton imm-dpage__skeleton--line" />
                <div className="imm-dpage__skeleton imm-dpage__skeleton--line" style={{ width: '70%' }} />
              </div>
            )}

            {load.kind === 'error' && (
              <div className="imm-dpage__error" role="alert">
                <p className="imm-page__note">
                  {load.code === 'offline' ? <CloudOff size="1.1em" aria-hidden /> : <AlertTriangle size="1.1em" aria-hidden />}
                  {load.code === 'offline' ? 'Offline mode is on, so VYSTRAL can’t look this game up. Pages you opened before still show what they knew.' : `This game couldn’t be looked up. ${load.message}`}
                </p>
                {item.price && <p className="imm-page__note"><Tag size="1.1em" aria-hidden /> {item.price}{item.cut ? ` · −${item.cut}%` : ''}{item.source === 'wishlist' ? ' on Steam, from your wishlist' : ''}</p>}
                <div className="imm-panel__actions">
                  {load.code !== 'offline' && (
                    <button className="imm-btn imm-btn--primary" data-autofocus onClick={() => void fetchDetails(true)}>
                      <RefreshCw size="1.05em" aria-hidden /> Try again
                    </button>
                  )}
                  <WatchButton watching={watching} busy={busy} pulse={pulse} reduce={reduce} onClick={() => void toggleWatch()} />
                  <button className="imm-btn imm-btn--ghost" onClick={close}><PadHint button="B">Back</PadHint></button>
                </div>
              </div>
            )}

            {d && (
              <div className="imm-dpage__content">
                <div className="imm-panel__stats">
                  {stats.map((s, i) => (
                    <motion.div
                      key={s.label}
                      className="imm-panel__stat"
                      initial={reduce ? false : { opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ ...spring.panel, delay: 0.06 + i * 0.04 }}
                    >
                      {s.icon}
                      <span className="imm-panel__stat-label">{s.label}</span>
                      <span className="imm-panel__stat-value">{s.value}</span>
                      {s.hint && <span className="imm-dpage__stat-hint">{s.hint}</span>}
                    </motion.div>
                  ))}
                </div>

                <div className="imm-panel__actions">
                  {owned && (
                    <button className="imm-btn imm-btn--primary" data-autofocus onClick={() => onOpenGame(owned)}>
                      <LibraryBig size="1.1em" aria-hidden /> Open in your library
                    </button>
                  )}
                  <WatchButton watching={watching} busy={busy} pulse={pulse} reduce={reduce} primary={!owned} onClick={() => void toggleWatch()} />
                  <button className="imm-btn imm-btn--ghost" onClick={close}><PadHint button="B">Back</PadHint></button>
                </div>

                <section className="imm-dpage__get" aria-labelledby="imm-dpage-get">
                  <h3 id="imm-dpage-get" className="imm-dpage__h">
                    <ShoppingBag size="1em" aria-hidden /> Where to get it
                    <span className="imm-dpage__h-note">Opens in your browser, after you confirm</span>
                  </h3>
                  {stores.length === 0 && <p className="imm-page__note">No official store page is known for this game yet.</p>}
                  <div className="imm-dpage__links">
                    {stores.map((l) => (
                      <button key={l.id} className="imm-btn imm-dpage__link" onClick={() => ask(l)} aria-label={`${l.label} store page. Opens in your browser after you confirm.`}>
                        {l.platform ? <StoreLogo platform={l.platform} size={22} decorative /> : <ShoppingBag size="1.1em" aria-hidden />}
                        {l.label}
                        <ExternalLink size="0.9em" aria-hidden className="imm-dpage__ext" />
                      </button>
                    ))}
                    {info.map((l) => (
                      <button key={l.id} className="imm-btn imm-btn--ghost imm-dpage__link imm-dpage__link--info" onClick={() => ask(l)} aria-label={`${l.label} page. Opens in your browser after you confirm.`}>
                        {l.id === 'igdb' || l.id === 'rawg' || l.id === 'wikidata' ? <ServiceLogo service={l.id} size={18} decorative /> : <ExternalLink size="1em" aria-hidden />}
                        {l.label}
                      </button>
                    ))}
                  </div>
                </section>

                {d.description && <p className="imm-panel__desc imm-dpage__desc">{d.description}</p>}

                {(d.deck || d.antiCheat || d.cloud.length > 0) && (
                  <div className="imm-dpage__chips" aria-label="Compatibility and cloud play">
                    {d.deck && <span className="imm-dpage__chip"><BadgeCheck size="1em" aria-hidden /> Steam Deck: {DECK_LABEL[d.deck.category]}</span>}
                    {d.antiCheat && (
                      <span className="imm-dpage__chip" data-warn={d.antiCheat.kernel || undefined}>
                        <ShieldAlert size="1em" aria-hidden /> {d.antiCheat.kernel ? `Kernel anti-cheat (${d.antiCheat.names[0] ?? 'unknown'})` : `Anti-cheat: ${d.antiCheat.names.join(', ')}`}
                      </span>
                    )}
                    {d.cloud.map((c) => <span key={c.service} className="imm-dpage__chip"><Cloud size="1em" aria-hidden /> On {c.serviceName}{c.match === 'title' ? ' (likely match)' : ''}</span>)}
                  </div>
                )}

                {d.reason === 'offline' && <p className="imm-page__note"><CloudOff size="1em" aria-hidden /> Offline mode is on: showing what VYSTRAL found earlier.</p>}
                <p className="imm-dpage__credits">
                  {d.credits.map((c) => c.note).join(' · ')}
                  {d.credits.length ? ' · ' : ''}VYSTRAL never buys, installs or launches anything from here.
                </p>
              </div>
            )}
          </div>

          <footer className="imm-page__hints" aria-hidden>
            <PadHint button="A">Select</PadHint>
            <PadHint button="Y">{watching ? 'Stop watching' : 'Watch'}</PadHint>
            <PadHint button={['LT', 'RT']}>Scroll</PadHint>
            <PadHint button="B">Back</PadHint>
          </footer>
        </div>
      </motion.div>

      <AnimatePresence>
        {confirm && (
          <OpenConfirm
            key={confirm.id}
            link={confirm}
            title={title}
            onCancel={() => {
              sound.back();
              setConfirm(null);
              restore();
            }}
            onOpen={() => {
              const l = confirm;
              setConfirm(null);
              restore();
              haptic('confirm');
              sound.select();
              void call('discover.openLink', { key: item.key, link: l.id })
                .then(() => voiceOver.say(`${l.label} opened in your browser`, 'notice'))
                .catch((err) => useStore.getState().toast({ tone: 'info', title: errorMessage(err) }));
            }}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function WatchButton({ watching, busy, pulse, reduce, primary, onClick }: { watching: boolean; busy: boolean; pulse: number; reduce: boolean; primary?: boolean; onClick: () => void }) {
  return (
    <button
      className={`imm-btn imm-dpage__watch ${primary ? 'imm-btn--primary' : ''}`}
      data-autofocus={primary || undefined}
      aria-pressed={watching}
      aria-busy={busy || undefined}
      onClick={onClick}
    >
      <motion.span
        key={pulse}
        className="imm-dpage__watch-icon"
        initial={reduce || pulse === 0 ? false : { scale: 0.4, rotate: -20 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={pick(reduce, spring.focus)}
      >
        {watching ? <Check size="1.1em" aria-hidden /> : <Eye size="1.1em" aria-hidden />}
      </motion.span>
      {watching ? 'Watching' : 'Watch'}
      <span className="imm-dpage__glyph" aria-hidden><PadGlyph button="Y" /></span>
    </button>
  );
}

/** Asks before anything leaves Immersive Mode: the store page opens in the browser on the desktop. */
function OpenConfirm({ link, title, onCancel, onOpen }: { link: DiscoverLink; title: string; onCancel: () => void; onOpen: () => void }) {
  const reduce = useReducedMotion();
  const present = useIsPresent();
  const ref = useRef<HTMLDivElement>(null);
  const handle = useRef<(b: GamepadButton, r: boolean) => boolean>(() => true);
  useLayoutEffect(() => {
    handle.current = (button, repeat) => {
      if (!present) return true;
      switch (button) {
        case 'Up': case 'Down': case 'Left': case 'Right': return false;
        case 'A': return repeat;
        case 'B': if (!repeat) onCancel(); return true;
        default: return true;
      }
    };
  });
  useEffect(() => {
    if (!present) return;
    return pushPadHandler((b, r) => handle.current(b, r));
  }, [present]);
  // Focus moves in at once, so an A pressed straight away confirms here and never reaches the page behind.
  useLayoutEffect(() => {
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
  }, []);
  const where = link.kind === 'store' ? `the ${link.label} store page` : `the ${link.label} page`;
  return (
    <motion.div
      ref={ref}
      className="imm-dconfirm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="imm-dconfirm-title"
      aria-describedby="imm-dconfirm-body"
      data-dialog-open={present || undefined}
      inert={!present || undefined}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.98, transition: { duration: 0.14, ease: ease.in } }}
      transition={pick(reduce, spring.panel)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        } else if (e.key === 'Tab') trapTab(e, ref.current);
        else if (KEY_DIRS[e.key]) {
          e.preventDefault();
          if (!moveFocus(KEY_DIRS[e.key])) haptic('edge');
        }
      }}
    >
      <span className="imm-dconfirm__icon" aria-hidden>{link.platform ? <StoreLogo platform={link.platform} size={30} decorative /> : <ExternalLink />}</span>
      <h2 id="imm-dconfirm-title" className="imm-dconfirm__title">Open {where}?</h2>
      <p id="imm-dconfirm-body" className="imm-dconfirm__body">
        {title} opens in your web browser on the desktop. Immersive Mode stays open behind it. Nothing is bought or installed.
      </p>
      <div className="imm-dconfirm__actions">
        <button className="imm-btn imm-btn--primary" data-autofocus onClick={onOpen}>
          <ExternalLink size="1em" aria-hidden /> Open in browser
        </button>
        <button className="imm-btn" onClick={onCancel}><PadHint button="B">Cancel</PadHint></button>
      </div>
    </motion.div>
  );
}

function trapTab(e: ReactKeyboardEvent, root: HTMLElement | null) {
  if (!root) return;
  const items = [...root.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), [tabindex="0"]')].filter((el) => !el.closest('[inert]'));
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
