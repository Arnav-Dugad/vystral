import { call, errorMessage } from '../bridge/bridge';
import type { Game } from '../bridge/types';
import { useStore } from './store';

/** User-facing game mutations: optimistic, reversible where practical, with clear feedback. */

const store = () => useStore.getState();

async function mutate(gameId: string, patch: Partial<Game>, method: string, params: object, failTitle: string) {
  const before = store().gamesById.get(gameId);
  store().patchGame(gameId, patch);
  try {
    await call(method, params);
    return true;
  } catch (err) {
    if (before) store().patchGame(gameId, before);
    store().toast({ tone: 'danger', title: failTitle, body: errorMessage(err) });
    return false;
  }
}

export function toggleFavorite(game: Game) {
  return mutate(game.id, { favorite: !game.favorite }, 'game.setFavorite', { gameId: game.id, value: !game.favorite }, 'Couldn’t update favorites');
}

export async function setHidden(game: Game, hidden: boolean) {
  const ok = await mutate(game.id, { hidden }, 'game.setHidden', { gameId: game.id, value: hidden }, 'Couldn’t update the game');
  if (ok && hidden)
    store().toast({
      tone: 'info',
      title: `${game.title} is hidden`,
      body: 'Find it again with the “Hidden” filter in the library.',
      action: { label: 'Undo', run: () => void setHidden(game, false) },
    });
}

export function setRating(game: Game, rating: number | null) {
  return mutate(game.id, { userRating: rating }, 'game.setRating', { gameId: game.id, rating }, 'Couldn’t save the rating');
}

export function setNotes(game: Game, notes: string) {
  return mutate(game.id, { notes }, 'game.setNotes', { gameId: game.id, notes }, 'Couldn’t save your notes');
}

export function setPreferred(game: Game, installationId: string | null) {
  return mutate(game.id, { preferredInstallationId: installationId }, 'game.setPreferred', { gameId: game.id, installationId }, 'Couldn’t change the preferred version');
}

export async function setCollection(game: Game, collectionId: string, member: boolean) {
  const collections = member ? [...new Set([...game.collections, collectionId])] : game.collections.filter((c) => c !== collectionId);
  const ok = await mutate(game.id, { collections }, 'collections.setMembership', { collectionId, gameId: game.id, member }, 'Couldn’t update the collection');
  if (ok) void store().refreshLibrary();
}

export async function createCollection(name: string, gameId?: string) {
  try {
    const id = await call<string>('collections.create', { name, icon: null, rule: null });
    if (gameId) await call('collections.setMembership', { collectionId: id, gameId, member: true });
    await store().refreshLibrary();
    store().toast({ tone: 'success', title: `Collection “${name}” created` });
    return id;
  } catch (err) {
    store().toast({ tone: 'danger', title: 'Couldn’t create the collection', body: errorMessage(err) });
    return null;
  }
}

export async function openFolder(game: Game) {
  try {
    await call('game.openFolder', { gameId: game.id });
  } catch (err) {
    store().toast({ tone: 'warning', title: 'Folder not available', body: errorMessage(err) });
  }
}

export async function addManualGame() {
  try {
    const id = await call<string | null>('game.addManual', { title: null }, 300_000);
    if (id) {
      await store().refreshLibrary();
      store().toast({ tone: 'success', title: 'Added to your library' });
      store().navigate({ name: 'game', id });
    }
  } catch (err) {
    store().toast({ tone: 'danger', title: 'Couldn’t add the program', body: errorMessage(err) });
  }
}

export async function removeManualGame(game: Game) {
  try {
    await call('game.removeManual', { gameId: game.id });
    await store().refreshLibrary();
    store().navigate({ name: 'library' }, { replace: true });
    store().toast({ tone: 'info', title: `${game.title} was removed from VYSTRAL`, body: 'Its files on disk were not touched.' });
  } catch (err) {
    store().toast({ tone: 'danger', title: 'Couldn’t remove it', body: errorMessage(err) });
  }
}
