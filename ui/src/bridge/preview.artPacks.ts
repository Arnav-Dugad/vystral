/**
 * Track N preview handlers: art packs, with fictional SteamGridDB art (the same locally drawn SVG
 * placeholders the art picker uses — never the network). The job really runs (a few slots a second),
 * really keeps hand-picked art, and really undoes. ?nosgdb simulates a missing SteamGridDB key.
 */
import type {
  ArtPackJob, ArtPackKind, ArtPackPlan, ArtPackPreset, ArtPackRequest, ArtPackRestore, ArtPackRun, ArtPackSample, ArtPacksStatus,
  DataSourcesStatus, Game, Settings, UserArt,
} from './types';
import { BridgeError } from './bridge';
import { placeholderArt } from './preview.dataSources';

type Emit = (name: string, payload: unknown) => void;

interface Ctx {
  lib: { games: Game[] };
  emit: () => Emit;
  settings: () => Settings;
  timers: number[];
  /** The art picker's own record of user-chosen art (preview.dataSources). */
  userArt: (gameId: string) => UserArt[];
  dataSources: () => DataSourcesStatus;
}

const PRESETS: ArtPackPreset[] = [
  { id: 'official', label: 'Official', description: 'The community’s best-rated art for each game, with official logos.', styles: { cover: [], hero: [], logo: ['official'] } },
  { id: 'alternate', label: 'Alternate', description: 'Fresh takes on each game’s key art, with custom logos.', styles: { cover: ['alternate'], hero: ['alternate'], logo: ['custom'] } },
  { id: 'minimal', label: 'Minimal', description: 'Covers without logos and quiet backgrounds: the artwork on its own.', styles: { cover: ['no_logo'], hero: ['alternate'] } },
  { id: 'blurred', label: 'Blurred', description: 'Soft, blurred art that lets titles and logos stand out.', styles: { cover: ['blurred'], hero: ['blurred'] } },
  { id: 'material', label: 'Material', description: 'Flat, graphic, colour-blocked art in the Material style.', styles: { cover: ['material'], hero: ['material'] } },
  { id: 'white', label: 'White logo', description: 'Covers with clean white logos, and white logos everywhere.', styles: { cover: ['white_logo'], logo: ['white'] } },
];

const KINDS: ArtPackKind[] = ['cover', 'hero', 'logo'];
const AUTHORS = ['Lumen', 'pixelwren', 'Halcyon', 'grid_smith', 'Orbit', 'mossy', 'Corvid', 'nightjar'];
const STEP_MS = 60;

const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

interface Entry { gameId: string; kind: ArtPackKind; url: string; previous: string | null }
interface PackArt { url: string; pack: string; author: string }

