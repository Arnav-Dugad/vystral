/**
 * Track X preview: library tools with fictional data only (nothing touches the disk or the network).
 *
 * URL switches:
 * - `?healthNew` — the background health check "noticed" a disconnected drive and a broken shortcut (also fills the
 *   Health page, like `?health`). Tests can push a fresh one with `window.__vystralPreviewHealthNews.unplug()`.
 * - `?compare` — Steam Input layouts (as `?controls`), and "Compare with default" has something to compare.
 * - `?uninstall` — the advisor also finds subscription and streaming listings.
 * - `?mods` — Steam games get Workshop items and a Mod Organizer 2 instance.
 * - `?saves` — PCGamingWiki save locations are turned on, with found, missing and unsupported places.
 */
import type {
  ControlId, ControllerCompare, ControllerControl, ControllerDiff, ControllerLayout, ControllerSet, Game, HealthIssue, HealthNews, HealthReport,
  ModItem, ModsList, ModSource, SaveLocation, SavesLookup, Settings, UninstallAdvice,
} from './types';
import { BridgeError } from './bridge';

type Emit = (name: string, payload: unknown) => void;

export const TRACK_X_DEFAULT_SETTINGS: Pick<Settings, 'dataSources.pcgamingwiki' | 'dataSources.workshopTitles' | 'home.healthNews'> = {
  'dataSources.pcgamingwiki': false,
  'dataSources.workshopTitles': false,
  'home.healthNews': true,
};

declare global {
  interface Window {
    __vystralPreviewHealthNews?: { unplug(): void };
  }
}

const MB = 1024 ** 2;

/** Same idea as SteamInputCompare.Compare (C#), for the preview only. */
function diffLayouts(yours: ControllerLayout, base: ControllerLayout): Pick<ControllerCompare, 'differences' | 'unchanged' | 'onlyInYours' | 'onlyInDefault'> {
  const words = (c: ControllerControl) => (c.bindings.length ? c.bindings.map((b) => (b.detail && b.detail !== b.label ? `${b.label} (${b.detail})` : b.label)) : c.mode ? [c.mode] : []);
  const key = (c: ControllerControl) => `${c.mode ?? ''}|${c.bindings.map((b) => `${b.activator}/${b.slot}/${b.label}/${b.detail}`).sort().join(',')}`;
  const differences: ControllerDiff[] = [];
  let unchanged = 0;
  const onlyInYours: string[] = [];
  const matched = new Set<ControllerSet>();
  for (const set of yours.sets) {
    const other = base.sets.find((b) => b.kind === set.kind && b.id.toLowerCase() === set.id.toLowerCase());
    if (!other) { onlyInYours.push(set.name); continue; }
    matched.add(other);
    const mine = new Map(set.controls.filter((c) => c.bindings.length || c.mode).map((c) => [c.control, c]));
    const theirs = new Map(other.controls.filter((c) => c.bindings.length || c.mode).map((c) => [c.control, c]));
    for (const id of new Set<ControlId>([...mine.keys(), ...theirs.keys()])) {
      const a = mine.get(id), b = theirs.get(id);
      if (a && b) {
        if (key(a) === key(b)) unchanged++;
        else differences.push({ setId: set.id, setName: set.name, control: id, change: 'changed', before: words(b), after: words(a), modeBefore: b.mode, modeAfter: a.mode });
      } else if (a) differences.push({ setId: set.id, setName: set.name, control: id, change: 'added', before: [], after: words(a), modeBefore: null, modeAfter: a.mode });
      else if (b) differences.push({ setId: set.id, setName: set.name, control: id, change: 'removed', before: words(b), after: [], modeBefore: b.mode, modeAfter: null });
    }
  }
  return { differences, unchanged, onlyInYours, onlyInDefault: base.sets.filter((s) => !matched.has(s)).map((s) => s.name) };
}

