import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Gamepad2, GitCompareArrows, Layers, Info } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { ControlId, ControllerCompare, ControllerLayout, ControllerSet, Game } from '../../bridge/types';
import { bindingLine, CONTROL_NAME } from '../../lib/gamepad';
import { pick, spring } from '../../lib/motion';
import { useReducedMotion } from '../../state/store';
import { Badge, Button, Segmented, Skeleton } from '../ui/primitives';
import { GamepadDiagram } from './GamepadDiagram';
import { ControlsCompare } from './ControlsCompare';
import './controls.css';

const SOURCE_LABEL = { personal: 'Your own layout', template: 'Steam template', workshop: 'Downloaded layout' } as const;

/** Loads a game's Steam Input layout once per game id (also used by Immersive at merge). */
export function useControllerLayout(gameId: string): { layout: ControllerLayout | null; error: string | null } {
  const [state, setState] = useState<{ id: string; layout: ControllerLayout | null; error: string | null }>({ id: '', layout: null, error: null });
  useEffect(() => {
    let live = true;
    call<ControllerLayout>('controls.get', { gameId })
      .then((layout) => live && setState({ id: gameId, layout, error: null }))
      .catch((err) => live && setState({ id: gameId, layout: null, error: errorMessage(err) }));
    return () => { live = false; };
  }, [gameId]);
  return state.id === gameId ? state : { layout: null, error: null };
}

/**
 * Track Q: a game's Steam Input layout before you play — read-only from Steam's files on this PC. An Xbox diagram
 * with a callout for every bound control, a switcher for action sets and layers, and the same information as a
 * table for screen readers and keyboard users. Exported for Immersive (`variant="immersive"` drops the table
 * into a compact list and enlarges the diagram).
 */
export function ControlsPanel({ game, variant = 'desktop' }: { game: Game; variant?: 'desktop' | 'immersive' }) {
  const { layout, error } = useControllerLayout(game.id);
  if (error) return <ControlsMessage icon={<AlertTriangle size={22} />} title="Couldn’t read the layout" body={error} />;
  if (!layout) {
    return (
      <div className="controls" aria-busy>
        <Skeleton height={28} width="40%" />
        <Skeleton height={360} radius={22} className="controls__skeleton" />
      </div>
    );
  }
  switch (layout.status) {
    case 'none':
      return (
        <ControlsMessage
          icon={<Gamepad2 size={22} />}
          title="Uses the game’s own controller support"
          body="Steam has no Steam Input layout saved for this game on this PC, so your controller works exactly as the game designed it. If you set one up in Steam, it appears here."
        />
      );
    case 'notSteam':
      return <ControlsMessage icon={<Gamepad2 size={22} />} title="Controls come from the game" body="Steam Input layouts are shown for Steam games. This one uses its own controller support." />;
    case 'noSteam':
      return <ControlsMessage icon={<Info size={22} />} title="Steam isn’t installed" body="Steam Input layouts are read from Steam’s folder on this PC, and Steam wasn’t found." />;
    case 'unreadable':
      return <ControlsMessage icon={<AlertTriangle size={22} />} title="This layout couldn’t be read" body={layout.note ?? 'Steam has a layout for this game, but it isn’t in a format VYSTRAL understands.'} />;
    default:
      return <LayoutView layout={layout} variant={variant} gameId={game.id} />;
  }
}

function ControlsMessage({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="controls controls--message" role="status">
      <span className="controls__msg-icon" aria-hidden>{icon}</span>
      <div>
        <h3 className="controls__msg-title">{title}</h3>
        <p className="controls__msg-body">{body}</p>
      </div>
    </div>
  );
}

