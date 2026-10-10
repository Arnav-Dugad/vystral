import { useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CheckCheck, ChevronDown, Eye, EyeOff, FolderMinus, FolderPlus, Heart, HeartOff, CircleCheck, CircleDashed, ExternalLink, X, Flag } from 'lucide-react';
import type { Game, LibrarySnapshot } from '../../bridge/types';
import { STATUSES } from '../../lib/status';
import { plural } from '../../lib/format';
import { exit, pick, spring } from '../../lib/motion';
import { MAX_STORE_PAGES, summarize } from '../../lib/selection';
import type { BulkAction } from '../../lib/bulk';
import { openInStores, runBulk } from '../../state/bulkActions';
import { useReducedMotion } from '../../state/store';
import { Menu, type MenuEntry } from '../ui/Menu';
import './bulk-bar.css';

/**
 * Track D1: the floating action bar for Library multi-select. Rises from the bottom edge with the count; every
 * action applies to all selected games at once and one Undo (on the toast) puts them all back.
 */
export function BulkBar({
  ids, games, shown, collections, collectionId, onSelectAll, onClear,
}: {
  /** Selected games, in display order. */
  ids: string[];
  games: Game[];
  /** How many games the current filter shows (for "Select all"). */
  shown: number;
  collections: LibrarySnapshot['collections'];
  /** The collection being viewed, if any (offered first for "Remove from"). */
  collectionId?: string;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const reduce = useReducedMotion();
  const [menu, setMenu] = useState<{ kind: 'status' | 'collection'; at: { x: number; y: number } } | null>(null);
  const [busy, setBusy] = useState(false);
  const s = useMemo(() => summarize(games), [games]);
  const manual = collections.filter((c) => !c.rule);
  const open = ids.length > 0;

  const run = async (action: BulkAction, collectionName?: string) => {
    setBusy(true);
    try {
      await runBulk(ids, action, { collectionName });
    } finally {
      setBusy(false);
    }
  };
  const openMenu = (kind: 'status' | 'collection') => (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ kind, at: { x: r.left, y: r.top - 8 - (kind === 'status' ? 280 : Math.min(320, 64 + manual.length * 36 * 2)) } });
  };

  const statusEntries: MenuEntry[] = [
    { kind: 'label', label: `Set status for ${plural(ids.length, 'game')}` },
    ...STATUSES.map((st): MenuEntry => {
      const Icon = st.icon;
      return { label: st.label, icon: <span className="status-mark__icon" style={{ ['--st' as string]: st.color }}><Icon size={14} /></span>, onSelect: () => void run({ kind: 'status', status: st.value }), hint: s.status === st.value ? 'All' : undefined };
    }),
    { kind: 'separator' },
    { label: 'Clear status', icon: <CircleDashed size={14} />, onSelect: () => void run({ kind: 'status', status: null }), disabled: s.status === null },
  ];
  const collectionEntries: MenuEntry[] = manual.length === 0
    ? [{ kind: 'label', label: 'No collections yet' }, { label: 'Create one from a game’s right-click menu', disabled: true, onSelect: () => {} }]
    : [
        { kind: 'label', label: 'Add to' },
        ...manual.map((c): MenuEntry => {
          const all = games.every((g) => g.collections.includes(c.id));
          return { label: c.name, icon: <FolderPlus size={14} />, disabled: all, hint: all ? 'All in it' : undefined, onSelect: () => void run({ kind: 'collection', collectionId: c.id, value: true }, c.name) };
        }),
        ...(() => {
          const removable = [...manual].sort((a, b) => Number(b.id === collectionId) - Number(a.id === collectionId)).filter((c) => games.some((g) => g.collections.includes(c.id)));
          return removable.length
            ? [{ kind: 'separator' } as MenuEntry, { kind: 'label', label: 'Remove from' } as MenuEntry,
                ...removable.map((c): MenuEntry => ({ label: c.name, icon: <FolderMinus size={14} />, onSelect: () => void run({ kind: 'collection', collectionId: c.id, value: false }, c.name) }))]
            : [];
        })(),
      ];

  const tooMany = s.withStore > MAX_STORE_PAGES;
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="bulk-bar"
          role="toolbar"
          aria-label={`Actions for ${plural(ids.length, 'selected game')}`}
          data-busy={busy || undefined}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 48, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduce ? { opacity: 0, transition: exit } : { opacity: 0, y: 32, transition: exit }}
          transition={pick(reduce, spring.panel)}
        >
          <div className="bulk-bar__count" aria-hidden>
            <motion.span key={ids.length} className="bulk-bar__num num" initial={reduce ? false : { y: 8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={pick(reduce, spring.micro)}>
              {ids.length.toLocaleString()}
            </motion.span>
            <span className="bulk-bar__label">selected</span>
          </div>
          <span className="visually-hidden" aria-live="polite">{plural(ids.length, 'game')} selected</span>
          <span className="bulk-bar__sep" aria-hidden />
          <Act icon={<Flag size={15} />} onClick={openMenu('status')} hasMenu disabled={busy}>Status</Act>
          <Act icon={<FolderPlus size={15} />} onClick={openMenu('collection')} hasMenu disabled={busy}>Collection</Act>
          <Act icon={s.allFavorite ? <HeartOff size={15} /> : <Heart size={15} />} onClick={() => void run({ kind: 'favorite', value: !s.allFavorite })} disabled={busy}>
            {s.allFavorite ? 'Unfavorite' : 'Favorite'}
          </Act>
          <Act icon={s.allHidden ? <Eye size={15} /> : <EyeOff size={15} />} onClick={() => void run({ kind: 'hidden', value: !s.allHidden })} disabled={busy}>
            {s.allHidden ? 'Unhide' : 'Hide'}
          </Act>
          <Act
            icon={<CircleCheck size={15} />}
            onClick={() => void run({ kind: 'played', value: !s.allMarkedPlayed })}
            disabled={busy}
            title={s.allMarkedPlayed ? 'Clear the “played elsewhere” mark' : 'You played these somewhere VYSTRAL can’t see. They leave “Never played”; no playtime is added.'}
          >
            {s.allMarkedPlayed ? 'Unmark played' : 'Mark played'}
          </Act>
          <Act
            icon={<ExternalLink size={15} />}
            onClick={() => void openInStores(ids)}
            disabled={busy || s.withStore === 0 || tooMany}
            title={tooMany ? `Select ${MAX_STORE_PAGES} or fewer games to open their store pages` : s.withStore === 0 ? 'These are games you added yourself' : undefined}
          >
            Open in store
          </Act>
          <span className="bulk-bar__sep" aria-hidden />
          {ids.length < shown && (
            <Act icon={<CheckCheck size={15} />} onClick={onSelectAll} quiet>
              Select all {shown.toLocaleString()}
            </Act>
          )}
          <button type="button" className="bulk-bar__close" onClick={onClear} aria-label="Clear selection" title="Clear selection (Esc)">
            <X size={16} />
          </button>
          <Menu at={menu?.kind === 'status' ? menu.at : null} entries={statusEntries} onClose={() => setMenu(null)} label="Set status" />
          <Menu at={menu?.kind === 'collection' ? menu.at : null} entries={collectionEntries} onClose={() => setMenu(null)} label="Add to or remove from a collection" />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Act({ icon, children, onClick, disabled, hasMenu, quiet, title }: { icon: ReactNode; children: ReactNode; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; hasMenu?: boolean; quiet?: boolean; title?: string }) {
  return (
    <button type="button" className="bulk-bar__act" data-quiet={quiet || undefined} onClick={onClick} disabled={disabled} aria-haspopup={hasMenu ? 'menu' : undefined} title={title}>
      <span className="bulk-bar__icon" aria-hidden>{icon}</span>
      <span>{children}</span>
      {hasMenu && <ChevronDown size={13} aria-hidden className="bulk-bar__chev" />}
    </button>
  );
}
