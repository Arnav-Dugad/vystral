// Track C4: open the Library filtered by community tags (a tag chip on a game page). One pending request; the
// Library takes it when it mounts.

let pending: number[] | null = null;

export function requestLibraryTags(ids: number[]): void {
  pending = ids.filter((id) => Number.isInteger(id) && id > 0).slice(0, 8);
}

export function takeLibraryTags(): number[] {
  const ids = pending ?? [];
  pending = null;
  return ids;
}
