// Track X: library tools — pure helpers for the Home "new issue" card, the Steam Input compare view, the uninstall
// advisor and the Files tab (saves and mods). Tested in libraryTools.test.ts.
import type {
  ControlId, ControllerCompare, ControllerDiffChange, Game, HealthFix, HealthIssue, HealthNews, ModItem, ModSource, SavePlatform,
  SavesLookup, UninstallAdvice,
} from '../bridge/types';
import { formatBytes, formatRelative, lastPlayed, playSeconds, plural } from './format';

// ---------- Home: new health issues ----------

/** Fixes that are safe to offer as one tap on Home (they never delete anything; navigation-only fixes go through "See all"). */
const ONE_TAP: readonly HealthFix['action'][] = ['locate', 'refetchArt', 'lookupMetadata', 'closeSession', 'enableStore', 'openVersions', 'openGame', 'rescan'];

/** The one-tap fix for an issue on Home, or null. A missing drive's rescan can't help until it's back, so it isn't offered. */
export function oneTapFix(issue: HealthIssue): HealthFix | null {
  if (issue.kind === 'missingDrive') return null;
  return issue.fixes.find((f) => f.safe && ONE_TAP.includes(f.action)) ?? issue.fixes.find((f) => ONE_TAP.includes(f.action)) ?? null;
}

const EYEBROW: Partial<Record<HealthIssue['kind'], string>> = {
  missingDrive: 'A drive was disconnected',
  brokenShortcut: 'A shortcut stopped working',
  launchTargetMissing: 'A game can’t start',
  openSession: 'A session never ended',
  steamLibraryDuplicate: 'A game is installed twice',
  artFileMissing: 'Some art went missing',
  artPlaceholder: 'Some art is a placeholder',
  artMissing: 'A cover is missing',
};

export interface NewsCopy {
  eyebrow: string;
  title: string;
  body: string;
  /** "2 more things to look at", or null. */
  more: string | null;
}

export function newsCopy(news: HealthNews): NewsCopy | null {
  const [top, ...rest] = news.issues;
  if (!top) return null;
  const eyebrow = EYEBROW[top.kind] ?? (top.severity === 'problem' ? 'Something needs fixing' : 'Something new to look at');
  return { eyebrow, title: top.title, body: top.detail, more: rest.length ? `${plural(rest.length, 'more thing')} to look at` : null };
}

// ---------- Steam Input compare ----------

export const CHANGE_LABEL: Record<ControllerDiffChange, string> = { added: 'Added', removed: 'Removed', changed: 'Changed' };

/** Changes per control in one set (or in every set when `setId` is null). */
export function diffMap(cmp: ControllerCompare, setId: string | null): Map<ControlId, ControllerDiffChange> {
  const map = new Map<ControlId, ControllerDiffChange>();
  for (const d of cmp.differences) if (setId === null || d.setId.toLowerCase() === setId.toLowerCase()) map.set(d.control, d.change);
  return map;
}

export function diffCounts(cmp: ControllerCompare, setId: string | null = null): Record<ControllerDiffChange, number> {
  const counts = { added: 0, removed: 0, changed: 0 };
  for (const d of cmp.differences) if (setId === null || d.setId.toLowerCase() === setId.toLowerCase()) counts[d.change]++;
  return counts;
}

/** "3 differences: 1 changed, 1 added, 1 removed." */
export function diffSummary(cmp: ControllerCompare, setId: string | null = null): string {
  const c = diffCounts(cmp, setId);
  const total = c.added + c.removed + c.changed;
  if (total === 0) return 'No differences in this set.';
  const parts = (['changed', 'added', 'removed'] as const).filter((k) => c[k]).map((k) => `${c[k]} ${k}`);
  return `${plural(total, 'difference')}: ${parts.join(', ')}.`;
}

/** Where the comparison's default came from, in one calm sentence. */
export function basisLine(cmp: ControllerCompare): string {
  const name = cmp.defaultName ? `“${cmp.defaultName}”` : 'the default';
  switch (cmp.basis) {
    case 'progenitor': return `Your layout started from ${name}; Steam recorded that when you first edited it.`;
    case 'title': return `Compared with Steam’s ${name} template, which has the same name as your layout.`;
    case 'controllerDefault': return `Compared with Steam’s ${name} template for this controller — the layout Steam suggests first.`;
    case 'self': return `You use Steam’s ${name} template as it is.`;
    default: return '';
  }
}

// ---------- Uninstall advisor ----------

export type AdviceTone = 'keep' | 'think' | 'safe';

export interface Advice {
  tone: AdviceTone;
  headline: string;
  reasons: string[];
}

