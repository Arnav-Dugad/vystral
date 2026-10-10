/**
 * Track D5 preview: "Not interested" memory, the "Free this week" shelf and the cloud readiness check. Everything here
 * is FICTIONAL and local: no giveaway, store or network is contacted, and "Claim" only records the request
 * (window.__vystralPreviewFreebies) for UI tests.
 *
 * Switches: `?freebies` turns the free shelf on (Discover and the Home row); `?freebiesFail` makes the source fail
 * with nothing saved; `?freebiesNone` returns an empty list. `?readiness=great|fair|poor` picks the readiness result
 * (default: good); `?readinessWifi` measures over 2.4 GHz Wi-Fi.
 */
import type { CloudReadiness, CloudReadinessProbe, FreebieItem, Freebies, Game, RecommendDismissal, Settings } from './types';
import { BridgeError } from './bridge';
import { placeholderArt } from './preview.dataSources';

type Emit = (name: string, payload: unknown) => void;

export const RECOMMEND_DEFAULT_SETTINGS: Pick<Settings, 'freebies.enabled' | 'freebies.homeRow'> = {
  'freebies.enabled': false,
  'freebies.homeRow': false,
};

export function previewRecommendSettings(params: URLSearchParams): Partial<Settings> {
  return params.has('freebies') ? { 'freebies.enabled': true, 'freebies.homeRow': true } : {};
}

declare global {
  interface Window {
    __vystralPreviewFreebies?: { opened: string[] };
  }
}

const DAY = 86_400_000;

/** Fictional giveaways. "Moss & Marrow" is a preview library game, so the shelf shows "In your library" for it. */
const GIVEAWAYS: (Omit<FreebieItem, 'image' | 'endDate'> & { days?: number })[] = [
  { id: '9100001', title: 'Lanternfall Odyssey', platform: 'epic', worth: '$24.99', url: 'https://store.epicgames.com/p/lanternfall-odyssey', days: 3 },
  { id: '9100002', title: 'Moss & Marrow', platform: 'epic', worth: '$14.99', url: 'https://store.epicgames.com/p/moss-and-marrow', days: 3 },
  { id: '9100003', title: 'Ironwake Rally', platform: 'steam', worth: '$19.99', url: 'https://store.steampowered.com/app/9100003/', days: 1 },
  { id: '9100004', title: 'The Quiet Cartographer', platform: 'gog', worth: '$9.99', url: 'https://www.gog.com/en/game/the_quiet_cartographer', days: 6 },
  { id: '9100005', title: 'Sunken Bell', platform: 'prime', worth: null, url: 'https://gaming.amazon.com/sunken-bell', days: 12 },
  { id: '9100006', title: 'Pixel Pilgrims', platform: 'itch', worth: '$4.99', url: 'https://example-dev.itch.io/pixel-pilgrims', days: undefined },
  { id: '9100007', title: 'Starfall Tactics: Admiral Pack', platform: 'steam', worth: '$2.99', url: 'https://store.steampowered.com/app/9100007/', days: 9, kind: 'dlc' },
];

