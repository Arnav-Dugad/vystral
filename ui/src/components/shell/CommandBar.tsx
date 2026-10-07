import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  BarChart3, BookOpen, Bot, CornerDownLeft, FilePlus2, Gamepad2, Home, Images, LibraryBig, Moon, Play, RefreshCw,
  Search, Settings2, Sparkles, Wand2, ArrowDownToLine, HeartPulse, Compass, Check, CloudOff,
} from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { AiQuery, DiscoverResult, DiscoverSearch, Game } from '../../bridge/types';
import { formatRelative, isInstalled, lastPlayed, PLATFORM_NAMES } from '../../lib/format';
import { exit, pick, spring } from '../../lib/motion';
import { fromAiQuery, parseQuery, searchGames, type ParsedQuery } from '../../lib/search';
import { addManualGame } from '../../state/actions';
import { useReducedMotion, useStore } from '../../state/store';
import { GameCover } from '../game/GameCover';
import { Badge, Kbd } from '../ui/primitives';
import { StoreLogos } from '../ui/StoreLogo';
import { openUpdateCenter } from './UpdateCenter';
import { cleanQuery, splitByLibrary, SOURCE_NAMES } from '../../lib/discover';
import { useDiscoverSearch } from '../../state/discover';
import { DiscoverCover, Highlight, listWords, openResult, SourceMarks } from '../discover/DiscoverBits';
import '../discover/discover.css';

interface Item {
  id: string;
  /** Track U: 'Not in your library' holds results from Steam, IGDB, RAWG and Wikidata. */
  group: 'Games' | 'Not in your library' | 'Actions' | 'Go to' | 'Local AI';
  label: ReactNode;
  meta?: ReactNode;
  icon: ReactNode;
  run: () => void;
  hint?: string;
}

