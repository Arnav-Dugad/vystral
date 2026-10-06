import { useEffect } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, HardDriveDownload } from 'lucide-react';
import type { Game } from '../../bridge/types';
import { chipText, fitSentence, updateForGame } from '../../lib/diskForecast';
import { ensureDiskForecast, useDiskForecast } from '../../state/diskForecast';
import { useReducedMotion, useStore } from '../../state/store';
import '../storage/update-space.css';

/**
 * Track P: on a game page, the room its pending Steam update still needs and what its drive has
 * free ("Next update needs 23.4 GB · 9.1 GB free on D:"). Opens Storage Studio. Nothing shows when
 * no update is pending.
 */
export function UpdateSpaceChip({ game }: { game: Game }) {
  const forecast = useDiskForecast((s) => s.forecast);
  const navigate = useStore((s) => s.navigate);
  const reduce = useReducedMotion();
  useEffect(() => void ensureDiskForecast(), [game.id]);
  const hit = updateForGame(forecast, game.id);
  if (!hit) return null;
  const { update, drive } = hit;
  const Icon = update.fit === 'short' || update.fit === 'tight' ? AlertTriangle : update.fit === 'ok' ? CheckCircle2 : HardDriveDownload;
  const fitWord = update.fit === 'short' ? 'Won’t fit' : update.fit === 'tight' ? 'Tight' : null;
  return (
    <motion.button
      className="uschip"
      data-fit={update.fit}
      onClick={() => navigate({ name: 'storage' })}
      aria-label={`${chipText(update, drive)}. ${fitSentence(update, drive)} Open Storage Studio`}
      title={fitSentence(update, drive)}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduce ? 0.15 : 0.3, delay: reduce ? 0 : 0.25 }}
    >
      <Icon size={15} aria-hidden />
      {fitWord && <span className="uschip__fit">{fitWord}</span>}
      <span className="uschip__text">{chipText(update, drive)}</span>
    </motion.button>
  );
}
