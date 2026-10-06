import { describe, expect, it } from 'vitest';
import type { ControllerControl, HealthIssue, HealthReport } from '../bridge/types';
import { checkedLabel, headline, ringDash, safeIssues, sections, tier } from './health';
import { ANCHORS, bindingLine, layoutCallouts, offDiagram, primary, spokenSummary, truncate, VIEW } from './gamepad';
import { previewScore } from '../bridge/preview.health';

const issue = (id: string, group: HealthIssue['group'], severity: HealthIssue['severity'], safe = false, games = 1): HealthIssue => ({
  id, kind: 'artMissing', group, severity, title: id, detail: '', gameId: null, gameIds: Array.from({ length: games }, (_, i) => `g${i}`),
  installationId: null, platform: null, platforms: [], path: null, drive: null, sessionId: null, artKind: null, otherGameId: null,
  fixes: [{ action: 'refetchArt', label: 'Get it again', safe }],
});

const report = (issues: HealthIssue[], gameCount = 40): HealthReport => ({
  checkedAt: '2026-10-06T12:00:00Z', elapsedMs: 41, score: previewScore(issues, gameCount), gameCount, issues, dismissedCount: 0, offline: false, scanning: false,
});

describe('health sections', () => {
  it('groups issues, most serious section first, severities counted', () => {
    const s = sections([issue('a', 'art', 'info'), issue('b', 'art', 'warning'), issue('c', 'launch', 'problem'), issue('d', 'metadata', 'info')]);
    expect(s.map((x) => x.id)).toEqual(['launch', 'art', 'metadata']);
    expect(s[1].counts).toEqual({ problem: 0, warning: 1, info: 1 });
    expect(s[1].worst).toBe('warning');
    expect(s[1].issues.map((i) => i.id)).toEqual(['b', 'a']);
    expect(sections([])).toEqual([]);
  });

  it('safe issues and headlines', () => {
    const list = [issue('a', 'art', 'warning', true), issue('b', 'launch', 'problem')];
    expect(safeIssues(list).map((i) => i.id)).toEqual(['a']);
    expect(headline(report(list))).toBe('2 things to look at, one of them stopping a game from starting.');
    expect(headline(report([issue('a', 'art', 'info')]))).toBe('1 thing to tidy up. Nothing is stopping your games from starting.');
    expect(headline(report([]))).toBe('All 40 games look healthy.');
    expect(headline(report([], 0))).toMatch(/Nothing to check yet/);
  });

  it('score, tiers and ring geometry', () => {
    expect(previewScore([], 10)).toBe(100);
    expect(previewScore([issue('a', 'launch', 'problem')], 100)).toBe(87); // same formula as LibraryHealth.Score in C#
    expect(previewScore([issue('a', 'art', 'info')], 100)).toBe(98);
    expect(previewScore(Array.from({ length: 500 }, (_, i) => issue(`${i}`, 'launch', 'problem')), 10)).toBe(1);
    expect([tier(100), tier(80), tier(50), tier(10)]).toEqual(['excellent', 'good', 'fair', 'poor']);
    const { circumference, offset } = ringDash(25, 10);
    expect(offset).toBeCloseTo(circumference * 0.75);
    expect(ringDash(150, 10).offset).toBe(0);
  });

  it('says where the numbers come from', () => {
    expect(checkedLabel(report([]), Date.parse('2026-10-06T12:00:05Z'))).toBe('Checked just now · took 41 ms · nothing was sent anywhere');
    expect(checkedLabel(report([]), Date.parse('2026-10-06T12:03:00Z'))).toMatch(/^Checked 3 min ago/);
  });
});

const ctl = (control: ControllerControl['control'], ...labels: string[]): ControllerControl => ({
  control, mode: null, fromLayer: false, bindings: labels.map((label) => ({ activator: 'press', slot: null, label, detail: null, kind: 'key' })),
});

describe('gamepad diagram', () => {
  it('words bindings with their activator and direction', () => {
    expect(bindingLine({ activator: 'press', slot: null, label: 'Jump', detail: 'Space', kind: 'key' })).toBe('Jump');
    expect(bindingLine({ activator: 'long', slot: null, label: 'Left Ctrl', detail: null, kind: 'key' })).toBe('Hold: Left Ctrl');
    expect(bindingLine({ activator: 'press', slot: 'up', label: 'W', detail: null, kind: 'key' })).toBe('↑ W');
    expect(bindingLine({ activator: 'double', slot: 'left', label: 'Map', detail: null, kind: 'key' })).toBe('← Double press: Map');
    expect(primary({ control: 'rs', mode: 'Mouse', fromLayer: false, bindings: [] })).toEqual({ text: 'Mouse', more: 0 });
    expect(truncate('A very long action name indeed', 10)).toBe('A very lo…');
  });

  it('lays callouts out per side, in order, never overlapping, inside the drawing', () => {
    const all = (Object.keys(ANCHORS) as ControllerControl['control'][]).map((c) => ctl(c, `${c} action`));
    const callouts = layoutCallouts(all);
    expect(callouts.some((c) => c.control === 'lsClick')).toBe(false); // merged into the stick
    const ls = callouts.find((c) => c.control === 'ls')!;
    expect(ls.lines).toEqual(['ls action', 'Click: lsClick action']);
    for (const side of ['left', 'right'] as const) {
      const ys = callouts.filter((c) => c.side === side).map((c) => c.y);
      for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(VIEW.gap);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(VIEW.top);
    }
    expect(callouts.find((c) => c.control === 'a')!.side).toBe('right');
    expect(callouts.find((c) => c.control === 'lt')!.y).toBe(ANCHORS.lt!.y); // room to sit level with its control
  });

  it('lists controls that are not on the drawing, and speaks a summary', () => {
    const controls = [ctl('a', 'Jump'), ctl('p1', 'Reload'), ctl('gyro'), { ...ctl('leftPad'), mode: 'Mouse' }];
    expect(offDiagram(controls).map((c) => c.control)).toEqual(['p1', 'leftPad']);
    expect(spokenSummary(controls)).toBe('A: Jump. Paddle P1: Reload');
    expect(layoutCallouts([ctl('b')])).toEqual([]); // nothing bound: no callout
  });
});
