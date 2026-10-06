import { useEffect } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, CircleHelp, HardDriveDownload } from 'lucide-react';
import type { DriveForecast, PendingUpdate } from '../../bridge/types';
import { fitSentence } from '../../lib/diskForecast';
import { formatBytes, formatRelative } from '../../lib/format';
import { spring } from '../../lib/motion';
import { ensureDiskForecast, useDiskForecast } from '../../state/diskForecast';
import { useReducedMotion, useStore } from '../../state/store';
import { GameCover } from '../../components/game/GameCover';
import { Badge } from '../../components/ui/primitives';
import { UpdateSpaceBar } from '../../components/storage/UpdateSpaceBar';
import '../../components/storage/update-space.css';
import './pending-updates.css';

const PHASE: Record<PendingUpdate['phase'], string> = { queued: 'Waiting', downloading: 'Downloading', staging: 'Installing', paused: 'Paused' };

/**
 * Track P: Storage Studio's "Pending Steam updates": per drive, a stacked bar of what's in use and
 * what each pending update still needs, and the list of updates with how they fit. Read from
 * Steam's own app manifests (read-only); refreshed when Steam writes them.
 */
export function PendingUpdates() {
  const forecast = useDiskForecast((s) => s.forecast);
  useEffect(() => void ensureDiskForecast(15_000), []);
  if (!forecast?.available || forecast.drives.length === 0) return null;
  return (
    <section className="pupd" aria-labelledby="pupd-title">
      <div className="pupd__head">
        <h2 id="pupd-title" className="section-head__title"><HardDriveDownload size={17} aria-hidden /> Pending Steam updates</h2>
        <span className="pupd__meta">
          {forecast.pendingCount} {forecast.pendingCount === 1 ? 'update' : 'updates'} · read from Steam’s files {formatRelative(forecast.scannedAt).toLowerCase()}
        </span>
      </div>
      <div className="pupd__drives">
        {forecast.drives.map((d) => <DriveCard key={d.drive} drive={d} />)}
      </div>
      <p className="pupd__how">
        Each update needs room for its download and for the rebuilt files Steam stages before swapping them in, so the numbers here are the most it can
        need at once. Updates on the same drive are added up; Steam runs them one at a time, so together they usually need a little less.
      </p>
    </section>
  );
}

function DriveCard({ drive }: { drive: DriveForecast }) {
  const status = drive.status === 'short' ? { tone: 'danger' as const, text: 'Won’t fit' } : drive.status === 'tight' ? { tone: 'warn' as const, text: 'Nearly full' } : { tone: 'ok' as const, text: 'Fits' };
  return (
    <div className="pupd__drive surface" data-status={drive.status}>
      <div className="pupd__drive-head">
        <h3>{drive.label ? `${drive.label} (${drive.drive})` : drive.drive}</h3>
        <Badge tone={status.tone}>{status.text}</Badge>
        <span className="pupd__free num">{formatBytes(drive.freeBytes)} free · updates need {formatBytes(drive.needBytes)}</span>
      </div>
      <UpdateSpaceBar drive={drive} />
      <p className="pupd__after">
        {drive.afterBytes < 0
          ? `About ${formatBytes(-drive.afterBytes)} more free space is needed for all of them.`
          : `${formatBytes(drive.afterBytes)} would be left once they’re done.`}
      </p>
      <ul className="pupd__list" aria-label={`Pending updates on ${drive.drive}`}>
        {drive.updates.map((u, i) => <UpdateRow key={u.appId} update={u} drive={drive} index={i} />)}
      </ul>
    </div>
  );
}

function UpdateRow({ update: u, drive, index }: { update: PendingUpdate; drive: DriveForecast; index: number }) {
  const game = useStore((s) => (u.gameId ? s.gamesById.get(u.gameId) : undefined));
  const navigate = useStore((s) => s.navigate);
  const reduce = useReducedMotion();
  const Icon = u.fit === 'short' || u.fit === 'tight' ? AlertTriangle : u.fit === 'unknown' ? CircleHelp : CheckCircle2;
  const notes = [
    u.kind === 'install' ? 'Installing' : PHASE[u.phase],
    u.whenLaunched ? 'Steam updates it when you launch it' : null,
    u.scheduledAt ? `Steam plans to start it ${formatRelative(u.scheduledAt).toLowerCase()}` : null,
    u.lastResult != null ? `Steam’s last attempt ended with code ${u.lastResult}` : null,
  ].filter(Boolean).join(' · ');
  const title = game?.title ?? u.name;
  const body = (
    <>
      <span className="pupd__thumb" aria-hidden>{game && <GameCover game={game} />}</span>
      <span className="pupd__text">
        <span className="pupd__title truncate">{title}</span>
        <span className="pupd__notes truncate">{notes}</span>
      </span>
      <span className="pupd__need">
        <span className="num">{u.needBytes == null ? 'Size not known yet' : formatBytes(u.needBytes)}</span>
        {u.needBytes != null && u.needBytes > 0 && (
          <span className="pupd__split num">{formatBytes(u.downloadRemaining)} download · {formatBytes(u.stageRemaining)} staging</span>
        )}
      </span>
      <span className="pupd__fit" data-fit={u.fit} title={fitSentence(u, drive)}>
        <Icon size={15} aria-hidden /> <span className="visually-hidden">{fitSentence(u, drive)}</span>
      </span>
    </>
  );
  return (
    <motion.li
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : { ...spring.panel, delay: 0.1 + index * 0.05 }}
    >
      {game ? (
        <button className="pupd__row" onClick={() => navigate({ name: 'game', id: game.id })} aria-label={`${title}: ${u.needBytes == null ? 'size not known yet' : formatBytes(u.needBytes)}. ${fitSentence(u, drive)} Open its page`}>
          {body}
        </button>
      ) : (
        <div className="pupd__row">{body}</div>
      )}
    </motion.li>
  );
}
