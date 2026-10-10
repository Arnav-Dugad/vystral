import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Hash, Search, X } from 'lucide-react';
import type { LibraryTags } from '../../bridge/types';
import '../game/insights/insights.css';

/**
 * Track C4: filter the Library by Steam community tags. A "Tags" chip opens a searchable, multi-select list (most
 * common in your library first, with counts); chosen tags show as removable chips. Games must have every chosen tag.
 */
export function TagFilter({ data, selected, onChange }: { data: LibraryTags | null; selected: number[]; onChange: (ids: number[]) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const tags = data?.tags ?? [];
  const names = useMemo(() => new Map(tags.map((t) => [t.id, t.name])), [tags]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (needle ? tags.filter((t) => t.name.toLowerCase().includes(needle)) : tags).slice(0, 80);
  }, [tags, q]);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [open]);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, id]);

  if (!data || data.status === 'off' || (!tags.length && !data.refreshing && !selected.length)) return null;

  const toggle = (tagId: number) => onChange(selected.includes(tagId) ? selected.filter((x) => x !== tagId) : [...selected, tagId].slice(0, 8));
  const close = () => { setOpen(false); setQ(''); button.current?.focus(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(list.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter' && list[active]) { e.preventDefault(); toggle(list[active].id); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  };

  return (
    <div className="lib-tags" ref={root}>
      <span className="lib-tagpick">
        <button ref={button} className="chip" aria-haspopup="dialog" aria-expanded={open} aria-pressed={selected.length > 0} onClick={() => (open ? close() : setOpen(true))}>
          <Hash size={13} aria-hidden /> Tags{selected.length ? ` · ${selected.length}` : ''}
        </button>
        {open && (
          <div className="lib-tagpick__panel" role="dialog" aria-label="Filter by community tags">
            <label className="lib-search" style={{ height: 34 }}>
              <Search size={14} aria-hidden />
              <input
                ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Find a tag…" spellCheck={false}
                role="combobox" aria-expanded aria-controls={`${id}-list`} aria-activedescendant={list[active] ? `${id}-opt-${active}` : undefined} aria-label="Find a tag"
              />
            </label>
            <ul className="lib-tagpick__list" id={`${id}-list`} role="listbox" aria-multiselectable aria-label="Community tags">
              {list.map((t, i) => (
                <li key={t.id} role="presentation">
                  <button id={`${id}-opt-${i}`} role="option" tabIndex={-1} aria-selected={selected.includes(t.id)} className="lib-tagpick__opt" data-active={i === active || undefined}
                    onMouseEnter={() => setActive(i)} onClick={() => toggle(t.id)}>
                    <span className="lib-tagpick__check" aria-hidden>{selected.includes(t.id) && <Check size={13} />}</span>
                    {t.name}
                    <span className="num" aria-label={`${t.count} ${t.count === 1 ? 'game' : 'games'}`}>{t.count}</span>
                  </button>
                </li>
              ))}
              {!list.length && <li className="lib-tagpick__foot" role="presentation">{data.refreshing ? 'Tags are still being looked up…' : 'No tag by that name in your library.'}</li>}
            </ul>
            <p className="lib-tagpick__foot">
              Community tags from Steam players · {data.covered} of {data.steamGames} Steam {data.steamGames === 1 ? 'game' : 'games'} tagged{data.refreshing ? ' · looking up more…' : ''}. Games from other stores have no Steam tags.
            </p>
          </div>
        )}
      </span>
      {selected.map((tagId) => (
        <button key={tagId} className="chip" aria-pressed onClick={() => toggle(tagId)} aria-label={`Remove tag filter ${names.get(tagId) ?? tagId}`}>
          {names.get(tagId) ?? `Tag ${tagId}`} <X size={12} aria-hidden />
        </button>
      ))}
    </div>
  );
}
