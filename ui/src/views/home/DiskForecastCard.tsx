import { useEffect, useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { FolderOpen, HardDriveDownload, X } from 'lucide-react';
import { warningCopy, warningDrives, warningKey } from '../../lib/diskForecast';
import { spring } from '../../lib/motion';
import { isInstalled } from '../../lib/format';
import { openFolder } from '../../state/actions';
import { ensureDiskForecast, useDiskForecast } from '../../state/diskForecast';
import { useReducedMotion, useStore } from '../../state/store';
import { Button, IconButton } from '../../components/ui/primitives';
import { UpdateSpaceBar } from '../../components/storage/UpdateSpaceBar';
import '../../components/storage/update-space.css';

/**
 * Track P: a calm warning on Home when a pending Steam update won't fit on its drive, or would
 * leave it under ~5 % free. Suggests only safe things: Storage Studio and the game's folder.
 * Dismissed warnings stay away for this run unless the situation changes.
 */
export function DiskForecastCard() {
  const forecast = useDiskForecast((s) => s.forecast);
  const dismissed = useDiskForecast((s) => s.dismissed);
  const dismiss = useDiskForecast((s) => s.dismiss);
  const gamesById = useStore((s) => s.gamesById);
  const navigate = useStore((s) => s.navigate);
  const reduce = useReducedMotion();

  useEffect(() => void ensureDiskForecast(), []);

  const drives = useMemo(() => warningDrives(forecast), [forecast]);
  const key = warningKey(drives);
  const show = drives.length > 0 && !dismissed.includes(key);
  const drive = drives[0];
  const copy = drive ? warningCopy(drive, gamesById) : null;
  const lead = drive?.updates.find((u) => u.gameId && (u.needBytes ?? 0) > 0) ?? drive?.updates.find((u) => u.gameId);
  const leadGame = lead?.gameId ? gamesById.get(lead.gameId) : undefined;

  return (
    <AnimatePresence>
      {show && drive && copy && (
        <motion.section
          key="diskwarn"
          className="diskwarn surface"
          data-status={drive.status}
          aria-labelledby="diskwarn-title"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, transition: { duration: 0.2 } }}
          transition={reduce ? { duration: 0.15 } : spring.panel}
        >
          <div className="diskwarn__glow" aria-hidden />
          <header className="diskwarn__head">
            <span className="diskwarn__eyebrow caps">
              <HardDriveDownload size={13} aria-hidden /> {drive.status === 'short' ? 'Not enough space for an update' : 'Space is getting tight'}
            </span>
            <IconButton label="Dismiss" size="sm" onClick={() => dismiss(key)}><X size={15} /></IconButton>
          </header>
          <h2 id="diskwarn-title" className="diskwarn__title">{copy.title}</h2>
          <p className="diskwarn__body">{copy.body}</p>
          <div className="diskwarn__bar">
            <UpdateSpaceBar drive={drive} />
            <div className="diskwarn__legend" aria-hidden>
              <span>Free space on {drive.drive}</span>
              <span><i className="k-update" />Pending updates</span>
              {drive.afterBytes < 0 && <span><i className="k-over" />Doesn’t fit</span>}
              {drive.afterBytes > 0 && <span><i className="k-free" />Still free</span>}
            </div>
          </div>
          {drives.length > 1 && (
            <p className="diskwarn__more">
              {drives.slice(1).map((d) => `${d.drive} is ${d.status === 'short' ? 'short of space' : 'nearly full'} too`).join(' · ')}.
            </p>
          )}
          <div className="diskwarn__actions">
            <Button variant="primary" size="sm" onClick={() => navigate({ name: 'storage' })}>Open Storage Studio</Button>
            {leadGame && isInstalled(leadGame) && (
              <Button size="sm" icon={<FolderOpen size={14} />} onClick={() => void openFolder(leadGame)}>Open {leadGame.title}’s folder</Button>
            )}
          </div>
          <p className="diskwarn__safe">Sizes come from Steam’s own files on this PC. VYSTRAL never deletes anything; uninstalling happens in the store.</p>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
