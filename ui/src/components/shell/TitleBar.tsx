import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Gamepad2, RefreshCw, Search } from 'lucide-react';
import { call } from '../../bridge/bridge';
import { useStore } from '../../state/store';
import { IconButton, Kbd } from '../ui/primitives';
import { UpdatePill } from './UpdateCenter';
import { NowPlaying } from './NowPlaying';
import { NotificationBell } from './NotificationCenter';
import { applyCaptionInsets, captionInsets } from '../../lib/captionInsets';

/**
 * Custom title bar. Empty areas are reported to the native window as caption (drag) regions;
 * the system draws the minimize/maximize/close buttons in the reserved space on the right. Track C2: that space
 * comes from `--caption-inset-right` (the native caption-button inset, never less than the buttons' width when it
 * isn't known yet) plus a small gap, and every button in the bar is reported as a passthrough region so its clicks
 * always arrive.
 */
export function TitleBar() {
  const back = useStore((s) => s.back.length > 0);
  const forward = useStore((s) => s.forward.length > 0);
  const goBack = useStore((s) => s.goBack);
  const goForward = useStore((s) => s.goForward);
  const openCommand = useStore((s) => s.setCommandOpen);
  const native = useStore((s) => s.native);
  const win = useStore((s) => s.window);
  const { right: inset, left: insetLeft } = captionInsets(win, native);
  const scan = useStore((s) => s.scan);
  const scanLibrary = useStore((s) => s.scanLibrary);
  const setMode = useStore((s) => s.setMode);
  const barRef = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);

  useEffect(() => {
    applyCaptionInsets({ right: inset, left: insetLeft });
  }, [inset, insetLeft]);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar || !native) return;
    let raf = 0;
    const report = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const rect = (el: Element) => {
          const r = el.getBoundingClientRect();
          return { x: r.left, y: r.top, width: r.width, height: r.height };
        };
        const visible = (r: { width: number; height: number }) => r.width > 0 && r.height > 0;
        const regions = [...bar.querySelectorAll<HTMLElement>('[data-drag]')].map(rect).filter(visible).slice(0, 16);
        const passthrough = [...bar.querySelectorAll<HTMLElement>('button, a[href], input, select, [data-passthrough]')].map(rect).filter(visible).slice(0, 32);
        void call('window.dragRegions', { regions, passthrough }).catch(() => {});
      });
    };
    const ro = new ResizeObserver(report);
    ro.observe(bar);
    bar.querySelectorAll('[data-drag], .titlebar__right').forEach((el) => ro.observe(el));
    // Buttons that appear or go (Now playing, the update pill) move the others without resizing a drag area.
    const mo = new MutationObserver(report);
    mo.observe(bar, { childList: true, subtree: true });
    report();
    return () => {
      ro.disconnect();
      mo.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [native, inset, insetLeft]);

  useEffect(() => {
    const t = window.setTimeout(() => force((n) => n + 1), 400);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <header className="titlebar" ref={barRef}>
      <div className="titlebar__brand" data-drag>
        <img className="titlebar__mark" src="./vystral-mark.svg" alt="" />
        <span className="wordmark">VYSTRAL</span>
      </div>
      <IconButton label="Back (Alt+Left)" size="sm" disabled={!back} onClick={goBack}>
        <ArrowLeft size={16} />
      </IconButton>
      <IconButton label="Forward (Alt+Right)" size="sm" disabled={!forward} onClick={goForward}>
        <ArrowRight size={16} />
      </IconButton>
      <div className="titlebar__drag" data-drag />
      <button className="titlebar__search" onClick={() => openCommand(true)} aria-label="Search your library and commands (Ctrl+K)">
        <Search size={15} aria-hidden />
        <span>Search games, filters, actions…</span>
        <Kbd>Ctrl</Kbd>
        <Kbd>K</Kbd>
      </button>
      <div className="titlebar__drag" data-drag />
      <div className="titlebar__right">
        <NowPlaying />
        {!native && <span className="preview-chip" title="Running outside the VYSTRAL app with sample data">PREVIEW · SAMPLE DATA</span>}
        <UpdatePill />
        <NotificationBell />
        <IconButton label={scan.running ? 'Scanning your stores…' : 'Rescan installed games'} size="sm" onClick={() => void scanLibrary()} disabled={scan.running}>
          <RefreshCw size={15} className={scan.running ? 'spin' : undefined} style={scan.running ? { animation: 'spin 1s linear infinite' } : undefined} />
        </IconButton>
        <IconButton label="Immersive Mode (F11)" size="sm" onClick={() => void setMode('immersive')}>
          <Gamepad2 size={16} />
        </IconButton>
      </div>
      <div className="titlebar__drag titlebar__caption-space" data-drag data-inset={inset} aria-hidden />
    </header>
  );
}
