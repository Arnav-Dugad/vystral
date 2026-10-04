import { useState } from 'react';
import { Folder, FolderMinus, FolderPlus, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { MediaFolder } from '../../bridge/types';
import { call, errorMessage } from '../../bridge/bridge';
import { Dialog } from '../../components/ui/Dialog';
import { Badge, Button, IconButton } from '../../components/ui/primitives';
import { useStore } from '../../state/store';

/** Lists capture folders; automatic ones (Steam, Xbox Game Bar) can't be removed. */
export function FoldersDialog({
  open,
  folders,
  onClose,
  onChanged,
}: {
  open: boolean;
  folders: MediaFolder[];
  onClose: () => void;
  onChanged: (folders: MediaFolder[] | null) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useStore((s) => s.toast);

  const add = async () => {
    setBusy('add');
    try {
      const result = await call<MediaFolder[] | null>('media.addFolder', undefined, 10 * 60_000);
      if (result) {
        onChanged(result);
        toast({ tone: 'success', title: 'Folder added', body: 'Its screenshots and clips now appear in Moments.' });
      }
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t add that folder', body: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (folder: MediaFolder) => {
    setBusy(folder.id);
    try {
      const result = await call<MediaFolder[] | null>('media.removeFolder', { folderId: folder.id });
      onChanged(Array.isArray(result) ? result : null);
      toast({ tone: 'info', title: `${folder.label} removed`, body: 'Nothing was deleted — VYSTRAL just stops showing files from it.' });
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t remove that folder', body: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Capture folders"
      wide
      describedBy="mv-folders-desc"
      actions={
        <>
          <Button variant="ghost" onClick={() => void useStore.getState().setSetting('moments.enabled', false)}>
            Turn off Moments
          </Button>
          <span style={{ flex: 1 }} />
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
          <Button variant="primary" icon={<FolderPlus size={16} aria-hidden />} loading={busy === 'add'} onClick={() => void add()}>
            Add folder…
          </Button>
        </>
      }
    >
      <p id="mv-folders-desc" className="mv-folders__desc">
        <ShieldCheck size={16} aria-hidden />
        VYSTRAL reads these folders on this PC only. Files are never uploaded, moved or changed.
      </p>
      {folders.length === 0 ? (
        <p className="mv-folders__empty">No capture folders were found yet. Add a folder where you keep screenshots or clips.</p>
      ) : (
        <ul className="mv-folders">
          {folders.map((f) => (
            <li key={f.id} className="mv-folder" data-missing={!f.exists}>
              <span className="mv-folder__icon" aria-hidden>
                {f.exists ? <Folder size={18} /> : <TriangleAlert size={18} />}
              </span>
              <span className="mv-folder__text">
                <span className="mv-folder__label">
                  {f.label}
                  {f.automatic ? <Badge>Found automatically</Badge> : <Badge tone="accent">Added by you</Badge>}
                  {!f.exists && <Badge tone="warn">Not found</Badge>}
                </span>
                <span className="mv-folder__path num selectable" title={f.path}>
                  {f.path}
                </span>
              </span>
              {!f.automatic ? (
                <IconButton label={`Remove ${f.label}`} disabled={busy != null} onClick={() => void remove(f)}>
                  <FolderMinus size={18} />
                </IconButton>
              ) : (
                <span className="mv-folder__auto">Automatic</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