export function CommandBar() {
  const open = useStore((s) => s.commandOpen);
  const setOpen = useStore((s) => s.setCommandOpen);
  const reduce = useReducedMotion();
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="cmd-backdrop"
          data-dialog-open
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: exit }}
          transition={pick(reduce, spring.effect)}
          onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command bar"
            className="cmd"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.985, transition: exit }}
            transition={pick(reduce, spring.panel)}
          >
            <CommandBody onClose={() => setOpen(false)} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function CommandBody({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [sel, setSel] = useState(0);
  const [aiQuery, setAiQuery] = useState<ParsedQuery | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const games = useStore((s) => s.library.games);
  const drives = useStore((s) => s.drives);
  const navigate = useStore((s) => s.navigate);
  const launchGame = useStore((s) => s.launchGame);
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const setMode = useStore((s) => s.setMode);
  const scanLibrary = useStore((s) => s.scanLibrary);
  const toast = useStore((s) => s.toast);
  const genres = useMemo(() => [...new Set(games.flatMap((g) => g.genres))], [games]);
  // Bumped whenever the text changes or the bar closes, so a late ai.parseQuery answer is dropped.
  const aiSeq = useRef(0);
  // Guards against Enter/click running the same command twice before the bar has closed.
  const running = useRef(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    // Escape anywhere (including controller B, which dispatches Escape on window) closes the bar.
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Something layered over the bar (the on-screen keyboard) closes first.
      if (document.querySelector('[data-dialog-open]:not(.cmd-backdrop):not(.launch-pill)')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onEscape, true);
    return () => {
      window.removeEventListener('keydown', onEscape, true);
      aiSeq.current++;
      // Give focus back to where it was, unless the command moved it somewhere on purpose.
      if (previous?.isConnected && (document.activeElement === document.body || document.activeElement == null || inputRef.current === document.activeElement)) previous.focus?.();
    };
  }, []);
  useEffect(() => {
    aiSeq.current++;
    setSel(0);
    setAiQuery(null);
    setAiBusy(false);
  }, [text]);

  const parsed = useMemo(() => aiQuery ?? parseQuery(text, { genres, drives }), [aiQuery, text, genres, drives]);

  const results = useMemo(() => {
    if (!text.trim()) {
      // Empty query: recently played first.
      return [...games]
        .filter((g) => !g.hidden)
        .sort((a, b) => (lastPlayed(b).at ?? '').localeCompare(lastPlayed(a).at ?? ''))
        .slice(0, 6);
    }
    let found = searchGames(games, parsed);
    // If interpreting words as filters removed everything, fall back to plain title search
    // (a game called "Night Racing" should still be findable by typing "racing").
    if (found.length === 0 && parsed.chips.length > 0 && !aiQuery) {
      found = searchGames(games, { intent: parsed.intent, text: text.replace(/^(launch|play|start|run|open)\s+/i, ''), filters: {}, chips: [], structured: false });
    }
    return found.slice(0, parsed.structured ? 40 : 8);
  }, [games, parsed, text, aiQuery]);

  // Track U: plain title searches also ask the connected sources for games that aren't in the library.
  const remoteText = parsed.text || text.trim();
  const remoteEligible = !!cleanQuery(text) && !aiQuery && parsed.intent !== 'launch' && parsed.chips.length === 0;
  const online = useDiscoverSearch(remoteText, 'bar', { enabled: remoteEligible, debounceMs: 300 });
  const shownIds = useMemo(() => new Set(results.map((g) => g.id)), [results]);
  const remote = useMemo(
    () => (remoteEligible && online.search ? splitByLibrary(online.search.results, shownIds) : { owned: [], rest: [] }),
    [remoteEligible, online.search, shownIds],
  );
  const searchingOnline = remoteEligible && !settings?.['privacy.localOnly'] && (settings?.['discover.searchOnline'] ?? true);
  const askedSources = (online.search?.sources ?? []).filter((s) => s.state !== 'skipped').map((s) => s.id);

  const go = (r: Parameters<typeof navigate>[0]) => () => {
    navigate(r);
    onClose();
  };

  const actions: Item[] = [
    { id: 'a-scan', group: 'Actions', label: 'Rescan installed games', icon: <RefreshCw size={16} />, run: () => { void scanLibrary(); onClose(); } },
    { id: 'a-add', group: 'Actions', label: 'Add a game or program…', icon: <FilePlus2 size={16} />, run: () => { onClose(); void addManualGame(); } },
    { id: 'a-imm', group: 'Actions', label: 'Switch to Immersive Mode', icon: <Gamepad2 size={16} />, hint: 'F11', run: () => { onClose(); void setMode('immersive'); } },
    {
      id: 'a-theme', group: 'Actions', label: `Theme: switch to ${settings?.['appearance.theme'] === 'light' ? 'Obsidian' : 'Light'}`, icon: <Moon size={16} />,
      run: () => void setSetting('appearance.theme', settings?.['appearance.theme'] === 'light' ? 'obsidian' : 'light'),
    },
    { id: 'a-upd', group: 'Actions', label: 'Check for updates', icon: <ArrowDownToLine size={16} />, run: () => { onClose(); openUpdateCenter(); } },
    // Track Q: the library health check (broken shortcuts, missing drives, duplicates, art…).
    { id: 'a-health', group: 'Actions', label: 'Check library health (fix broken games, art, duplicates)', icon: <HeartPulse size={16} />, run: go({ name: 'health' }) },
  ];
  const pages: Item[] = [
    { id: 'p-home', group: 'Go to', label: 'Home', icon: <Home size={16} />, run: go({ name: 'home' }) },
    { id: 'p-lib', group: 'Go to', label: 'Library', icon: <LibraryBig size={16} />, run: go({ name: 'library' }) },
    { id: 'p-jr', group: 'Go to', label: 'Journal', icon: <BookOpen size={16} />, run: go({ name: 'journal' }) },
    { id: 'p-perf', group: 'Go to', label: 'Performance', icon: <BarChart3 size={16} />, run: go({ name: 'performance' }) },
    { id: 'p-mom', group: 'Go to', label: 'Moments', icon: <Images size={16} />, run: go({ name: 'moments' }) },
    { id: 'p-con', group: 'Go to', label: 'Constellation', icon: <Sparkles size={16} />, run: go({ name: 'constellation' }) },
    { id: 'p-ai', group: 'Go to', label: 'Assistant', icon: <Bot size={16} />, run: go({ name: 'assistant' }) },
    { id: 'p-set', group: 'Go to', label: 'Settings', icon: <Settings2 size={16} />, hint: 'Ctrl ,', run: go({ name: 'settings' }) },
  ];

  const q = text.trim().toLowerCase();
  const matchText = (s: string) => !q || s.toLowerCase().includes(q.replace(/^(go to|open)\s+/, ''));

  const items: Item[] = [
    ...results.map<Item>((g) => gameItem(g, parsed.intent === 'launch', () => {
      onClose();
      if (parsed.intent === 'launch') void launchGame(g.id);
      else navigate({ name: 'game', id: g.id });
    }, parsed.intent === 'launch' ? null : parsed.text)),
    ...(remoteEligible
      ? [
          ...remote.owned.slice(0, 2).map((r) => discoverItem(r, remoteText, 'Games', onClose)),
          ...remote.rest.slice(0, 6).map((r) => discoverItem(r, remoteText, 'Not in your library', onClose)),
          {
            id: 'discover-all', group: 'Not in your library' as const,
            label: <>Search everywhere for “{text.trim()}”</>,
            meta: everywhereMeta(online.search, online.busy, !!settings?.['privacy.localOnly'], settings?.['discover.searchOnline'] ?? true),
            icon: <span className="cmd__icon"><Compass size={16} /></span>,
            run: go({ name: 'discover', query: text.trim() }),
          },
        ]
      : []),
    ...(settings?.['ai.enabled'] && q.split(/\s+/).length >= 3 && !aiQuery
      ? [{
          id: 'ai', group: 'Local AI' as const, label: aiBusy ? 'Asking your local model…' : `Interpret “${text.trim()}” with local AI`,
          icon: <Wand2 size={16} />,
          run: async () => {
            if (aiBusy) return;
            const seq = ++aiSeq.current;
            setAiBusy(true);
            try {
              const r = await call<AiQuery | null>('ai.parseQuery', { query: text.trim() }, 30_000);
              if (seq !== aiSeq.current) return; // the text changed or the bar closed meanwhile
              if (r) {
                setAiQuery(fromAiQuery(r));
                setSel(0);
              } else toast({ tone: 'info', title: 'The local model couldn’t interpret that', body: 'Showing regular search results instead.' });
            } catch (err) {
              if (seq === aiSeq.current) toast({ tone: 'warning', title: 'Local AI unavailable', body: errorMessage(err) });
            } finally {
              if (seq === aiSeq.current) setAiBusy(false);
            }
          },
        }]
      : []),
    ...actions.filter((a) => matchText(String(a.label))),
    ...pages.filter((p) => matchText(String(p.label))),
  ];

  const runItem = (item: Item | undefined) => {
    if (!item || running.current) return;
    running.current = true;
    item.run();
    // Commands that keep the bar open (theme, local AI) can run again after a beat.
    window.setTimeout(() => { running.current = false; }, 400);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (!e.repeat) runItem(items[Math.min(sel, items.length - 1)]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  let lastGroup = '';
  return (
    <>
      <div className="cmd__input-row">
        <Search size={20} aria-hidden style={{ color: 'var(--text-3)' }} />
        <input
          ref={inputRef}
          className="cmd__input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder="Try “installed racing under 20 GB” or “launch …”"
          aria-label="Search"
          data-osk-predict="games"
          aria-controls="cmd-list"
          aria-activedescendant={items[sel] ? `cmd-${items[sel].id}` : undefined}
          role="combobox"
          aria-expanded
          spellCheck={false}
        />
      </div>
      {parsed.chips.length > 0 && (
        <div className="cmd__chips" aria-label="How your search was understood">
          {parsed.intent === 'launch' && <Badge tone="accent" icon={<Play size={12} />}>Launch</Badge>}
          {parsed.chips.map((c) => <Badge key={c}>{c}</Badge>)}
          {parsed.text && <Badge>Title: “{parsed.text}”</Badge>}
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-3)', alignSelf: 'center' }}>{results.length} {results.length === 1 ? 'match' : 'matches'}</span>
        </div>
      )}
      <div className="cmd__list" id="cmd-list" role="listbox" ref={listRef} aria-label="Results">
        {items.length === 0 && <div className="cmd__empty">Nothing matches “{text}”. Try a shorter title, or a filter like “installed” or “steam”.</div>}
        {items.map((item, i) => {
          const header = item.group !== lastGroup ? item.group : null;
          lastGroup = item.group;
          return (
            <div key={item.id}>
              {header && <div className="cmd__group caps">{header === 'Games' ? (text.trim() ? 'In your library' : 'Recently played') : header}</div>}
              {item.id === 'discover-all' && online.busy && remote.rest.length === 0 && searchingOnline && (
                <div className="cmd__skeletons" aria-hidden>
                  {[0, 1].map((n) => (
                    <div key={n} className="cmd__item cmd__item--skeleton">
                      <span className="cmd__thumb skeleton" />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="skeleton" style={{ height: 12, width: n ? '42%' : '58%' }} />
                        <div className="skeleton" style={{ height: 10, width: n ? '26%' : '34%', marginTop: 6 }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <button
                id={`cmd-${item.id}`}
                data-index={i}
                role="option"
                aria-selected={i === sel}
                className="cmd__item"
                onMouseEnter={() => setSel(i)}
                onClick={() => runItem(item)}
              >
                {item.icon}
                <div style={{ minWidth: 0 }}>
                  <div className="truncate">{item.label}</div>
                  {item.meta && <div className="cmd__meta truncate">{item.meta}</div>}
                </div>
                <span className="cmd__hint">
                  {item.hint && <Kbd>{item.hint}</Kbd>}
                  {i === sel && <CornerDownLeft size={14} aria-hidden />}
                </span>
              </button>
            </div>
          );
        })}
      </div>
      <div className="cmd__footer">
        <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> to move</span>
        <span><Kbd>Enter</Kbd> to open</span>
        <span><Kbd>Esc</Kbd> to close</span>
        <span style={{ marginLeft: 'auto' }}>
          {searchingOnline && askedSources.length > 0
            ? <span title={`Your library is searched on this PC; also asking ${listWords(askedSources.map((s) => SOURCE_NAMES[s]))}`}>Also asking <SourceMarks sources={askedSources} size={12} label={false} /><span className="visually-hidden"> {listWords(askedSources.map((s) => SOURCE_NAMES[s]))}</span></span>
            : 'Searches run on this PC'}
          {settings?.['ai.enabled'] ? ' · local AI available' : ''}
        </span>
      </div>
    </>
  );
}

function gameItem(g: Game, launch: boolean, run: () => void, query?: string | null): Item {
  const lp = lastPlayed(g);
  const installed = isInstalled(g);
  return {
    id: g.id,
    group: 'Games',
    label: launch ? <>Launch <strong>{g.title}</strong></> : query ? <Highlight text={g.title} query={query} /> : g.title,
    meta: (
      <>
        <StoreLogos platforms={g.installations.map((i) => i.platform)} size={14} decorative />{' '}
        {[...new Set(g.installations.map((i) => PLATFORM_NAMES[i.platform]))].join(' · ')}
        {lp.at ? ` · played ${formatRelative(lp.at).toLowerCase()}` : ''}
        {!installed ? ' · not installed' : ''}
      </>
    ),
    icon: (
      <span className="cmd__thumb">
        <GameCover game={g} />
      </span>
    ),
    run,
  };
}

/** Track U: a game from Steam, IGDB, RAWG or Wikidata. Opens its page (or, for a library match, the game's own page). */
function discoverItem(r: DiscoverResult, query: string, group: Item['group'], close: () => void): Item {
  const id = `d-${r.key}`;
  return {
    id,
    group,
    label: <Highlight text={r.title} query={query} />,
    meta: (
      <>
        {r.libraryGameId && <span className="cmd__owned"><Check size={11} aria-hidden /> In your library · </span>}
        {r.year ?? 'Year unknown'}
        {r.stores.length > 0 && <> · <StoreLogos platforms={r.stores} size={14} decorative /> {[...new Set(r.stores.map((p) => PLATFORM_NAMES[p]))].join(' · ')}</>}
        {r.kind === 'extra' && ' · add-on'}
        <SourceMarks sources={r.sources} size={12} />
      </>
    ),
    icon: (
      <span className="cmd__thumb">
        <DiscoverCover itemKey={r.key} title={r.title} known={r.cover} genres={r.genres} />
      </span>
    ),
    run: () => {
      const thumb = document.getElementById(`cmd-${id}`)?.querySelector('.cmd__thumb');
      openResult(r, thumb);
      close();
    },
  };
}

/** What the "Search everywhere" row says about the online search right now. */
function everywhereMeta(search: DiscoverSearch | null, busy: boolean, offline: boolean, searchOnline: boolean) {
  if (offline) return <><CloudOff size={11} aria-hidden /> Offline mode is on, so only your library is searched</>;
  if (!searchOnline) return 'Searching stores and game databases is off · open Discover to turn it on';
  const asked = (search?.sources ?? []).filter((s) => s.state !== 'skipped');
  if (busy) return asked.length ? `Asking ${listWords(asked.map((s) => s.name))}…` : 'Searching…';
  const found = search?.results.filter((r) => !r.libraryGameId).length ?? 0;
  return found ? 'Filters, more results and every source on the Discover page' : `Nothing else found on ${listWords(asked.map((s) => s.name)) || 'the connected sources'} · try other words`;
}
