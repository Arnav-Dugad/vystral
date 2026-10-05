/**
 * A deliberately small HLS reader for Steam's store trailers. Steam serves every trailer the
 * same way (checked 2026-10 on old and new apps): a master playlist with four H.264 variants
 * (1080p/720p/480p/360p) sharing one AAC audio rendition, each a VOD media playlist of
 * ~3-second fragmented-MP4 segments with an EXT-X-MAP init segment and relative URIs. That
 * is exactly what Media Source Extensions accept natively, so no transmuxing is needed.
 * Anything outside that shape is rejected and the hero art simply stays.
 */

export interface HlsVariant {
  uri: string;
  bandwidth: number;
  width: number | null;
  height: number | null;
  /** e.g. avc1.640029 */
  videoCodec: string | null;
  /** e.g. mp4a.40.2 */
  audioCodec: string | null;
  audioGroup: string | null;
}

export interface HlsAudio {
  groupId: string;
  uri: string;
  isDefault: boolean;
}

export interface HlsMaster {
  variants: HlsVariant[];
  audio: HlsAudio[];
}

export interface HlsMedia {
  init: string | null;
  segments: { uri: string; duration: number }[];
  ended: boolean;
  totalDuration: number;
}

/** Relative URIs only: letters, digits and _ . - /, no "..", no scheme, no query. */
const SAFE_URI = /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_./-]{0,119}$/;
export const isSafeUri = (uri: string) => SAFE_URI.test(uri);

/** Parses `KEY=value,KEY="quoted, value"` attribute lists. */
export function parseAttributes(list: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(list))) out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  return out;
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

export function parseMaster(text: string): HlsMaster | null {
  const ls = lines(text);
  if (ls[0] !== '#EXTM3U') return null;
  const variants: HlsVariant[] = [];
  const audio: HlsAudio[] = [];
  for (let i = 1; i < ls.length; i++) {
    const l = ls[i];
    if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(l.slice('#EXT-X-MEDIA:'.length));
      if (a.TYPE === 'AUDIO' && a.URI && a['GROUP-ID'] && isSafeUri(a.URI)) audio.push({ groupId: a['GROUP-ID'], uri: a.URI, isDefault: a.DEFAULT === 'YES' });
    } else if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributes(l.slice('#EXT-X-STREAM-INF:'.length));
      const uri = ls[i + 1];
      if (!uri || uri.startsWith('#') || !isSafeUri(uri)) continue;
      i++;
      const [w, h] = (a.RESOLUTION ?? '').split('x').map((n) => Number(n));
      const codecs = (a.CODECS ?? '').split(',').map((c) => c.trim());
      variants.push({
        uri,
        bandwidth: Number(a.BANDWIDTH) || 0,
        width: Number.isFinite(w) && w > 0 ? w : null,
        height: Number.isFinite(h) && h > 0 ? h : null,
        videoCodec: codecs.find((c) => /^(avc1|avc3|hvc1|hev1|av01|vp09)\./.test(c)) ?? null,
        audioCodec: codecs.find((c) => /^(mp4a|opus|ac-3|ec-3)/.test(c)) ?? null,
        audioGroup: a.AUDIO ?? null,
      });
    }
  }
  return variants.length ? { variants, audio } : null;
}

export function parseMedia(text: string): HlsMedia | null {
  const ls = lines(text);
  if (ls[0] !== '#EXTM3U') return null;
  let init: string | null = null;
  const segments: { uri: string; duration: number }[] = [];
  let pending: number | null = null;
  let ended = false;
  for (let i = 1; i < ls.length; i++) {
    const l = ls[i];
    if (l.startsWith('#EXT-X-MAP:')) {
      const uri = parseAttributes(l.slice('#EXT-X-MAP:'.length)).URI;
      if (!uri || !isSafeUri(uri)) return null;
      init = uri;
    } else if (l.startsWith('#EXTINF:')) {
      pending = Number.parseFloat(l.slice('#EXTINF:'.length));
    } else if (l === '#EXT-X-ENDLIST') {
      ended = true;
    } else if (l.startsWith('#EXT-X-KEY') && !l.includes('METHOD=NONE')) {
      return null; // encrypted streams are not supported
    } else if (!l.startsWith('#')) {
      if (!isSafeUri(l)) return null;
      segments.push({ uri: l, duration: pending != null && Number.isFinite(pending) ? pending : 0 });
      pending = null;
    }
  }
  if (!segments.length) return null;
  return { init, segments, ended, totalDuration: segments.reduce((n, s) => n + s.duration, 0) };
}

/**
 * The variant to play: the largest at or below `maxHeight` whose codec the browser can decode,
 * else the smallest decodable one. `canPlay` is MediaSource.isTypeSupported in the app.
 */
export function pickVariant(variants: readonly HlsVariant[], maxHeight: number, canPlay: (mime: string) => boolean): HlsVariant | null {
  const playable = variants.filter((v) => v.videoCodec && canPlay(`video/mp4; codecs="${v.videoCodec}"`));
  if (!playable.length) return null;
  const h = (v: HlsVariant) => v.height ?? 0;
  const fits = playable.filter((v) => h(v) > 0 && h(v) <= maxHeight).sort((a, b) => h(b) - h(a) || b.bandwidth - a.bandwidth);
  return fits[0] ?? [...playable].sort((a, b) => h(a) - h(b) || a.bandwidth - b.bandwidth)[0];
}

/** The audio rendition for a variant: its group's default, else the group's first. */
export function pickAudio(master: HlsMaster, variant: HlsVariant): HlsAudio | null {
  if (!variant.audioGroup) return null;
  const group = master.audio.filter((a) => a.groupId === variant.audioGroup);
  return group.find((a) => a.isDefault) ?? group[0] ?? null;
}

/** Resolves a playlist-relative URI against the folder of `base` (a same-origin proxy URL). */
export function resolveUri(base: string, uri: string): string {
  const u = new URL(base);
  u.search = '';
  u.pathname = u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1) + uri;
  return u.toString();
}