/** A fictional "Gamepad" template the personal preview layout could have started from. */
function previewTemplate(yours: ControllerLayout): ControllerLayout {
  const swap = (c: ControllerControl): ControllerControl | null => {
    if (c.control === 'p1' || c.control === 'gyro') return null; // yours added these
    if (c.control === 'b') return { ...c, bindings: [{ activator: 'press', slot: null, label: 'Dodge', detail: null, kind: 'action' }] };
    if (c.control === 'dpadUp') return { ...c, bindings: [{ activator: 'press', slot: null, label: 'Quick item', detail: null, kind: 'action' }] };
    return c;
  };
  const sets = yours.sets.map((s) => {
    const controls = s.controls.map(swap).filter((c): c is ControllerControl => !!c);
    if (s.id === 'InGame') controls.push({ control: 'dpadDown', mode: null, fromLayer: false, bindings: [{ activator: 'press', slot: null, label: 'Emote wheel', detail: null, kind: 'action' }] });
    return { ...s, controls };
  });
  return { ...yours, title: 'Gamepad', sourceKind: 'template', templateName: 'Gamepad', description: 'For games with built-in gamepad support.', sets };
}

export function trackXPreviewHandlers(ctx: {
  lib: { games: Game[] };
  emit: () => Emit;
  settings: () => Settings;
  setSettings: (s: Settings) => void;
  healthCheck: () => HealthReport;
  controlsGet: (gameId: string) => ControllerLayout;
  timers: number[];
}) {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const newsOn = params.has('healthNew');
  if (params.has('saves')) ctx.setSettings({ ...ctx.settings(), 'dataSources.pcgamingwiki': true });
  const acknowledged = new Set<string>();
  let extra: HealthIssue[] = [];
  const wait = (ms: number) => new Promise<void>((r) => ctx.timers.push(window.setTimeout(r, ms)));
  const byId = (id: string) => {
    const g = ctx.lib.games.find((x) => x.id === id);
    if (!g) throw new BridgeError('notFound', 'That game is no longer in your library.');
    return g;
  };
  const steamOf = (g: Game) => g.installations.find((i) => i.platform === 'steam');
  const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

  const news = (): HealthNews => {
    if (!ctx.settings()['home.healthNews']) return { issues: [], checkedAt: null, reason: null, score: 100 };
    const report = ctx.healthCheck();
    const wanted = newsOn ? ['missingDrive', 'brokenShortcut'] : [];
    const issues = [...extra, ...report.issues.filter((i) => wanted.includes(i.kind))].filter((i) => !acknowledged.has(i.id));
    const rank = { problem: 0, warning: 1, info: 2 };
    return { issues: issues.sort((a, b) => rank[a.severity] - rank[b.severity]), checkedAt: report.checkedAt, reason: newsOn ? 'drive' : null, score: report.score };
  };

  if (typeof window !== 'undefined') {
    window.__vystralPreviewHealthNews = {
      /** A second drive goes away: a new warning appears on Home through the event, like the real watcher. */
      unplug() {
        const games = ctx.lib.games.filter((g) => g.installations.some((i) => i.platform === 'epic')).slice(0, 2);
        extra = [{
          id: 'missingDrive:F', kind: 'missingDrive', group: 'drives', severity: 'warning', title: 'Drive F: isn’t connected',
          detail: `${games.length} games are installed there. Nothing was removed — they’ll be back as soon as you reconnect the drive. Rescan afterwards.`,
          gameId: null, gameIds: games.map((g) => g.id), installationId: null, platform: 'epic', platforms: ['epic'], path: null, drive: 'F:',
          sessionId: null, artKind: null, otherGameId: null, fixes: [{ action: 'rescan', label: 'Rescan', safe: true }],
        }];
        ctx.emit()('health.news', news());
      },
    };
  }

  const advice = (gameId: string, installationId?: string | null): UninstallAdvice => {
    const g = byId(gameId);
    const inst = (installationId ? g.installations.find((i) => i.id === installationId) : undefined)
      ?? g.installations.find((i) => i.state === 'installed' && i.platform === 'steam') ?? g.installations.find((i) => i.state === 'installed');
    if (!inst || inst.state !== 'installed') throw new BridgeError('invalid', 'This game isn’t installed.');
    const h = hash(g.id);
    const steam = inst.platform === 'steam';
    const services: UninstallAdvice['services'] = [];
    if (inst.platform === 'xbox') services.push({ service: 'gamepass', name: 'Xbox app', note: 'If it came with Game Pass, you can install it again any time while your membership is active.' });
    if (params.has('uninstall') && h % 2 === 0) services.push({ service: 'gfn', name: 'GeForce NOW', note: 'Listed on GeForce NOW, so you could stream your copy instead of reinstalling.' });
    return {
      gameId: g.id, installationId: inst.id, platform: inst.platform, sizeBytes: inst.sizeBytes ?? null, sizeSource: steam ? 'manifest' : inst.sizeBytes ? 'scan' : 'none',
      drive: inst.drive,
      saves: steam
        ? (h % 3 === 0 ? { state: 'localOnly', files: 0, bytes: 0, lastSync: null } : { state: 'steamCloud', files: 3 + (h % 9), bytes: (2 + (h % 40)) * MB, lastSync: new Date(Date.now() - (h % 20) * 86400000).toISOString() })
        : { state: 'unknown', files: 0, bytes: 0, lastSync: null },
      services,
      action: inst.platform === 'manual' ? 'none' : steam ? 'steamUninstall' : ['xbox', 'epic', 'gog'].includes(inst.platform) ? 'openStore' : 'windowsApps',
      actionLabel: inst.platform === 'manual' ? '' : steam ? 'Open Steam’s uninstall' : ['xbox', 'epic', 'gog'].includes(inst.platform) ? `Open ${{ xbox: 'Xbox', epic: 'Epic Games', gog: 'GOG' }[inst.platform as 'xbox' | 'epic' | 'gog']}` : 'Open Windows’ Installed apps',
    };
  };

  const WORKSHOP = ['Better Night Sky', 'Realistic Rain', 'Extended Map Pack', 'Quality of Life Tweaks', 'Retro HUD', 'Cinematic Camera', 'Orchestral Score Remix', 'Hardcore Economy'];
  const MO2 = ['Unofficial Patch', 'Sharper Textures', 'Quiet Footsteps', 'Map Markers', 'Lighting Overhaul'];
  const lastMods = new Map<string, ModsList>();
  const mods = (g: Game): ModsList => {
    const steam = steamOf(g);
    const sources: ModSource[] = [];
    const titlesOn = ctx.settings()['dataSources.workshopTitles'];
    if (params.has('mods') && steam) {
      const h = hash(g.id);
      const n = 3 + (h % 5);
      const items: ModItem[] = WORKSHOP.slice(0, n).map((name, i) => ({
        id: String(2_800_000_000 + h % 1000 * 10 + i), name: String(2_800_000_000 + h % 1000 * 10 + i), title: titlesOn ? name : null,
        bytes: (i + 1) * 37 * MB + (h % 90) * MB, updated: new Date(Date.now() - (i * 9 + 2) * 86400000).toISOString(), enabled: null, present: i !== n - 1,
        installed: i !== n - 1 ? new Date(Date.now() - (i * 23 + 40) * 86400000).toISOString() : null, // Track D1
      }));
      sources.push({ id: 'workshop', kind: 'workshop', label: 'Steam Workshop', detail: null, folder: `C:\\Program Files (x86)\\Steam\\steamapps\\workshop\\content\\${steam.platformGameId}`, bytes: items.reduce((s, i) => s + (i.bytes ?? 0), 0), count: items.length, partial: false, items });
      if (h % 2 === 0) {
        const mo2: ModItem[] = MO2.map((name, i) => ({ id: (h + i).toString(16).padStart(16, '0').slice(-16), name, title: null, bytes: (i + 2) * 120 * MB, updated: new Date(Date.now() - (i * 30 + 5) * 86400000).toISOString(), enabled: i !== 2, present: true, installed: new Date(Date.now() - (i * 30 + 60) * 86400000).toISOString() }));
        sources.push({ id: 'mo2-0', kind: 'mo2', label: 'Mod Organizer 2', detail: `Mod Organizer 2 · ${g.title} · ${mo2.filter((m) => m.enabled).length} of ${mo2.length} on in “Default”`, folder: `C:\\Users\\You\\AppData\\Local\\ModOrganizer\\${g.title}\\mods`, bytes: mo2.reduce((s, i) => s + (i.bytes ?? 0), 0), count: mo2.length, partial: false, items: mo2 });
      }
    }
    const missing = sources.filter((s) => s.kind === 'workshop').flatMap((s) => s.items).filter((i) => !i.title).length;
    const titles: ModsList['titles'] = !steam ? 'notSteam' : !sources.some((s) => s.kind === 'workshop') ? 'none' : !titlesOn ? 'off' : missing ? (ctx.settings()['privacy.localOnly'] ? 'offline' : 'ready') : 'done';
    const dto: ModsList = { gameId: g.id, appId: steam?.platformGameId ?? null, sources, titles, missingTitles: missing, scannedAt: new Date().toISOString() };
    lastMods.set(g.id, dto);
    return dto;
  };

  const saves = (g: Game): SavesLookup => {
    const steam = steamOf(g);
    const empty = (status: SavesLookup['status'], message: string | null = null): SavesLookup => ({ gameId: g.id, status, message, article: null, locations: [], fetched: null, stale: false });
    if (!steam) return empty('noSteamApp', 'Save locations are looked up by Steam app ID, and this game doesn’t have one.');
    if (!ctx.settings()['dataSources.pcgamingwiki']) return empty('off');
    if (ctx.settings()['privacy.localOnly']) return empty('offline', 'Offline mode is on, so PCGamingWiki wasn’t asked.');
    const h = hash(g.id);
    if (h % 7 === 3 && g.title !== 'Nebula Drift') return { ...empty('notFound'), fetched: new Date().toISOString() };
    const studio = g.developer ?? 'Studio';
    const locations: SaveLocation[] = [
      { id: 's0', platform: 'windows', raw: `{{p|appdata}}\\${studio}\\${g.title}\\Saves`, display: `%APPDATA%\\${studio}\\${g.title}\\Saves`, path: `C:\\Users\\You\\AppData\\Roaming\\${studio}\\${g.title}\\Saves`, exists: true, isFile: false, bytes: (3 + (h % 60)) * MB, files: 4 + (h % 12), modified: new Date(Date.now() - (h % 9) * 86400000).toISOString(), partial: false, problem: null },
      { id: 's1', platform: 'steam', raw: `{{p|steam}}\\userdata\\{{p|uid}}\\${steam.platformGameId}\\remote`, display: `Steam\\userdata\\<uid>\\${steam.platformGameId}\\remote`, path: `C:\\Program Files (x86)\\Steam\\userdata\\42\\${steam.platformGameId}\\remote`, exists: h % 2 === 0, isFile: false, bytes: h % 2 === 0 ? 2 * MB : null, files: h % 2 === 0 ? 3 : 0, modified: h % 2 === 0 ? new Date(Date.now() - 2 * 86400000).toISOString() : null, partial: false, problem: null },
      { id: 's2', platform: 'microsoftStore', raw: `{{p|localappdata}}\\Packages\\Example.${g.title.replace(/\W/g, '')}_8wekyb3d8bbwe\\SystemAppData\\wgs`, display: `%LOCALAPPDATA%\\Packages\\Example.${g.title.replace(/\W/g, '')}_8wekyb3d8bbwe\\SystemAppData\\wgs`, path: `C:\\Users\\You\\AppData\\Local\\Packages\\Example.${g.title.replace(/\W/g, '')}_8wekyb3d8bbwe\\SystemAppData\\wgs`, exists: false, isFile: false, bytes: null, files: 0, modified: null, partial: false, problem: null },
      { id: 's3', platform: 'windows', raw: `{{p|hkcu}}\\Software\\${studio}\\${g.title}`, display: `{{p|hkcu}}\\Software\\${studio}\\${g.title}`, path: null, exists: false, isFile: false, bytes: null, files: 0, modified: null, partial: false, problem: 'unsupported' },
    ];
    return { gameId: g.id, status: 'ok', message: null, article: g.title, locations, fetched: new Date(Date.now() - 3 * 86400000).toISOString(), stale: false };
  };

  return {
    'health.news': () => news(),
    'health.newsSeen': (p: { issueIds?: string[] | null; all?: boolean | null }) => {
      const ids = p.all ? news().issues.map((i) => i.id) : p.issueIds ?? [];
      ids.forEach((id) => acknowledged.add(id));
      return news();
    },
    'controls.compare': (p: { gameId: string }): ControllerCompare => {
      const yours = ctx.controlsGet(p.gameId);
      if (yours.status !== 'steamInput') return { status: 'notSteamInput', yours, default: null, basis: null, defaultName: null, differences: [], unchanged: 0, onlyInYours: [], onlyInDefault: [], note: null };
      if (!params.has('compare')) return { status: 'noDefault', yours, default: null, basis: null, defaultName: null, differences: [], unchanged: 0, onlyInYours: [], onlyInDefault: [], note: 'Steam’s templates aren’t on this PC, so there’s nothing to compare with.' };
      if (yours.sourceKind === 'template') return { status: 'same', yours, default: yours, basis: 'self', defaultName: yours.templateName ?? yours.title, differences: [], unchanged: yours.sets.reduce((n, s) => n + s.controls.length, 0), onlyInYours: [], onlyInDefault: [], note: null };
      const base = previewTemplate(yours);
      const d = diffLayouts(yours, base);
      return { status: d.differences.length || d.onlyInYours.length || d.onlyInDefault.length ? 'ok' : 'same', yours, default: base, basis: 'progenitor', defaultName: 'Gamepad', ...d, note: null };
    },
    'uninstall.advice': (p: { gameId: string; installationId?: string | null }) => advice(p.gameId, p.installationId),
    'uninstall.open': (p: { gameId: string; installationId?: string | null }) => {
      const a = advice(p.gameId, p.installationId);
      if (a.action === 'none') throw new BridgeError('unsupported', 'You added this one yourself, so remove it the way you installed it.');
      return { action: a.action };
    },
    'mods.list': (p: { gameId: string }) => mods(byId(p.gameId)),
    'mods.titles': async (p: { gameId: string }) => {
      if (!ctx.settings()['dataSources.workshopTitles']) throw new BridgeError('off', 'Workshop titles are off. Turn them on in Settings › Data sources.');
      if (ctx.settings()['privacy.localOnly']) throw new BridgeError('offline', 'Offline mode is on, so VYSTRAL can’t look up Workshop titles.');
      await wait(500);
      const g = byId(p.gameId);
      const last = lastMods.get(g.id) ?? mods(g);
      const sources = last.sources.map((s) => s.kind !== 'workshop' ? s : { ...s, items: s.items.map((i, n) => ({ ...i, title: WORKSHOP[n] ?? i.title })) });
      const dto: ModsList = { ...last, sources, titles: 'done', missingTitles: 0 };
      lastMods.set(g.id, dto);
      return dto;
    },
    'mods.open': () => true,
    'saves.lookup': async (p: { gameId: string; refresh?: boolean | null }) => {
      await wait(p.refresh ? 700 : 260);
      return saves(byId(p.gameId));
    },
    'saves.open': () => true,
    'saves.openArticle': () => true,
  };
}
