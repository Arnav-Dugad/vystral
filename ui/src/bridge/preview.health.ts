/**
 * Track Q preview: the library health check and Steam Input layouts with fictional data. The library is healthy by
 * default (so existing screenshots stay stable); `?health` fills the page with one of every kind of issue, built from
 * the preview games. `?controls` gives Steam games a fictional template, a personal layout with sets and a layer, or
 * none. Nothing here touches the network or the disk.
 */
import type {
  ControllerLayout, ControllerSet, Game, HealthFix, HealthFixAllResult, HealthIssue, HealthReport, HealthSeverity, PlatformKey, Session,
} from './types';
import { BridgeError } from './bridge';

type Emit = (name: string, payload: unknown) => void;

const WEIGHT: Record<HealthSeverity, number> = { problem: 6, warning: 2.5, info: 0.75 };

/** Same formula as LibraryHealth.Score (C#). */
export function previewScore(issues: HealthIssue[], games: number): number {
  if (!issues.length) return 100;
  const weight = issues.reduce((s, i) => s + WEIGHT[i.severity] * (1 + 0.25 * Math.min(Math.max(i.gameIds.length - 1, 0), 8)), 0);
  const scale = Math.max(12, games * 0.4);
  return Math.min(99, Math.max(1, Math.round((100 * scale) / (scale + weight))));
}

const fix = (action: HealthFix['action'], label: string, safe = false): HealthFix => ({ action, label, safe });

