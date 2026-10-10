/**
 * Track D4: the YouTube embed VYSTRAL builds for a trailer, and the player messages it listens to. Pure and tested:
 * the host's frame check (YouTubeEmbed.IsAllowedFrame) accepts exactly the parameters built here.
 */
export const YOUTUBE_ORIGIN = 'https://www.youtube-nocookie.com';

const EMBED = /^https:\/\/www\.youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{11}$/;

/** Muted autoplay, inline, no YouTube controls/keyboard/annotations, related videos from the same channel only. Null for anything but a plain embed URL. */
export function youTubeEmbedSrc(src: string, origin: string): string | null {
  if (!EMBED.test(src)) return null;
  const params = new URLSearchParams({
    autoplay: '1', mute: '1', playsinline: '1', controls: '0', rel: '0', modestbranding: '1', iv_load_policy: '3', disablekb: '1', enablejsapi: '1',
  });
  if (origin === 'https://app.vystral.example') params.set('origin', origin);
  return `${src}?${params.toString()}`;
}

/**
 * The player's state from one message (YouTube's iframe API sends JSON strings: `onStateChange` with 0 = ended,
 * 1 = playing, or `infoDelivery` with `info.playerState`). Anything else is ignored.
 */
export function youTubeMessage(data: unknown): 'playing' | 'ended' | null {
  if (typeof data !== 'string' || data.length > 20_000) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as { event?: unknown; info?: unknown };
  const state = m.event === 'onStateChange' ? m.info
    : m.event === 'infoDelivery' && m.info && typeof m.info === 'object' ? (m.info as { playerState?: unknown }).playerState : undefined;
  return state === 0 ? 'ended' : state === 1 ? 'playing' : null;
}