export function artPackPreviewHandlers(ctx: Ctx): Record<string, (p: any) => unknown> {
  const noKey = new URLSearchParams(location.search).has('nosgdb');
  let job: ArtPackJob | null = null;
  let control: { pause: boolean; cancel: boolean } = { pause: false, cancel: false };
  const runs: (ArtPackRun & { entries: Entry[] })[] = [];
  const packArt = new Map<string, Partial<Record<ArtPackKind, PackArt>>>();

  const configured = () => !noKey && !!ctx.dataSources().providers.find((p) => p.id === 'steamgriddb')?.configured;
  const preset = (id: string) => PRESETS.find((p) => p.id === id) ?? (() => { throw new BridgeError('invalid', 'Unknown art pack style.'); })();
  const visibleIndex = (g: Game) => ctx.lib.games.indexOf(g);
  // About one game in seven has no confident SteamGridDB match, like real libraries.
  const matched = (g: Game) => visibleIndex(g) % 7 !== 6;
  const matchedBy = (g: Game) => (g.installations.some((i) => i.platform === 'steam') ? 'steam' : 'title') as 'steam' | 'title';

  /** Art the user chose by hand (in the picker or from a file) — never art an earlier pack applied. */
  const handPicked = (g: Game, kind: ArtPackKind) => {
    const pack = packArt.get(g.id)?.[kind];
    if (pack && g.art[kind] === pack.url) return false;
    return ctx.userArt(g.id).some((u) => u.kind === kind && u.source !== 'artpack');
  };

  const inScope = (g: Game, scope: string) => {
    if (g.hidden) return false;
    if (scope === 'all') return true;
    if (scope === 'installed') return g.installations.some((i) => i.state === 'installed');
    if (scope.startsWith('collection:')) return g.collections.includes(scope.slice(11));
    if (scope.startsWith('platform:')) return g.installations.some((i) => i.platform === scope.slice(9));
    throw new BridgeError('invalid', 'Unknown selection of games.');
  };

  const lastPlayed = (g: Game) => [g.lastTrackedPlay, ...g.installations.map((i) => i.importedLastPlayed)].filter(Boolean).sort().pop() ?? '';

  const plan = (r: ArtPackRequest) => {
    const p = preset(r.preset);
    const kinds = KINDS.filter((k) => r.kinds.includes(k) && p.styles[k]);
    if (!kinds.length) throw new BridgeError('invalid', 'Choose at least one kind of artwork.');
    const games = ctx.lib.games
      .filter((g) => inScope(g, r.scope))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || lastPlayed(b).localeCompare(lastPlayed(a)) || a.title.localeCompare(b.title));
    const slots: { game: Game; kind: ArtPackKind }[] = [];
    const sample: { gameId: string; title: string }[] = [];
    let kept = 0, touched = 0;
    for (const g of games) {
      let any = false;
      for (const k of kinds) {
        if (handPicked(g, k) && !r.replaceMine) { kept++; continue; }
        slots.push({ game: g, kind: k });
        any = true;
      }
      if (!any) continue;
      touched++;
      if (sample.length < 8) sample.push({ gameId: g.id, title: g.title });
    }
    return { preset: p, kinds, slots, sample, kept, touched, inScope: games.length };
  };

  const requireReady = () => {
    if (!configured()) throw new BridgeError('notConfigured', 'Art packs use SteamGridDB, which needs your own free API key. Add it in Settings → Library & stores → Data sources.');
    const s = ctx.settings();
    if (s['privacy.localOnly']) throw new BridgeError('offline', 'Offline mode is on, so VYSTRAL doesn’t contact SteamGridDB. Turn it off in Settings → Privacy.');
    if (s['dataSaver.enabled']) throw new BridgeError('disabled', 'Data saver is on, so art packs don’t download artwork. Turn it off in Settings → Privacy to apply one.');
  };

  const artFor = (g: Game, presetId: string, kind: ArtPackKind) => {
    const style = PRESETS.find((p) => p.id === presetId)?.styles[kind]?.[0] ?? (kind === 'logo' ? 'official' : 'alternate');
    return placeholderArt(kind, g.title, hash(presetId) % 97, style);
  };

  const setArt = (g: Game, kind: ArtPackKind, url: string | null) => {
    // A new array, as the native bridge would send, so views that select the game list re-render.
    ctx.lib.games = ctx.lib.games.map((x) => (x.id === g.id ? { ...x, art: { ...x.art, [kind]: url } } : x));
  };

  const status = (): ArtPacksStatus => {
    const s = ctx.settings();
    return {
      configured: configured(),
      localOnly: s['privacy.localOnly'],
      dataSaver: s['dataSaver.enabled'],
      gameActive: false,
      safeMode: false,
      presets: PRESETS,
      job,
      runs: runs.map(({ entries, ...r }) => ({ ...r, replaced: entries.length, canRestore: !r.restoredAt && entries.length > 0 && !isRunning() })),
    };
  };

  const isRunning = () => !!job && ['running', 'paused', 'waiting'].includes(job.state);
  const emitJob = () => job && ctx.emit()('artPacks.progress', { ...job });

  const run = (r: ArtPackRequest) => {
    const p = plan(r);
    if (!p.slots.length) throw new BridgeError('invalid', p.kept ? 'Every slot in this selection holds art you chose yourself. Tick “Replace my picks” to change them too.' : 'There’s nothing to change in this selection.');
    const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const started = new Date().toISOString();
    job = {
      id, presetId: p.preset.id, presetLabel: p.preset.label, kinds: p.kinds, scope: r.scope, replaceHandPicked: r.replaceMine, state: 'running', reason: null,
      total: p.slots.length, done: 0, applied: 0, kept: 0, noMatch: 0, noArt: 0, failed: 0, started, finished: null, etaSeconds: null, current: null, resumeAt: null,
    };
    const record = { id, presetId: p.preset.id, presetLabel: p.preset.label, scope: r.scope, kinds: p.kinds, replaced: 0, started, finished: null as string | null, state: 'running' as ArtPackRun['state'], restoredAt: null as string | null, canRestore: false, entries: [] as Entry[] };
    runs.unshift(record);
    control = { pause: false, cancel: false };
    const queue = [...p.slots];
    let sinceChange = 0;
    const finish = (state: 'done' | 'cancelled') => {
      job = { ...job!, state, finished: new Date().toISOString(), current: null, etaSeconds: null };
      record.state = state;
      record.finished = job.finished;
      emitJob();
      ctx.emit()('library.changed', { reason: 'artwork' });
    };
    const step = () => {
      if (!job) return;
      if (control.cancel) return finish('cancelled');
      if (control.pause) {
        if (job.state !== 'paused') {
          job = { ...job, state: 'paused', etaSeconds: null };
          emitJob();
        }
        ctx.timers.push(window.setTimeout(step, 150));
        return;
      }
      const next = queue.shift();
      if (!next) return finish('done');
      const g = ctx.lib.games.find((x) => x.id === next.game.id);
      const j = { ...job, state: 'running' as const, current: next.game.title };
      if (!g) j.failed++;
      else if (!matched(g)) j.noMatch++;
      else if (handPicked(g, next.kind) && !r.replaceMine) j.kept++;
      else {
        const url = artFor(g, p.preset.id, next.kind);
        record.entries.push({ gameId: g.id, kind: next.kind, url, previous: g.art[next.kind] });
        const packs = packArt.get(g.id) ?? {};
        packs[next.kind] = { url, pack: p.preset.label, author: AUTHORS[hash(g.id + next.kind) % AUTHORS.length] };
        packArt.set(g.id, packs);
        setArt(g, next.kind, url);
        j.applied++;
        sinceChange++;
      }
      j.done = j.applied + j.kept + j.noMatch + j.noArt + j.failed;
      j.etaSeconds = Math.ceil(((j.total - j.done) * STEP_MS) / 1000);
      job = j;
      emitJob();
      if (sinceChange >= 6) {
        sinceChange = 0;
        ctx.emit()('library.changed', { reason: 'artwork' });
      }
      ctx.timers.push(window.setTimeout(step, STEP_MS));
    };
    ctx.timers.push(window.setTimeout(step, STEP_MS));
    return job;
  };

  return {
    'artPacks.status': () => status(),
    'artPacks.plan': (r: ArtPackRequest): ArtPackPlan => {
      const p = plan(r);
      return { inScope: p.inScope, games: p.touched, slots: p.slots.length, keptHandPicked: p.kept, estimatedSeconds: Math.ceil(p.touched * 0.4 + p.slots.length * 0.9), sample: p.sample };
    },
    'artPacks.sample': async (r: { gameId: string; preset: string; kind: ArtPackKind }): Promise<ArtPackSample> => {
      requireReady();
      const g = ctx.lib.games.find((x) => x.id === r.gameId);
      if (!g) throw new BridgeError('notFound', 'That game no longer exists.');
      await new Promise((res) => setTimeout(res, 80 + Math.random() * 220));
      if (!matched(g)) return { gameId: g.id, kind: r.kind, thumb: null, matchedBy: null, author: null, reason: 'noMatch' };
      if (!preset(r.preset).styles[r.kind]) return { gameId: g.id, kind: r.kind, thumb: null, matchedBy: matchedBy(g), author: null, reason: 'noArt' };
      return { gameId: g.id, kind: r.kind, thumb: artFor(g, r.preset, r.kind), matchedBy: matchedBy(g), author: AUTHORS[hash(g.id + r.kind) % AUTHORS.length], reason: null };
    },
    'artPacks.start': (r: ArtPackRequest) => {
      requireReady();
      if (isRunning()) throw new BridgeError('invalid', 'An art pack is already being applied. Wait for it to finish, or cancel it.');
      return run(r);
    },
    'artPacks.pause': () => {
      if (!isRunning()) return job;
      control.pause = true;
      job = { ...job!, state: 'paused', etaSeconds: null };
      emitJob();
      return job;
    },
    'artPacks.resume': () => {
      if (!isRunning()) return job;
      control.pause = false;
      job = { ...job!, state: 'running' };
      emitJob();
      return job;
    },
    'artPacks.cancel': () => {
      if (isRunning()) control.cancel = true;
      return job;
    },
    'artPacks.restore': (p: { id: string }): ArtPackRestore => {
      if (isRunning()) throw new BridgeError('invalid', 'Wait for the current art pack to finish (or cancel it) before restoring.');
      const record = runs.find((r) => r.id === p.id);
      if (!record) throw new BridgeError('invalid', 'That art pack record no longer exists.');
      if (record.restoredAt) return { restored: 0, skipped: 0 };
      let restored = 0, skipped = 0;
      for (const e of [...record.entries].reverse()) {
        const g = ctx.lib.games.find((x) => x.id === e.gameId);
        if (!g || g.art[e.kind] !== e.url) { skipped++; continue; }
        setArt(g, e.kind, e.previous);
        const packs = packArt.get(g.id);
        if (packs?.[e.kind]?.url === e.url) delete packs[e.kind];
        restored++;
      }
      record.restoredAt = new Date().toISOString();
      ctx.emit()('library.changed', { reason: 'artwork' });
      return { restored, skipped };
    },
    // Art an art pack applied shows as such on the game page (and hand-picked art keeps its credit).
    'art.userArt': (p: { gameId: string }): UserArt[] => {
      const g = ctx.lib.games.find((x) => x.id === p.gameId);
      const packs = packArt.get(p.gameId) ?? {};
      const fromPack = (Object.entries(packs) as [ArtPackKind, PackArt][]).filter(([k, a]) => g?.art[k] === a.url);
      const base = ctx.userArt(p.gameId).filter((u) => !fromPack.some(([k]) => k === u.kind));
      return [...base, ...fromPack.map(([kind, a]) => ({ kind, source: 'artpack', author: a.author, pack: a.pack }))];
    },
  };
}