function buildIssues(lib: { games: Game[]; sessions: Session[] }): HealthIssue[] {
  const games = lib.games.filter((g) => !g.hidden);
  const by = (title: string) => games.find((g) => g.title === title);
  const of = (p: PlatformKey) => games.filter((g) => g.installations.some((i) => i.platform === p));
  const out: HealthIssue[] = [];
  const base = (g: Game | undefined, partial: Partial<HealthIssue> & Pick<HealthIssue, 'id' | 'kind' | 'group' | 'severity' | 'title' | 'detail' | 'fixes'>): HealthIssue => ({
    gameId: g?.id ?? null, gameIds: g ? [g.id] : [], installationId: null, platform: null, platforms: g ? [...new Set(g.installations.map((i) => i.platform))] : [],
    path: null, drive: null, sessionId: null, artKind: null, otherGameId: null, ...partial,
  });

  const lumen = by('Lumen Garden');
  if (lumen) {
    const inst = lumen.installations[0];
    out.push(base(lumen, {
      id: `brokenShortcut:${inst.id}`, kind: 'brokenShortcut', group: 'launch', severity: 'problem', title: 'Lumen Garden can’t start',
      detail: 'The program you added isn’t where it used to be. It may have been moved, renamed or uninstalled. Point VYSTRAL at it again and everything else (playtime, notes, art) stays.',
      installationId: inst.id, platform: 'manual', path: 'C:\\Games\\Lumen Garden\\LumenGarden.exe', fixes: [fix('locate', 'Locate the program…'), fix('hide', 'Hide it')],
    }));
  }
  const quiet = by('Quiet Harbor');
  if (quiet) {
    out.push(base(quiet, {
      id: `launchTargetMissing:${quiet.installations[0].id}`, kind: 'launchTargetMissing', group: 'launch', severity: 'problem', title: 'Quiet Harbor’s folder is gone',
      detail: 'GOG listed it at this folder, but the folder isn’t there now. A rescan updates what’s installed; if you moved the game, let GOG find it first.',
      installationId: quiet.installations[0].id, platform: 'gog', path: 'D:\\GOG Games\\Quiet Harbor', fixes: [fix('rescan', 'Rescan', true), fix('openVersions', 'See versions')],
    }));
  }
  const onE = of('steam').slice(5, 8);
  if (onE.length) {
    out.push({
      id: 'missingDrive:E', kind: 'missingDrive', group: 'drives', severity: 'warning', title: 'Drive E: isn’t connected',
      detail: `${onE.length} games are installed there. Nothing was removed — they’ll be back as soon as you reconnect the drive. Rescan afterwards.`,
      gameId: null, gameIds: onE.map((g) => g.id), installationId: null, platform: 'steam', platforms: ['steam'], path: null, drive: 'E:', sessionId: null,
      artKind: null, otherGameId: null, fixes: [fix('rescan', 'Rescan', true)],
    });
  }
  const session = lib.sessions[0];
  const sessionGame = session && games.find((g) => g.id === session.gameId);
  if (session && sessionGame) {
    out.push(base(sessionGame, {
      id: `openSession:${session.id}`, kind: 'openSession', group: 'sessions', severity: 'warning', title: `A ${sessionGame.title} session never ended`,
      detail: 'It started 2 Oct 2026, 21:14 and has no end time, so it isn’t counted in your playtime. Closing it uses the last moment VYSTRAL saw the game running.',
      sessionId: session.id, platforms: [], fixes: [fix('closeSession', 'Close it')],
    }));
    out.push(base(sessionGame, {
      id: `longSession:${session.id}`, kind: 'longSession', group: 'sessions', severity: 'info', title: `${sessionGame.title}: a 19-hour session`,
      detail: 'Recorded 14 Sept 2026, 18:02. If the game was left open (or the PC slept), this one session inflates your playtime.',
      sessionId: session.id, platforms: [], fixes: [fix('openSession', 'Review session')],
    }));
  }
  const ashen = by('Ashen Crown');
  if (ashen) {
    out.push(base(ashen, {
      id: `duplicateInstall:${ashen.id}`, kind: 'duplicateInstall', group: 'duplicates', severity: 'info', title: 'Ashen Crown is installed 2 times',
      detail: 'It’s installed from Steam and Epic Games, using 118 GB in total. Pick the one you play; the other can be uninstalled from its store to free space.',
      fixes: [fix('openVersions', 'Choose a version')],
    }));
  }
  const nebula = by('Nebula Drift');
  if (nebula) {
    out.push(base(nebula, {
      id: 'steamLibraryDuplicate:100000', kind: 'steamLibraryDuplicate', group: 'duplicates', severity: 'warning', title: 'Nebula Drift is in 2 Steam libraries',
      detail: 'Steam has a copy in each of these folders: C:\\Program Files (x86)\\Steam; D:\\SteamLibrary. Steam uses only one, so the other is wasted space. Remove the extra copy in Steam’s Storage settings.',
      platform: 'steam', platforms: ['steam'], fixes: [fix('openGame', 'Open game page')],
    }));
  }
  const k1 = by('Kingsfall'), k2 = by('Kingsfall Remastered');
  if (k1 && k2) {
    out.push({
      ...base(k1, {
        id: `duplicateSuggestion:${k1.id}-${k2.id}`, kind: 'duplicateSuggestion', group: 'duplicates', severity: 'info',
        title: '“Kingsfall” and “Kingsfall Remastered” might be the same game',
        detail: 'Both titles reduce to “kingsfall” but differ in edition or store, so they were kept separate. Merging only changes how they appear in VYSTRAL, and you can separate them again later.',
        otherGameId: k2.id, fixes: [fix('merge', 'Merge'), fix('keepSeparate', 'Keep separate')],
      }),
      gameIds: [k1.id, k2.id], platforms: ['steam', 'xbox'],
    });
  }
  const paper = by('Paper Kingdoms');
  if (paper) {
    out.push(base(paper, {
      id: `staleMissing:${paper.installations[0].id}`, kind: 'staleMissing', group: 'installs', severity: 'info', title: 'Paper Kingdoms hasn’t been seen in 47 days',
      detail: 'Ubisoft Connect stopped listing it 47 days ago. It’s kept (with your playtime and notes) in case it comes back. Rescan to check, or hide it if it’s gone for good.',
      installationId: paper.installations[0].id, platform: 'ubisoft', fixes: [fix('rescan', 'Rescan', true), fix('hide', 'Hide it')],
    }));
  }
  const bnet = of('battlenet');
  if (bnet.length) {
    out.push({
      id: 'platformOff:battlenet', kind: 'platformOff', group: 'installs', severity: 'info', title: 'Battle.net scanning is off',
      detail: `${bnet.length} ${bnet.length === 1 ? 'game' : 'games'} from Battle.net won’t notice installs, updates or uninstalls until it’s back on.`,
      gameId: null, gameIds: bnet.map((g) => g.id), installationId: null, platform: 'battlenet', platforms: ['battlenet'], path: null, drive: null, sessionId: null,
      artKind: null, otherGameId: null, fixes: [fix('enableStore', 'Turn it on')],
    });
  }
  const art: [string, HealthIssue['kind'], HealthIssue['artKind'], HealthSeverity, string, string][] = [
    ['Starfall Tactics', 'artMissing', 'cover', 'warning', 'Starfall Tactics has no cover', 'It shows a generated cover for now. VYSTRAL can get Steam’s own cover, or you can choose one.'],
    ['Glasswing', 'artPlaceholder', 'cover', 'warning', 'Glasswing’s cover is a placeholder', 'The image is a blank stand-in (4.4 KB), not real art.'],
    ['Northbound', 'artLowRes', 'cover', 'info', 'Northbound’s cover is low resolution', 'It’s 200×300, so it looks soft on large cards and screens.'],
    ['Deep Field', 'artMissing', 'hero', 'info', 'Deep Field has no background', 'Its page and Immersive Mode use a blurred cover instead.'],
    ['Moss & Marrow', 'artFileMissing', 'hero', 'warning', 'Moss & Marrow’s background file is missing', 'The background was removed from VYSTRAL’s art cache (for example by clearing the cache).'],
  ];
  for (const [title, kind, artKind, severity, t, detail] of art) {
    const g = by(title);
    if (!g) continue;
    const steam = g.installations.some((i) => i.platform === 'steam');
    const label = artKind === 'hero' ? 'a background' : 'a cover';
    out.push(base(g, {
      id: `${kind}:${g.id}-${artKind}`, kind, group: 'art', severity, title: t, detail, artKind,
      fixes: steam ? [fix('refetchArt', 'Get it again', true), fix('pickArt', `Choose ${label}…`)] : [fix('pickArt', `Choose ${label}…`)],
    }));
  }
  for (const title of ['Cobalt Frontier', 'Overclock Arena']) {
    const g = by(title);
    if (!g) continue;
    out.push(base(g, {
      id: `metadataMissing:${g.id}`, kind: 'metadataMissing', group: 'metadata', severity: 'info', title: `${title} has no details`,
      detail: 'No description, developer or genres were found last time. Looking again often helps after a store page changes.',
      fixes: [fix('lookupMetadata', 'Look again', true), fix('openGame', 'Open game page')],
    }));
  }
  const rank = { problem: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export function healthPreviewHandlers(ctx: { lib: { games: Game[]; sessions: Session[] }; emit: () => Emit; timers: number[] }) {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  let issues: HealthIssue[] = params.has('health') ? buildIssues(ctx.lib) : [];
  const dismissed = new Map<string, HealthIssue>();
  const visibleGames = () => ctx.lib.games.filter((g) => !g.hidden).length;
  const report = (): HealthReport => ({
    checkedAt: new Date().toISOString(), elapsedMs: 38 + (issues.length % 7), score: previewScore(issues, visibleGames()),
    gameCount: visibleGames(), issues: [...issues], dismissedCount: dismissed.size, offline: false, scanning: false,
  });
  const find = (id: string) => {
    const i = issues.find((x) => x.id === id);
    if (!i) throw new BridgeError('notFound', 'That issue is already gone.');
    return i;
  };
  const wait = (ms: number) => new Promise<void>((r) => ctx.timers.push(window.setTimeout(r, ms)));

  return {
    'health.check': () => report(),
    'health.dismiss': (p: { issueId: string }) => {
      const i = find(p.issueId);
      issues = issues.filter((x) => x !== i);
      dismissed.set(i.id, i);
      return report();
    },
    'health.restore': (p: { issueId: string }) => {
      const i = dismissed.get(p.issueId);
      if (i) {
        dismissed.delete(i.id);
        issues = [...issues, i];
      }
      return report();
    },
    'health.restoreAll': () => {
      issues = [...issues, ...dismissed.values()];
      dismissed.clear();
      return report();
    },
    'health.fix': async (p: { issueId: string; action: string }) => {
      const i = find(p.issueId);
      if (!i.fixes.some((f) => f.action === p.action)) throw new BridgeError('invalid', 'That fix doesn’t apply here.');
      await wait(p.action === 'rescan' ? 900 : 500);
      if (p.action === 'rescan' && i.kind === 'missingDrive') throw new BridgeError('unavailable', 'Drive E: is still not connected. Plug it in, then rescan.');
      issues = issues.filter((x) => x !== i);
      return report();
    },
    'health.fixAll': async (): Promise<HealthFixAllResult> => {
      const safe = issues.filter((i) => i.fixes.some((f) => f.safe) && i.kind !== 'missingDrive');
      const total = safe.length;
      for (let n = 0; n < total; n++) {
        ctx.emit()('health.progress', { done: n, total, label: `${safe[n].fixes[0].label} · ${ctx.lib.games.find((g) => g.id === safe[n].gameId)?.title ?? 'your library'}…` });
        await wait(260);
      }
      ctx.emit()('health.progress', { done: total, total, label: 'Done' });
      issues = issues.filter((i) => !safe.includes(i));
      return { fixed: total, skipped: 0, notes: total ? ['Details are being looked up in the background; they appear over the next few minutes.'] : [], report: report() };
    },
    'health.locateExecutable': () => {
      throw new BridgeError('unsupported', 'Locating a program needs the VYSTRAL app (preview mode can’t open file dialogs).');
    },
    'controls.get': (p: { gameId: string }): ControllerLayout => previewLayout(ctx.lib.games.find((g) => g.id === p.gameId), params.has('controls')),
  };
}

const none = (status: ControllerLayout['status']): ControllerLayout => ({
  status, title: null, description: null, controllerType: null, controllerLabel: null, sourceKind: null, templateName: null, sets: [], note: null,
});

const b = (label: string, detail: string | null = null, kind: ControllerSet['controls'][number]['bindings'][number]['kind'] = 'key', activator: ControllerSet['controls'][number]['bindings'][number]['activator'] = 'press', slot: string | null = null) =>
  ({ activator, slot, label, detail, kind });

function previewLayout(game: Game | undefined, enabled: boolean): ControllerLayout {
  if (!game || !game.installations.some((i) => i.platform === 'steam')) return none('notSteam');
  if (!enabled) return none('none');
  const hash = [...game.id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const kind = game.title === 'Nebula Drift' ? 0 : game.title === 'Starfall Tactics' ? 1 : hash % 3;
  if (kind === 2) return none('none');
  if (kind === 1) {
    return {
      status: 'steamInput', title: 'Keyboard (WASD) and Mouse', description: 'For games designed for keyboard and mouse, without real controller support.',
      controllerType: 'controller_xboxone', controllerLabel: 'Xbox One / Series controller', sourceKind: 'template', templateName: 'Keyboard (WASD) and Mouse', note: null,
      sets: [{
        id: 'Default', name: 'Default', kind: 'set', parentId: null, controls: [
          { control: 'a', mode: null, fromLayer: false, bindings: [b('Jump', 'Space')] },
          { control: 'b', mode: null, fromLayer: false, bindings: [b('Use', 'E')] },
          { control: 'x', mode: null, fromLayer: false, bindings: [b('Reload', 'R'), b('Left Ctrl', null, 'key', 'long')] },
          { control: 'y', mode: null, fromLayer: false, bindings: [b('Flashlight', 'F')] },
          { control: 'lb', mode: null, fromLayer: false, bindings: [b('Previous weapon', 'Scroll down', 'mouse')] },
          { control: 'rb', mode: null, fromLayer: false, bindings: [b('Next weapon', 'Scroll up', 'mouse')] },
          { control: 'lt', mode: 'Trigger', fromLayer: false, bindings: [b('Right click', null, 'mouse')] },
          { control: 'rt', mode: 'Trigger', fromLayer: false, bindings: [b('Left click', null, 'mouse')] },
          { control: 'ls', mode: 'Directional pad', fromLayer: false, bindings: [b('Move Forward', 'W', 'key', 'press', 'up'), b('S', null, 'key', 'press', 'down'), b('A', null, 'key', 'press', 'left'), b('D', null, 'key', 'press', 'right')] },
          { control: 'lsClick', mode: null, fromLayer: false, bindings: [b('Sprint', 'Left Shift')] },
          { control: 'rs', mode: 'Mouse', fromLayer: false, bindings: [b('Mouse movement', null, 'gamepad', 'analog')] },
          { control: 'rsClick', mode: null, fromLayer: false, bindings: [b('Middle click', null, 'mouse')] },
          { control: 'dpadUp', mode: null, fromLayer: false, bindings: [b('Weapon 1', '1')] },
          { control: 'dpadRight', mode: null, fromLayer: false, bindings: [b('Weapon 2', '2')] },
          { control: 'dpadDown', mode: null, fromLayer: false, bindings: [b('Weapon 3', '3')] },
          { control: 'dpadLeft', mode: null, fromLayer: false, bindings: [b('Weapon 4', '4')] },
          { control: 'view', mode: null, fromLayer: false, bindings: [b('Map', 'Tab')] },
          { control: 'menu', mode: null, fromLayer: false, bindings: [b('Menu', 'Esc')] },
          { control: 'share', mode: null, fromLayer: false, bindings: [b('Screenshot', null, 'system')] },
        ],
      }],
    };
  }
  const onFoot: ControllerSet = {
    id: 'InGame', name: 'On foot', kind: 'set', parentId: null, controls: [
      { control: 'a', mode: null, fromLayer: false, bindings: [b('Jump', null, 'action')] },
      { control: 'b', mode: null, fromLayer: false, bindings: [b('Dodge', null, 'action'), b('Crouch', null, 'action', 'long')] },
      { control: 'x', mode: null, fromLayer: false, bindings: [b('Interact', null, 'action'), b('Menus', 'Switch to Menus', 'set', 'double')] },
      { control: 'y', mode: null, fromLayer: false, bindings: [b('Hold for Driving', null, 'layer')] },
      { control: 'lb', mode: null, fromLayer: false, bindings: [b('Scanner', null, 'action')] },
      { control: 'rb', mode: null, fromLayer: false, bindings: [b('Grenade', null, 'action')] },
      { control: 'lt', mode: 'Trigger', fromLayer: false, bindings: [b('Aim', null, 'action', 'analog')] },
      { control: 'rt', mode: 'Trigger', fromLayer: false, bindings: [b('Fire', null, 'action', 'analog')] },
      { control: 'ls', mode: 'Joystick', fromLayer: false, bindings: [b('Move', null, 'action', 'analog')] },
      { control: 'lsClick', mode: null, fromLayer: false, bindings: [b('Sprint', null, 'action')] },
      { control: 'rs', mode: 'Camera', fromLayer: false, bindings: [b('Look around', null, 'action', 'analog')] },
      { control: 'rsClick', mode: null, fromLayer: false, bindings: [b('Melee', null, 'action')] },
      { control: 'dpadUp', mode: null, fromLayer: false, bindings: [b('Flashlight', null, 'action')] },
      { control: 'view', mode: null, fromLayer: false, bindings: [b('Open map', null, 'action')] },
      { control: 'menu', mode: null, fromLayer: false, bindings: [b('Pause', null, 'action')] },
      { control: 'p1', mode: null, fromLayer: false, bindings: [b('Jump', null, 'action')] },
      { control: 'gyro', mode: 'Gyro mouse', fromLayer: false, bindings: [b('Fine aim', null, 'action', 'analog')] },
    ],
  };
  const driving: ControllerSet = {
    id: 'Driving', name: 'Driving', kind: 'layer', parentId: 'InGame',
    controls: onFoot.controls.map((c) =>
      c.control === 'a' ? { ...c, fromLayer: true, bindings: [b('Handbrake', 'A', 'gamepad')] }
        : c.control === 'rt' ? { ...c, fromLayer: true, bindings: [b('Accelerate', null, 'action', 'analog')] }
          : c.control === 'lt' ? { ...c, fromLayer: true, bindings: [b('Brake', null, 'action', 'analog')] }
            : c),
  };
  const menus: ControllerSet = {
    id: 'Menu', name: 'Menus', kind: 'set', parentId: null, controls: [
      { control: 'a', mode: null, fromLayer: false, bindings: [b('Select', null, 'action')] },
      { control: 'b', mode: null, fromLayer: false, bindings: [b('Back', null, 'action')] },
      { control: 'ls', mode: 'Directional pad', fromLayer: false, bindings: [b('Navigate', null, 'action', 'analog')] },
      { control: 'lb', mode: null, fromLayer: false, bindings: [b('Previous tab', null, 'action')] },
      { control: 'rb', mode: null, fromLayer: false, bindings: [b('Next tab', null, 'action')] },
    ],
  };
  return {
    status: 'steamInput', title: 'My layout', description: null, controllerType: 'controller_xboxone', controllerLabel: 'Xbox One / Series controller',
    sourceKind: 'personal', templateName: null, note: null, sets: [onFoot, menus, driving],
  };
}
