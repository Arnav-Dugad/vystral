import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { CalendarDays, ChevronLeft, ChevronRight, Film, FolderOpen, Gamepad2, HardDrive, Image as ImageIcon, Link2, X } from 'lucide-react';
import type { MediaFolder, MediaItem } from '../../bridge/types';
import { Button, IconButton } from '../../components/ui/primitives';
import { useReducedMotion, useStore } from '../../state/store';
import { formatBytes, formatDate } from '../../lib/format';
import { exit, pick, spring } from '../../lib/motion';
import { pushPadHandler } from '../../lib/input';
import { matchLabel } from './grouping';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

/**
 * Full-screen viewer. Behaves like the app's Dialog (focus moves in and returns, Tab is
 * trapped, Escape / controller B closes) and adds Left/Right navigation from keyboard and pad.
 */
export function Lightbox({
  items,
  index,
  folders,
  onIndex,
  onClose,
}: {
  items: MediaItem[];
  index: number | null;
  folders: MediaFolder[];
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const open = index != null && index >= 0 && index < items.length;
  return createPortal(
    <AnimatePresence>{open && <Viewer items={items} index={index} folders={folders} onIndex={onIndex} onClose={onClose} />}</AnimatePresence>,
    document.body,
  );
}

function Viewer({
  items,
  index,
  folders,
  onIndex,
  onClose,
}: {
  items: MediaItem[];
  index: number;
  folders: MediaFolder[];
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const item = items[index];
  const game = useStore((s) => (item.gameId ? s.gamesById.get(item.gameId) ?? null : null));
  const folder = folders.find((f) => f.id === item.folderId);
  const [direction, setDirection] = useState(0);
  const hasPrev = index > 0;
  const hasNext = index < items.length - 1;
  // While the viewer fades out it is still mounted; stepping then would reopen it.
  const isPresent = useIsPresent();

  const go = (delta: number) => {
    if (!isPresent) return;
    const next = index + delta;
    if (next < 0 || next >= items.length) return;
    setDirection(delta);
    onIndex(next);
  };
  const goRef = useRef(go);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    goRef.current = go;
    closeRef.current = onClose;
  });

  // Focus in on open, back out on close; trap Tab; keyboard navigation.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      const inVideo = e.target instanceof HTMLVideoElement;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === 'ArrowLeft' && !inVideo) {
        e.preventDefault();
        goRef.current(-1);
      } else if (e.key === 'ArrowRight' && !inVideo) {
        e.preventDefault();
        goRef.current(1);
      } else if (e.key === 'Tab' && ref.current) {
        const els = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (!els.length) return;
        const first = els[0], last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        } else if (!ref.current.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    const popPad = pushPadHandler((button, repeat) => {
      if (button === 'Left') goRef.current(-1);
      else if (button === 'Right') goRef.current(1);
      else if (button === 'B') {
        if (!repeat) closeRef.current();
      } else return false;
      return true;
    });
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey, true);
      popPad();
      previous?.focus?.({ preventScroll: true });
    };
  }, []);

  // Warm the neighbours so stepping through feels instant.
  useEffect(() => {
    for (const n of [items[index - 1], items[index + 1]]) {
      if (n?.kind === 'image') {
        const img = new Image();
        img.decoding = 'async';
        img.src = n.url;
      }
    }
  }, [items, index]);

  const openGame = () => {
    if (!game) return;
    onClose();
    useStore.getState().navigate({ name: 'game', id: game.id });
  };

  return (
    <motion.div
      className="mv-lightbox"
      data-dialog-open
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: exit }}
      transition={pick(reduce, spring.effect)}
    >
      <div ref={ref} className="mv-lightbox__inner" role="dialog" aria-modal="true" aria-label={`${item.name}, ${index + 1} of ${items.length}`}>
        <div className="mv-lightbox__stage" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
          <div className="mv-lightbox__counter num" aria-hidden>
            {(index + 1).toLocaleString()} / {items.length.toLocaleString()}
          </div>
          <AnimatePresence initial={false} mode="popLayout" custom={direction}>
            <motion.div
              key={item.url}
              className="mv-lightbox__media"
              initial={reduce ? { opacity: 0 } : { opacity: 0, x: direction * 40, scale: 0.985 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, x: direction * -30, transition: exit }}
              transition={pick(reduce, spring.panel)}
              onMouseDown={(e) => e.target === e.currentTarget && onClose()}
            >
              <Media item={item} />
            </motion.div>
          </AnimatePresence>
          <button type="button" className="mv-lightbox__nav mv-lightbox__nav--prev" aria-label="Previous" disabled={!hasPrev} onClick={() => go(-1)}>
            <ChevronLeft size={26} />
          </button>
          <button type="button" className="mv-lightbox__nav mv-lightbox__nav--next" aria-label="Next" disabled={!hasNext} onClick={() => go(1)}>
            <ChevronRight size={26} />
          </button>
        </div>

        <aside className="mv-lightbox__info" aria-label="Details">
          <div className="mv-lightbox__info-head">
            <span className="caps">{item.kind === 'video' ? 'Clip' : 'Screenshot'}</span>
            <IconButton label="Close viewer" onClick={onClose} data-autofocus>
              <X size={18} />
            </IconButton>
          </div>
          <h2 className="mv-lightbox__name selectable">{item.name}</h2>
          <dl className="mv-facts">
            <div>
              <dt><CalendarDays size={14} aria-hidden /> File date</dt>
              <dd>{formatDate(item.modifiedAt, { dateStyle: 'long', timeStyle: 'short' })}</dd>
            </div>
            <div>
              <dt><HardDrive size={14} aria-hidden /> Size</dt>
              <dd className="num">{formatBytes(item.sizeBytes)}</dd>
            </div>
            <div>
              <dt>{item.kind === 'video' ? <Film size={14} aria-hidden /> : <ImageIcon size={14} aria-hidden />} Type</dt>
              <dd>{item.kind === 'video' ? 'Video clip' : 'Image'}</dd>
            </div>
            {folder && (
              <div>
                <dt><FolderOpen size={14} aria-hidden /> Folder</dt>
                <dd className="mv-facts__path selectable" title={folder.path}>{folder.label}</dd>
              </div>
            )}
            <div>
              <dt><Link2 size={14} aria-hidden /> Game</dt>
              <dd>
                {game ? game.title : 'Unsorted'}
                <span className="mv-facts__sub">{matchLabel(item.matchedBy)}</span>
              </dd>
            </div>
          </dl>
          {game && (
            <Button variant="secondary" block icon={<Gamepad2 size={16} aria-hidden />} onClick={openGame}>
              Open {game.title}
            </Button>
          )}
          <p className="mv-lightbox__note">The date shown is the file’s modified date. Files stay where they are; VYSTRAL only reads them.</p>
          <div className="mv-lightbox__keys" aria-hidden>
            <span className="kbd">←</span>
            <span className="kbd">→</span> browse <span className="kbd">Esc</span> close
          </div>
        </aside>
      </div>
    </motion.div>
  );
}

function Media({ item }: { item: MediaItem }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="mv-lightbox__failed" role="img" aria-label="Preview unavailable">
        {item.kind === 'video' ? <Film size={40} aria-hidden /> : <ImageIcon size={40} aria-hidden />}
        <span>This file can’t be previewed. It may have been moved or deleted.</span>
      </div>
    );
  }
  if (item.kind === 'video') {
    return (
      <video
        className="mv-lightbox__video"
        src={item.url}
        poster={item.thumbUrl || undefined}
        controls
        preload="metadata"
        playsInline
        onError={() => setFailed(true)}
        aria-label={item.name}
      />
    );
  }
  return (
    <>
      {!loaded && (
        <div className="mv-lightbox__loading" aria-hidden>
          {item.thumbUrl && <img src={item.thumbUrl} alt="" className="mv-lightbox__placeholder" />}
          <span className="spinner" />
        </div>
      )}
      <img
        className="mv-lightbox__img"
        src={item.url}
        alt={item.name}
        decoding="async"
        draggable={false}
        data-loaded={loaded}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    </>
  );
}
