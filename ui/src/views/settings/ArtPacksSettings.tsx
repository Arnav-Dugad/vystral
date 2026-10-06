import { useState } from 'react';
import { RotateCcw, Wand2 } from 'lucide-react';
import { call } from '../../bridge/bridge';
import type { ArtPackJob } from '../../bridge/types';
import { formatRelative } from '../../lib/format';
import { isActive, jobFraction, jobStatusLine, KIND_LABEL, scopeLabel } from '../../lib/artPacks';
import { useStore } from '../../state/store';
import { Badge, Button, ProgressBar } from '../../components/ui/primitives';
import { ArtPacksDialog } from '../../components/artpacks/ArtPacksDialog';
import { restoreArtPack, setArtPackJob, useArtPacks } from '../../components/artpacks/artPacksState';
import '../../components/artpacks/art-packs.css';

/** Settings › Library & stores: Art packs (Track N) — open the dialog, follow a running pack, undo past ones. */
export function ArtPacksSettings() {
  const status = useArtPacks();
  const collections = useStore((s) => s.library.collections);
  const [open, setOpen] = useState(false);
  const job = status?.job ?? null;
  const control = async (method: 'artPacks.pause' | 'artPacks.resume' | 'artPacks.cancel') => {
    const j = await call<ArtPackJob | null>(method).catch(() => null);
    if (j) setArtPackJob(j);
  };
  return (
    <section className="sgroup">
      <h2 className="sgroup__title">Art packs</h2>
      <p className="sgroup__desc">
        Give the whole library one look: pick a SteamGridDB style — Official, Alternate, Minimal, Blurred, Material or White logo — for covers,
        backgrounds and logos, preview it on eight games, then apply it in the background. Art you chose yourself stays unless you say otherwise, and
        every pack can be undone. Uses your own SteamGridDB key; only game IDs and titles are sent, to SteamGridDB alone.
      </p>
      <div className="srow">
        <div className="srow__text">
          <span className="srow__label">Apply a style to many games</span>
          <div className="srow__hint">
            {!status ? '…' : !status.configured ? 'Needs your SteamGridDB API key (Data sources, above).' : status.localOnly ? 'Unavailable while Offline mode is on.' : status.dataSaver ? 'Unavailable while Data saver is on.' : 'Rate-limited and pausable; waits while a game runs.'}
          </div>
        </div>
        <div className="srow__control">
          <Button size="sm" icon={<Wand2 size={14} />} onClick={() => setOpen(true)}>Open art packs…</Button>
        </div>
      </div>

      {isActive(job) && (
        <div className="srow artpacks-settings__job">
          <span className="srow__label">{job.presetLabel} · {scopeLabel(job.scope, collections)}</span>
          <ProgressBar value={jobFraction(job) * 100} label="Art pack progress" />
          <div className="srow__hint" role="status">{jobStatusLine(job)}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {job.state === 'paused'
              ? <Button size="sm" onClick={() => void control('artPacks.resume')}>Resume</Button>
              : <Button size="sm" onClick={() => void control('artPacks.pause')}>Pause</Button>}
            <Button size="sm" variant="ghost" onClick={() => void control('artPacks.cancel')}>Cancel</Button>
          </div>
        </div>
      )}

      {!!status?.runs.length && (
        <div className="srow" style={{ display: 'block' }}>
          <span className="srow__label">Recent art packs</span>
          <ul className="artpacks-settings__runs">
            {status.runs.map((r) => (
              <li key={r.id} className="artpacks-settings__run">
                <div>
                  <span>{r.presetLabel} · {scopeLabel(r.scope, collections)}</span>
                  <span className="srow__hint">
                    {r.kinds.map((k) => KIND_LABEL[k]).join(', ')} · {r.replaced.toLocaleString()} changed · {formatRelative(r.started)}
                  </span>
                </div>
                {r.restoredAt ? <Badge>Restored</Badge> : r.state === 'running' ? <Badge tone="accent">Running</Badge> : r.state === 'interrupted' ? <Badge tone="warn">Interrupted</Badge> : null}
                {r.canRestore && (
                  <Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} onClick={() => void restoreArtPack(r.id)}>Restore previous art</Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ArtPacksDialog open={open} onClose={() => setOpen(false)} />
    </section>
  );
}
