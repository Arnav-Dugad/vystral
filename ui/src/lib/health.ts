// Track Q: library health check — grouping, wording and score helpers (pure; tested in health.test.ts).
import type { HealthAction, HealthGroup, HealthIssue, HealthReport, HealthSeverity } from '../bridge/types';

export interface GroupMeta {
  id: HealthGroup;
  title: string;
  /** One calm sentence under the section title. */
  blurb: string;
}

export const GROUPS: GroupMeta[] = [
  { id: 'launch', title: 'Games that can’t start', blurb: 'Their program or folder isn’t where VYSTRAL expects it.' },
  { id: 'drives', title: 'Drives that aren’t connected', blurb: 'Games on these drives come back when you plug them in.' },
  { id: 'sessions', title: 'Play sessions', blurb: 'Sessions without an end, or long enough to look like the game was left open.' },
  { id: 'duplicates', title: 'Duplicates', blurb: 'The same game more than once, installed or listed.' },
  { id: 'installs', title: 'Installs and stores', blurb: 'Games stores stopped listing, and stores VYSTRAL isn’t reading.' },
  { id: 'art', title: 'Artwork', blurb: 'Missing, placeholder or blurry covers and backgrounds.' },
  { id: 'metadata', title: 'Game details', blurb: 'Games without a description, developer or genres.' },
];

export const SEVERITY_LABEL: Record<HealthSeverity, string> = { problem: 'Needs fixing', warning: 'Worth a look', info: 'Nice to fix' };

/** Fixes that run natively through `health.fix`. */
export const NATIVE_FIXES: readonly HealthAction[] = ['rescan', 'refetchArt', 'lookupMetadata', 'closeSession'];

export interface IssueSection extends GroupMeta {
  issues: HealthIssue[];
  counts: Record<HealthSeverity, number>;
  /** The most serious severity in the section. */
  worst: HealthSeverity;
}

const RANK: Record<HealthSeverity, number> = { problem: 0, warning: 1, info: 2 };

/** Issues grouped in display order (most serious section first, then the fixed group order); empty groups dropped. */
export function sections(issues: HealthIssue[]): IssueSection[] {
  const out: IssueSection[] = [];
  for (const meta of GROUPS) {
    const list = issues.filter((i) => i.group === meta.id);
    if (!list.length) continue;
    const counts = { problem: 0, warning: 0, info: 0 };
    for (const i of list) counts[i.severity]++;
    const worst: HealthSeverity = counts.problem ? 'problem' : counts.warning ? 'warning' : 'info';
    out.push({ ...meta, issues: [...list].sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.title.localeCompare(b.title)), counts, worst });
  }
  return out.sort((a, b) => RANK[a.worst] - RANK[b.worst] || GROUPS.findIndex((g) => g.id === a.id) - GROUPS.findIndex((g) => g.id === b.id));
}

export type Tier = 'excellent' | 'good' | 'fair' | 'poor';

export function tier(score: number): Tier {
  return score >= 90 ? 'excellent' : score >= 70 ? 'good' : score >= 45 ? 'fair' : 'poor';
}

export const TIER_LABEL: Record<Tier, string> = { excellent: 'In great shape', good: 'In good shape', fair: 'Needs a little care', poor: 'Needs attention' };

/** The issues "Fix all safe issues" would act on (each issue's first safe fix). */
export function safeIssues(issues: HealthIssue[]): HealthIssue[] {
  return issues.filter((i) => i.fixes.some((f) => f.safe));
}

/** A one-line summary under the score. */
export function headline(report: HealthReport): string {
  const n = report.issues.length;
  if (n === 0) return report.gameCount === 0 ? 'Nothing to check yet. Add or scan some games first.' : `All ${report.gameCount.toLocaleString()} ${report.gameCount === 1 ? 'game looks' : 'games look'} healthy.`;
  const problems = report.issues.filter((i) => i.severity === 'problem').length;
  const things = `${n.toLocaleString()} ${n === 1 ? 'thing' : 'things'}`;
  return problems
    ? `${things} to look at, ${problems === 1 ? 'one of them' : `${problems.toLocaleString()} of them`} stopping a game from starting.`
    : `${things} to tidy up. Nothing is stopping your games from starting.`;
}

/** Ring geometry: the visible arc length for a score on a circle of radius r. */
export function ringDash(score: number, r: number): { circumference: number; offset: number } {
  const circumference = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, score));
  return { circumference, offset: circumference * (1 - clamped / 100) };
}

/** "Checked 2 seconds ago · 41 ms" style meta (no Date.now dependency in tests: pass `now`). */
export function checkedLabel(report: HealthReport, now = Date.now()): string {
  const secs = Math.max(0, Math.round((now - Date.parse(report.checkedAt)) / 1000));
  const when = secs < 10 ? 'just now' : secs < 60 ? `${secs} seconds ago` : secs < 3600 ? `${Math.round(secs / 60)} min ago` : 'a while ago';
  return `Checked ${when} · took ${report.elapsedMs.toLocaleString()} ms · nothing was sent anywhere`;
}
