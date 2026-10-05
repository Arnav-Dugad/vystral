/**
 * Track G preview: a fictional Windows accent (and no Mica — a browser can't draw it). The accent
 * changes once shortly after start, like a user changing their Windows colour, so the UI's live
 * update path is exercised too.
 */
import type { SystemAppearance } from './types';

type Emit = (name: string, payload: unknown) => void;

/** Fictional Windows accents (a teal, then an orange). */
export const PREVIEW_SYSTEM_ACCENTS: Pick<SystemAppearance, 'accent' | 'accentLight' | 'accentDark'>[] = [
  { accent: '#008B8B', accentLight: ['#2AA8A4', '#5CC4BE', '#8FDFD9'], accentDark: ['#006E6E', '#005252', '#003838'] },
  { accent: '#D9630B', accentLight: ['#EC8236', '#F7A161', '#FFC08F'], accentDark: ['#B04F06', '#863B03', '#5D2801'] },
];

export function shellPreviewHandlers(ctx: { emit: () => Emit; timers: number[] }) {
  let requested = false;
  let state: SystemAppearance = {
    ...PREVIEW_SYSTEM_ACCENTS[0],
    systemDark: true, highContrast: false, transparencyEffects: true, energySaver: false,
    backdropSupported: false, backdropRequested: false, backdrop: 'none', backdropReason: 'preview',
  };
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  if (params.has('accentChange')) {
    ctx.timers.push(window.setTimeout(() => {
      state = { ...state, ...PREVIEW_SYSTEM_ACCENTS[1] };
      ctx.emit()('system.accent', state);
    }, 1500));
  }
  return {
    'system.accent': (): SystemAppearance => state,
    'window.backdrop': (p: { value?: boolean }): SystemAppearance => {
      requested = !!p?.value;
      state = { ...state, backdropRequested: requested, backdropReason: requested ? 'preview' : 'notRequested' };
      return state;
    },
  } satisfies Record<string, (p: never) => unknown>;
}
