// Track D5: recommend.v2 — "Not interested" memory and the cloud readiness check.
// Mirror of src/Vystral.Windows/Services/RecommendStore.cs and Cloud/CloudReadiness.cs.

/** One "Not interested" (recommend.dismissed / recommend.dismiss). Stored in ui-state/recommend.json on this PC only. */
export interface RecommendDismissal {
  /** `game:<library id>` | `discover:<discover key>` | `free:<giveaway id>` */
  key: string;
  title: string;
  /** Feature keys of what was dismissed (k:…, s:…, d:…), at most 12, so the taste profile learns from it. */
  features: string[];
  at: string;
}

/** One host measured by cloud.readiness. */
export interface CloudReadinessProbe {
  service: 'gfn' | 'xbox';
  /** The public host that was measured (e.g. play.geforcenow.com). */
  host: string;
  /** TCP connection times in ms, one per attempt that answered. */
  samples: number[];
  /** Attempts made. */
  attempts: number;
  /** Median connect time (≈ one round trip), ms. */
  latencyMs: number | null;
  /** Mean absolute difference between consecutive samples, ms. */
  jitterMs: number | null;
  /** Share of attempts that got no answer, 0..1. */
  loss: number;
  error: string | null;
}

export type CloudReadinessLevel = 'great' | 'good' | 'fair' | 'poor' | 'unknown';

/** call('cloud.readiness', { run }): measured only when asked (run: true); otherwise the last result, or null. */
export interface CloudReadiness {
  checkedAt: string;
  /** 'ethernet' | 'wifi' | 'cellular' | 'other' | 'unknown' */
  link: 'ethernet' | 'wifi' | 'cellular' | 'other' | 'unknown';
  /** The adapter's link speed to your router or access point (Mbps), not your internet speed. */
  linkMbps: number | null;
  /** Wi-Fi band when Windows reports it ('5' = 5 GHz, '6' = 6 GHz, '2.4'). */
  wifiBand: '2.4' | '5' | '6' | null;
  metered: boolean;
  probes: CloudReadinessProbe[];
  level: CloudReadinessLevel;
  /** One plain sentence. */
  summary: string;
  /** Specific, honest advice lines. */
  tips: string[];
  /** What was measured, in plain words (always shown). */
  method: string;
  /** offline | null */
  reason: string | null;
}

/** call('discover.cloudMap', { keys }): which Discover results a downloaded cloud catalogue lists. No request is made. */
export interface DiscoverCloudMap {
  /** Cloud play is on (catalogues are only downloaded then). */
  enabled: boolean;
  map: Record<string, { service: 'gfn' | 'xbox'; match: 'store' | 'title'; playType: string | null }[]>;
}
