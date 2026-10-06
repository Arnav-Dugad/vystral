// Track Q: open a game page on a particular tab ("See versions" from the health check, "Controls" from elsewhere).
// One pending request; the game page takes it when it mounts for that game.

let pending: { id: string; tab: string } | null = null;

export function requestGameTab(id: string, tab: string): void {
  pending = { id, tab };
}

export function takeGameTab(id: string): string | null {
  if (pending?.id !== id) return null;
  const { tab } = pending;
  pending = null;
  return tab;
}
