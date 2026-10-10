/**
 * Track C5 preview: optional cloud AI providers and AI features with a FAKE provider. Nothing here contacts any AI;
 * a tiny keyword "model" stands in so every state can be seen and tested. All data is the preview's fictional library.
 * URL switches:
 *   ?aiCloud     Claude is connected (key "…k9Qz"), opted in and chosen, so every AI feature answers (fake)
 *   ?aiFail      the chosen provider fails every request (features fall back to VYSTRAL's own answers)
 *   ?aiInvent    the fake model invents numbers (VYSTRAL discards its wording and shows its own summary)
 *   ?aiSlow      the fake model takes ~1.6 s per answer (loading states)
 */
import type {
  AiCloudStatus, AiEngine, AiFeature, AiProviderChoice, CloudAiAction, CloudAiProviderId, CloudAiProviderStatus, CloudAiTest, DuplicateExplanation,
  DuplicateFact, Game, JournalAnswer, JournalGroup, JournalMetric, JournalResult, JournalRow, JournalSpec, NewsFeed, PatchSummary, RecapCaption,
  ReplayData, Session, Settings, SmartFilterAnswer, TimeToBeatMap, TonightAnswer, TonightPick,
} from './types';
import { BridgeError } from './bridge';
import { parseSmartFilter } from '../lib/smartFilter';

type Emit = (name: string, payload: unknown) => void;

export const AI_CLOUD_DEFAULT_SETTINGS: Pick<Settings,
  'ai.provider' | 'ai.cloud.anthropic.optIn' | 'ai.cloud.openai.optIn' | 'ai.cloud.gemini.optIn' | 'ai.cloud.compatible.optIn' |
  'ai.cloud.anthropic.model' | 'ai.cloud.openai.model' | 'ai.cloud.gemini.model' | 'ai.cloud.compatible.model' | 'ai.cloud.compatible.url' |
  'ai.features.journal' | 'ai.features.patchNotes' | 'ai.features.tonight' | 'ai.features.smartCollections' | 'ai.features.duplicates' |
  'ai.features.recapCaptions'> = {
  'ai.provider': 'local',
  'ai.cloud.anthropic.optIn': false,
  'ai.cloud.openai.optIn': false,
  'ai.cloud.gemini.optIn': false,
  'ai.cloud.compatible.optIn': false,
  'ai.cloud.anthropic.model': 'claude-sonnet-5-5',
  'ai.cloud.openai.model': '',
  'ai.cloud.gemini.model': '',
  'ai.cloud.compatible.model': '',
  'ai.cloud.compatible.url': '',
  'ai.features.journal': true,
  'ai.features.patchNotes': true,
  'ai.features.tonight': true,
  'ai.features.smartCollections': true,
  'ai.features.duplicates': true,
  'ai.features.recapCaptions': false,
};

/** Applies ?aiCloud to the starting settings. */
export function previewAiSettings(params: URLSearchParams): Partial<Settings> {
  return params.has('aiCloud') ? { 'ai.provider': 'anthropic', 'ai.cloud.anthropic.optIn': true } : {};
}

