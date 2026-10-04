import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Gamepad2, RefreshCw, Search } from 'lucide-react';
import { call } from '../../bridge/bridge';
import { useStore } from '../../state/store';
import { IconButton, Kbd } from '../ui/primitives';
import { UpdatePill } from './UpdateCenter';

/**
 * Custom title bar. Empty areas are reported to the native window as caption (drag) regions;
 * the system draws the minimize/maximize/close buttons in the reserved space on the right.
 */
export function TitleBar() {
  const back = useStore((s) => s.back.length > 0);
  const forward = useStore((s) => s.forward.length > 0);
  const goBack = useStore((s) => s.goBack);
  const goForward = useStore((s) => s.goForward);
  const openCommand = useStore((s) => s.setCommandOpen);
  const native = useStore((s) => s.native);
  const inset = useStore((s) => s.window.captionInsetRight);
  const scan = useStore((s) => s.scan);
  const scanLibrary = useStore((s) => s.scanLibrary);
  const setMode = useStore((s) => s.setMode);
  const barRef = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar || !native) return;
    let raf = 0;
    const report = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const regions = [...bar.querySelectorAll<HTMLElement>('[data-drag]')].map((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.left, y: r.top, width: r.width, height: r.height };
        });
        void call('window.dragRegions', { regions }).catch(() => {});
      });
    };
    const ro = new ResizeObserver(report);
    ro.observe(bar);
    bar.querySelectorAll('[data-drag]').forEach((el) => ro.observe(el));
    report();
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [native, inset]);

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
        {!native && <span className="preview-chip" title="Running outside the VYSTRAL app with sample data">PREVIEW · SAMPLE DATA</span>}
        <UpdatePill />
        <IconButton label={scan.running ? 'Scanning your stores…' : 'Rescan installed games'} size="sm" onClick={() => void scanLibrary()} disabled={scan.running}>
          <RefreshCw size={15} className={scan.running ? 'spin' : undefined} style={scan.running ? { animation: 'spin 1s linear infinite' } : undefined} />
        </IconButton>
        <IconButton label="Immersive Mode (F11)" size="sm" onClick={() => void setMode('immersive')}>
          <Gamepad2 size={16} />
        </IconButton>
      </div>
      <div className="titlebar__drag titlebar__caption-space" data-drag style={{ width: Math.max(12, inset + 8) }} />
    </header>
  );
}