function LayoutView({ layout, variant, gameId }: { layout: ControllerLayout; variant: 'desktop' | 'immersive'; gameId: string }) {
  const reduce = useReducedMotion();
  // Track X: "Compare with default" — looked up quietly once; the button appears only when there's something to compare with.
  const [cmp, setCmp] = useState<ControllerCompare | null>(null);
  const [comparing, setComparing] = useState(false);
  useEffect(() => {
    if (variant !== 'desktop') return;
    let live = true;
    call<ControllerCompare>('controls.compare', { gameId }).then((c) => live && setCmp(c)).catch(() => {});
    return () => { live = false; };
  }, [gameId, variant]);
  const canCompare = cmp?.status === 'ok' || cmp?.status === 'same';
  const sets = layout.sets.filter((s) => s.kind === 'set');
  const layers = layout.sets.filter((s) => s.kind === 'layer');
  const [setId, setSetId] = useState(sets[0]?.id ?? layout.sets[0]?.id ?? '');
  const [layerId, setLayerId] = useState<string | null>(null);
  const [active, setActive] = useState<ControlId | null>(null);
  const shownLayers = layers.filter((l) => !l.parentId || l.parentId.toLowerCase() === setId.toLowerCase());
  const current: ControllerSet | undefined = (layerId && layout.sets.find((s) => s.id === layerId)) || layout.sets.find((s) => s.id === setId) || layout.sets[0];
  const rows = useMemo(() => current?.controls.filter((c) => c.bindings.length || c.mode) ?? [], [current]);
  if (!current) return <ControlsMessage icon={<Gamepad2 size={22} />} title="This layout is empty" body="Steam has a layout for this game, but nothing is bound in it." />;

  const source = layout.sourceKind ? SOURCE_LABEL[layout.sourceKind] : null;
  return (
    <div className="controls" data-variant={variant}>
      <div className="controls__head">
        <div className="controls__titles">
          <h3 className="controls__title">{layout.templateName ?? layout.title ?? 'Steam Input layout'}</h3>
          <p className="controls__meta">
            {source && <Badge tone="accent">{source}</Badge>}
            {layout.controllerLabel && <span>Saved for: {layout.controllerLabel}</span>}
          </p>
          {layout.description && <p className="controls__desc">{layout.description}</p>}
        </div>
        {(sets.length > 1 || shownLayers.length > 0 || canCompare) && (
          <div className="controls__switch">
            {canCompare && (
              <Button size="sm" variant={comparing ? 'secondary' : 'ghost'} icon={<GitCompareArrows size={14} />} aria-pressed={comparing} onClick={() => setComparing(!comparing)}>
                {comparing ? 'Hide comparison' : 'Compare with default'}
              </Button>
            )}
            {sets.length > 1 && (
              <Segmented
                label="Action set"
                value={setId}
                onChange={(v) => { setSetId(v); setLayerId(null); }}
                options={sets.slice(0, 6).map((s) => ({ value: s.id, label: s.name }))}
              />
            )}
            {shownLayers.length > 0 && (
              <div className="controls__layers" role="group" aria-label="Action layers">
                <Layers size={14} aria-hidden />
                {shownLayers.map((l) => (
                  <button key={l.id} className="chip" aria-pressed={layerId === l.id} onClick={() => setLayerId(layerId === l.id ? null : l.id)}>
                    {l.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {comparing && cmp && <ControlsCompare cmp={cmp} set={current} onDone={() => setComparing(false)} />}
      {!comparing && <>
      <div className="controls__stage">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={current.id}
            className="controls__diagram"
            initial={{ opacity: 0, scale: reduce ? 1 : 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={pick(reduce, spring.panel)}
          >
            <GamepadDiagram controls={current.controls} active={active} onActive={setActive} setKey={current.id} />
          </motion.div>
        </AnimatePresence>
        {current.kind === 'layer' && <p className="controls__legend"><span className="controls__swatch" aria-hidden /> Changed while “{current.name}” is on; the rest comes from its action set.</p>}
      </div>

      <table className="controls__table">
        <caption className="visually-hidden">Every control in “{current.name}”</caption>
        <thead>
          <tr><th scope="col">Control</th><th scope="col">What it does</th></tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr
              key={c.control}
              data-active={active === c.control || undefined}
              data-layer={c.fromLayer || undefined}
              onMouseEnter={() => setActive(c.control)}
              onMouseLeave={() => setActive(null)}
            >
              <th scope="row">
                {CONTROL_NAME[c.control]}
                {c.mode && <span className="controls__mode">{c.mode}</span>}
              </th>
              <td>
                {c.bindings.length === 0 ? <span className="controls__muted">{c.mode}</span> : (
                  <ul className="controls__binds">
                    {c.bindings.map((b, i) => (
                      <li key={i} data-kind={b.kind}>
                        {bindingLine(b)}
                        {b.detail && <span className="controls__detail"> {b.detail}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {c.fromLayer && <span className="visually-hidden"> (changed by this layer)</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </>}
      {!comparing && <p className="controls__foot">Read from Steam’s files on this PC. VYSTRAL never changes your layout — edit it in Steam’s controller settings.</p>}
    </div>
  );
}
