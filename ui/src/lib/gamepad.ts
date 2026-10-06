// Track Q: the Xbox controller diagram for Steam Input layouts — control names, anchors and callout layout (pure).
import type { BindingActivator, ControlId, ControllerBinding, ControllerControl } from '../bridge/types';

/** The diagram's coordinate space (SVG viewBox). The controller sits in the middle, callouts in two columns. */
export const VIEW = { width: 1000, height: 560, labelLeftX: 268, labelRightX: 732, top: 28, bottom: 524, gap: 46 } as const;

export const CONTROL_NAME: Record<ControlId, string> = {
  a: 'A', b: 'B', x: 'X', y: 'Y', lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT',
  ls: 'Left stick', lsClick: 'Left stick click', rs: 'Right stick', rsClick: 'Right stick click',
  dpadUp: 'D-pad up', dpadDown: 'D-pad down', dpadLeft: 'D-pad left', dpadRight: 'D-pad right',
  view: 'View', menu: 'Menu', share: 'Share', guide: 'Xbox button',
  p1: 'Paddle P1', p2: 'Paddle P2', p3: 'Paddle P3', p4: 'Paddle P4',
  leftPad: 'Left trackpad', rightPad: 'Right trackpad', centerPad: 'Touchpad', gyro: 'Gyro',
};

/** Where each control is on the drawing, and which side its callout goes. Off-diagram controls have no anchor. */
export const ANCHORS: Partial<Record<ControlId, { x: number; y: number; side: 'left' | 'right' }>> = {
  lt: { x: 392, y: 112, side: 'left' },
  rt: { x: 608, y: 112, side: 'right' },
  lb: { x: 378, y: 158, side: 'left' },
  rb: { x: 622, y: 158, side: 'right' },
  view: { x: 462, y: 232, side: 'left' },
  guide: { x: 500, y: 190, side: 'left' },
  share: { x: 500, y: 250, side: 'right' },
  menu: { x: 538, y: 232, side: 'right' },
  ls: { x: 404, y: 246, side: 'left' },
  lsClick: { x: 404, y: 246, side: 'left' },
  dpadUp: { x: 452, y: 300, side: 'left' },
  dpadLeft: { x: 430, y: 322, side: 'left' },
  dpadRight: { x: 474, y: 322, side: 'left' },
  dpadDown: { x: 452, y: 344, side: 'left' },
  y: { x: 596, y: 214, side: 'right' },
  x: { x: 570, y: 240, side: 'right' },
  b: { x: 622, y: 240, side: 'right' },
  a: { x: 596, y: 266, side: 'right' },
  rs: { x: 548, y: 322, side: 'right' },
  rsClick: { x: 548, y: 322, side: 'right' },
};

export const ACTIVATOR_LABEL: Record<BindingActivator, string | null> = {
  press: null, long: 'Hold', double: 'Double press', start: 'On press', release: 'On release', soft: 'Soft pull',
  chord: 'Chord', turbo: 'Turbo', analog: null, modeshift: 'Mode shift', other: null,
};

const SLOT_LABEL: Record<string, string> = { up: '↑', down: '↓', left: '←', right: '→', click: 'Click', outer: 'Outer ring' };

/** One line of a callout: "Jump", "Hold: Left Ctrl", "↑ Move Forward". */
export function bindingLine(b: ControllerBinding): string {
  const prefix = [b.slot ? SLOT_LABEL[b.slot] ?? b.slot : null, ACTIVATOR_LABEL[b.activator]].filter(Boolean).join(' ');
  return prefix ? `${prefix}${b.slot && !ACTIVATOR_LABEL[b.activator] ? ' ' : ': '}${b.label}` : b.label;
}

/** The headline for a control (its main binding, or how it behaves), plus how many more there are. */
export function primary(control: ControllerControl): { text: string; more: number } {
  const main = control.bindings.find((b) => b.activator === 'analog') ?? control.bindings.find((b) => b.activator === 'press' && !b.slot) ?? control.bindings[0];
  const text = main ? bindingLine(main) : control.mode ?? '';
  return { text, more: Math.max(0, control.bindings.length - (main ? 1 : 0)) };
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

export interface Callout {
  control: ControlId;
  side: 'left' | 'right';
  anchor: { x: number; y: number };
  /** Label baseline position. */
  y: number;
  lines: string[];
}

/**
 * Places a callout for every bound control that has an anchor: per side, in the anchors' top-to-bottom order,
 * spaced at least `gap` apart and kept inside the drawing (pushed up from the bottom if needed).
 * Sticks merge their click into one callout.
 */
export function layoutCallouts(controls: ControllerControl[], maxLines = 2): Callout[] {
  const byId = new Map(controls.map((c) => [c.control, c]));
  const out: Callout[] = [];
  for (const side of ['left', 'right'] as const) {
    const items: Callout[] = [];
    for (const c of controls) {
      const anchor = ANCHORS[c.control];
      if (!anchor || anchor.side !== side) continue;
      if (c.control === 'lsClick' && byId.has('ls')) continue;
      if (c.control === 'rsClick' && byId.has('rs')) continue;
      const lines: string[] = [];
      const p = primary(c);
      if (p.text) lines.push(p.text);
      const click = c.control === 'ls' ? byId.get('lsClick') : c.control === 'rs' ? byId.get('rsClick') : undefined;
      if (click?.bindings.length) lines.push(`Click: ${primary(click).text}`);
      else if (c.bindings.length > 1) {
        const second = c.bindings.find((b) => bindingLine(b) !== p.text);
        if (second) lines.push(bindingLine(second));
      }
      if (!lines.length) continue;
      items.push({ control: c.control, side, anchor: { x: anchor.x, y: anchor.y }, y: anchor.y, lines: lines.slice(0, maxLines) });
    }
    items.sort((a, b) => a.anchor.y - b.anchor.y || a.anchor.x - b.anchor.x);
    // Each label is two text lines; keep them `gap` apart, top to bottom, inside the drawing.
    let next: number = VIEW.top;
    for (const it of items) {
      it.y = Math.max(it.anchor.y, next);
      next = it.y + VIEW.gap;
    }
    let ceiling: number = VIEW.bottom;
    for (let i = items.length - 1; i >= 0; i--) {
      items[i].y = Math.max(VIEW.top + i * VIEW.gap, Math.min(items[i].y, ceiling));
      ceiling = items[i].y - VIEW.gap;
    }
    out.push(...items);
  }
  return out;
}

/** Controls that aren't on the Xbox drawing (paddles, trackpads, gyro, Xbox button) but are bound. */
export function offDiagram(controls: ControllerControl[]): ControllerControl[] {
  return controls.filter((c) => !ANCHORS[c.control] && (c.bindings.length > 0 || c.mode));
}

/** A spoken summary of a set for the diagram's accessible name. */
export function spokenSummary(controls: ControllerControl[]): string {
  return controls
    .filter((c) => c.bindings.length)
    .map((c) => `${CONTROL_NAME[c.control]}: ${c.bindings.map(bindingLine).join(', ')}`)
    .join('. ');
}
