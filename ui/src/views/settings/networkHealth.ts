/** Network health (Settings → Privacy). Shapes mirror NetworkHealthService.cs. */

export type HealthStatus = 'ok' | 'warn' | 'down' | 'skipped';

export interface HealthProbeInfo {
  id: string;
  label: string;
  purpose: string;
  host: string;
  local: boolean;
  /** Shown but not run, with the reason ("Skipped: Offline mode is on"). */
  skipped: string | null;
}

export interface AddressCheck {
  address: string;
  family: 'IPv4' | 'IPv6';
  reachable: boolean;
  ms: number | null;
  error: string | null;
}

export interface HealthResult {
  id: string;
  label: string;
  purpose: string;
  host: string;
  status: HealthStatus;
  summary: string;
  detail: string | null;
  ms: number | null;
  addresses: AddressCheck[];
  checkedAt: string;
}

export const STATUS_LABEL: Record<HealthStatus, string> = { ok: 'Working', warn: 'Works, with a caveat', down: 'Not working', skipped: 'Skipped' };

/** Overall line for the panel header. */
export function overall(results: HealthResult[]): { status: HealthStatus; text: string } | null {
  const run = results.filter((r) => r.status !== 'skipped');
  if (results.length === 0) return null;
  if (run.length === 0) return { status: 'skipped', text: 'Nothing was checked' };
  const down = run.filter((r) => r.status === 'down').length;
  const warn = run.filter((r) => r.status === 'warn').length;
  if (down) return { status: 'down', text: `${down} of ${run.length} services ${down === 1 ? 'isn’t' : 'aren’t'} reachable` };
  if (warn) return { status: 'warn', text: `All reachable · ${warn} with a caveat` };
  return { status: 'ok', text: `All ${run.length} services are reachable` };
}

/**
 * SVG polyline points for a latency sparkline (oldest → newest), scaled to the series' own
 * range with a floor so small jitter doesn't look dramatic. Failed checks (null) are left out.
 */
export function sparkPoints(values: (number | null)[], width: number, height: number, pad = 2): { x: number; y: number }[] {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length === 0) return [];
  const max = Math.max(...nums, 200);
  const min = Math.min(...nums, 0);
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  const out: { x: number; y: number }[] = [];
  values.forEach((v, i) => {
    if (v === null) return;
    const t = (v - min) / (max - min || 1);
    out.push({ x: pad + i * step, y: pad + (1 - t) * (height - pad * 2) });
  });
  return out;
}
