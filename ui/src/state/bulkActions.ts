/**
 * Track D1: Library bulk actions. Optimistic (every selected game changes at once on screen), applied by the backend
 * in one transaction, and undoable from a single toast: Undo restores exactly what the database held before
 * (statuses with their dates, flags, collection membership, played marks) in one transaction too.
 */
import { BridgeError, call, errorMessage } from '../bridge/bridge';
import type { BulkEditResult, BulkUndoResult, Game } from '../bridge/types';
import { MAX_BULK_GAMES } from '../bridge/types.trackD1';
import { bulkBody, bulkParams, bulkTitle, nothingToChange, planBulk, type BulkAction } from '../lib/bulk';
import { MAX_STORE_PAGES, storeInstallation } from '../lib/selection';
import { plural } from '../lib/format';
import { useStore } from './store';

let lastToast: number | null = null;

/** Applies many patches with one store update (patching one game at a time re-indexes the library each time). */
function patchMany(patches: ReadonlyMap<string, Partial<Game>>) {
  if (patches.size === 0) return;
  const s = useStore.getState();
  if (!s.libraryLoaded) {
    for (const [id, p] of patches) s.patchGame(id, p);
    return;
  }
  const games = s.library.games.map((g) => (patches.has(g.id) ? { ...g, ...patches.get(g.id) } : g));
  const library = { ...s.library, games };
  useStore.setState({ library, gamesById: new Map(games.map((g) => [g.id, g])) });
}

/**
 * Runs one bulk action on the given games. Resolves to true when it was saved (or there was nothing to change).
 * Games the action leaves as they are aren't sent back as changed, and the toast says so.
 */
export async function runBulk(ids: readonly string[], action: BulkAction, opts: { collectionName?: string } = {}): Promise<boolean> {
  const s = useStore.getState();
  if (ids.length === 0) return true;
  if (ids.length > MAX_BULK_GAMES) {
    s.toast({ tone: 'warning', title: `That’s more than ${MAX_BULK_GAMES.toLocaleString()} games`, body: 'Narrow the filter and try again in smaller groups.' });
    return false;
  }
  const games = ids.map((id) => s.gamesById.get(id)).filter((g): g is Game => !!g);
  const plan = planBulk(games, action, new Date().toISOString());
  if (plan.patches.size === 0) {
    s.toast({ tone: 'info', title: 'Nothing to change', body: nothingToChange(action) });
    return true;
  }
  patchMany(plan.patches);
  let res: BulkEditResult;
  try {
    res = await call<BulkEditResult>('library.bulkEdit', bulkParams([...plan.patches.keys()], action), 30_000);
  } catch (err) {
    patchMany(plan.before);
    useStore.getState().toast({ tone: 'danger', title: 'Nothing was changed', body: errorMessage(err) });
    return false;
  }
  const st = useStore.getState();
  if (lastToast !== null) st.dismissToast(lastToast);
  const changed = Math.max(res.changed, 0);
  lastToast = st.toast({
    tone: 'success',
    title: bulkTitle(action, changed || plan.patches.size, opts.collectionName),
    body: bulkBody(action, changed || plan.patches.size, ids.length),
    action: res.token ? { label: 'Undo', run: () => void undoBulk(res.token!, plan.before) } : undefined,
  });
  return true;
}

/** Undo for a bulk change: the backend restores every game in one transaction; the page follows. */
export async function undoBulk(token: string, before: ReadonlyMap<string, Partial<Game>>): Promise<boolean> {
  try {
    const res = await call<BulkUndoResult>('library.bulkUndo', { token }, 30_000);
    patchMany(before);
    if (lastToast !== null) useStore.getState().dismissToast(lastToast);
    lastToast = null;
    useStore.getState().toast({ tone: 'info', title: res.restored === 1 ? 'Undone: one game is back as it was' : `Undone: ${plural(res.restored, 'game')} are back as they were` });
    void useStore.getState().refreshLibrary();
    return true;
  } catch (err) {
    const expired = err instanceof BridgeError && err.code === 'expired';
    useStore.getState().toast({ tone: expired ? 'warning' : 'danger', title: expired ? 'Too late to undo' : 'Couldn’t undo', body: errorMessage(err) });
    return false;
  }
}

/** Opens the store page of each selected game (one per game, at most {@link MAX_STORE_PAGES}). */
export async function openInStores(ids: readonly string[]): Promise<void> {
  const s = useStore.getState();
  const targets = ids.map((id) => s.gamesById.get(id)).filter((g): g is Game => !!g)
    .map((g) => ({ g, inst: storeInstallation(g) })).filter((x) => x.inst);
  if (targets.length === 0) {
    s.toast({ tone: 'info', title: 'No store pages to open', body: 'These are games you added yourself.' });
    return;
  }
  if (targets.length > MAX_STORE_PAGES) {
    s.toast({ tone: 'info', title: `Select ${MAX_STORE_PAGES} or fewer`, body: 'Opening one store page per game for more than that would bury your desktop in windows.' });
    return;
  }
  const failed: string[] = [];
  for (const { g, inst } of targets) {
    try {
      await call('game.openInStore', { installationId: inst });
    } catch {
      failed.push(g.title);
    }
  }
  if (failed.length) s.toast({ tone: 'warning', title: failed.length === targets.length ? 'Couldn’t open the store pages' : `Couldn’t open ${plural(failed.length, 'store page')}`, body: `${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}: that store doesn’t open game pages directly.` });
}
