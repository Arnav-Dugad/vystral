import { call, errorMessage } from '../bridge/bridge';
import type { Game, GameStatus, StatusResult } from '../bridge/types';
import { STATUS_META } from '../lib/status';
import { useStore } from './store';

let lastToast: number | null = null;

/**
 * Sets a game's play status optimistically, with an Undo toast. Only one status toast is shown
 * at a time, so clicking through several statuses doesn't stack notifications.
 */
export async function setGameStatus(game: Game, status: GameStatus | null, opts: { undoable?: boolean } = {}): Promise<boolean> {
  const store = useStore.getState();
  const before = { status: game.status ?? null, statusChangedAt: game.statusChangedAt ?? null };
  if (before.status === status) return true;
  store.patchGame(game.id, { status, statusChangedAt: status ? new Date().toISOString() : null });
  try {
    const res = await call<StatusResult>('game.setStatus', { gameId: game.id, status });
    useStore.getState().patchGame(game.id, { status: res.status, statusChangedAt: res.statusChangedAt });
  } catch (err) {
    useStore.getState().patchGame(game.id, before);
    useStore.getState().toast({ tone: 'danger', title: 'Status not saved', body: errorMessage(err) });
    return false;
  }
  if (opts.undoable !== false) {
    const s = useStore.getState();
    if (lastToast !== null) s.dismissToast(lastToast);
    lastToast = s.toast({
      tone: 'success',
      title: status ? `${game.title}: ${STATUS_META[status].label}` : `${game.title}: status cleared`,
      body: before.status ? `Was ${STATUS_META[before.status].label}.` : undefined,
      action: {
        label: 'Undo',
        run: () => {
          const current = useStore.getState().gamesById.get(game.id);
          if (current) void setGameStatus(current, before.status, { undoable: false });
        },
      },
    });
  }
  return true;
}
