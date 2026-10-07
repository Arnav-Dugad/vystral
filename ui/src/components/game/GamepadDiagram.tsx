import { memo, useMemo } from 'react';
import type { ControlId, ControllerControl, ControllerDiffChange } from '../../bridge/types';
import { ANCHORS, CONTROL_NAME, layoutCallouts, truncate, VIEW } from '../../lib/gamepad';

/** How far from a control's centre its callout line starts, so the line meets the control's edge, not its label. */
const EDGE: Partial<Record<ControlId, number>> = {
  a: 17, b: 17, x: 17, y: 17, ls: 26, rs: 26, lsClick: 26, rsClick: 26, dpadUp: 11, dpadDown: 11, dpadLeft: 11, dpadRight: 11,
  view: 11, menu: 11, share: 9, guide: 18,
};

const mirror = (d: string) => d.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_, x, y) => `${1000 - Number(x)} ${y}`);

const BODY =
  'M 372 150 C 420 136 460 140 500 140 C 540 140 580 136 628 150 C 672 162 700 190 716 240 C 736 300 756 380 760 430 ' +
  'C 764 470 742 492 712 488 C 684 484 664 462 646 432 C 628 402 606 384 576 384 L 424 384 C 394 384 372 402 354 432 ' +
  'C 336 462 316 484 288 488 C 258 492 236 470 240 430 C 244 380 264 300 284 240 C 300 190 328 162 372 150 Z';
const TRIGGER_L = 'M 352 142 C 354 114 372 98 398 98 C 420 98 432 112 434 142 Z';
const BUMPER_L = 'M 336 170 C 358 152 398 143 440 142';

/**
 * Track Q: an Xbox controller drawn in SVG with a callout line from every bound control to its label. Decorative for
 * assistive technology (the controls table next to it says the same thing); `active` highlights one control, and
 * hovering a callout reports it with `onActive`. Lines draw themselves in, unless motion is reduced.
 */
export const GamepadDiagram = memo(function GamepadDiagram({ controls, active, onActive, setKey, diff }: {
  controls: ControllerControl[];
  active: ControlId | null;
  onActive: (c: ControlId | null) => void;
  /** Changes when the shown set changes, so callouts animate in again. */
  setKey: string;
  /** Track X: "Compare with default" marks added / removed / changed controls. */
  diff?: ReadonlyMap<ControlId, ControllerDiffChange>;
}) {
  const callouts = useMemo(() => layoutCallouts(controls), [controls]);
  const bound = useMemo(() => new Set(controls.filter((c) => c.bindings.length || c.mode).map((c) => c.control)), [controls]);
  const layer = useMemo(() => new Set(controls.filter((c) => c.fromLayer).map((c) => c.control)), [controls]);
  const part = (id: ControlId, extra?: ControlId[]) => {
    const ids = [id, ...(extra ?? [])];
    return {
      'data-bound': ids.some((i) => bound.has(i)) || undefined,
      'data-active': (active && ids.includes(active)) || undefined,
      'data-layer': ids.some((i) => layer.has(i)) || undefined,
      'data-diff': ids.map((i) => diff?.get(i)).find(Boolean),
    };
  };
  const face = (id: 'a' | 'b' | 'x' | 'y') => {
    const p = ANCHORS[id]!;
    return (
      <g key={id} className={`pad__face pad__face--${id}`} {...part(id)}>
        <circle cx={p.x} cy={p.y} r={15} />
        <text x={p.x} y={p.y + 5} textAnchor="middle">{id.toUpperCase()}</text>
      </g>
    );
  };

  return (
    <svg className="pad" viewBox={`0 0 ${VIEW.width} ${VIEW.height}`} aria-hidden focusable="false" data-set={setKey}>
      <defs>
        <linearGradient id="pad-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="pad__shade1" />
          <stop offset="100%" className="pad__shade2" />
        </linearGradient>
      </defs>
      <g className="pad__device">
        <path className="pad__trigger" d={TRIGGER_L} {...part('lt')} />
        <path className="pad__trigger" d={mirror(TRIGGER_L)} {...part('rt')} />
        <path className="pad__bumper" d={BUMPER_L} {...part('lb')} />
        <path className="pad__bumper" d={mirror(BUMPER_L)} {...part('rb')} />
        <path className="pad__body" d={BODY} />
        <g className="pad__stick" {...part('ls', ['lsClick'])}>
          <circle className="pad__well" cx={404} cy={246} r={36} />
          <circle className="pad__cap" cx={404} cy={246} r={24} />
        </g>
        <g className="pad__stick" {...part('rs', ['rsClick'])}>
          <circle className="pad__well" cx={548} cy={322} r={36} />
          <circle className="pad__cap" cx={548} cy={322} r={24} />
        </g>
        <g className="pad__dpad">
          <rect className="pad__well" x={418} y={288} width={68} height={68} rx={18} />
          <rect className="pad__dir" x={443} y={294} width={18} height={22} rx={4} {...part('dpadUp')} />
          <rect className="pad__dir" x={443} y={328} width={18} height={22} rx={4} {...part('dpadDown')} />
          <rect className="pad__dir" x={424} y={313} width={22} height={18} rx={4} {...part('dpadLeft')} />
          <rect className="pad__dir" x={458} y={313} width={22} height={18} rx={4} {...part('dpadRight')} />
        </g>
        {(['a', 'b', 'x', 'y'] as const).map(face)}
        <rect className="pad__small" x={452} y={225} width={20} height={14} rx={7} {...part('view')} />
        <rect className="pad__small" x={528} y={225} width={20} height={14} rx={7} {...part('menu')} />
        <rect className="pad__small" x={492} y={245} width={16} height={10} rx={5} {...part('share')} />
        <circle className="pad__guide" cx={500} cy={190} r={16} {...part('guide')} />
      </g>

      <g className="pad__callouts" key={setKey}>
        {callouts.map((c, i) => {
          const left = c.side === 'left';
          const labelX = left ? VIEW.labelLeftX : VIEW.labelRightX;
          const knee = left ? 300 : 700;
          const dx = knee - c.anchor.x, dy = c.y - c.anchor.y;
          const len = Math.hypot(dx, dy) || 1;
          const edge = EDGE[c.control] ?? 0;
          const sx = c.anchor.x + (dx / len) * edge, sy = c.anchor.y + (dy / len) * edge;
          const isActive = active === c.control || (active === 'lsClick' && c.control === 'ls') || (active === 'rsClick' && c.control === 'rs');
          return (
            <g
              key={c.control}
              className="pad__callout"
              data-active={isActive || undefined}
              data-layer={layer.has(c.control) || undefined}
              data-diff={diff?.get(c.control) ?? (c.control === 'ls' ? diff?.get('lsClick') : c.control === 'rs' ? diff?.get('rsClick') : undefined)}
              style={{ ['--i' as string]: i }}
              onMouseEnter={() => onActive(c.control)}
              onMouseLeave={() => onActive(null)}
            >
              <path className="pad__line" pathLength={1} d={`M ${sx} ${sy} L ${knee} ${c.y} L ${labelX + (left ? 8 : -8)} ${c.y}`} />
              <circle className="pad__dot" cx={sx} cy={sy} r={3} />
              <text className="pad__label" x={labelX} y={c.y + 5} textAnchor={left ? 'end' : 'start'}>
                <tspan className="pad__label-main">{truncate(c.lines[0], 30)}</tspan>
                <tspan className="pad__label-sub" x={labelX} dy={18}>
                  {truncate([CONTROL_NAME[c.control], c.lines[1]].filter(Boolean).join(' · '), 36)}
                </tspan>
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
});
