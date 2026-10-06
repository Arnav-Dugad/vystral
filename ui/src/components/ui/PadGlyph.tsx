import type { CSSProperties, ReactNode } from 'react';
import { usePadFamily, type PadFamily } from '../../lib/padFamily';
import {
  BUMPER_PATH, DPAD_PATH, glyphSpec, SHAPE_WIDTH, strokeText, TEXT_METRICS, textCenterX, TRIGGER_PATH, type GlyphSpec, type PadButton,
} from '../../lib/padGlyphs';

export type { PadButton } from '../../lib/padGlyphs';

/**
 * A controller button, drawn as a crisp SVG (Track T). Face buttons are circles with their letter
 * (or PlayStation symbol) geometrically centred; bumpers and triggers have their own shapes; Menu
 * and View are the real three-line and two-squares icons. The family (Xbox, PlayStation, Nintendo)
 * follows Settings › Controller › Button glyphs ("Auto" detects the pad). Sized in em (1.5em tall by
 * default, `--pad-glyph-size` to change), so it scales with the text around it; in running text it
 * sits on the cap-height centre.
 */
export function PadGlyph({ button, family }: { button: PadButton; family?: PadFamily }) {
  const auto = usePadFamily();
  const spec = glyphSpec(button, family ?? auto);
  const w = SHAPE_WIDTH[spec.shape];
  return (
    <span
      className={`pad-glyph pad-glyph--${spec.shape}`}
      data-tone={spec.tone}
      data-button={button}
      role="img"
      aria-label={spec.name}
      style={{ '--pg-w': w / 24 } as CSSProperties}
    >
      <svg viewBox={`0 0 ${w} 24`} aria-hidden focusable="false">
        <Shape spec={spec} />
        <Ink spec={spec} />
      </svg>
    </span>
  );
}

function Shape({ spec }: { spec: GlyphSpec }) {
  const mirror = spec.mirror ? `matrix(-1 0 0 1 ${SHAPE_WIDTH[spec.shape]} 0)` : undefined;
  switch (spec.shape) {
    case 'face': case 'center': case 'stick':
      return <circle className="pg__body" cx="12" cy="12" r="11" />;
    case 'bumper':
      return <path className="pg__body" d={BUMPER_PATH} transform={mirror} />;
    case 'trigger':
      return <path className="pg__body" d={TRIGGER_PATH} transform={mirror} />;
    case 'dpad':
      return <path className="pg__body pg__body--round" d={DPAD_PATH} />;
  }
}

function Ink({ spec }: { spec: GlyphSpec }) {
  if (spec.shape === 'dpad') {
    const on = (axis: 'h' | 'v') => spec.arms === 'all' || spec.arms === axis;
    return (
      <>
        <path className="pg__ink-fill" data-dim={!on('v') || undefined} d="M12 5.4L14 8H10Z M12 18.6L14 16H10Z" />
        <path className="pg__ink-fill" data-dim={!on('h') || undefined} d="M5.4 12L8 10V14Z M18.6 12L16 10V14Z" />
      </>
    );
  }
  if (spec.shape === 'stick') {
    const m = TEXT_METRICS.stick;
    return (
      <>
        <circle className="pg__ring" cx="12" cy="12" r="7.6" />
        <path className="pg__ink" style={{ strokeWidth: m.stroke }} d={strokeText(spec.text ?? '', m.cap, 12, m.cy)} />
      </>
    );
  }
  if (spec.symbol) return <Symbol kind={spec.symbol} />;
  const m = TEXT_METRICS[spec.shape];
  return <path className="pg__ink" style={{ strokeWidth: m.stroke }} d={strokeText(spec.text ?? '', m.cap, textCenterX(spec), m.cy)} />;
}

function Symbol({ kind }: { kind: NonNullable<GlyphSpec['symbol']> }): ReactNode {
  switch (kind) {
    case 'cross':
      return <path className="pg__ink" style={{ strokeWidth: 2.2 }} d="M7.6 7.6L16.4 16.4M16.4 7.6L7.6 16.4" />;
    case 'circle':
      return <circle className="pg__ink" style={{ strokeWidth: 2.2 }} cx="12" cy="12" r="5" />;
    case 'square':
      return <rect className="pg__ink" style={{ strokeWidth: 2.1 }} x="7.5" y="7.5" width="9" height="9" rx="0.9" />;
    case 'triangle':
      // Centred between the triangle's box centre and its centroid: that reads as centred.
      return <path className="pg__ink" style={{ strokeWidth: 2.1 }} d="M12 6.75L17.2 15.7H6.8Z" />;
    case 'menu':
      return <path className="pg__ink" style={{ strokeWidth: 1.9 }} d="M7.6 8.2H16.4M7.6 12H16.4M7.6 15.8H16.4" />;
    case 'options':
      return <path className="pg__ink" style={{ strokeWidth: 1.9 }} d="M8.4 8.4H15.6M8.4 12H15.6M8.4 15.6H15.6" />;
    case 'view':
      return (
        <>
          <rect className="pg__ink" style={{ strokeWidth: 1.7 }} x="6.6" y="6.6" width="7.4" height="7.4" rx="1.5" />
          <rect className="pg__ink pg__ink--cover" style={{ strokeWidth: 1.7 }} x="10" y="10" width="7.4" height="7.4" rx="1.5" />
        </>
      );
    case 'create':
      return (
        <>
          <rect className="pg__ink" style={{ strokeWidth: 1.8 }} x="7.4" y="13.3" width="9.2" height="3.7" rx="1.85" />
          <path className="pg__ink" style={{ strokeWidth: 1.8 }} d="M12 7V10.2M8.2 8L9.5 10.6M15.8 8L14.5 10.6" />
        </>
      );
  }
}

/**
 * A hint: one or more glyphs and a label, vertically centred on one line. The label box is trimmed
 * to the cap height, so the glyph's centre and the text's optical centre line up exactly.
 */
export function PadHint({ button, children, className = '' }: { button: PadButton | PadButton[]; children?: ReactNode; className?: string }) {
  const buttons = Array.isArray(button) ? button : [button];
  return (
    <span className={`pad-hint ${className}`}>
      <span className="pad-hint__glyphs">
        {buttons.map((b) => (
          <PadGlyph key={b} button={b} />
        ))}
      </span>
      {children != null && <span className="pad-hint__label">{children}</span>}
    </span>
  );
}