const DAY = 86_400_000;

/**
 * A gentle recommendation from what VYSTRAL knows: recent play, playtime, cloud saves, the size to download again and
 * any subscription that lists it. Never a verdict — the reasons are always shown.
 */
export function advise(game: Game, advice: UninstallAdvice, now = Date.now()): Advice {
  const lp = lastPlayed(game);
  const since = lp.at ? (now - Date.parse(lp.at)) / DAY : Infinity;
  const hours = playSeconds(game) / 3600;
  const reasons: string[] = [];
  const big = (advice.sizeBytes ?? 0) >= 60 * 1024 ** 3;
  const cloud = advice.saves.state === 'steamCloud';
  const localOnly = advice.saves.state === 'localOnly';
  const sub = advice.services.length > 0;

  if (since < 14) reasons.push(`You played it ${formatRelative(lp.at, now).toLowerCase()}.`);
  else if (Number.isFinite(since)) reasons.push(`Last played ${formatRelative(lp.at, now).toLowerCase()}.`);
  else reasons.push('You haven’t played it yet.');
  if (cloud) reasons.push('Its saves are in Steam Cloud, so they’ll be waiting if you reinstall.');
  if (localOnly) reasons.push('Steam Cloud has nothing for it on this PC, so its saves may live only here. Check the Files tab first.');
  if (advice.sizeBytes) reasons.push(`Reinstalling means downloading about ${formatBytes(advice.sizeBytes)} again${big ? ', which can take a while' : ''}.`);
  if (sub) reasons.push(advice.services[0].note);

  if (since < 14 || (hours >= 1 && since < 45)) {
    return { tone: 'keep', headline: 'You’re still playing this one — maybe keep it.', reasons };
  }
  if (localOnly) {
    return { tone: 'think', headline: 'Fine to uninstall, once your saves are safe.', reasons };
  }
  if (big && since < 180) {
    return { tone: 'think', headline: 'Uninstall if you need the space — it’s a big download to get back.', reasons };
  }
  return { tone: 'safe', headline: since >= 180 ? 'A good one to uninstall if you need the space.' : 'Safe to uninstall if you need the space.', reasons };
}

// ---------- Files tab ----------

export const SAVE_PLATFORM: Record<SavePlatform, string> = {
  windows: 'Windows', steam: 'Steam Cloud folder', microsoftStore: 'Microsoft Store / Xbox', gog: 'GOG', epic: 'Epic Games', ea: 'EA app',
  ubisoft: 'Ubisoft Connect', battlenet: 'Battle.net',
};

/** "Found in 2 of 4 places" / "Not found on this PC" for the saves header. */
export function savesSummary(s: SavesLookup): string {
  const checkable = s.locations.filter((l) => !l.problem);
  const found = s.locations.filter((l) => l.exists);
  if (!s.locations.length) return 'PCGamingWiki doesn’t list a Windows save location for this game yet.';
  if (!found.length) return checkable.length ? 'None of the listed places exist on this PC yet — maybe it hasn’t saved here, or it uses the cloud only.' : 'The listed places can’t be checked on Windows.';
  const bytes = found.reduce((n, l) => n + (l.bytes ?? 0), 0);
  return `Found in ${found.length} of ${checkable.length || s.locations.length} ${checkable.length === 1 ? 'place' : 'places'} · ${formatBytes(bytes)}`;
}

export type ModSort = 'name' | 'size' | 'updated';

export function modName(item: ModItem): string {
  return item.title ?? item.name;
}

export function sortMods(items: ModItem[], by: ModSort): ModItem[] {
  const list = [...items];
  if (by === 'size') return list.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || modName(a).localeCompare(modName(b)));
  if (by === 'updated') return list.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '') || modName(a).localeCompare(modName(b)));
  return list.sort((a, b) => modName(a).localeCompare(modName(b), undefined, { numeric: true, sensitivity: 'base' }));
}

/** "34 items · 2.1 GB" (with "at least" when the folder was too big to measure fully). */
export function sourceSummary(s: ModSource): string {
  const on = s.items.filter((i) => i.enabled === true).length;
  const enabled = s.items.some((i) => i.enabled !== null) ? ` · ${on} on` : '';
  return `${plural(s.count, s.kind === 'workshop' ? 'item' : 'mod')} · ${s.partial ? 'at least ' : ''}${formatBytes(s.bytes)}${enabled}`;
}

export function modsTotal(sources: ModSource[]): { count: number; bytes: number } {
  return sources.reduce((t, s) => ({ count: t.count + s.count, bytes: t.bytes + s.bytes }), { count: 0, bytes: 0 });
}
