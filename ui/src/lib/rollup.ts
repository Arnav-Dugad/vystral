/**
 * Track Y: number roll-ups. A formatted number ("12h 30m", "1,284") counts up digit by digit like an
 * odometer the first time it comes into view, once per app session per element. Pure planning lives
 * here (unit-tested); the component is `components/ui/RollUp.tsx`.
 *
 * Every digit is a vertical strip of 0–9 that rolls from 0 to its value. Less significant digits roll
 * through extra full turns, so the number reads as counting up rather than sliding into place; each
 * digit lands a little after the one to its left, ending on the units. Non-digits (letters, spaces,
 * separators) never move, so the text's shape is fixed from the first frame.
 */

export type RollToken =
  | { kind: 'text'; text: string }
  | { kind: 'digit'; digit: number; /** extra full turns before landing */ turns: number; /** 0…9 strip index to land on */ target: number; delayMs: number; durationMs: number };

export const ROLL_BASE_MS = 720;
export const ROLL_STAGGER_MS = 55;
/** Above this many digits the roll would feel busy; the number simply fades in instead. */
export const ROLL_MAX_DIGITS = 9;

/** Splits text into static runs and digits, and plans each digit's roll. */
export function planRoll(text: string): RollToken[] {
  const tokens: RollToken[] = [];
  const digits = [...text].filter((c) => c >= '0' && c <= '9').length;
  let seen = 0;
  let run = '';
  for (const ch of text) {
    if (ch >= '0' && ch <= '9') {
      if (run) tokens.push({ kind: 'text', text: run });
      run = '';
      const fromRight = digits - 1 - seen;
      const turns = fromRight === 0 ? 2 : fromRight === 1 ? 1 : 0;
      const digit = ch.charCodeAt(0) - 48;
      tokens.push({
        kind: 'digit',
        digit,
        turns,
        target: turns * 10 + digit,
        delayMs: seen * ROLL_STAGGER_MS,
        durationMs: ROLL_BASE_MS + turns * 160,
      });
      seen++;
    } else run += ch;
  }
  if (run) tokens.push({ kind: 'text', text: run });
  return tokens;
}

/** When the last digit lands (ms), for tests and for removing will-change afterwards. */
export function rollDuration(tokens: readonly RollToken[]): number {
  let end = 0;
  for (const t of tokens) if (t.kind === 'digit') end = Math.max(end, t.delayMs + t.durationMs);
  return end;
}

export function digitCount(text: string): number {
  let n = 0;
  for (const c of text) if (c >= '0' && c <= '9') n++;
  return n;
}

/* ------------------------------------------------------------------ once per session */

const rolled = new Set<string>();

/**
 * Whether an element should roll: never under reduced motion, never twice for the same id in one app
 * session, and never for text without digits or with too many of them.
 */
export function shouldRoll(id: string, text: string, reduced: boolean): boolean {
  if (reduced) return false;
  if (rolled.has(id)) return false;
  const n = digitCount(text);
  return n > 0 && n <= ROLL_MAX_DIGITS;
}

export function markRolled(id: string): void {
  if (rolled.size > 2000) rolled.clear(); // bounded; a very long session simply rolls again
  rolled.add(id);
}

export function hasRolled(id: string): boolean {
  return rolled.has(id);
}

/** Test helper. */
export function resetRolled(): void {
  rolled.clear();
}
