import { describe, expect, it } from 'vitest';
import { overall, sparkPoints, type HealthResult, type HealthStatus } from './networkHealth';

const r = (status: HealthStatus): HealthResult => ({
  id: status, label: status, purpose: '', host: 'h', status, summary: '', detail: null, ms: 100, addresses: [], checkedAt: '',
});

describe('network health', () => {
  it('summarises the worst state', () => {
    expect(overall([])).toBeNull();
    expect(overall([r('ok'), r('ok')])).toEqual({ status: 'ok', text: 'All 2 services are reachable' });
    expect(overall([r('ok'), r('warn'), r('skipped')])).toEqual({ status: 'warn', text: 'All reachable · 1 with a caveat' });
    expect(overall([r('ok'), r('down'), r('warn')])!.text).toBe('1 of 3 services isn’t reachable');
    expect(overall([r('skipped')])!.status).toBe('skipped');
  });

  it('scales sparkline points into the box and drops failed checks', () => {
    const pts = sparkPoints([100, null, 300, 50], 72, 24, 3);
    expect(pts).toHaveLength(3);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(3);
      expect(p.x).toBeLessThanOrEqual(69);
      expect(p.y).toBeGreaterThanOrEqual(3);
      expect(p.y).toBeLessThanOrEqual(21);
    }
    expect(pts[1].y).toBeLessThan(pts[0].y); // slower is higher
    expect(sparkPoints([null], 72, 24)).toEqual([]);
  });
});
