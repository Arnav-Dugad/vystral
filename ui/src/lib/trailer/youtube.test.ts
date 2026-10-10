import { describe, expect, it } from 'vitest';
import { youTubeEmbedSrc, youTubeMessage } from './youtube';

describe('youTubeEmbedSrc', () => {
  it('builds a muted, inline, control-less embed on youtube-nocookie.com only', () => {
    const src = youTubeEmbedSrc('https://www.youtube-nocookie.com/embed/nBT2SP21f3Q', 'https://app.vystral.example')!;
    const u = new URL(src);
    expect(u.origin).toBe('https://www.youtube-nocookie.com');
    expect(u.pathname).toBe('/embed/nBT2SP21f3Q');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      autoplay: '1', mute: '1', playsinline: '1', controls: '0', rel: '0', modestbranding: '1', iv_load_policy: '3', disablekb: '1', enablejsapi: '1',
      origin: 'https://app.vystral.example',
    });
    // Every parameter is one the host's frame check allows (same list as YouTubeEmbed.cs).
    const allowed = ['autoplay', 'mute', 'playsinline', 'rel', 'controls', 'modestbranding', 'enablejsapi', 'iv_load_policy', 'disablekb', 'fs', 'cc_load_policy', 'origin'];
    for (const k of u.searchParams.keys()) expect(allowed).toContain(k);
  });

  it('refuses anything else and leaves the origin out outside the app', () => {
    expect(youTubeEmbedSrc('https://www.youtube.com/embed/nBT2SP21f3Q', 'https://app.vystral.example')).toBeNull();
    expect(youTubeEmbedSrc('https://www.youtube-nocookie.com/embed/nBT2SP21f3Q?list=x', 'https://app.vystral.example')).toBeNull();
    expect(youTubeEmbedSrc('javascript:alert(1)', 'https://app.vystral.example')).toBeNull();
    expect(youTubeEmbedSrc('https://www.youtube-nocookie.com/embed/nBT2SP21f3Q', 'http://localhost:5173')).not.toContain('origin=');
  });
});

describe('youTubeMessage', () => {
  it('reads ended and playing from both message shapes', () => {
    expect(youTubeMessage(JSON.stringify({ event: 'onStateChange', info: 0 }))).toBe('ended');
    expect(youTubeMessage(JSON.stringify({ event: 'onStateChange', info: 1 }))).toBe('playing');
    expect(youTubeMessage(JSON.stringify({ event: 'infoDelivery', info: { playerState: 0, currentTime: 90 } }))).toBe('ended');
  });

  it('ignores everything else', () => {
    for (const d of [null, 42, { event: 'onStateChange', info: 0 }, 'not json', JSON.stringify({ event: 'onReady' }), JSON.stringify([0]), 'x'.repeat(30_000)])
      expect(youTubeMessage(d)).toBeNull();
  });
});