export function recommendPreviewHandlers(ctx: { lib: { games: Game[] }; emit: () => Emit; settings: () => Settings }) {
  const params = new URLSearchParams(location.search);
  const dismissed: RecommendDismissal[] = [];
  const opened: string[] = [];
  if (typeof window !== 'undefined') window.__vystralPreviewFreebies = { opened };
  let fetchedAt: string | null = null;
  let readiness: CloudReadiness | null = null;

  const items = (): FreebieItem[] => (params.has('freebiesNone') ? [] : GIVEAWAYS.map((g) => ({
    id: g.id, title: g.title, platform: g.platform, worth: g.worth ?? null, url: g.url, kind: g.kind ?? 'game',
    endDate: g.days == null ? null : new Date(Math.floor(Date.now() / DAY) * DAY + g.days * DAY + 15 * 3600_000).toISOString(),
    image: placeholderArt('cover', g.title, 0, 'alternate'),
  })));

  const freebies = (refresh = false): Freebies => {
    const s = ctx.settings();
    if (!s['freebies.enabled']) return { items: [], fetchedAt: null, state: 'off', reason: null, preview: true };
    if (s['privacy.localOnly']) {
      return fetchedAt ? { items: items(), fetchedAt, state: 'stale', reason: 'offline', preview: true } : { items: [], fetchedAt: null, state: 'offline', reason: 'offline', preview: true };
    }
    if (params.has('freebiesFail')) return { items: [], fetchedAt: null, state: 'failed', reason: 'unavailable', preview: true };
    if (!fetchedAt || refresh) fetchedAt = new Date(Date.now() - (refresh ? 0 : 2 * 3600_000)).toISOString();
    return { items: items(), fetchedAt, state: 'ready', reason: null, preview: true };
  };

  const probe = (service: 'gfn' | 'xbox', host: string, base: number, spread: number, loss = 0): CloudReadinessProbe => {
    const samples = Array.from({ length: 6 }, (_, i) => Math.round(base + Math.sin(i * 1.7 + base) * spread + spread));
    const kept = samples.slice(0, Math.round(samples.length * (1 - loss)));
    const med = [...kept].sort((a, b) => a - b)[kept.length >> 1] ?? null;
    let j = 0;
    for (let i = 1; i < kept.length; i++) j += Math.abs(kept[i] - kept[i - 1]);
    return { service, host, samples: kept, attempts: samples.length, latencyMs: med, jitterMs: kept.length > 1 ? Math.round(j / (kept.length - 1)) : null, loss, error: kept.length ? null : 'No answer within 3 s' };
  };

  const measure = (): CloudReadiness => {
    const level = params.get('readiness');
    const wifi = params.has('readinessWifi') || level === 'poor';
    const [base, spread, loss] = level === 'great' ? [11, 1, 0] : level === 'fair' ? [58, 9, 0] : level === 'poor' ? [96, 34, 1 / 6] : [24, 3, 0];
    const probes = [probe('gfn', 'play.geforcenow.com', base, spread, loss), probe('xbox', 'www.xbox.com', base + 6, spread, loss)];
    const lv = level === 'great' ? 'great' : level === 'fair' ? 'fair' : level === 'poor' ? 'poor' : 'good';
    const summary = {
      great: 'Your connection looks great for cloud play.',
      good: 'Your connection looks good for cloud play.',
      fair: 'Cloud play should work, with a little more delay than ideal.',
      poor: 'Cloud play may stutter or look soft on this connection right now.',
    }[lv];
    const tips = lv === 'poor'
      ? ['You’re on 2.4 GHz Wi-Fi. A 5 GHz network or an Ethernet cable usually helps the most.', 'Some answers took much longer than others (jitter), which streams feel as stutter. Pausing downloads on this network can help.', 'One in six attempts got no answer.']
      : lv === 'fair' ? ['Round trips around 60 ms are playable, but fast games feel a little behind. Ethernet or a closer Wi-Fi access point helps.'] : [];
    return {
      checkedAt: new Date().toISOString(), link: wifi ? 'wifi' : 'ethernet', linkMbps: wifi ? 72 : 1000, wifiBand: wifi ? '2.4' : null, metered: false,
      probes, level: lv, summary, tips,
      method: 'Six short connections to each service’s public website (no game data, nothing about you). That shows the round trip to a nearby server and how steady it is. The stream itself runs from the service’s data centres, so in-game delay can differ, and the link speed is your adapter’s speed to your router, not your internet speed.',
      reason: null,
    };
  };

  return {
    'recommend.dismissed': () => dismissed,
    'recommend.dismiss': (p: { key: string; title: string; features?: string[] }) => {
      if (!/^(game:[0-9a-f]{32}|discover:(?:steam-\d{1,10}|igdb-\d{1,12}|rawg-[a-z0-9][a-z0-9-]{0,119}|wd-Q\d{1,12})|free:\d{1,10})$/.test(p?.key ?? '')) throw new BridgeError('invalid', 'Unknown item.');
      const i = dismissed.findIndex((d) => d.key === p.key);
      if (i >= 0) dismissed.splice(i, 1);
      dismissed.unshift({ key: p.key, title: String(p.title ?? '').slice(0, 200), features: (p.features ?? []).slice(0, 12), at: new Date().toISOString() });
      ctx.emit()('recommend.dismissed', [...dismissed]);
      return [...dismissed];
    },
    'recommend.undismiss': (p: { key: string }) => {
      const i = dismissed.findIndex((d) => d.key === p?.key);
      if (i >= 0) dismissed.splice(i, 1);
      ctx.emit()('recommend.dismissed', [...dismissed]);
      return [...dismissed];
    },
    'recommend.clearDismissed': () => {
      dismissed.length = 0;
      ctx.emit()('recommend.dismissed', []);
      return [];
    },
    'freebies.get': (p?: { refresh?: boolean }) => freebies(!!p?.refresh),
    'freebies.open': (p: { id: string }) => {
      const s = ctx.settings();
      if (!s['freebies.enabled']) throw new BridgeError('disabled', 'Free this week is off.');
      if (!GIVEAWAYS.some((g) => g.id === p?.id)) throw new BridgeError('notFound', 'That giveaway is no longer listed. Refresh the list.');
      opened.push(p.id);
      return true;
    },
    'cloud.readiness': async (p?: { run?: boolean }) => {
      if (!p?.run) return readiness;
      if (ctx.settings()['privacy.localOnly']) throw new BridgeError('offline', 'Offline mode is on, so VYSTRAL doesn’t contact any service. Turn it off in Settings → Privacy to check.');
      await new Promise((r) => setTimeout(r, 700));
      readiness = measure();
      return readiness;
    },
  };
}
