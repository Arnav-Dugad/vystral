import { useState } from 'react';
import { ArrowDownToLine, ExternalLink, HardDrive, ShieldCheck, X } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { Game, Installation } from '../../bridge/types';
import { formatBytes, PLATFORM_NAMES } from '../../lib/format';
import { useInstallFor } from '../../state/installs';
import { useStore } from '../../state/store';
import { Button, IconButton } from '../ui/primitives';
import { Dialog } from '../ui/Dialog';
import { StoreLogo } from '../ui/StoreLogo';
import { InstallProgressPanel } from './InstallProgress';
import './install.css';

/**
 * Shown in the detail hero when no copy of the game is installed. Steam games install through
 * Steam (steam://install/<appid>) with live progress read from Steam's manifests; other stores
 * open their own page. VYSTRAL itself never downloads or writes game files.
 */
export function InstallButton({ game, size = 'lg' }: { game: Game; size?: 'md' | 'lg' | 'xl' }) {
  const steam = game.installations.find((i) => i.platform === 'steam' && i.state !== 'installed' && /^\d{1,10}$/.test(i.platformGameId));
  const progress = useInstallFor(game.id);

  if (progress && progress.kind === 'install' && progress.phase !== 'removed') {
    return (
      <InstallProgressPanel
        progress={progress}
        size={size}
        actions={
          progress.watching && (
            <>
              {steam && (
                <IconButton label="Show in Steam" size="sm" onClick={() => openInStore(steam)}>
                  <ExternalLink size={15} />
                </IconButton>
              )}
              <IconButton label="Stop showing progress (Steam keeps installing)" size="sm" onClick={() => void call('steam.forgetInstall', { gameId: game.id }).catch(() => undefined)}>
                <X size={15} />
              </IconButton>
            </>
          )
        }
      />
    );
  }

  if (steam) return <SteamInstall game={game} inst={steam} size={size} />;

  const store = game.installations.find((i) => i.platform !== 'manual' && i.state !== 'installed');
  if (!store) return null;
  const name = PLATFORM_NAMES[store.platform];
  return (
    <div className="install-cta">
      <Button size={size} icon={<StoreLogo platform={store.platform} size={size === 'xl' ? 20 : 16} decorative motion />} onClick={() => openInStore(store)} aria-label={`Open ${name} to install ${game.title}`}>
        Install in {name}
      </Button>
      <span className="install-cta__hint">Opens {name}. Installing happens there.</span>
    </div>
  );
}

/** Opens the store app's page for an installation (installing happens there). */
export function openInStore(inst: Installation) {
  void call('game.openInStore', { installationId: inst.id }).catch((err) =>
    useStore.getState().toast({ tone: 'info', title: `Couldn’t open ${PLATFORM_NAMES[inst.platform]}`, body: errorMessage(err) }),
  );
}

function SteamInstall({ game, inst, size }: { game: Game; inst: Installation; size: 'md' | 'lg' | 'xl' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} icon={<ArrowDownToLine size={size === 'xl' ? 20 : 17} />} onClick={() => setOpen(true)}>
        Install
      </Button>
      <SteamInstallDialog game={game} inst={inst} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Confirms handing the install to Steam (which shows its own size and drive choice). */
export function SteamInstallDialog({ game, inst, open, onClose }: { game: Game; inst: Installation; open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const toast = useStore((s) => s.toast);
  const setOpen = (v: boolean) => !v && onClose();

  const start = async () => {
    setBusy(true);
    try {
      await call('steam.install', { gameId: game.id });
      setOpen(false);
    } catch (err) {
      toast({ tone: 'danger', title: 'Steam couldn’t be asked to install it', body: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Install ${game.title} with Steam?`}
        describedBy="install-dialog-desc"
        actions={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void start()} data-autofocus icon={<ArrowDownToLine size={16} />}>
              Open Steam to install
            </Button>
          </>
        }
      >
        <p id="install-dialog-desc">
          Steam opens its install window, where you choose the drive and see the download size. VYSTRAL then shows Steam’s progress here.
        </p>
        <div className="install-dialog__facts">
          <div className="install-dialog__fact">
            <HardDrive size={16} aria-hidden />
            <span>
              {inst.sizeBytes
                ? <>Last known size on disk: <strong className="num">{formatBytes(inst.sizeBytes)}</strong>. Steam shows the current download size before it starts.</>
                : <>The download size isn’t known yet. Steam shows it in its install window before anything downloads.</>}
            </span>
          </div>
          <div className="install-dialog__fact">
            <ShieldCheck size={16} aria-hidden />
            <span>Steam handles the download and install. VYSTRAL never downloads or changes game files itself.</span>
          </div>
        </div>
      </Dialog>
    </>
  );
}
