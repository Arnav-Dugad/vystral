/**
 * Track D5 preview: "Not interested" memory and the cloud readiness check. Everything here is FICTIONAL and local:
 * nothing is measured or contacted. ("Free this week" reads Track D4's freebies.get, faked in preview.identity.ts.)
 *
 * Switches: `?freebies` (Track D4: GamerPower and Epic on) also turns on the Home row; `?readiness=great|fair|poor`
 * picks the readiness result (default: good); `?readinessWifi` measures over Wi-Fi.
 */
import type { CloudReadiness, CloudReadinessProbe, Game, RecommendDismissal, Settings } from './types';
import { BridgeError } from './bridge';

type Emit = (name: string, payload: unknown) => void;

export const RECOMMEND_DEFAULT_SETTINGS: Pick<Settings, 'freebies.homeRow'> = {
  'freebies.homeRow': false,
};

export function previewRecommendSettings(params: URLSearchParams): Partial<Settings> {
  return params.has('freebies') ? { 'freebies.homeRow': true } : {};
}

/** Same shapes as RecommendStore.IsKey on the native side. */
const KEY = /^(game:[0-9a-f]{32}|discover:(?:steam-\d{1,10}|igdb-\d{1,12}|rawg-[a-z0-9][a-z0-9-]{0,119}|wd-Q\d{1,12})|free:(?:gp-\d{1,9}|epic-[0-9a-f]{16,32}))$/;

export function recommendPreviewHandlers(ctx: { lib: { games: Game[] }; emit: () => Emit; settings: () => Settings }) {
  const params = new URLSearchParams(location.search);
  const dismissed: RecommendDismissal[] = [];
  let readiness: CloudReadiness | null = null;

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
      ? ['Round trips around 96 ms make games feel slow to respond. GeForce NOW recommends under 80 ms, and under 40 ms for fast games.',
        'Some answers took much longer than others (jitter), which streams feel as stutter. Pausing downloads and video on this network can help.',
        '2 of 12 attempts got no answer.', 'On Wi-Fi, a 5 GHz network or an Ethernet cable gives the steadiest stream.']
      : lv === 'fair' ? ['Round trips around 58 ms are playable, but fast games feel a little behind. Ethernet or a closer Wi-Fi access point helps.'] : [];
    return {
      checkedAt: new Date().toISOString(), link: wifi ? 'wifi' : 'ethernet', linkMbps: wifi ? 72 : 1000, wifiBand: null, metered: false,
      probes, level: lv, summary, tips,
      method: 'Six short connections to each service’s public website (no game data, nothing about you). That shows the round trip to a nearby server and how steady it is. The stream itself runs from the service’s data centres, so in-game delay can differ, and the link speed is your adapter’s speed to your router, not your internet speed.',
      reason: null,
    };
  };

  return {
    'recommend.dismissed': () => dismissed,
    'recommend.dismiss': (p: { key: string; title: string; features?: string[] }) => {
      if (!KEY.test(p?.key ?? '')) throw new BridgeError('invalid', 'Unknown item.');
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
