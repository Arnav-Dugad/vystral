import { useEffect, useId, useState } from 'react';
import { ChevronDown, ShieldCheck } from 'lucide-react';
import { call } from '../../bridge/bridge';
import type { AntiCheatNote as Note, Game } from '../../bridge/types';
import { formatDate } from '../../lib/format';
import { useStore } from '../../state/store';
import './anticheat-note.css';

/**
 * Track M: a calm, informative note on the game page when AreWeAntiCheatYet lists a kernel-level
 * anti-cheat for this game. It says what VYSTRAL itself does (read-only) and nothing it can't verify.
 * Hidden with Settings › Launching & sessions › Anti-cheat notes.
 */
export function AntiCheatNote({ game }: { game: Game }) {
  const enabled = useStore((s) => s.settings?.['launch.antiCheatNotes'] ?? true);
  const sourceOn = useStore((s) => s.settings?.['dataSources.antiCheat'] ?? true);
  const fps = useStore((s) => s.settings?.['fps.captureEnabled'] ?? false);
  const key = `${game.id}|${enabled}|${sourceOn}|${fps}`;
  const [state, setState] = useState<{ key: string; note: Note | null } | null>(null);
  const note = state?.key === key ? state.note : null;
  const [open, setOpen] = useState(false);
  const id = useId();

  useEffect(() => {
    let alive = true;
    if (!enabled || !sourceOn) return;
    call<Note | null>('compat.antiCheatNote', { gameId: game.id })
      .then((n) => alive && setState({ key, note: n && Array.isArray(n.kernel) && n.kernel.length ? n : null }))
      .catch(() => alive && setState({ key, note: null }));
    return () => { alive = false; };
  }, [key, game.id, enabled, sourceOn]);

  if (!note) return null;
  return (
    <aside className="acn surface" aria-labelledby={`${id}-h`}>
      <span className="acn__icon" aria-hidden><ShieldCheck size={16} /></span>
      <div className="acn__body">
        <p id={`${id}-h`} className="acn__headline">{note.headline}</p>
        <button className="acn__toggle" aria-expanded={open} aria-controls={`${id}-more`} onClick={() => setOpen((o) => !o)}>
          What VYSTRAL does <ChevronDown size={13} aria-hidden data-open={open || undefined} />
        </button>
        <ul id={`${id}-more`} className="acn__notes" hidden={!open}>
          {note.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
        <p className="acn__src">
          {note.source}{note.updated ? ` Updated ${formatDate(note.updated)}.` : ''}{' '}
          <button className="acn__link" onClick={() => useStore.getState().navigate({ name: 'settings', section: 'launching' })}>Hide these notes</button>
        </p>
      </div>
    </aside>
  );
}