const NAMES: Record<CloudAiProviderId, [string, string, string]> = {
  anthropic: ['Claude', 'Anthropic', 'api.anthropic.com'],
  openai: ['ChatGPT', 'OpenAI', 'api.openai.com'],
  gemini: ['Gemini', 'Google', 'generativelanguage.googleapis.com'],
  compatible: ['OpenAI-compatible', 'the endpoint you entered', '(not set)'],
};
const IDS: CloudAiProviderId[] = ['anthropic', 'openai', 'gemini', 'compatible'];
const CLAUDE = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001'];
const LABEL: Record<string, string> = { 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-haiku-4-5-20251001': 'Claude Haiku 4.5' };
const FAKE_MODELS: Record<CloudAiProviderId, string[]> = {
  anthropic: CLAUDE,
  openai: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  compatible: ['openrouter/auto', 'meta-llama/llama-3.3-70b-instruct'],
};

const FEATURES: Omit<AiFeature, 'enabled'>[] = [
  { id: 'assistant', label: 'Assistant', sends: 'Your messages, the name of the page you’re on (and the game, if you’re on its page), and — only when the Assistant looks something up — what that look-up found: for example game titles, genres, statuses, hours played, sizes, play totals, prices or frame-rate statistics. Before look-up results go to a cloud AI you see exactly what and choose whether to share. Never folder paths, notes, keys or account details.', withoutAi: 'Without an AI, the Assistant can’t chat; every page still shows VYSTRAL’s own data.' },
  { id: 'journal', label: 'Play history questions (Assistant)', sends: 'Your question, today’s date, the names of games and genres in your library (to understand the question), then the totals VYSTRAL calculated for the chart (game titles or dates with hours and session counts).', withoutAi: 'The Assistant can’t look up your play history; the Journal page still shows it.' },
  { id: 'patchNotes', label: 'Patch note summaries', sends: 'The game’s title and the text of the public news post you asked to summarize.', withoutAi: 'The post’s first key lines are shown instead.' },
  { id: 'tonight', label: 'What to play tonight (Assistant)', sends: 'Your mood, the time you have and anything you type, plus up to 8 candidate games VYSTRAL picked: title, genres, your hours, average session length, time to beat, install and subscription status.', withoutAi: 'VYSTRAL’s own top three picks with their reasons.' },
  { id: 'smartCollections', label: 'Smart collections from a sentence', sends: 'Your sentence and the list of genre names in your library.', withoutAi: 'VYSTRAL’s own query parser builds the filter from your sentence.' },
  { id: 'duplicates', label: 'Duplicate explanations', sends: 'The two entries’ titles, stores, release years, developers and the matching facts VYSTRAL found.', withoutAi: 'The matching facts are listed without a sentence.' },
  { id: 'recapCaptions', label: 'Session recap captions', sends: 'The game’s title and that session’s stats: length, time of day, achievements unlocked, average frame rate and how many times you’ve played it.', withoutAi: 'No caption.' },
];

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dur = (s: number) => {
  if (s < 60) return 'under a minute';
  const m = Math.floor(s / 60), h = Math.floor(m / 60), mm = m % 60;
  return h === 0 ? `${mm} min` : mm === 0 ? `${h} h` : `${h} h ${mm} min`;
};
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const PLATFORM_NAME: Record<string, string> = { steam: 'Steam', xbox: 'Xbox', epic: 'Epic Games', gog: 'GOG', ea: 'EA app', ubisoft: 'Ubisoft Connect', battlenet: 'Battle.net', manual: 'Added by you' };

export function aiCloudPreviewHandlers(ctx: {
  lib: { games: Game[]; sessions: Session[] };
  emit: () => Emit;
  settings: () => Settings;
  setSettings: (s: Settings) => void;
  ttb: () => TimeToBeatMap;
  news: (gameId: string) => NewsFeed;
  replay: (sessionId: string) => ReplayData;
  duplicates: () => { gameIdA: string; gameIdB: string }[];
}) {
  const params = new URLSearchParams(location.search);
  const fail = params.has('aiFail');
  const invent = params.has('aiInvent');
  const slow = params.has('aiSlow');
  const keys: Partial<Record<CloudAiProviderId, string>> = params.has('aiCloud') ? { anthropic: '…k9Qz' } : {};
  const listed: Partial<Record<CloudAiProviderId, string[]>> = {};
  const tests: Partial<Record<CloudAiProviderId, CloudAiTest>> = {};
  const patchCache = new Map<string, PatchSummary>();
  const captionCache = new Map<string, RecapCaption>();
  const set = (patch: Partial<Settings>) => {
    const next = { ...ctx.settings(), ...patch };
    ctx.setSettings(next);
    ctx.emit()('settings.changed', next);
  };

  const s = () => ctx.settings();
  const model = (p: CloudAiProviderId) => {
    const chosen = s()[`ai.cloud.${p}.model` as const] as string;
    if (p === 'anthropic') return CLAUDE.includes(chosen) ? chosen : 'claude-sonnet-5-5';
    if (chosen) return chosen;
    return p === 'openai' ? 'gpt-5-mini' : p === 'gemini' ? 'gemini-2.5-flash' : listed[p]?.[0] ?? '';
  };
  const configured = (p: CloudAiProviderId) => !!keys[p] && (p !== 'compatible' || !!s()['ai.cloud.compatible.url']);
  const optedIn = (p: CloudAiProviderId) => !!s()[`ai.cloud.${p}.optIn` as const];
  const providerStatus = (p: CloudAiProviderId): CloudAiProviderStatus => ({
    id: p, name: NAMES[p][0], company: NAMES[p][1], configured: configured(p), keyMasked: keys[p] ?? null, optedIn: optedIn(p),
    model: model(p), modelLabel: LABEL[model(p)] ?? model(p), models: p === 'anthropic' ? CLAUDE : listed[p] ?? [], modelsListed: p === 'anthropic' || !!listed[p],
    baseUrl: p === 'compatible' && s()['ai.cloud.compatible.url'] ? `${s()['ai.cloud.compatible.url']}/` : null, lastTest: tests[p] ?? null, pausedUntil: null,
    host: p === 'compatible' ? (s()['ai.cloud.compatible.url'] ? new URL(s()['ai.cloud.compatible.url']).host : '(not set)') : NAMES[p][2],
  });

  const active = (): AiEngine => {
    const chosen = s()['ai.provider'] as AiProviderChoice;
    const localOn = s()['ai.enabled'];
    if (chosen !== 'local') {
      const [name] = NAMES[chosen];
      const label = `${name} · ${LABEL[model(chosen)] ?? model(chosen)}`;
      if (!s()['privacy.localOnly'] && optedIn(chosen) && configured(chosen)) return { engine: chosen, label, cloud: true, ready: true, reason: null };
      const reason = s()['privacy.localOnly'] ? `${name} is paused while Offline mode is on.` : !configured(chosen) ? `No key is saved for ${name}.` : `${name} isn’t turned on yet (Settings → AI).`;
      return localOn
        ? { engine: 'local', label: `Local AI · ${s()['ai.model']}`, cloud: false, ready: true, reason: `${reason} Local AI answers instead.` }
        : { engine: 'none', label: 'No AI', cloud: false, ready: false, reason };
    }
    if (localOn) return { engine: 'local', label: `Local AI · ${s()['ai.model']}`, cloud: false, ready: true, reason: null };
    return { engine: 'none', label: 'No AI', cloud: false, ready: false, reason: 'No AI is set up. Choose local AI or a cloud provider in Settings → AI.' };
  };

  const status = (): AiCloudStatus => ({
    provider: s()['ai.provider'] as AiProviderChoice, providers: IDS.map(providerStatus), localOnly: s()['privacy.localOnly'], localEnabled: s()['ai.enabled'],
    active: active(), features: FEATURES.map((f) => ({ ...f, enabled: !!s()[`ai.features.${f.id}` as keyof Settings] })),
  });

  /** The fake "model": returns accepted text, or null with a note (mirrors AiRouter.AskAsync). */
  const ask = async <T,>(feature: string, make: () => T | null, opts: { ignoreSwitch?: boolean } = {}): Promise<{ text: T | null; label: string | null; note: string | null; sent: string | null }> => {
    if (!opts.ignoreSwitch && !s()[`ai.features.${feature}` as keyof Settings]) return { text: null, label: null, note: null, sent: null };
    const e = active();
    await delay(slow ? 1600 : 350);
    if (e.engine === 'local') return { text: null, label: null, note: 'Ollama isn’t available in preview mode, so VYSTRAL’s own answer is shown.', sent: null };
    if (!e.ready || !e.cloud) return { text: null, label: null, note: e.reason, sent: null };
    if (fail) return { text: null, label: null, note: `${NAMES[e.engine as CloudAiProviderId][0]} is having trouble right now. Try again later.`, sent: null };
    const text = make();
    const f = FEATURES.find((x) => x.id === feature)!;
    if (text == null) return { text: null, label: null, note: `${NAMES[e.engine as CloudAiProviderId][0]}’s answer didn’t match the facts, so it wasn’t used.`, sent: null };
    return { text, label: e.label, note: null, sent: `Sent to ${NAMES[e.engine as CloudAiProviderId][1]} (${e.label}): ${f.sends}` };
  };

  // ---------- Journal (a small executor mirroring Ai/JournalQuery.cs) ----------
  const run = (spec: JournalSpec): JournalResult => {
    const byId = new Map(ctx.lib.games.map((g) => [g.id, g]));
    const from = spec.from ? new Date(`${spec.from}T00:00:00`) : null;
    const to = spec.to ? new Date(`${spec.to}T23:59:59`) : null;
    const picked = ctx.lib.sessions.filter((x) => x.end && x.durationSeconds > 0 && byId.has(x.gameId)).filter((x) => {
      const t = new Date(x.start);
      return (!from || t >= from) && (!to || t <= to) && (!spec.gameIds.length || spec.gameIds.includes(x.gameId)) &&
        (!spec.genres.length || byId.get(x.gameId)!.genres.some((g) => spec.genres.includes(g)));
    });
    const keyOf = (x: Session): [string, string, string | null][] => {
      const g = byId.get(x.gameId)!;
      const d = new Date(x.start);
      switch (spec.groupBy) {
        case 'game': return [[g.id, g.title, g.id]];
        case 'genre': return (g.genres.length ? g.genres : ['Unknown genre']).map((n) => [n.toLowerCase(), n, null]);
        case 'platform': { const p = g.installations.find((i) => i.id === x.installationId)?.platform ?? g.installations[0]?.platform ?? 'manual'; return [[p, PLATFORM_NAME[p], null]]; }
        case 'month': return [[ymd(d).slice(0, 7), d.toLocaleString('en', { month: 'short', year: 'numeric' }), null]];
        case 'weekday': return [[String((d.getDay() + 6) % 7), d.toLocaleString('en', { weekday: 'long' }), null]];
        case 'hour': return [[String(d.getHours()).padStart(2, '0'), hourLabel(d.getHours()), null]];
        case 'day': return [[ymd(d), d.toLocaleString('en', { month: 'short', day: 'numeric' }), null]];
        default: return [['all', 'Total', null]];
      }
    };
    const measure = (xs: Session[]) => spec.metric === 'sessions' ? xs.length
      : spec.metric === 'days' ? new Set(xs.map((x) => ymd(new Date(x.start)))).size
      : spec.metric === 'average' ? (xs.length ? xs.reduce((a, x) => a + x.durationSeconds, 0) / xs.length : 0)
      : spec.metric === 'longest' ? Math.max(0, ...xs.map((x) => x.durationSeconds))
      : xs.reduce((a, x) => a + x.durationSeconds, 0);
    const groups = new Map<string, { label: string; gameId: string | null; items: Session[] }>();
    for (const x of picked) for (const [k, label, gameId] of keyOf(x)) {
      const e = groups.get(k) ?? { label, gameId, items: [] };
      e.items.push(x);
      groups.set(k, e);
    }
    let rows: JournalRow[] = [...groups].map(([key, v]) => ({ key, label: v.label, value: Math.round(measure(v.items) * 100) / 100, gameId: v.gameId }));
    const time = ['month', 'weekday', 'hour', 'day'].includes(spec.groupBy);
    if (spec.groupBy === 'weekday') rows = Array.from({ length: 7 }, (_, i) => rows.find((r) => r.key === String(i)) ?? { key: String(i), label: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][i], value: 0, gameId: null });
    else if (spec.groupBy === 'hour') rows = Array.from({ length: 24 }, (_, h) => rows.find((r) => r.key === String(h).padStart(2, '0')) ?? { key: String(h).padStart(2, '0'), label: hourLabel(h), value: 0, gameId: null });
    else if (time) rows.sort((a, b) => a.key.localeCompare(b.key));
    else rows = rows.sort((a, b) => (spec.sort === 'asc' ? a.value - b.value : b.value - a.value) || a.label.localeCompare(b.label)).slice(0, spec.limit);
    const unit = spec.metric === 'sessions' ? 'count' : spec.metric === 'days' ? 'days' : 'seconds';
    const range = rangeLabel(spec.from, spec.to);
    const metricWord = { playtime: 'Playtime', sessions: 'Sessions', days: 'Days played', average: 'Average session', longest: 'Longest session' }[spec.metric];
    return {
      spec, rows, unit, chart: time ? 'column' : 'bar', total: Math.round(measure(picked) * 100) / 100, sessions: picked.length,
      games: new Set(picked.map((x) => x.gameId)).size, rangeLabel: range, description: `${metricWord} by ${spec.groupBy} · ${range}`,
      notes: spec.groupBy === 'genre' ? ['A game with several genres counts toward each of them.'] : [], unmatched: [],
    };
  };
  const fmt = (v: number, unit: JournalResult['unit']) => unit === 'count' ? `${v} ${v === 1 ? 'session' : 'sessions'}` : unit === 'days' ? `${v} ${v === 1 ? 'day' : 'days'}` : dur(v);
  const plain = (r: JournalResult) => {
    if (!r.sessions) return `No tracked sessions match in ${r.rangeLabel}.`;
    const top = [...r.rows].sort((a, b) => b.value - a.value)[0];
    if (r.spec.metric === 'playtime' && r.spec.groupBy !== 'none' && top) return `${top.label} leads ${r.rangeLabel} with ${fmt(top.value, r.unit)}. In total you played ${fmt(r.total, r.unit)} across ${r.sessions} sessions.`;
    if (top && r.spec.groupBy !== 'none') return `${top.label}: ${fmt(top.value, r.unit)} in ${r.rangeLabel}.`;
    return `You played ${fmt(r.total, r.unit)} in ${r.rangeLabel}.`;
  };
  const resolveSpec = (input: Record<string, unknown>): JournalSpec => {
    const today = new Date();
    let from: string | null = (input.from as string) ?? null, to: string | null = (input.to as string) ?? null;
    const preset = input.preset as string | undefined;
    if (!from && !to && preset) {
      const y = today.getFullYear(), m = today.getMonth();
      const r: Record<string, [Date, Date] | null> = {
        last7: [new Date(today.getTime() - 6 * 864e5), today], last30: [new Date(today.getTime() - 29 * 864e5), today],
        thisMonth: [new Date(y, m, 1), today], lastMonth: [new Date(y, m - 1, 1), new Date(y, m, 0)],
        thisYear: [new Date(y, 0, 1), today], lastYear: [new Date(y - 1, 0, 1), new Date(y - 1, 11, 31)], all: null,
      };
      if (!(preset in r)) throw new BridgeError('invalid', 'That question couldn’t be run.');
      const v = r[preset];
      if (v) { from = ymd(v[0]); to = ymd(v[1]); }
    }
    const metric = (input.metric as JournalMetric) ?? 'playtime';
    const groupBy = (input.groupBy as JournalGroup) ?? 'game';
    if (!['playtime', 'sessions', 'days', 'average', 'longest'].includes(metric) || !['game', 'genre', 'platform', 'month', 'weekday', 'hour', 'day', 'none'].includes(groupBy))
      throw new BridgeError('invalid', 'That question couldn’t be run.');
    return { metric, groupBy, from, to, gameIds: (input.gameIds as string[]) ?? [], genres: (input.genres as string[]) ?? [], platforms: [], sort: input.sort === 'asc' ? 'asc' : 'desc', limit: Math.min(20, Math.max(1, Number(input.limit ?? 10))) };
  };
  /** The fake planner: keywords → spec (a real model returns JSON that is validated natively). */
  const plan = (q: string): Record<string, unknown> | 'unsupported' => {
    const t = q.toLowerCase();
    if (/\b(weather|price|cost|achievement|friend)\b/.test(t)) return 'unsupported';
    const spec: Record<string, unknown> = { metric: 'playtime', groupBy: 'game' };
    if (/sessions?\b|how often/.test(t)) spec.metric = 'sessions';
    if (/longest/.test(t)) spec.metric = 'longest';
    if (/genre/.test(t)) spec.groupBy = 'genre';
    else if (/day of the week|weekday|which days/.test(t)) spec.groupBy = 'weekday';
    else if (/time of day|what time|hour/.test(t)) spec.groupBy = 'hour';
    else if (/each month|per month|by month|monthly/.test(t)) spec.groupBy = 'month';
    const month = MONTHS.findIndex((m) => t.includes(m));
    const now = new Date();
    if (month >= 0) {
      const year = month > now.getMonth() ? now.getFullYear() - 1 : now.getFullYear();
      spec.from = ymd(new Date(year, month, 1));
      spec.to = ymd(new Date(year, month + 1, 0));
    } else if (/last month/.test(t)) spec.preset = 'lastMonth';
    else if (/this month/.test(t)) spec.preset = 'thisMonth';
    else if (/this year/.test(t)) spec.preset = 'thisYear';
    else if (/last week|7 days/.test(t)) spec.preset = 'last7';
    else spec.preset = 'all';
    const game = ctx.lib.games.find((g) => t.includes(g.title.toLowerCase()));
    if (game) spec.gameIds = [game.id];
    return spec;
  };

  // ---------- Tonight ----------
  const tonight = (mood: string, minutes: number) => {
    const ttb = ctx.ttb().games;
    const moodGenres: Record<string, string[]> = {
      chill: ['casual', 'simulation', 'puzzle', 'platformer', 'indie', 'adventure'], intense: ['action', 'shooter', 'racing', 'horror', 'survival'],
      story: ['rpg', 'adventure', 'narrative'], brainy: ['strategy', 'puzzle', 'simulation'], social: ['multiplayer', 'sports'],
    };
    return ctx.lib.games
      .filter((g) => !g.hidden && g.status !== 'completed' && g.status !== 'abandoned' && g.installations.some((i) => i.state === 'installed'))
      .map((g) => {
        const reasons: string[] = [];
        let score = 3;
        if (g.status === 'playing') { score += 3; reasons.push('You marked it as playing'); }
        else if (g.status === 'backlog') { score += 1.5; reasons.push('It’s on your backlog'); }
        const t = ttb[g.id]?.main;
        const left = t ? Math.max(0, t - g.trackedSeconds) : null;
        if (left && left <= minutes * 60 * 1.05) { score += 4; reasons.push(`About ${dur(left)} left to the credits, so you could finish it tonight`); }
        const avg = g.sessionCount > 0 ? g.trackedSeconds / g.sessionCount / 60 : null;
        if (avg && avg <= minutes * 1.1) { score += 2; reasons.push(`Your sessions average ${Math.round(avg)} min, which fits your ${minutes >= 90 ? `${minutes / 60} h` : `${minutes} min`}`); }
        const genre = g.genres.find((x) => moodGenres[mood]?.some((w) => x.toLowerCase().includes(w)));
        if (genre) { score += 2.5; reasons.push(`${genre} suits ${mood === 'chill' ? 'something chill' : mood === 'intense' ? 'something intense' : mood === 'story' ? 'a good story' : mood === 'brainy' ? 'something to think about' : 'playing with others'}`); }
        if (g.favorite) { score += 1; reasons.push('One of your favorites'); }
        if (!reasons.length) reasons.push('Installed and ready');
        return { g, score, reasons };
      })
      .sort((a, b) => b.score - a.score || a.g.title.localeCompare(b.g.title))
      .slice(0, 8);
  };

  // ---------- Duplicates ----------
  const dupFacts = (a: Game, b: Game): DuplicateFact[] => {
    const facts: DuplicateFact[] = [];
    const base = (t: string) => t.toLowerCase().replace(/\b(remastered|definitive edition|goty|game of the year edition|deluxe edition)\b/g, '').trim();
    if (a.title.toLowerCase() === b.title.toLowerCase()) facts.push({ kind: 'title', text: 'The titles are identical.', supports: true });
    else if (base(a.title) === base(b.title)) facts.push({ kind: 'title', text: `Both titles read “${base(a.title)}” once edition words are set aside.`, supports: true });
    if (/remaster/i.test(a.title) !== /remaster/i.test(b.title)) facts.push({ kind: 'edition', text: 'One is a remaster, which is often sold as a separate game.', supports: false });
    if (a.developer && a.developer === b.developer) facts.push({ kind: 'developer', text: `Same developer: ${a.developer}.`, supports: true });
    const ya = a.releaseDate?.slice(0, 4), yb = b.releaseDate?.slice(0, 4);
    if (ya && yb) facts.push(ya === yb ? { kind: 'year', text: `Both were released in ${ya}.`, supports: true } : { kind: 'year', text: `Release years differ: ${ya} and ${yb}.`, supports: false });
    const sa = [...new Set(a.installations.map((i) => i.platform))], sb = [...new Set(b.installations.map((i) => i.platform))];
    const shared = sa.filter((p) => sb.includes(p));
    facts.push(shared.length
      ? { kind: 'store', text: `Both are on ${shared.map((p) => PLATFORM_NAME[p]).join(' and ')}, where they’re listed as separate products.`, supports: false }
      : { kind: 'store', text: `They come from different stores: ${sa.map((p) => PLATFORM_NAME[p]).join(', ')} and ${sb.map((p) => PLATFORM_NAME[p]).join(', ')}.`, supports: true });
    return facts;
  };

  const handlers: Record<string, (p: any) => unknown> = {
    'aiCloud.status': () => status(),
    'aiCloud.connect': async (p: { provider: CloudAiProviderId; key: string; baseUrl?: string | null }): Promise<CloudAiAction> => {
      if (!IDS.includes(p.provider)) throw new BridgeError('invalid', 'Unknown AI provider.');
      await delay(500);
      const key = String(p.key ?? '').trim();
      const record = (outcome: CloudAiTest['outcome'], message: string) => (tests[p.provider] = { outcome, message, at: new Date().toISOString() });
      let result: CloudAiTest;
      if (s()['privacy.localOnly']) result = record('offline', `Offline mode is on, so VYSTRAL doesn’t contact ${NAMES[p.provider][0]}. Turn it off in Settings → Privacy.`);
      else if (!/^[A-Za-z0-9_\-.]{16,250}$/.test(key)) result = record('invalidKey', 'That doesn’t look like an API key. Copy it again, without spaces.');
      else if (p.provider !== 'anthropic' && key.startsWith('sk-ant-')) result = record('invalidKey', 'That looks like a Claude key. Add it under Claude instead.');
      else if (p.provider === 'compatible' && !/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\-/]*)?$/.test(String(p.baseUrl ?? '').trim()))
        result = record('malformed', 'The address must start with https:// and contain no password, “?” or “#”. For example https://openrouter.ai/api/v1');
      else if (key.toLowerCase().startsWith('bad')) result = record('invalidKey', `${NAMES[p.provider][0]} didn’t accept the key. Check it, or create a new one.`);
      else {
        keys[p.provider] = `…${key.slice(-4)}`;
        listed[p.provider] = FAKE_MODELS[p.provider];
        if (p.provider === 'compatible') set({ 'ai.cloud.compatible.url': String(p.baseUrl).trim().replace(/\/+$/, '') });
        result = record('ok', p.provider === 'anthropic' ? 'Saved. Anthropic accepted the key.' : `Saved. ${NAMES[p.provider][1]} lists ${FAKE_MODELS[p.provider].length} models for this key.`);
      }
      ctx.emit()('aiCloud.changed', status());
      return { result, provider: providerStatus(p.provider) };
    },
    'aiCloud.test': async (p: { provider: CloudAiProviderId }): Promise<CloudAiAction> => {
      await delay(slow ? 1600 : 450);
      const name = NAMES[p.provider][0];
      tests[p.provider] = s()['privacy.localOnly'] ? { outcome: 'offline', message: `Offline mode is on, so VYSTRAL doesn’t contact ${name}.`, at: new Date().toISOString() }
        : !configured(p.provider) ? { outcome: 'notConfigured', message: 'No key is saved for this provider yet.', at: new Date().toISOString() }
        : fail ? { outcome: 'unavailable', message: `${name} is having trouble right now. Try again later.`, at: new Date().toISOString() }
        : { outcome: 'ok', message: `${LABEL[model(p.provider)] ?? model(p.provider)} answered in 0.4 s (preview stand-in).`, at: new Date().toISOString() };
      return { result: tests[p.provider]!, provider: providerStatus(p.provider) };
    },
    'aiCloud.disconnect': (p: { provider: CloudAiProviderId }) => {
      delete keys[p.provider];
      delete listed[p.provider];
      delete tests[p.provider];
      set({ [`ai.cloud.${p.provider}.optIn`]: false, ...(s()['ai.provider'] === p.provider ? { 'ai.provider': 'local' } : {}) } as Partial<Settings>);
      const st = status();
      ctx.emit()('aiCloud.changed', st);
      return st;
    },
    'aiCloud.models': async (p: { provider: CloudAiProviderId }) => {
      await delay(300);
      if (!configured(p.provider)) throw new BridgeError('notConfigured', 'No key is saved for this provider yet.');
      listed[p.provider] = FAKE_MODELS[p.provider];
      return providerStatus(p.provider);
    },
    'aiCloud.openLink': () => true,

    'aix.journalRun': (p: { spec: Record<string, unknown>; label: string }): JournalAnswer => {
      const r = run(resolveSpec(p.spec));
      return { question: p.label, result: r, answer: plain(r), plannedBy: null, phrasedBy: null, note: null, needsAi: false, unsupported: null, engine: active(), sent: null };
    },
    'aix.journalAsk': async (p: { question: string }): Promise<JournalAnswer> => {
      const e = active();
      const q = String(p.question ?? '').slice(0, 300);
      if (!e.ready || !s()['ai.features.journal']) return { question: q, result: null, answer: '', plannedBy: null, phrasedBy: null, note: e.reason, needsAi: true, unsupported: null, engine: e, sent: null };
      const planned = plan(q);
      const first = await ask('journal', () => 'plan');
      if (!first.text) return { question: q, result: null, answer: '', plannedBy: null, phrasedBy: null, note: first.note, needsAi: false, unsupported: null, engine: e, sent: null };
      if (planned === 'unsupported') return { question: q, result: null, answer: '', plannedBy: first.label, phrasedBy: null, note: null, needsAi: false, unsupported: 'Your play sessions don’t record that, so it can’t be answered from the Journal.', engine: e, sent: first.sent };
      const r = run(resolveSpec(planned));
      const own = plain(r);
      const top = [...r.rows].sort((a, b) => b.value - a.value)[0];
      const phrased = await ask('journal', () => invent ? null
        : !r.sessions ? `Nothing was tracked in ${r.rangeLabel}, so there’s nothing to compare yet.`
        : top && r.spec.groupBy === 'game' ? `${top.label} was your go-to in ${r.rangeLabel}, with ${fmt(top.value, r.unit)} of the ${fmt(r.total, r.unit)} you played.`
        : own);
      return {
        question: q, result: r, answer: phrased.text ?? own, plannedBy: first.label, phrasedBy: phrased.label,
        note: phrased.text ? null : phrased.note ?? 'The AI’s wording didn’t match the numbers, so VYSTRAL’s own summary is shown.',
        needsAi: false, unsupported: null, engine: e, sent: phrased.sent ?? first.sent,
      };
    },
    'aix.patchSummary': async (p: { gameId: string; gid: string; refresh?: boolean }): Promise<PatchSummary> => {
      const post = ctx.news(p.gameId).posts.find((x) => x.gid === p.gid);
      if (!post) throw new BridgeError('notFound', 'That post is no longer listed. Refresh the news.');
      const key = `${p.gameId}:${p.gid}`;
      if (!p.refresh && patchCache.has(key)) return { ...patchCache.get(key)!, cached: true, engine: active(), sent: null };
      const items = post.blocks.filter((b) => b.kind === 'li').map((b) => b.spans.map((x) => x.text).join('').trim()).filter(Boolean);
      const sentences = post.blocks.filter((b) => b.kind === 'p').flatMap((b) => b.spans.map((x) => x.text).join('').split(/(?<=[.!?])\s+/)).map((x) => x.trim()).filter((x) => x.length > 12);
      const keyLines = (items.length >= 2 ? items : sentences).slice(0, 3);
      const out = await ask('patchNotes', () => invent ? null : keyLines.map((l) => (l.length > 110 ? `${l.slice(0, 108).trimEnd()}…` : l).replace(/^./, (c) => c.toUpperCase())));
      if (out.text) {
        const res: PatchSummary = { bullets: out.text, ai: true, aiLabel: out.label, cached: false, note: null, trimmed: false, engine: active(), sent: out.sent };
        patchCache.set(key, res);
        return res;
      }
      return { bullets: keyLines, ai: false, aiLabel: null, cached: false, note: out.note ?? active().reason, trimmed: false, engine: active(), sent: null };
    },
    'aix.tonight': async (p: { mood?: string; minutes?: number; note?: string; includeSubs?: boolean }): Promise<TonightAnswer> => {
      const mood = p.mood ?? 'any';
      const minutes = Math.min(600, Math.max(15, p.minutes ?? 60));
      const cs = tonight(mood, minutes);
      const intro = cs.length ? `For ${mood === 'any' ? 'anything' : mood === 'chill' ? 'something chill' : mood === 'intense' ? 'something intense' : mood === 'story' ? 'a good story' : mood === 'brainy' ? 'something to think about' : 'playing with others'} with about ${minutes >= 90 ? `${minutes / 60} hours` : `${minutes} minutes`}, these fit best.`
        : 'Nothing is installed or included in your plans right now, so there’s nothing to suggest for tonight.';
      const toPick = (c: (typeof cs)[number], reason: string): TonightPick => ({ kind: 'library', gameId: c.g.id, productId: null, title: c.g.title, reason, facts: c.reasons, installed: true, plan: null });
      if (!cs.length) return { intro, picks: [], considered: 0, engine: active(), aiLabel: null, note: null, sent: null };
      const out = await ask('tonight', () => invent ? null : 'ok');
      if (out.text) {
        const note = (p.note ?? '').trim();
        const picks = cs.slice(0, 3).map((c, i) => toPick(c, i === 0
          ? `${c.reasons[0]}${note ? ` — and it fits “${note.slice(0, 60)}”` : ''}. A good pick to settle into tonight.`
          : `${c.reasons[0]}. ${c.reasons[1] ?? 'Ready whenever you are'}.`));
        return { intro: 'Here’s what I’d reach for tonight.', picks, considered: cs.length, engine: active(), aiLabel: out.label, note: null, sent: out.sent };
      }
      return { intro, picks: cs.slice(0, 3).map((c) => toPick(c, `${c.reasons.slice(0, 2).join('. ')}.`)), considered: cs.length, engine: active(), aiLabel: null, note: out.note, sent: null };
    },
    'aix.smartFilter': async (p: { sentence: string }): Promise<SmartFilterAnswer> => {
      const e = active();
      const sentence = String(p.sentence ?? '').slice(0, 200);
      if (!e.ready || !s()['ai.features.smartCollections'])
        return { sentence, name: null, filter: null, dropped: [], needsAi: true, aiLabel: null, note: e.reason, engine: e, sent: null };
      const known = [...new Set(ctx.lib.games.flatMap((g) => g.genres))];
      const t = sentence.toLowerCase();
      const raw: Record<string, unknown> = {};
      const want = (words: string[]) => known.filter((k) => words.includes(k.toLowerCase()));
      if (/\b(cosy|cozy|chill|relax|calm)/.test(t)) raw.genresAny = want(['casual', 'puzzle', 'simulation', 'indie', 'adventure', 'platformer']);
      for (const g of known) if (t.includes(g.toLowerCase())) raw.genresAny = [...new Set([...(raw.genresAny as string[] ?? []), g])];
      const hours = t.match(/under (\d{1,3}) ?(h|hours?)/);
      if (hours) raw.ttbMaxHours = Number(hours[1]);
      if (/(haven['’]?t|not) (finished|beaten)|unfinished/.test(t)) raw.statusNone = ['beaten', 'completed'];
      if (/\binstalled\b/.test(t)) raw.installed = !/not installed/.test(t);
      if (/never played|unplayed/.test(t)) raw.neverPlayed = true;
      const filter = parseSmartFilter(raw);
      const out = await ask('smartCollections', () => (filter ? 'ok' : null));
      if (out.text && filter) {
        const name = sentence.replace(/\b(i|my|that|which|games?)\b/gi, ' ').replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase()).slice(0, 40) || 'Smart collection';
        return { sentence, name, filter, dropped: [], needsAi: false, aiLabel: out.label, note: null, engine: e, sent: out.sent };
      }
      return { sentence, name: null, filter: null, dropped: [], needsAi: false, aiLabel: null, note: out.note ?? 'The AI couldn’t turn that into a filter VYSTRAL could check, so VYSTRAL’s own reading of your sentence is shown.', engine: e, sent: null };
    },
    'aix.explainDuplicate': async (p: { gameIdA: string; gameIdB: string }): Promise<DuplicateExplanation> => {
      const a = ctx.lib.games.find((g) => g.id === p.gameIdA), b = ctx.lib.games.find((g) => g.id === p.gameIdB);
      if (!a || !b) throw new BridgeError('notFound', 'That game is no longer in your library.');
      const facts = dupFacts(a, b);
      const out = await ask('duplicates', () => invent ? null
        : `${a.title} and ${b.title} share a name and studio, but ${facts.some((f) => f.kind === 'edition') ? 'one is a remaster that’s usually sold separately' : 'they come from different stores'}, so they may be different products.`);
      return { facts, sentence: out.text, aiLabel: out.label, note: out.note, engine: active(), sent: out.sent };
    },
    'aix.recapCaption': async (p: { sessionId: string; refresh?: boolean; ask?: boolean }): Promise<RecapCaption> => {
      const data = ctx.replay(p.sessionId);
      if (!p.refresh && captionCache.has(p.sessionId)) return { ...captionCache.get(p.sessionId)!, cached: true };
      const e = active();
      if (!e.ready || (!p.ask && !s()['ai.features.recapCaptions'])) return { caption: null, aiLabel: null, cached: false, note: null, engine: e, sent: null };
      const hour = new Date(data.session.start).getHours();
      const when = hour < 5 ? 'late-night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 22 ? 'evening' : 'late-night';
      const out = await ask('recapCaptions', () => invent ? null
        : `A ${when} run of ${dur(data.session.durationSeconds)} in ${data.session.title}${data.achievements.length ? `, with ${data.achievements[0].name} to show for it` : ''}.`, { ignoreSwitch: !!p.ask });
      if (out.text) {
        const res: RecapCaption = { caption: out.text, aiLabel: out.label, cached: false, note: null, engine: e, sent: out.sent };
        captionCache.set(p.sessionId, res);
        return res;
      }
      return { caption: null, aiLabel: null, cached: false, note: out.note, engine: e, sent: null };
    },
    'aix.clearCache': () => { patchCache.clear(); captionCache.clear(); return true; },
  };
  void ctx.duplicates;
  return handlers;
}

function hourLabel(h: number) {
  return h === 0 ? '12 am' : h < 12 ? `${h} am` : h === 12 ? '12 pm' : `${h - 12} pm`;
}

function rangeLabel(from: string | null, to: string | null): string {
  if (!from && !to) return 'all time';
  const d = (s: string) => new Date(`${s}T00:00:00`).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  if (from && to) {
    const f = new Date(`${from}T00:00:00`), t = new Date(`${to}T00:00:00`);
    const lastDay = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
    if (f.getDate() === 1 && t.getDate() === lastDay && f.getMonth() === t.getMonth() && f.getFullYear() === t.getFullYear())
      return f.toLocaleString('en', { month: 'long', year: 'numeric' });
    if (from.endsWith('-01-01') && to.endsWith('-12-31') && from.slice(0, 4) === to.slice(0, 4)) return from.slice(0, 4);
    return from === to ? d(from) : `${d(from)} – ${d(to)}`;
  }
  return from ? `since ${d(from)}` : `until ${d(to!)}`;
}
