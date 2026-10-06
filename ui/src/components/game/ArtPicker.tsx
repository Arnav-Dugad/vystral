import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { Check, CloudOff, ExternalLink, Images, RotateCcw, Search, Settings2, Sparkles, Wand2 } from 'lucide-react';
import { call, errorMessage, on, BridgeError } from '../../bridge/bridge';
import type { ArtOption, ArtOptions, Game, PickerKind, UserArt } from '../../bridge/types';
import { gridMove, PICKER_SLOTS, STYLE_LABEL } from '../../lib/dataSources';
import { presetForStyle } from '../../lib/artPacks';
import { ArtPacksDialog, type ArtPacksInitial } from '../artpacks/ArtPacksDialog';
import { useReducedMotion, useStore } from '../../state/store';
import { Button } from '../ui/primitives';
import { Dialog } from '../ui/Dialog';
import './art-picker.css';

/** User-chosen art for a game (refreshed whenever the library changes). */
export function useUserArt(gameId: string): UserArt[] {
  const [list, setList] = useState<UserArt[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => call<UserArt[]>('art.userArt', { gameId }).then((l) => alive && setList(l)).catch(() => alive && setList([]));
    void load();
    const off = on('library.changed', () => void load());
    return () => { alive = false; off(); };
  }, [gameId]);
  return list;
}

/** "Browse SteamGridDB…" and "Reset to default" for one artwork slot, plus the credit line for picked art. */
export function ArtSlotActions({ game, kind, userArt }: { game: Game; kind: PickerKind; userArt: UserArt[] }) {
  const [open, setOpen] = useState(false);
  const [packs, setPacks] = useState<ArtPacksInitial | null>(null);
  const [resetting, setResetting] = useState(false);
  const toast = useStore((s) => s.toast);
  const refresh = useStore((s) => s.refreshLibrary);
  const mine = userArt.find((u) => u.kind === kind);
  const close = useCallback(() => setOpen(false), []);

  const reset = async () => {
    setResetting(true);
    try {
      if (await call<boolean>('art.reset', { gameId: game.id, kind }, 120_000)) {
        await refresh();
        toast({ tone: 'success', title: 'Back to the default artwork', body: 'Store artwork returns as soon as the store has it.' });
      }
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t reset the artwork', body: errorMessage(err) });
    } finally {
      setResetting(false);
    }
  };

  return (
    <>
      <div className="art-slot__extra">
        <Button size="sm" variant="ghost" icon={<Images size={14} />} onClick={() => setOpen(true)}>Browse SteamGridDB…</Button>
        {mine && <Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} loading={resetting} onClick={() => void reset()}>Reset to default</Button>}
      </div>
      {mine && (
        <p className="art-slot__credit">
          {mine.source === 'artpack' ? (
            <>From the {mine.pack ?? 'art'} pack · SteamGridDB{mine.author ? <> art by <span className="selectable">{mine.author}</span></> : null}. Scans never replace it.</>
          ) : (
            <>Your choice{mine.source === 'steamgriddb' ? <> · from SteamGridDB{mine.author ? <> by <span className="selectable">{mine.author}</span></> : null}</> : ' · from a file'}. Scans never replace it.</>
          )}
        </p>
      )}
      <ArtPickerDialog
        game={game}
        kind={kind}
        open={open}
        onClose={close}
        onApplyStyle={(preset) => {
          setOpen(false);
          // Track N: the picked style, for this slot, across the library.
          setPacks({ preset, kinds: [kind === 'icon' ? 'cover' : kind], scope: 'all' });
        }}
      />
      <ArtPacksDialog open={!!packs} onClose={() => setPacks(null)} initial={packs ?? undefined} />
    </>
  );
}

const CONCURRENCY = 4;

/** Cell height as a padding percentage of its width (more reliable than aspect-ratio inside a scrolling grid). */
const ratioPad = (ratio: string) => {
  const [w, h] = ratio.split('/').map((x) => Number(x.trim()));
  return `${((h || 1) / (w || 1)) * 100}%`;
};

