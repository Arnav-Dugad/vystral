import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, Equal, Minus, PenLine, Plus } from 'lucide-react';
import type { ControlId, ControllerCompare, ControllerDiffChange, ControllerSet } from '../../bridge/types';
import { ANCHORS, CONTROL_NAME } from '../../lib/gamepad';
import { basisLine, CHANGE_LABEL, diffCounts, diffMap, diffSummary } from '../../lib/libraryTools';
import { pick, spring } from '../../lib/motion';
import { useReducedMotion } from '../../state/store';
import { Button, Segmented } from '../ui/primitives';
import { GamepadDiagram } from './GamepadDiagram';
import './controls-compare.css';

const CHANGE_ICON: Record<ControllerDiffChange, typeof Plus> = { added: Plus, removed: Minus, changed: PenLine };

/**
 * Track X: your Steam Input layout next to the one it started from (or Steam's Gamepad template). Side by side, or one
 * diagram you flip between; added, removed and changed controls are marked on both, and listed below with before → after.
 * Read-only: VYSTRAL never edits a layout.
 */
export function ControlsCompare({ cmp, set, onDone }: { cmp: ControllerCompare; set: ControllerSet; onDone: () => void }) {
  const reduce = useReducedMotion();
  const [mode, setMode] = useState<'side' | 'overlay'>('side');
  const [showing, setShowing] = useState<'yours' | 'default'>('yours');
  const [active, setActive] = useState<ControlId | null>(null);
  const baseSet = useMemo(
    () => cmp.default?.sets.find((s) => s.kind === set.kind && s.id.toLowerCase() === set.id.toLowerCase())
      ?? (cmp.default?.sets.filter((s) => s.kind === 'set').length === 1 && set.kind === 'set' ? cmp.default.sets.find((s) => s.kind === 'set') : undefined),
    [cmp.default, set],
  );
  const map = useMemo(() => diffMap(cmp, baseSet ? set.id : null), [cmp, set.id, baseSet]);
  const counts = diffCounts(cmp, set.id);
  const rows = cmp.differences.filter((d) => d.setId.toLowerCase() === set.id.toLowerCase());
  const defaultName = cmp.defaultName ?? 'Default';
  // Paddles, trackpads, gyro and the guide button aren't drawn; say so instead of hiding their changes.
  const offDrawing = rows.filter((d) => !ANCHORS[d.control]);

  const diagram = (which: 'yours' | 'default') => {
    const controls = which === 'yours' ? set.controls : baseSet?.controls ?? [];
    return (
      <figure className="ccmp__pane" data-which={which}>
        <figcaption className="ccmp__caption">
          <span className="ccmp__dot" aria-hidden />
          {which === 'yours' ? 'Yours' : <>Default · <span className="ccmp__name">{defaultName}</span></>}
        </figcaption>
        <GamepadDiagram controls={controls} active={active} onActive={setActive} setKey={`${which}-${set.id}`} diff={map} />
      </figure>
    );
  };

  return (
    <div className="ccmp" data-mode={mode}>
      <div className="ccmp__head">
        <div className="ccmp__titles">
          <p className="ccmp__basis">{basisLine(cmp)}</p>
          <p className="ccmp__summary" aria-live="polite">
            {cmp.status === 'same' ? 'No differences — your layout matches it exactly.' : diffSummary(cmp, set.id)}
          </p>
          {cmp.status !== 'same' && (
            <ul className="ccmp__legend" aria-label="Key">
              {(['changed', 'added', 'removed'] as const).map((k) => (
                <li key={k} data-change={k}><span className="ccmp__swatch" aria-hidden /> {CHANGE_LABEL[k]} <span className="num">{counts[k]}</span></li>
              ))}
            </ul>
          )}
        </div>
        <div className="ccmp__switch">
          <Segmented label="Compare view" value={mode} onChange={setMode} options={[{ value: 'side', label: 'Side by side' }, { value: 'overlay', label: 'Overlay' }]} />
          {mode === 'overlay' && (
            <Segmented label="Show" value={showing} onChange={setShowing} options={[{ value: 'yours', label: 'Yours' }, { value: 'default', label: 'Default' }]} />
          )}
          <Button size="sm" variant="ghost" onClick={onDone}>Done</Button>
        </div>
      </div>

      {!baseSet && <p className="ccmp__note">“{set.name}” isn’t in {defaultName}, so everything in it is yours.</p>}

      <div className="ccmp__stage">
        {mode === 'side' ? (
          <div className="ccmp__panes">
            {diagram('yours')}
            {diagram('default')}
          </div>
        ) : (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={showing} className="ccmp__overlay" initial={{ opacity: 0, scale: reduce ? 1 : 0.99 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={pick(reduce, spring.panel)}>
              {diagram(showing)}
            </motion.div>
          </AnimatePresence>
        )}
        {offDrawing.length > 0 && (
          <p className="ccmp__off">
            Not on the drawing:
            {offDrawing.map((d) => {
              const Icon = CHANGE_ICON[d.change];
              return <span key={d.control} className="ccmp__pill" data-change={d.change}><Icon size={11} aria-hidden /> {CONTROL_NAME[d.control]} · {CHANGE_LABEL[d.change].toLowerCase()}</span>;
            })}
          </p>
        )}
      </div>

      {rows.length > 0 ? (
        <table className="ccmp__table">
          <caption className="visually-hidden">Differences in “{set.name}” between your layout and {defaultName}</caption>
          <thead>
            <tr><th scope="col">Control</th><th scope="col">Change</th><th scope="col">{defaultName}</th><th scope="col"><span className="visually-hidden">becomes</span></th><th scope="col">Yours</th></tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const Icon = CHANGE_ICON[d.change];
              return (
                <tr key={`${d.setId}-${d.control}`} data-change={d.change} data-active={active === d.control || undefined}
                  onMouseEnter={() => setActive(d.control)} onMouseLeave={() => setActive(null)}>
                  <th scope="row">{CONTROL_NAME[d.control]}</th>
                  <td><span className="ccmp__pill"><Icon size={12} aria-hidden /> {CHANGE_LABEL[d.change]}</span></td>
                  <td className="ccmp__before">{lines(d.before, d.modeBefore)}</td>
                  <td className="ccmp__arrow" aria-hidden><ArrowRight size={14} /></td>
                  <td className="ccmp__after">{lines(d.after, d.modeAfter)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="ccmp__same"><Equal size={14} aria-hidden /> Every control in “{set.name}” does the same thing in both.</p>
      )}
      {(cmp.onlyInYours.length > 0 || cmp.onlyInDefault.length > 0) && (
        <p className="ccmp__note">
          {cmp.onlyInYours.length > 0 && <>Only in yours: {cmp.onlyInYours.join(', ')}. </>}
          {cmp.onlyInDefault.length > 0 && <>Only in {defaultName}: {cmp.onlyInDefault.join(', ')}.</>}
        </p>
      )}
      {cmp.note && <p className="ccmp__note">{cmp.note}</p>}
      <p className="controls__foot">Both are read from Steam’s files on this PC. VYSTRAL never changes a layout — to go back to the default, pick it in Steam’s controller settings.</p>
    </div>
  );
}

function lines(list: string[], mode: string | null) {
  if (!list.length) return <span className="ccmp__muted">{mode ?? 'Nothing'}</span>;
  return (
    <ul className="ccmp__binds">
      {list.map((l, i) => <li key={i}>{l}</li>)}
      {mode && !list.includes(mode) && <li className="ccmp__mode">{mode}</li>}
    </ul>
  );
}
