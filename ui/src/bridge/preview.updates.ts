/**
 * Track J preview: "What's new" state, "New" badges, a rollback notice, and Network health with
 * fictional results. Defaults keep the interface settled (no tour, no badges) so other tests are
 * unaffected; URL parameters simulate the interesting cases:
 *   ?whatsnew=0.3.1   last seen version 0.3.1 → the tour for the current version shows once
 *   ?badges           this PC "started" on 0.2.0 → 0.3/0.4 "New" badges show
 *   ?rollback         a rollback notice (0.4.1 → current) is waiting
 * The state lives in localStorage, so a reload behaves like the next start.
 */
import type { Settings } from './types';
import type { HealthProbeInfo, HealthResult } from '../views/settings/networkHealth';
import { CURATED } from '../whatsnew/tours';
import { RELEASES } from '../whatsnew/releases';
import { compareVersions } from '../whatsnew/version';

const KEY = 'vystral.preview.whatsNew';

interface Stored {
  lastSeenVersion: string | null;
  firstVersion: string | null;
  seenBadges: string[];
  rollbackNotice: { from: string; to: string; at: string } | null;
}

/** The preview "installed version": the newest version with a tour or changelog section. */
export const PREVIEW_VERSION = [...CURATED.map((t) => t.version), ...RELEASES.map((r) => r.version)].sort((a, b) => compareVersions(b, a))[0] ?? '0.4.0';

function read(params: URLSearchParams): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Stored;
  } catch {
    // fall through to the seeded state
  }
  const seeded: Stored = {
    lastSeenVersion: params.get('whatsnew') || PREVIEW_VERSION,
    firstVersion: params.has('badges') ? '0.2.0' : PREVIEW_VERSION,
    seenBadges: [],
    rollbackNotice: params.has('rollback') ? { from: '0.4.1', to: PREVIEW_VERSION, at: new Date().toISOString() } : null,
  };
  write(seeded);
  return seeded;
}

function write(s: Stored) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // storage unavailable: the state lasts for this page only
  }
}

const PROBES: Omit<HealthProbeInfo, 'skipped'>[] = [
  { id: 'github.api', label: 'GitHub releases', purpose: 'Update checks', host: 'api.github.com', local: false },
  { id: 'github.download', label: 'GitHub downloads', purpose: 'Downloading updates', host: 'release-assets.githubusercontent.com', local: false },
  { id: 'steam.store', label: 'Steam store', purpose: 'Game details', host: 'store.steampowered.com', local: false },
  { id: 'steam.cdn', label: 'Steam image servers', purpose: 'Artwork', host: 'shared.akamai.steamstatic.com', local: false },
  { id: 'steam.video', label: 'Steam video servers', purpose: 'Trailers', host: 'video.akamai.steamstatic.com', local: false },
];

export function updatesPreviewHandlers(ctx: { settings: () => Settings }) {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  let state = read(params);
  const save = (next: Stored) => {
    state = next;
    write(next);
  };

  const skipped = (id: string): string | null => {
    const s = ctx.settings();
    if (s['privacy.localOnly']) return 'Skipped: Offline mode is on';
    if ((id === 'steam.store' || id === 'steam.video') && !s['library.fetchMetadata']) return 'Not used: game details are off';
    if (id === 'steam.cdn' && !s['library.fetchArtwork']) return 'Not used: artwork downloads are off';
    if (id === 'steam.video' && s['dataSaver.enabled']) return 'Not used: Data saver is on';
    return null;
  };

  const jitter = (ms: number) => Math.round(ms * (0.8 + Math.random() * 0.45));

  const result = (p: Omit<HealthProbeInfo, 'skipped'>): HealthResult => {
    const at = new Date().toISOString();
    const base = { id: p.id, label: p.label, purpose: p.purpose, host: p.host, checkedAt: at };
    const skip = skipped(p.id);
    if (skip) return { ...base, status: 'skipped', summary: skip, detail: null, ms: null, addresses: [] };
    switch (p.id) {
      case 'github.download': {
        const ms = jitter(310);
        return {
          ...base, status: 'warn', ms,
          summary: `One of ${p.host}'s addresses (185.199.109.133) isn't reachable from this network; VYSTRAL uses the others`,
          detail: `Answered in ${ms} ms.`,
          addresses: [
            { address: '185.199.108.133', family: 'IPv4', reachable: true, ms: jitter(24), error: null },
            { address: '185.199.109.133', family: 'IPv4', reachable: false, ms: null, error: 'No answer within 3 s' },
            { address: '185.199.110.133', family: 'IPv4', reachable: true, ms: jitter(26), error: null },
            { address: '185.199.111.133', family: 'IPv4', reachable: true, ms: jitter(25), error: null },
          ],
        };
      }
      case 'steam.video': {
        const ms = jitter(1750);
        return {
          ...base, status: 'warn', ms, summary: `Slow: ${(ms / 1000).toFixed(1)} s`, detail: 'It works, just slowly. Downloads may take longer.',
          addresses: [{ address: '23.55.161.18', family: 'IPv4', reachable: true, ms: jitter(40), error: null }],
        };
      }
      default: {
        const ms = jitter(p.id === 'github.api' ? 140 : 90);
        return {
          ...base, status: 'ok', ms, summary: `OK · ${ms} ms`, detail: null,
          addresses: [
            { address: '20.207.73.85', family: 'IPv4', reachable: true, ms: jitter(18), error: null },
            { address: '2606:50c0:8000::85', family: 'IPv6', reachable: true, ms: jitter(20), error: null },
          ],
        };
      }
    }
  };

  return {
    'whatsNew.state': () => ({ currentVersion: PREVIEW_VERSION, ...state }),
    'whatsNew.markSeen': (p: { version: string }) => {
      save({ ...state, lastSeenVersion: p.version });
      return true;
    },
    'whatsNew.badgesSeen': (p: { keys: string[] }) => {
      save({ ...state, seenBadges: [...new Set([...state.seenBadges, ...p.keys])] });
      return true;
    },
    'update.dismissRollbackNotice': () => {
      save({ ...state, rollbackNotice: null });
      return true;
    },
    'network.health.list': (): HealthProbeInfo[] => PROBES.map((p) => ({ ...p, skipped: skipped(p.id) })),
    'network.health.check': async (p: { id: string | null }): Promise<HealthResult[]> => {
      const probes = PROBES.filter((x) => !p?.id || x.id === p.id);
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 500));
      return probes.map(result);
    },
  } satisfies Record<string, (p: never) => unknown>;
}