export function ArtPickerDialog({ game, kind, open, onClose, onApplyStyle }: {
  game: Game; kind: PickerKind; open: boolean; onClose: () => void;
  /** Track N: "Apply this style to…" opens Art packs with the matching style chosen. */
  onApplyStyle?: (preset: NonNullable<ReturnType<typeof presetForStyle>>) => void;
}) {
  const slot = PICKER_SLOTS.find((s) => s.kind === kind)!;
  const reduce = useReducedMotion();
  const toast = useStore((s) => s.toast);
  const refresh = useStore((s) => s.refreshLibrary);
  const navigate = useStore((s) => s.navigate);
  const [styles, setStyles] = useState<string[]>([]);
  const [animated, setAnimated] = useState(false);
  const [sgdbGameId, setSgdbGameId] = useState<string | null>(null);
  const [data, setData] = useState<ArtOptions | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, string | 'failed'>>({});
  const [forcePreviews, setForcePreviews] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [applying, setApplying] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);

  // Load the list whenever the dialog opens or a filter changes.
  useEffect(() => {
    if (!open) return;
    const gen = ++generation.current;
    setLoading(true);
    setError(null);
    call<ArtOptions>('art.options', { gameId: game.id, kind, styles, animated, page: 0, sgdbGameId }, 60_000)
      .then((d) => {
        if (gen !== generation.current) return;
        setData(d);
        setThumbs(Object.fromEntries(d.items.filter((i) => i.thumb).map((i) => [i.id, i.thumb!])));
        setSelected(null);
        setFocusIndex(0);
      })
      .catch((err) => {
        if (gen !== generation.current) return;
        setData(null);
        setError({ code: err instanceof BridgeError ? err.code : 'internal', message: errorMessage(err) });
      })
      .finally(() => gen === generation.current && setLoading(false));
  }, [open, game.id, kind, styles, animated, sgdbGameId]);

  // Fetch previews a few at a time, in order, through the native safe-image pipeline.
  useEffect(() => {
    if (!open || !data || (data.previewsPaused && !forcePreviews)) return;
    const gen = generation.current;
    const queue = data.items.filter((i) => !i.thumb).map((i) => i.id);
    let cancelled = false;
    const worker = async () => {
      while (!cancelled && queue.length) {
        const id = queue.shift()!;
        try {
          const url = await call<string | null>('art.thumb', { gameId: game.id, kind, optionId: id, force: forcePreviews }, 60_000);
          if (!cancelled && gen === generation.current) setThumbs((t) => ({ ...t, [id]: url ?? 'failed' }));
        } catch {
          if (!cancelled && gen === generation.current) setThumbs((t) => ({ ...t, [id]: 'failed' }));
        }
      }
    };
    for (let i = 0; i < CONCURRENCY; i++) void worker();
    return () => { cancelled = true; };
  }, [open, data, forcePreviews, game.id, kind]);

  const items = data?.items ?? [];
  const chosen = items.find((i) => i.id === selected) ?? null;
  // The style to spread: the selected image's, or the one style filter that's on.
  const packPreset = presetForStyle(kind, chosen ? chosen.style : styles.length === 1 ? styles[0] : null);

  const apply = async () => {
    if (!chosen) return;
    setApplying(true);
    try {
      await call('art.apply', { gameId: game.id, kind, optionId: chosen.id }, 120_000);
      await refresh();
      toast({ tone: 'success', title: `${slot.label} updated`, body: chosen.author ? `Artwork by ${chosen.author} on SteamGridDB.` : 'Artwork from SteamGridDB.' });
      onClose();
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t use that image', body: errorMessage(err) });
    } finally {
      setApplying(false);
    }
  };

  const columns = () => {
    const el = gridRef.current;
    if (!el) return 1;
    return Math.max(1, getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length);
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!items.length) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const it = items[focusIndex];
      if (it) {
        if (selected === it.id && e.key === 'Enter') void apply();
        else setSelected(it.id);
      }
      return;
    }
    const next = gridMove(focusIndex, e.key, items.length, columns());
    if (next !== focusIndex) {
      e.preventDefault();
      setFocusIndex(next);
      gridRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[next]?.focus();
    }
  };

  const toggleStyle = (s: string) => setStyles((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const matched = data?.game
    ? data.matchedBy === 'steam' ? `Matched by Steam app ID: ${data.game.name}` : data.matchedBy === 'title' ? `Matched by exact title: ${data.game.name}` : `Showing: ${data.game.name}`
    : null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={<span className="artpick__title"><Sparkles size={18} aria-hidden /> Choose a {slot.label.toLowerCase()} from SteamGridDB</span>}
      actions={
        <>
          <span className="artpick__attrib">
            Community artwork from SteamGridDB, credited to each artist.
            <button className="artpick__link" onClick={() => void call('dataSources.openLink', { provider: 'steamgriddb', link: 'home' })}>steamgriddb.com <ExternalLink size={11} aria-hidden /></button>
          </span>
          {onApplyStyle && packPreset && kind !== 'icon' && data?.game && (
            <Button variant="ghost" icon={<Wand2 size={15} />} onClick={() => onApplyStyle(packPreset)}>Apply this style to…</Button>
          )}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Check size={15} />} disabled={!chosen} loading={applying} onClick={() => void apply()}>Use this {slot.label.toLowerCase()}</Button>
        </>
      }
    >
      <div className="artpick" data-kind={kind}>
        <div className="artpick__toolbar">
          <div className="artpick__styles" role="group" aria-label="Styles">
            {(data?.styles ?? []).map((s) => (
              <button key={s} className="artpick__chip" aria-pressed={styles.includes(s)} onClick={() => toggleStyle(s)}>{STYLE_LABEL[s] ?? s}</button>
            ))}
          </div>
          <label className="artpick__animated">
            <input type="checkbox" checked={animated} onChange={(e) => setAnimated(e.target.checked)} />
            Include animated
          </label>
        </div>
        {matched && <p className="artpick__matched" role="status">{matched}</p>}

        {error && <PickerError error={error} onSettings={() => { onClose(); navigate({ name: 'settings', section: 'library' }); }} />}

        {data && !data.game && data.candidates.length > 0 && (
          <div className="artpick__candidates" role="group" aria-label="Choose the right game on SteamGridDB">
            <p><Search size={14} aria-hidden /> No exact match for “{game.title}”. Which of these is it?</p>
            {data.candidates.map((c) => (
              <Button key={c.id} size="sm" onClick={() => setSgdbGameId(c.id)}>{c.name}{c.year ? ` (${c.year})` : ''}</Button>
            ))}
          </div>
        )}
        {data && !data.game && data.candidates.length === 0 && !loading && <p className="artpick__empty">SteamGridDB has no entry for this game.</p>}

        {data?.previewsPaused && !forcePreviews && items.length > 0 && (
          <div className="artpick__paused" role="status">
            <CloudOff size={15} aria-hidden /> Data saver is on, so previews aren’t downloaded.
            <Button size="sm" variant="ghost" onClick={() => setForcePreviews(true)}>Load previews anyway</Button>
          </div>
        )}

        <div className="artpick__body">
          <div
            ref={gridRef}
            className="artpick__grid"
            role="listbox"
            aria-label={`${slot.label} options`}
            aria-busy={loading || undefined}
            onKeyDown={onGridKey}
          >
            {loading && !items.length && Array.from({ length: 12 }, (_, i) => (
              <div key={i} className="artpick__cell artpick__cell--skeleton" style={{ paddingTop: ratioPad(slot.ratio) }} aria-hidden>
                <div className="skeleton" />
              </div>
            ))}
            {items.map((it, i) => (
              <OptionCell
                key={it.id}
                item={it}
                ratio={slot.ratio}
                thumb={thumbs[it.id]}
                selected={it.id === selected}
                tabIndex={i === focusIndex ? 0 : -1}
                index={i}
                reduce={reduce}
                onFocus={() => setFocusIndex(i)}
                onSelect={() => { setSelected(it.id); setFocusIndex(i); }}
                onApply={() => { setSelected(it.id); }}
              />
            ))}
            {!loading && data?.game && !items.length && <p className="artpick__empty">No {slot.label.toLowerCase()}s match these filters.</p>}
          </div>

          <aside className="artpick__preview" aria-live="polite">
            <div className="artpick__stage" data-kind={kind} style={{ aspectRatio: slot.ratio }}>
              {chosen && thumbs[chosen.id] && thumbs[chosen.id] !== 'failed'
                ? <motion.img key={chosen.id} src={thumbs[chosen.id]} alt="" initial={reduce ? false : { opacity: 0, scale: 1.03 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.35 }} />
                : <span className="artpick__stage-empty">{chosen ? 'Preview unavailable' : 'Select an image to preview it'}</span>}
              {kind === 'hero' && <span className="artpick__stage-title" aria-hidden>{game.title}</span>}
            </div>
            {chosen && (
              <dl className="artpick__meta">
                <div><dt>Artist</dt><dd className="selectable">{chosen.author ?? 'Unknown'}</dd></div>
                <div><dt>Size</dt><dd className="num">{chosen.width && chosen.height ? `${chosen.width}×${chosen.height}` : '—'}</dd></div>
                <div><dt>Style</dt><dd>{chosen.style ? STYLE_LABEL[chosen.style] ?? chosen.style : '—'}</dd></div>
              </dl>
            )}
            <p className="artpick__note">The full-size image is downloaded, checked and kept in VYSTRAL’s private cache. It becomes your choice: scans never replace it, and “Reset to default” brings the store’s art back.</p>
          </aside>
        </div>
      </div>
    </Dialog>
  );
}

