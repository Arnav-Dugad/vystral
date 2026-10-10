// Track D3: the one Assistant (mirror of src/Vystral.Windows/Ai/Assistant/* and AppBackend.Assistant.cs).
import type { AiEngine, JournalResult } from './types.ai';

export interface AssistantToolInfo {
  name: string;
  label: string;
  kind: 'read' | 'action';
  /** What this look-up's result contains (shown before anything goes to a cloud AI). */
  sends: string;
}

/** call('assistant.status'). */
export interface AssistantStatus {
  engine: AiEngine;
  enabled: boolean;
  launcher: boolean;
  askBeforeSharing: boolean;
  keepHistory: boolean;
  localOnly: boolean;
  tools: AssistantToolInfo[];
}

export type AssistantPage =
  | 'home' | 'library' | 'game' | 'journal' | 'performance' | 'moments' | 'constellation' | 'assistant' | 'storage' | 'health' | 'discover'
  | 'discoverGame' | 'wishlist' | 'settings';

/** call('assistant.chat', …): starts an answer; everything else arrives as `assistant.event`. */
export interface AssistantChatParams {
  requestId: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  context: { page: AssistantPage; gameId?: string | null; sessionId?: string | null };
  shareApproved?: boolean;
}

export type AssistantToolStatus = 'running' | 'done' | 'error' | 'declined' | 'proposed';

export interface AssistantToolCall {
  id: string;
  name: string;
  label: string;
  kind: 'read' | 'action';
  status: AssistantToolStatus;
  summary: string | null;
}

export interface AssistantGameItem {
  id: string;
  title: string;
  sub: string | null;
}

export type AssistantCard =
  | { kind: 'games'; title: string; items: AssistantGameItem[] }
  | { kind: 'journal'; result: JournalResult }
  | { kind: 'picks'; title: string; items: { gameId: string | null; productId: string | null; title: string; facts: string[]; installed: boolean; plan: string | null }[] }
  | { kind: 'sources'; title: string; items: { label: string; source: string }[] }
  | {
      kind: 'stutter';
      title?: string;
      sessionId?: string;
      fpsAvg: number | null;
      fps1Low: number | null;
      p99: number | null;
      stutters: number | null;
      spikes: { at: string; ms: number }[];
      signals: string[];
    };

export type AssistantActionTool =
  | 'open_page' | 'open_game' | 'create_collection' | 'create_smart_collection' | 'set_status' | 'set_favorite' | 'start_discover_search' | 'watch_game';

/** A change the assistant prepared. Nothing happens until the user confirms it. */
export interface AssistantProposal {
  id: string;
  tool: AssistantActionTool;
  title: string;
  detail: string;
  confirm: string;
  args: Record<string, unknown>;
}

export interface AssistantApproval {
  id: string;
  company: string;
  engine: string;
  items: { tool: string; label: string; summary: string; sends: string }[];
}

export type AssistantEvent =
  | { requestId: string; type: 'start'; engine: string; cloud: boolean; provider: string; note?: string | null }
  | { requestId: string; type: 'delta'; text: string }
  | { requestId: string; type: 'tool'; call: AssistantToolCall; card?: AssistantCard | null }
  | { requestId: string; type: 'approval'; approval: AssistantApproval }
  | { requestId: string; type: 'action'; action: AssistantProposal }
  | { requestId: string; type: 'notice'; message: string }
  | { requestId: string; type: 'done'; engine: string; cloud: boolean; note?: string | null; sent?: string | null; stopped?: boolean }
  | { requestId: string; type: 'error'; message: string; setup?: boolean };

/** call('assistant.conversations'). */
export interface AssistantConversationInfo {
  id: string;
  title: string;
  updatedAt: string;
  messages: number;
}
