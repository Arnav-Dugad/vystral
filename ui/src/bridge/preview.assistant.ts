/**
 * Track D3 preview: the one Assistant with a FAKE provider. Nothing here contacts any AI; a tiny keyword planner stands in
 * for the model so every state can be seen and tested: streaming, look-up chips and cards, the approval before sharing
 * with a cloud AI, proposed actions, errors. All data is the preview's fictional library.
 * URL switches (with ?aiCloud from preview.ai.ts for a ready cloud provider):
 *   ?assistantFail   the provider fails after starting
 *   ?assistantSlow   slower streaming (loading states)
 */
import type {
  AiCloudStatus, AssistantCard, AssistantChatParams, AssistantConversationInfo, AssistantEvent, AssistantProposal, AssistantStatus, AssistantToolCall,
  AssistantToolInfo, Game, JournalAnswer, Session, Settings,
} from './types';
import { BridgeError } from './bridge';

type Emit = (name: string, payload: unknown) => void;

export const ASSISTANT_DEFAULT_SETTINGS: Pick<Settings, 'ai.features.assistant' | 'assistant.launcher' | 'assistant.askBeforeSharing' | 'assistant.keepHistory'> = {
  'ai.features.assistant': true,
  'assistant.launcher': true,
  'assistant.askBeforeSharing': true,
  'assistant.keepHistory': true,
};

const TOOLS: AssistantToolInfo[] = [
  ['search_library', 'Library search', 'read', 'Matching games from your library: titles, genres, stores, status, favorite, hours played, last played, install state and size.'],
  ['get_game', 'Game details', 'read', 'That game’s title, developer, genres, release date, status, rating, hours, sessions, stores, install size, time to beat and collections (never its folder or your notes).'],
  ['game_facts', 'Game facts', 'read', 'Public facts about that game: community tags, Steam Deck rating, anti-cheat, controller layout type, review scores and price.'],
  ['query_journal', 'Play history', 'read', 'Totals VYSTRAL calculated from your sessions: game titles or dates with hours and session counts.'],
  ['list_sessions', 'Sessions', 'read', 'Your recent sessions: game title, start time, length, average frame rate, 1% low and stutter count.'],
  ['weekly_recap', 'Weekly recap', 'read', 'That week’s totals: hours, days played, sessions, top games with their hours, the longest session, first-time games and last week’s total.'],
  ['tonight_picks', 'Tonight’s picks', 'read', 'Up to 8 candidate games: title, genres, your hours, average session length, time left to beat, status, install and subscription status.'],
  ['get_achievements', 'Achievements', 'read', 'Achievement counts and names with unlock dates and global rarity.'],
  ['get_wishlist', 'Wishlist', 'read', 'Wishlist titles with prices, discounts, lowest prices and release dates.'],
  ['search_store', 'Discover search', 'read', 'Store search results for your words: titles, years, stores and prices.'],
  ['get_subscriptions', 'Subscriptions', 'read', 'Your plans, how many games each includes, and titles that are leaving soon or new.'],
  ['cloud_availability', 'Cloud play', 'read', 'Cloud services that can stream that game and what they require.'],
  ['performance_overview', 'Performance', 'read', 'Your GPU, CPU and memory, recent sessions’ frame-rate summaries and the names of background apps seen during them.'],
  ['explain_stutter', 'Stutter check', 'read', 'That session’s frame-time statistics, the moments with spikes and the CPU, GPU, memory and temperature readings around them, plus background app names.'],
  ['get_storage', 'Storage', 'read', 'Drive letters with free and total space, your largest installed games with sizes, and whether pending updates fit.'],
  ['get_health', 'Library health', 'read', 'The health score and issue titles (no file paths).'],
  ['get_news', 'News', 'read', 'Titles, dates and the first lines of that game’s latest news posts.'],
  ['notifications_digest', 'Digest', 'read', 'Counts and titles: health issues, discounted wishlist games, subscription games leaving soon, drives short on space and near-complete achievements.'],
  ['suggest_tags', 'Tag ideas', 'read', 'That game’s title, genres, developer and store description, plus the most common tag names in your library.'],
  ['get_settings', 'Settings', 'read', 'Your VYSTRAL settings in that area (never keys or addresses).'],
  ['open_page', 'Open a page', 'action', 'Nothing (runs on this PC after you confirm).'],
  ['open_game', 'Open a game page', 'action', 'Nothing (runs on this PC after you confirm).'],
  ['create_collection', 'New collection', 'action', 'Nothing (runs on this PC after you confirm).'],
  ['create_smart_collection', 'New smart collection', 'action', 'Nothing (runs on this PC after you confirm).'],
  ['set_status', 'Set status', 'action', 'Nothing (runs on this PC after you confirm).'],
  ['set_favorite', 'Favorite', 'action', 'Nothing (runs on this PC after you confirm).'],
  ['start_discover_search', 'Discover search', 'action', 'Nothing (runs on this PC after you confirm).'],
  ['watch_game', 'Add to Watching', 'action', 'Nothing (runs on this PC after you confirm).'],
].map(([name, label, kind, sends]) => ({ name, label, kind: kind as 'read' | 'action', sends }));

