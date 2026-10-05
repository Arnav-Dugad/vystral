import { describe, expect, it } from 'vitest';
import { isSafeUri, parseAttributes, parseMaster, parseMedia, pickAudio, pickVariant, resolveUri } from './hls';
import { autoplayBlock, effectiveQuality, manualBlock, maxTrailerHeight, type TrailerConditions } from './policy';

// Captured from a real Steam store trailer (2026-10), unchanged.
const MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Default",AUTOSELECT=YES,DEFAULT=YES,URI="hls_264_4_audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=5800000,CODECS="avc1.640029,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=30,AUDIO="audio"
hls_264_0_video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2600000,CODECS="avc1.640029,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=30,AUDIO="audio"
hls_264_1_video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1400000,CODECS="avc1.640029,mp4a.40.2",RESOLUTION=854x480,FRAME-RATE=30,AUDIO="audio"
hls_264_2_video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.640029,mp4a.40.2",RESOLUTION=640x360,FRAME-RATE=30,AUDIO="audio"
hls_264_3_video.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-TARGETDURATION:3
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="dash_h264/init-stream1.m4s"
#EXTINF:3
dash_h264/chunk-stream1-00001.m4s
#EXTINF:3
dash_h264/chunk-stream1-00002.m4s
#EXTINF:0.9
dash_h264/chunk-stream1-00003.m4s
#EXT-X-ENDLIST
`;

const all = () => true;

describe('HLS parsing', () => {
  it('reads attributes including quoted commas', () => {
    expect(parseAttributes('BANDWIDTH=1,CODECS="avc1.640029,mp4a.40.2",AUDIO="audio"')).toEqual({ BANDWIDTH: '1', CODECS: 'avc1.640029,mp4a.40.2', AUDIO: 'audio' });
  });

  it('parses Steam’s master playlist', () => {
    const m = parseMaster(MASTER)!;
    expect(m.variants).toHaveLength(4);
    expect(m.variants[1]).toEqual({ uri: 'hls_264_1_video.m3u8', bandwidth: 2600000, width: 1280, height: 720, videoCodec: 'avc1.640029', audioCodec: 'mp4a.40.2', audioGroup: 'audio' });
    expect(m.audio).toEqual([{ groupId: 'audio', uri: 'hls_264_4_audio.m3u8', isDefault: true }]);
    expect(pickAudio(m, m.variants[0])?.uri).toBe('hls_264_4_audio.m3u8');
  });

  it('parses a media playlist with its init segment', () => {
    const p = parseMedia(MEDIA)!;
    expect(p.init).toBe('dash_h264/init-stream1.m4s');
    expect(p.segments.map((s) => s.uri)).toEqual(['dash_h264/chunk-stream1-00001.m4s', 'dash_h264/chunk-stream1-00002.m4s', 'dash_h264/chunk-stream1-00003.m4s']);
    expect(p.ended).toBe(true);
    expect(p.totalDuration).toBeCloseTo(6.9);
  });

  it('rejects absolute, parent or query URIs and encrypted streams', () => {
    for (const bad of ['https://evil.example/a.m4s', '../a.m4s', 'a/../../b.m4s', '/abs.m4s', 'a.m4s?x=1', '']) expect(isSafeUri(bad)).toBe(false);
    expect(parseMedia(MEDIA.replace('dash_h264/chunk-stream1-00002.m4s', 'https://evil.example/x.m4s'))).toBeNull();
    expect(parseMedia(MEDIA.replace('#EXT-X-MAP:URI="dash_h264/init-stream1.m4s"', '#EXT-X-MAP:URI="../init.m4s"'))).toBeNull();
    expect(parseMedia(MEDIA.replace('#EXT-X-ENDLIST', '#EXT-X-KEY:METHOD=AES-128,URI="k"'))).toBeNull();
    expect(parseMaster(MASTER.replace('hls_264_0_video.m3u8', '//evil.example/v.m3u8'))!.variants).toHaveLength(3);
    expect(parseMaster('not a playlist')).toBeNull();
    expect(parseMedia('#EXTM3U\n#EXT-X-ENDLIST')).toBeNull();
  });

  it('picks the largest variant within the cap that can be decoded', () => {
    const v = parseMaster(MASTER)!.variants;
    expect(pickVariant(v, 720, all)?.height).toBe(720);
    expect(pickVariant(v, 1080, all)?.height).toBe(1080);
    expect(pickVariant(v, 300, all)?.height).toBe(360); // nothing fits: smallest
    expect(pickVariant(v, 1080, () => false)).toBeNull();
  });

  it('resolves URIs inside the proxy folder and drops the query', () => {
    const base = 'https://media.vystral.example/trailer/0123456789abcdef0123456789abcdef/hls_264_master.m3u8?x=1';
    expect(resolveUri(base, 'hls_264_1_video.m3u8')).toBe('https://media.vystral.example/trailer/0123456789abcdef0123456789abcdef/hls_264_1_video.m3u8');
    expect(resolveUri(base.replace('hls_264_master.m3u8?x=1', 'hls_264_1_video.m3u8'), 'dash_h264/init-stream1.m4s')).toBe(
      'https://media.vystral.example/trailer/0123456789abcdef0123456789abcdef/dash_h264/init-stream1.m4s',
    );
  });
});

describe('trailer policy', () => {
  const ok: TrailerConditions = {
    active: true, autoplay: true, dataSaver: false, offline: false, reducedMotion: false, quality: 'balanced', gameActive: false, hidden: false, safeMode: false,
  };

  it('autoplays only when nothing blocks it', () => {
    expect(autoplayBlock(ok)).toBeNull();
    const cases: [Partial<TrailerConditions>, string][] = [
      [{ active: false }, 'inactive'],
      [{ autoplay: false }, 'autoplayOff'],
      [{ dataSaver: true }, 'dataSaver'],
      [{ offline: true }, 'offline'],
      [{ reducedMotion: true }, 'reducedMotion'],
      [{ quality: 'low' }, 'lowQuality'],
      [{ gameActive: true }, 'gameActive'],
      [{ hidden: true }, 'hidden'],
      [{ safeMode: true }, 'safeMode'],
    ];
    for (const [patch, reason] of cases) expect(autoplayBlock({ ...ok, ...patch })).toBe(reason);
  });

  it('lets a deliberate play through reduced motion and the autoplay switch, but never through data saver or a running game', () => {
    expect(manualBlock({ ...ok, reducedMotion: true, autoplay: false })).toBeNull();
    expect(manualBlock({ ...ok, dataSaver: true })).toBe('dataSaver');
    expect(manualBlock({ ...ok, gameActive: true })).toBe('gameActive');
    expect(manualBlock({ ...ok, offline: true })).toBe('offline');
  });

  it('caps resolution by quality', () => {
    expect(maxTrailerHeight('balanced', 1440)).toBe(720);
    expect(maxTrailerHeight('high', 1440)).toBe(1080);
    expect(maxTrailerHeight('high', 800)).toBe(720);
  });

  it('resolves auto quality like the app shell', () => {
    expect(effectiveQuality('auto', 4)).toBe('low');
    expect(effectiveQuality('auto', 16)).toBe('balanced');
    expect(effectiveQuality('high', 2)).toBe('high');
  });
});
