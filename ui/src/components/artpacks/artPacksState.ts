/**
 * Track N: shared art-pack state. The job runs natively; every view that shows it (the dialog, the
 * Settings group) reads this one store, kept fresh by `artPacks.progress`. When a run ends, a toast says
 * how it went and offers to undo it — wherever the user is.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { call, errorMessage, on } from '../../bridge/bridge';
import type { ArtPackJob, ArtPackRestore, ArtPacksStatus } from '../../bridge/types';
import { jobSummary } from '../../lib/artPacks';
import { useStore } from '../../state/store';

let status: ArtPacksStatus | null = null;
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());

export async function refreshArtPacks(): Promise<ArtPacksStatus | null> {
  try {
    status = await call<ArtPacksStatus>('artPacks.status');
    notify();
  } catch {
    /* keep what we had */
  }
  return status;
}

export function setArtPackJob(job: ArtPackJob | null) {
  if (!status) return;
  status = { ...status, job };
  notify();
}

const FINISHED = new Set(['done', 'cancelled', 'failed']);
let lastState: string | null = null;

on('artPacks.progress', (job) => {
  const was = status?.job?.id === job.id ? status.job.state : lastState;
  lastState = job.state;
  if (status) {
    status = { ...status, job };
    notify();
  }
  if (FINISHED.has(job.state) && was !== null && !FINISHED.has(was)) {
    void refreshArtPacks(); // the run list (and what can be restored) changed
    void useStore.getState().refreshLibrary();
    const toast = useStore.getState().toast;
    if (job.state === 'failed') {
      toast({ tone: 'danger', title: `The ${job.presetLabel} art pack stopped`, body: job.reason ?? undefined });
    } else if (job.applied > 0) {
      toast({
        tone: 'success',
        title: job.state === 'done' ? `${job.presetLabel} art applied` : `${job.presetLabel} art pack cancelled`,
        body: jobSummary(job),
        action: { label: 'Restore previous art', run: () => void restoreArtPack(job.id) },
      });
    } else {
      toast({ tone: 'info', title: job.state === 'done' ? 'Nothing changed' : 'Art pack cancelled', body: jobSummary(job) });
    }
  }
});

/** Puts back everything one art pack replaced. */
export async function restoreArtPack(id: string): Promise<ArtPackRestore | null> {
  const { toast, refreshLibrary } = useStore.getState();
  try {
    const r = await call<ArtPackRestore>('artPacks.restore', { id }, 120_000);
    await Promise.all([refreshLibrary(), refreshArtPacks()]);
    toast({
      tone: 'success',
      title: r.restored ? 'Previous art restored' : 'Nothing to restore',
      body: r.skipped ? `${r.skipped.toLocaleString()} ${r.skipped === 1 ? 'slot was' : 'slots were'} changed since, so ${r.skipped === 1 ? 'it was' : 'they were'} left as ${r.skipped === 1 ? 'it is' : 'they are'}.` : undefined,
    });
    return r;
  } catch (err) {
    toast({ tone: 'danger', title: 'Couldn’t restore the previous art', body: errorMessage(err) });
    return null;
  }
}

/** The art-pack status (fetched when first used, then kept fresh by progress events). */
export function useArtPacks(refreshOnMount = true): ArtPacksStatus | null {
  useEffect(() => {
    if (refreshOnMount) void refreshArtPacks();
  }, [refreshOnMount]);
  return useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => status,
  );
}
