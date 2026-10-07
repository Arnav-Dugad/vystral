import { useCallback, useEffect, useId, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, Lock, Users } from 'lucide-react';
import { call, on } from '../../bridge/bridge';
import type { FriendPlayed, FriendsHistory, Game } from '../../bridge/types';
import { formatRelative } from '../../lib/format';
import { formatMinutes, friendsPlayedHeadline } from '../../lib/steamExtras';
import { spring } from '../../lib/motion';
import { useReducedMotion, useStore } from '../../state/store';
import './steam-extras.css';

/**
 * Track W: "Juniper and Rook played this recently" in the game page hero (opt-in, friends.gameHistory).
 * From friends' public recently played games, read natively at most every few hours. Opens a small
 * list with each friend's playtime in the last two weeks. Renders nothing when off, not Steam, or
 * when no friend played it.
 */
export function FriendsPlayedChip({ game }: { game: Game }) {
  const enabled = useStore((s) => s.settings?.['friends.gameHistory'] ?? false);
  const isSteam = game.installations.some((i) => i.platform === 'steam');
  const [data, setData] = useState<FriendsHistory | null>(null);
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();
  const listId = useId();

  const load = useCallback(async () => {
    try {
      setData(await call<FriendsHistory>('friends.gameHistory', { gameId: game.id }));
    } catch {
      setData(null);
    }
  }, [game.id]);

  useEffect(() => {
    setOpen(false);
    if (!enabled || !isSteam) { setData(null); return; }
    void load();
    return on('friends.historyChanged', () => void load());
  }, [enabled, isSteam, load]);

  if (!data) return null;
  if (data.status === 'notLoaded' && data.refreshing) {
    return (
      <span className="fpchip fpchip--quiet" role="status">
        <Users size={14} aria-hidden /> Checking what your friends played… this takes a few minutes the first time
      </span>
    );
  }
  if (data.status !== 'ok' || data.friends.length === 0) return null;

  const shown = data.friends.slice(0, 4);
  const more = data.friends.length - shown.length;
  return (
    <div className="fpchip-wrap">
      <motion.button
        type="button"
        className="fpchip"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduce ? 0.15 : 0.3, delay: reduce ? 0 : 0.3 }}
      >
        <span className="fpchip__stack" aria-hidden>
          {shown.map((f, i) => <span key={f.key} style={{ zIndex: shown.length - i }}><FriendFace friend={f} /></span>)}
          {more > 0 && <span className="fpchip__more">+{more}</span>}
        </span>
        <span className="fpchip__text">
          {friendsPlayedHeadline(data.friends)}
          <span className="fpchip__time"> · {formatMinutes(data.totalMinutes)} in the last two weeks</span>
        </span>
        <ChevronDown size={14} className="fpchip__chev" data-open={open || undefined} aria-hidden />
      </motion.button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={listId}
            className="fpchip__panel"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.14 } }}
            transition={reduce ? { duration: 0.15 } : spring.panel}
          >
            <ul className="fpchip__list" aria-label="Friends who played this in the last two weeks">
              {data.friends.map((f) => (
                <li key={f.key}>
                  <FriendFace friend={f} size={28} />
                  <span className="truncate">{f.name}</span>
                  <span className="fpchip__mins num">{formatMinutes(f.minutesTwoWeeks)}</span>
                </li>
              ))}
            </ul>
            <p className="fpchip__src">
              <Lock size={11} aria-hidden /> From friends’ public Steam profiles{data.fetchedAt ? `, checked ${formatRelative(data.fetchedAt).toLowerCase()}` : ''}.
              {data.publicFriends > 0 && ` ${data.checked} of ${data.friendCount} friends share their games.`}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function FriendFace({ friend, size = 24 }: { friend: FriendPlayed; size?: number }) {
  const initial = [...friend.name.trim()][0]?.toUpperCase() ?? '?';
  return friend.avatar
    ? <img className="fpface" src={friend.avatar} alt="" width={size} height={size} draggable={false} />
    : <span className="fpface fpface--blank" style={{ width: size, height: size, fontSize: size * 0.45 }}>{initial}</span>;
}
