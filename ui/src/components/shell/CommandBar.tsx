import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  BarChart3, BookOpen, Bot, CornerDownLeft, FilePlus2, Gamepad2, Home, Images, LibraryBig, Moon, Play, RefreshCw,
  Search, Settings2, Sparkles, Wand2, ArrowDownToLine,
} from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { AiQuery, Game } from '../../bridge/types';
import { formatRelative, isInstalled, lastPlayed, PLATFORM_NAMES } from '../../lib/format';
import { exit, pick, spring } from '../../lib/motion';
import { fromAiQuery, parseQuery, searchGames, type ParsedQuery } from '../../lib/search';
import { addManualGame } from '../../state/actions';
import { useReducedMotion, useStore } from '../../state/store';
import { GameCover } from '../game/GameCover';
import { Badge, Kbd } from '../ui/primitives';
import { StoreLogos } from '../ui/StoreLogo';
import { openUpdateCenter } from './UpdateCenter';

interface Item {
  id: string;
  group: 'Games' | 'Actions' | 'Go to' | 'Local AI';
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

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    setSel(0);
    setAiQuery(null);
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
    })),
    ...(settings?.['ai.enabled'] && q.split(/\s+/).length >= 3 && !aiQuery
      ? [{
          id: 'ai', group: 'Local AI' as const, label: aiBusy ? 'Asking your local model…' : `Interpret “${text.trim()}” with local AI`,
          icon: <Wand2 size={16} />,
          run: async () => {
            setAiBusy(true);
            try {
              const r = await call<AiQuery | null>('ai.parseQuery', { query: text.trim() }, 30_000);
              if (r) setAiQuery(fromAiQuery(r));
              else toast({ tone: 'info', title: 'The local model couldn’t interpret that', body: 'Showing regular search results instead.' });
            } catch (err) {
              toast({ tone: 'warning', title: 'Local AI unavailable', body: errorMessage(err) });
            } finally {
              setAiBusy(false);
            }
          },
        }]
      : []),
    ...actions.filter((a) => matchText(String(a.label))),
    ...pages.filter((p) => matchText(String(p.label))),
  ];

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); items[sel]?.run(); }
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
              {header && <div className="cmd__group caps">{header === 'Games' && !text.trim() ? 'Recently played' : header}</div>}
              <button
                id={`cmd-${item.id}`}
                data-index={i}
                role="option"
                aria-selected={i === sel}
                className="cmd__item"
                onMouseEnter={() => setSel(i)}
                onClick={() => item.run()}
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
        <span style={{ marginLeft: 'auto' }}>Searches run on this PC{settings?.['ai.enabled'] ? ' · local AI available' : ''}</span>
      </div>
    </>
  );
}

function gameItem(g: Game, launch: boolean, run: () => void): Item {
  const lp = lastPlayed(g);
  const installed = isInstalled(g);
  return {
    id: g.id,
    group: 'Games',
    label: launch ? <>Launch <strong>{g.title}</strong></> : g.title,
    meta: (
      <>
        <StoreLogos platforms={g.installations.map((i) => i.platform)} size={14} decorative />{' '}
        {[...new Set(g.installations.map((i) => PLATFORM_NAMES[i.platform]))].join(' · ')}
        {lp.at ? ` · played ${formatRelative(lp.at)}` : ''}
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
