import { describe, expect, it } from 'vitest';
import { CAPTION_FALLBACK, applyCaptionInsets, captionInsets } from './captionInsets';

const w = (captionInsetRight: number, extra: Partial<{ mode: 'desktop' | 'immersive'; fullscreen: boolean; captionInsetLeft: number }> = {}) => ({
  mode: 'desktop' as const, fullscreen: false, captionInsetRight, ...extra,
});

describe('caption insets', () => {
  it('uses the reported inset', () => {
    expect(captionInsets(w(138), true)).toEqual({ right: 138, left: 0 });
    expect(captionInsets(w(141.6, { captionInsetLeft: 20 }), true)).toEqual({ right: 141.6, left: 20 });
  });

  it('never reserves nothing in the app while the caption buttons show', () => {
    expect(captionInsets(w(0), true).right).toBe(CAPTION_FALLBACK);
    expect(captionInsets(w(Number.NaN), true).right).toBe(CAPTION_FALLBACK);
    // The browser preview has no caption buttons and may ask for 0.
    expect(captionInsets(w(0), false).right).toBe(0);
  });

  it('reserves nothing in full screen and Immersive', () => {
    expect(captionInsets(w(138, { fullscreen: true }), true)).toEqual({ right: 0, left: 0 });
    expect(captionInsets(w(138, { mode: 'immersive' }), true)).toEqual({ right: 0, left: 0 });
  });

  it('clamps', () => {
    expect(captionInsets(w(9999), true).right).toBe(480);
    expect(captionInsets(w(-5), false).right).toBe(0);
  });

  it('writes CSS variables', () => {
    const el = { style: new Map<string, string>() } as unknown as HTMLElement;
    const props: Record<string, string> = {};
    (el as unknown as { style: { setProperty: (k: string, v: string) => void } }).style = { setProperty: (k, v) => (props[k] = v) };
    applyCaptionInsets({ right: 207, left: 0 }, el);
    expect(props['--caption-inset-right']).toBe('207px');
    expect(props['--caption-inset-left']).toBe('0px');
    expect(props['--caption-gap']).toBe('8px');
  });
});
