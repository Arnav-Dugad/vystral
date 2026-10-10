// Track C5: optional cloud AI providers and AI-assisted features (mirror of src/Vystral.Windows/Ai/* and AppBackend.AiFeatures.cs).

export type CloudAiProviderId = 'anthropic' | 'openai' | 'gemini' | 'compatible';
export type AiProviderChoice = 'local' | CloudAiProviderId;
export type AiFeatureId = 'assistant' | 'journal' | 'patchNotes' | 'tonight' | 'smartCollections' | 'duplicates' | 'recapCaptions';

export interface AiEngine {
  /** Who would answer right now. */
  engine: AiProviderChoice | 'none';
  label: string;
  cloud: boolean;
  ready: boolean;
  /** Why it isn't the chosen provider, or isn't ready (plain language). */
  reason: string | null;
}

export interface CloudAiTest {
  outcome: 'ok' | 'invalidKey' | 'notConfigured' | 'rateLimited' | 'unavailable' | 'malformed' | 'offline' | 'disabled';
  message: string;
  at: string;
}

export interface CloudAiProviderStatus {
  id: CloudAiProviderId;
  name: string;
  company: string;
  configured: boolean;
  /** Only the last four characters ever reach the page: "…1234". */
  keyMasked: string | null;
  optedIn: boolean;
  model: string;
  modelLabel: string;
  models: string[];
  modelsListed: boolean;
  /** The OpenAI-compatible endpoint's address (null for the others). */
  baseUrl: string | null;
  lastTest: CloudAiTest | null;
  pausedUntil: string | null;
  host: string;
}

export interface AiFeature {
  id: AiFeatureId;
  label: string;
  enabled: boolean;
  /** Exactly what this feature sends to a cloud provider. */
  sends: string;
  withoutAi: string;
}

/** call('aiCloud.status'). */
export interface AiCloudStatus {
  provider: AiProviderChoice;
  providers: CloudAiProviderStatus[];
  localOnly: boolean;
  localEnabled: boolean;
  active: AiEngine;
  features: AiFeature[];
}

export interface CloudAiAction {
  result: CloudAiTest;
  provider: CloudAiProviderStatus;
}

// ---------- Ask the Journal ----------

export type JournalMetric = 'playtime' | 'sessions' | 'days' | 'average' | 'longest';
export type JournalGroup = 'game' | 'genre' | 'platform' | 'month' | 'weekday' | 'hour' | 'day' | 'none';

/** What the page sends for a ready-made question (validated natively; never sent to any AI). */
export interface JournalSpecInput {
  metric?: JournalMetric;
  groupBy?: JournalGroup;
  preset?: 'last7' | 'last30' | 'thisMonth' | 'lastMonth' | 'thisYear' | 'lastYear' | 'all';
  from?: string;
  to?: string;
  sort?: 'asc' | 'desc';
  limit?: number;
}

export interface JournalSpec {
  metric: JournalMetric;
  groupBy: JournalGroup;
  from: string | null;
  to: string | null;
  gameIds: string[];
  genres: string[];
  platforms: string[];
  sort: 'asc' | 'desc';
  limit: number;
}

export interface JournalRow {
  key: string;
  label: string;
  value: number;
  gameId: string | null;
}

export interface JournalResult {
  spec: JournalSpec;
  rows: JournalRow[];
  unit: 'seconds' | 'count' | 'days';
  chart: 'bar' | 'column';
  total: number;
  sessions: number;
  games: number;
  rangeLabel: string;
  /** The query in words, e.g. "Playtime by game · August 2026 · top 10". */
  description: string;
  notes: string[];
  unmatched: string[];
}

/** call('aix.journalAsk', { question }) and call('aix.journalRun', { spec, label }). */
export interface JournalAnswer {
  question: string;
  result: JournalResult | null;
  answer: string;
  plannedBy: string | null;
  phrasedBy: string | null;
  note: string | null;
  /** No AI is set up (or the feature is off): offer ready-made questions. */
  needsAi: boolean;
  unsupported: string | null;
  engine: AiEngine;
  /** What was sent and to whom (null: nothing left this PC). */
  sent: string | null;
}

// ---------- Patch note summaries ----------

/** call('aix.patchSummary', { gameId, gid, refresh? }). */
export interface PatchSummary {
  bullets: string[];
  /** False: VYSTRAL's own "key lines" (no AI involved). */
  ai: boolean;
  aiLabel: string | null;
  cached: boolean;
  note: string | null;
  trimmed: boolean;
  engine: AiEngine;
  sent: string | null;
}

// ---------- What should I play tonight? ----------

export type TonightMood = 'any' | 'chill' | 'intense' | 'story' | 'brainy' | 'social';

export interface TonightPick {
  kind: 'library' | 'subscription';
  gameId: string | null;
  productId: string | null;
  title: string;
  reason: string;
  /** VYSTRAL's own reasons (deterministic facts). */
  facts: string[];
  installed: boolean;
  plan: string | null;
}

/** call('aix.tonight', { mood, minutes, note?, includeSubs? }). */
export interface TonightAnswer {
  intro: string;
  picks: TonightPick[];
  considered: number;
  engine: AiEngine;
  aiLabel: string | null;
  note: string | null;
  sent: string | null;
}

// ---------- Smart collections ----------

/** A smart collection's rule (stored in the collection's `rule`), see lib/smartFilter.ts. */
export interface SmartFilter {
  v: 1;
  genresAny?: string[];
  genresNone?: string[];
  statusAny?: ('backlog' | 'playing' | 'beaten' | 'completed' | 'abandoned' | 'none')[];
  statusNone?: ('backlog' | 'playing' | 'beaten' | 'completed' | 'abandoned' | 'none')[];
  platforms?: string[];
  installed?: boolean;
  favorite?: boolean;
  neverPlayed?: boolean;
  inSubscription?: boolean;
  ttbMaxHours?: number;
  ttbMinHours?: number;
  playedMaxHours?: number;
  playedMinHours?: number;
  notPlayedDays?: number;
  playedWithinDays?: number;
  sizeMaxGb?: number;
  sizeMinGb?: number;
  releasedFrom?: number;
  releasedTo?: number;
  titleIncludes?: string;
}

/** call('aix.smartFilter', { sentence }). */
export interface SmartFilterAnswer {
  sentence: string;
  name: string | null;
  filter: SmartFilter | null;
  dropped: string[];
  needsAi: boolean;
  aiLabel: string | null;
  note: string | null;
  engine: AiEngine;
  sent: string | null;
}

// ---------- Duplicates ----------

export interface DuplicateFact {
  kind: 'steamAppId' | 'title' | 'edition' | 'year' | 'developer' | 'store' | string;
  text: string;
  supports: boolean;
}

/** call('aix.explainDuplicate', { gameIdA, gameIdB }). */
export interface DuplicateExplanation {
  facts: DuplicateFact[];
  sentence: string | null;
  aiLabel: string | null;
  note: string | null;
  engine: AiEngine;
  sent: string | null;
}

// ---------- Recap captions ----------

/** call('aix.recapCaption', { sessionId, refresh?, ask? }). */
export interface RecapCaption {
  caption: string | null;
  aiLabel: string | null;
  cached: boolean;
  note: string | null;
  engine: AiEngine;
  sent: string | null;
}