function OptionCell({ item, ratio, thumb, selected, tabIndex, index, reduce, onFocus, onSelect, onApply }: {
  item: ArtOption; ratio: string; thumb: string | 'failed' | undefined; selected: boolean; tabIndex: number; index: number; reduce: boolean;
  onFocus: () => void; onSelect: () => void; onApply: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const label = useMemo(() => [
    item.style ? STYLE_LABEL[item.style] ?? item.style : null,
    item.author ? `by ${item.author}` : null,
    item.width && item.height ? `${item.width} by ${item.height}` : null,
  ].filter(Boolean).join(', '), [item]);
  return (
    <motion.div
      role="option"
      aria-selected={selected}
      aria-label={label || `Option ${index + 1}`}
      tabIndex={tabIndex}
      className="artpick__cell"
      style={{ paddingTop: ratioPad(ratio) }}
      onFocus={onFocus}
      onClick={onSelect}
      onDoubleClick={onApply}
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: reduce ? 0 : Math.min(index, 16) * 0.02 }}
    >
      {(!thumb || (thumb !== 'failed' && !loaded)) && <div className="skeleton" aria-hidden />}
      {thumb && thumb !== 'failed' && <img src={thumb} alt="" draggable={false} onLoad={() => setLoaded(true)} data-loaded={loaded || undefined} />}
      {thumb === 'failed' && <span className="artpick__failed">No preview</span>}
      {selected && <span className="artpick__check" aria-hidden><Check size={14} /></span>}
      {item.author && <span className="artpick__author" aria-hidden>{item.author}</span>}
    </motion.div>
  );
}

function PickerError({ error, onSettings }: { error: { code: string; message: string }; onSettings: () => void }) {
  return (
    <div className="artpick__error" role="alert">
      <p>{error.message}</p>
      {error.code === 'notConfigured' && <Button size="sm" icon={<Settings2 size={14} />} onClick={onSettings}>Open Data sources settings</Button>}
    </div>
  );
}