const COMPANY: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google', compatible: 'the endpoint you entered' };
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hours = (s: number) => Math.round((s / 3600) * 10) / 10;

interface Step {
  tool: string;
  args?: Record<string, unknown>;
}

interface Outcome {
  summary: string;
  card?: AssistantCard;
  action?: Omit<AssistantProposal, 'id'>;
  /** The fake model's sentence about this result. */
  say: string;
  shared: boolean;
}

export function assistantPreviewHandlers(ctx: {
  lib: { games: Game[]; sessions: Session[] };
  emit: () => Emit;
  settings: () => Settings;
  call: (method: string, params?: unknown) => unknown;
}) {
  const params = new URLSearchParams(location.search);
  const fail = params.has('assistantFail');
  const slow = params.has('assistantSlow');
  const conversations = new Map<string, Record<string, unknown>>();
  const running = new Map<string, { cancelled: boolean; approve?: (v: { allow: boolean; always: boolean }) => void; approvalId?: string }>();
  let seq = 0;

  const s = () => ctx.settings();
  const engine = () => {
    const st = ctx.call('aiCloud.status') as AiCloudStatus;
    if (!s()['ai.features.assistant']) return { engine: 'none', label: 'No AI', cloud: false, ready: false, reason: 'The Assistant is turned off in Settings → AI.' } as AiCloudStatus['active'];
    return st.active;
  };
  const status = (): AssistantStatus => ({
    engine: engine(), enabled: s()['ai.features.assistant'], launcher: s()['assistant.launcher'], askBeforeSharing: s()['assistant.askBeforeSharing'],
    keepHistory: s()['assistant.keepHistory'], localOnly: s()['privacy.localOnly'], tools: TOOLS,
  });

  const visible = () => ctx.lib.games.filter((g) => !g.hidden);
  const installed = (g: Game) => g.installations.some((i) => i.state === 'installed');
  const findGame = (q: string, gameId?: string | null) =>
    (gameId ? visible().find((g) => g.id === gameId) : undefined) ?? visible().find((g) => q.includes(g.title.toLowerCase()));

  function plan(q: string, c: AssistantChatParams['context']): Step[] {
    const game = findGame(q, c.gameId);
    if (/\bfavou?rites?\b/.test(q) && game) return [{ tool: 'set_favorite', args: { gameId: game.id } }];
    if (/\b(open|go to|take me to)\b.*\b(storage|journal|wishlist|discover|settings|library|health)\b/.test(q))
      return [{ tool: 'open_page', args: { page: q.match(/\b(storage|journal|wishlist|discover|settings|library|health)\b/)![1] } }];
    if (/stutter|frame ?time|hitch/.test(q)) return [{ tool: 'explain_stutter' }];
    if (/tonight|what should i play|play now/.test(q)) return [{ tool: 'tonight_picks', args: { minutes: Number(q.match(/(\d+)\s*h/)?.[1] ?? 1) * 60 } }];
    if (/weekly recap|my week|this week/.test(q)) return [{ tool: 'weekly_recap' }];
    if (/controller|steam deck|deck|reviews?|anti-?cheat/.test(q) && game) return [{ tool: 'game_facts', args: { gameId: game.id } }];
    if (/collection/.test(q)) return [{ tool: 'search_library' }, { tool: 'create_collection' }];
    if (/(played most|how much|hours|which days|this month|play history|journal)/.test(q)) return [{ tool: 'query_journal', args: { groupBy: /days/.test(q) ? 'weekday' : 'game' } }];
    if (/attention|digest|notifications?|news/.test(q)) return [{ tool: 'notifications_digest' }];
    if (/space|storage|uninstall|disk/.test(q)) return [{ tool: 'get_storage' }];
    if (/co-?op|friends|haven.t started|never played|find|which games|rpg|games/.test(q)) return [{ tool: 'search_library' }];
    return [];
  }

  function search(q: string): Game[] {
    let list = visible();
    if (/haven.t started|never played|not started/.test(q)) list = list.filter((g) => g.trackedSeconds === 0 && g.sessionCount === 0);
    const genre = ['rpg', 'racing', 'strategy', 'horror', 'puzzle', 'shooter', 'simulation', 'adventure', 'indie', 'action'].find((x) => q.includes(x));
    if (genre) list = list.filter((g) => g.genres.some((x) => x.toLowerCase() === genre));
    if (/co-?op|friends|multiplayer/.test(q)) list = list.filter((g) => g.genres.some((x) => /multiplayer|action|shooter|sports/i.test(x)));
    return list.slice(0, 12);
  }

  function run(step: Step, q: string, c: AssistantChatParams['context'], found: Game[]): Outcome {
    switch (step.tool) {
      case 'search_library': {
        const games = search(q);
        found.splice(0, found.length, ...games);
        return {
          summary: `${games.length} ${games.length === 1 ? 'game' : 'games'} found`, shared: true,
          card: games.length ? { kind: 'games', title: `${games.length} ${games.length === 1 ? 'game' : 'games'}`, items: games.map((g) => ({ id: g.id, title: g.title, sub: installed(g) ? `${hours(g.trackedSeconds)} h played` : 'Not installed' })) } : undefined,
          say: games.length ? `I found **${games.length} ${games.length === 1 ? 'game' : 'games'}** in your library that fit: ${games.slice(0, 3).map((g) => g.title).join(', ')}${games.length > 3 ? ' and more' : ''}.` : 'Nothing in your library matches that yet.',
        };
      }
      case 'tonight_picks': {
        const picks = visible().filter((g) => installed(g) && g.status !== 'completed' && g.status !== 'abandoned')
          .sort((a, b) => Number(b.status === 'playing') - Number(a.status === 'playing') || b.trackedSeconds - a.trackedSeconds).slice(0, 3);
        const minutes = Number(step.args?.minutes ?? 60);
        return {
          summary: `${picks.length} candidates`, shared: true,
          card: { kind: 'picks', title: `anything · ${minutes >= 90 ? `${minutes / 60} h` : `${minutes} min`}`, items: picks.map((g, i) => ({ gameId: g.id, productId: null, title: g.title, facts: i === 0 && g.status === 'playing' ? ['You marked it as playing', 'Installed and ready'] : ['Installed and ready', `${hours(g.trackedSeconds)} h played`], installed: true, plan: null })) },
          say: picks.length ? `With about ${minutes >= 90 ? `${minutes / 60} hours` : `${minutes} minutes`}, I’d reach for **${picks[0].title}**: it’s installed and ready to pick up where you left off.${picks[1] ? ` ${picks[1].title} is a good second choice.` : ''}` : 'Nothing is installed right now, so there’s nothing to suggest for tonight.',
        };
      }
      case 'query_journal':
      case 'weekly_recap': {
        const recap = step.tool === 'weekly_recap';
        const r = ctx.call('aix.journalRun', { spec: recap ? { metric: 'playtime', groupBy: 'day', preset: 'last7' } : { metric: 'playtime', groupBy: (step.args?.groupBy as string) ?? 'game', preset: /this month/.test(q) ? 'thisMonth' : 'all' }, label: q }) as JournalAnswer;
        return { summary: r.result?.description ?? 'Play history', shared: true, card: r.result ? { kind: 'journal', result: r.result } : undefined, say: recap ? `Here’s your week. ${r.answer}` : r.answer };
      }
      case 'game_facts': {
        const g = findGame(q, c.gameId)!;
        return {
          summary: `4 facts about ${g.title}`, shared: true,
          card: { kind: 'sources', title: `Sources for ${g.title}`, items: [{ label: 'Community tags', source: 'Steam community tags' }, { label: 'Steam Deck compatibility', source: 'Valve’s Steam Deck review' }, { label: 'Controller layout', source: 'Steam Input configuration on this PC' }, { label: 'User reviews', source: 'Steam user reviews' }] },
          say: `**Yes, ${g.title} plays well with a controller.** Its community tags include “Full controller support”, Valve rates it **Verified** on Steam Deck, and Steam Input has a gamepad layout for it on this PC. Players’ reviews are Very Positive.\n\nSources: Steam community tags, Valve’s Steam Deck review, Steam Input on this PC, Steam user reviews.`,
        };
      }
      case 'explain_stutter':
        return {
          summary: '4 spikes found', shared: true,
          card: { kind: 'stutter', title: 'Last session with frame data', fpsAvg: 88.4, fps1Low: 41, p99: 38.5, stutters: 14, spikes: [{ at: '0:30', ms: 95 }, { at: '1:00', ms: 92 }, { at: '1:30', ms: 96 }, { at: '6:40', ms: 88 }], signals: ['CPU load was 85% or more during 4 of 4 spikes.', 'The GPU was under 70% busy during those spikes.'] },
          say: 'The stutter came in **four short spikes**, three of them in the first two minutes. During each one the **CPU was nearly maxed out while the GPU sat mostly idle**, so the graphics card was waiting, not struggling.\n\nLikely causes, most likely first:\n- **Shaders compiling** as the level loaded (typical in the first minutes; it usually settles on the next run).\n- **Background work** competing for the CPU: closing heavy apps before playing can help.\n\nVYSTRAL didn’t change anything; these are just things you can try.',
        };
      case 'notifications_digest':
        return { summary: '3 things to look at', shared: true, say: 'Three things could use a look:\n- **Library health**: two games have a missing install folder.\n- **Wishlist**: one game is on sale.\n- **Disk space**: your C: drive is tight for pending updates.' };
      case 'get_storage': {
        const big = visible().filter(installed).sort((a, b) => (b.installations[0]?.sizeBytes ?? 0) - (a.installations[0]?.sizeBytes ?? 0)).slice(0, 5);
        return {
          summary: '2 drives', shared: true,
          card: { kind: 'games', title: 'Largest installed games', items: big.map((g) => ({ id: g.id, title: g.title, sub: `${Math.round((g.installations[0]?.sizeBytes ?? 0) / 1e9)} GB` })) },
          say: `Your biggest installs are ${big.slice(0, 2).map((g) => `**${g.title}**`).join(' and ')}. If you haven’t played one in a while, uninstalling it from its store frees the most space. VYSTRAL won’t uninstall anything for you.`,
        };
      }
      case 'set_favorite': {
        const g = findGame(q, step.args?.gameId as string | undefined)!;
        if (g.favorite) return { summary: 'Already a favorite', shared: false, say: `${g.title} is already one of your favorites.` };
        return {
          summary: `Add ${g.title} to favorites`, shared: false,
          action: { tool: 'set_favorite', title: `Add ${g.title} to favorites`, detail: 'You can change it back at any time.', confirm: 'Add to favorites', args: { gameId: g.id, favorite: true, title: g.title } },
          say: `I’ve set that up: confirm below to add **${g.title}** to your favorites.`,
        };
      }
      case 'create_collection': {
        const games = found.length ? found : search(q);
        if (!games.length) return { summary: 'Nothing to add', shared: false, say: 'There aren’t any games to put in that collection yet.' };
        const name = /short/.test(q) ? 'Short and unfinished' : 'Picked by the Assistant';
        return {
          summary: `Create “${name}”`, shared: false,
          action: { tool: 'create_collection', title: `Create “${name}”`, detail: `A collection with ${games.length} ${games.length === 1 ? 'game' : 'games'}: ${games.slice(0, 4).map((g) => g.title).join(', ')}${games.length > 4 ? ` and ${games.length - 4} more` : ''}.`, confirm: 'Create collection', args: { name, gameIds: games.map((g) => g.id), titles: games.map((g) => g.title) } },
          say: `I’ve prepared a collection for you to confirm.`,
        };
      }
      case 'open_page': {
        const page = String(step.args?.page);
        const label = page[0].toUpperCase() + page.slice(1);
        return { summary: `Open ${label}`, shared: false, action: { tool: 'open_page', title: `Open ${label}`, detail: 'Goes to that page in VYSTRAL.', confirm: 'Open', args: { page } }, say: `Ready when you are: confirm below to open ${label}.` };
      }
      default:
        return { summary: 'Done', shared: false, say: '' };
    }
  }

  async function answer(p: AssistantChatParams) {
    const id = p.requestId;
    const state = running.get(id)!;
    const emit = (e: AssistantEvent) => { if (!state.cancelled) ctx.emit()('assistant.event', e); };
    const e = engine();
    if (!e.ready || e.engine === 'none') return emit({ requestId: id, type: 'error', message: e.reason ?? 'No AI is set up. Choose local AI or a cloud provider in Settings → AI.', setup: true });
    if (e.engine === 'local') return emit({ requestId: id, type: 'error', message: 'Ollama isn’t available in preview mode. Choose a cloud provider (preview stand-in) in Settings → AI.' });
    emit({ requestId: id, type: 'start', engine: e.label, cloud: e.cloud, provider: e.engine });
    await delay(slow ? 1400 : 280);
    if (state.cancelled) return;
    if (fail) return emit({ requestId: id, type: 'error', message: `${e.label.split(' · ')[0]} is having trouble right now. Try again later.` });

    const q = (p.messages[p.messages.length - 1]?.content ?? '').toLowerCase();
    const steps = plan(q, p.context);
    const outcomes: { call: AssistantToolCall; out: Outcome }[] = [];
    const found: Game[] = [];
    for (const step of steps) {
      const info = TOOLS.find((t) => t.name === step.tool)!;
      const call: AssistantToolCall = { id: `toolu_${++seq}`, name: step.tool, label: info.label, kind: info.kind, status: 'running', summary: null };
      if (info.kind === 'read') emit({ requestId: id, type: 'tool', call });
      await delay(slow ? 900 : 240);
      if (state.cancelled) return;
      const out = run(step, q, p.context, found);
      if (out.action) {
        emit({ requestId: id, type: 'tool', call: { ...call, status: 'proposed', summary: out.action.title } });
        emit({ requestId: id, type: 'action', action: { id: `act-${++seq}`, ...out.action } });
      } else {
        emit({ requestId: id, type: 'tool', call: { ...call, status: 'done', summary: out.summary }, card: out.card ?? null });
      }
      outcomes.push({ call, out });
    }

    let shared = outcomes.filter((o) => o.out.shared);
    if (e.cloud && shared.length && s()['assistant.askBeforeSharing'] && !p.shareApproved) {
      const approvalId = `ap-${++seq}`;
      const choice = new Promise<{ allow: boolean; always: boolean }>((resolve) => { state.approve = resolve; state.approvalId = approvalId; });
      emit({
        requestId: id, type: 'approval',
        approval: { id: approvalId, company: COMPANY[e.engine] ?? 'the provider', engine: e.label, items: shared.map((o) => ({ tool: o.call.name, label: o.call.label, summary: o.out.summary, sends: TOOLS.find((t) => t.name === o.call.name)!.sends })) },
      });
      const { allow } = await choice;
      if (state.cancelled) return;
      if (!allow) {
        for (const o of shared) emit({ requestId: id, type: 'tool', call: { ...o.call, status: 'declined', summary: 'Not shared' } });
        shared = [];
        await stream(id, state, 'Okay, I didn’t share anything from your PC. Without those results I can’t answer that one precisely, but you can see what I found in the cards above.');
        return emit({ requestId: id, type: 'done', engine: e.label, cloud: e.cloud, sent: sent(e, []) });
      }
    }
    const text = outcomes.map((o) => o.out.say).filter(Boolean).join('\n\n')
      || 'I’m the VYSTRAL Assistant (preview stand-in). Ask about your library, play history, performance or storage, or what to play tonight.';
    await stream(id, state, text);
    emit({ requestId: id, type: 'done', engine: e.label, cloud: e.cloud, sent: sent(e, shared.map((o) => o.call.label)) });
  }

  const sent = (e: AiCloudStatus['active'], labels: string[]) => e.cloud
    ? `Sent to ${COMPANY[e.engine] ?? 'the provider'} (${e.label}): your messages in this chat, the page you were on${labels.length ? `, and what these look-ups found: ${[...new Set(labels)].join(', ')}.` : '. No app data was looked up.'} (Preview: nothing actually left this PC.)`
    : 'Handled by local AI on this PC. Nothing left your computer.';

  async function stream(id: string, state: { cancelled: boolean }, text: string) {
    const parts = text.match(/\S+\s*/g) ?? [];
    for (let i = 0; i < parts.length; i += 3) {
      if (state.cancelled) return;
      ctx.emit()('assistant.event', { requestId: id, type: 'delta', text: parts.slice(i, i + 3).join('') } satisfies AssistantEvent);
      await delay(slow ? 120 : 24);
    }
  }

  return {
    'assistant.status': () => status(),
    'assistant.chat': (p: AssistantChatParams) => {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(p?.requestId))) throw new BridgeError('invalid', 'Invalid request id.');
      if (!Array.isArray(p.messages) || !p.messages.length || p.messages.length > 60) throw new BridgeError('invalid', 'Invalid conversation.');
      if (p.messages[p.messages.length - 1].role !== 'user') throw new BridgeError('invalid', 'Ask something first.');
      for (const [k, r] of running) { r.cancelled = true; r.approve?.({ allow: false, always: false }); running.delete(k); }
      running.set(p.requestId, { cancelled: false });
      void answer(p).finally(() => running.delete(p.requestId));
      return true;
    },
    'assistant.cancel': (p: { requestId: string }) => {
      const r = running.get(p.requestId);
      if (!r) return false;
      r.approve?.({ allow: false, always: false });
      ctx.emit()('assistant.event', { requestId: p.requestId, type: 'done', engine: engine().label, cloud: engine().cloud, stopped: true, sent: null } satisfies AssistantEvent);
      r.cancelled = true;
      return true;
    },
    'assistant.approve': (p: { requestId: string; approvalId: string; allow: boolean; always?: boolean }) => {
      const r = running.get(p.requestId);
      if (!r || r.approvalId !== p.approvalId || !r.approve) return false;
      r.approve({ allow: p.allow, always: !!p.always });
      r.approve = undefined;
      return true;
    },
    'assistant.conversations': (): AssistantConversationInfo[] => !s()['assistant.keepHistory'] ? [] : [...conversations.values()]
      .map((c) => ({ id: String(c.id), title: String(c.title ?? ''), updatedAt: String(c.updatedAt), messages: (c.messages as unknown[]).length }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    'assistant.conversation.get': (p: { id: string }) => {
      const c = conversations.get(p.id);
      if (!c) throw new BridgeError('notFound', 'That conversation is no longer saved.');
      return structuredClone(c);
    },
    'assistant.conversation.save': (p: { id: string; conversation: Record<string, unknown> }) => {
      if (!s()['assistant.keepHistory']) return false;
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(p.id) || !Array.isArray(p.conversation?.messages)) throw new BridgeError('invalid', 'Invalid conversation.');
      conversations.set(p.id, { ...structuredClone(p.conversation), id: p.id, updatedAt: new Date().toISOString() });
      return true;
    },
    'assistant.conversation.delete': (p: { id: string }) => { conversations.delete(p.id); return true; },
    'assistant.conversation.clear': () => { conversations.clear(); return true; },
  };
}
