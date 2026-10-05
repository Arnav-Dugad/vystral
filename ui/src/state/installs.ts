import { create } from 'zustand';
import { call, on } from '../bridge/bridge';
import type { InstallProgress } from '../bridge/types';
import { useStore } from './store';

/**
 * Live install/update/uninstall progress reported by the native InstallWatcher (Steam manifests).
 * Separate from the main store so frequent progress events only re-render the few components
 * that show progress. Finished entries linger briefly so rings can complete their animation.
 */
interface InstallsState {
  byGame: Record<string, InstallProgress>;
  set(p: InstallProgress): void;
  remove(gameId: string): void;
}

export const useInstalls = create<InstallsState>((set, get) => ({
  byGame: {},
  set(p) {
    set({ byGame: { ...get().byGame, [p.gameId]: p } });
  },
  remove(gameId) {
    const { [gameId]: _gone, ...rest } = get().byGame;
    void _gone;
    set({ byGame: rest });
  },
}));

const LINGER_MS = 4000;
let started = false;
const lingerTimers = new Map<string, number>();

function handle(p: InstallProgress) {
  const store = useInstalls.getState();
  const before = store.byGame[p.gameId];
  window.clearTimeout(lingerTimers.get(p.gameId));
  store.set(p);
  if (!p.watching) {
    lingerTimers.set(p.gameId, window.setTimeout(() => {
      if (useInstalls.getState().byGame[p.gameId] === p) useInstalls.getState().remove(p.gameId);
    }, LINGER_MS));
  }
  // Only announce transitions we watched happen (not stale replays).
  if (before?.phase === p.phase) return;
  const app = useStore.getState();
  const game = app.gamesById.get(p.gameId);
  const title = game?.title ?? 'Your game';
  if (p.kind === 'install' && p.phase === 'installed') {
    app.toast({
      tone: 'success',
      title: `${title} is ready to play`,
      body: 'Steam finished installing it.',
      action: { label: 'Play', run: () => void useStore.getState().launchGame(p.gameId) },
    });
  } else if (p.kind === 'install' && p.phase === 'removed') {
    app.toast({ tone: 'info', title: `${title} isn’t being installed`, body: 'The install was cancelled or removed in Steam.' });
  } else if (p.kind === 'uninstall' && p.phase === 'removed') {
    app.toast({ tone: 'info', title: `Steam uninstalled ${title}`, body: 'It stays in your library as not installed.' });
  } else if (!p.watching && p.kind === 'install' && p.phase !== 'installed') {
    app.toast({ tone: 'info', title: `Stopped watching ${title}`, body: 'Nothing changed in Steam for 10 minutes. Steam keeps going on its own; check Steam’s Downloads page.' });
  }
}

/** Subscribes once to install events and hydrates what's already in progress. */
export function ensureInstallsStarted() {
  if (started || typeof window === 'undefined') return;
  started = true;
  on('install.progress', handle);
  call<InstallProgress[]>('steam.installs')
    .then((list) => {
      const store = useInstalls.getState();
      for (const p of list ?? []) if (!store.byGame[p.gameId]) store.set(p);
    })
    .catch(() => {
      // Older backends without the method: nothing in progress to show.
    });
}

/** Progress for one game (install, update or uninstall), or undefined. */
export function useInstallFor(gameId: string): InstallProgress | undefined {
  ensureInstallsStarted();
  return useInstalls((s) => s.byGame[gameId]);
}
