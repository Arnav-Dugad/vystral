/**
 * Track C6: a subtle toast when a session that just ended beat a personal record. Only real improvements count
 * (see recordsBrokenBy): strictly better than every other finished session, above a small floor, and never the
 * first record ever set. Each session is checked once.
 */
import { call, on } from '../bridge/bridge';
import type { Session } from '../bridge/types';
import { recordsBrokenBy, type BrokenRecord } from '../views/journal/records';
import { recordText } from '../views/journal/recordText';
import { useStore } from './store';

const checked = new Set<string>();
let started = false;

function listWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** The toast's words for what a session beat. Exported for tests. */
export function recordToast(broken: BrokenRecord[], gameTitle: string | null): { title: string; body: string } {
  const first = broken[0];
  const copy = recordText(first.id, first.after);
  if (broken.length === 1) {
    const was = recordText(first.id, first.before).value;
    return {
      title: `New personal record: ${copy.name}`,
      body: `${capitalise(copy.brag)}${gameTitle ? ` in ${gameTitle}` : ''}. Your best was ${was}.`,
    };
  }
  const names = broken.map((b) => recordText(b.id, b.after).name);
  return {
    title: `${broken.length} new personal records`,
    body: `${listWords(names)}${gameTitle ? `, all in ${gameTitle}` : ''}. ${capitalise(copy.brag)} leads the way.`,
  };
}

const capitalise = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

async function check(sessionId: string, gameId: string) {
  if (checked.has(sessionId)) return;
  checked.add(sessionId);
  let list: Session[];
  try {
    list = await call<Session[]>('sessions.list', { gameId: null, limit: 10000 });
  } catch {
    return; // no toast is better than a wrong one
  }
  if (!Array.isArray(list)) return;
  const broken = recordsBrokenBy(list, sessionId);
  if (!broken.length) return;
  const s = useStore.getState();
  const game = s.gamesById.get(gameId);
  const { title, body } = recordToast(broken, game?.title ?? null);
  s.toast({
    tone: 'success',
    title,
    body,
    action: { label: 'See your records', run: () => useStore.getState().navigate({ name: 'journal', tab: 'records' }) },
  });
}

/** Starts listening for finished sessions (once). */
export function startRecordWatch() {
  if (started) return;
  started = true;
  on('launch.state', (l) => {
    if (l.phase === 'ended' && l.sessionId && l.sessionId !== 'preview') void check(l.sessionId, l.gameId);
  });
}
