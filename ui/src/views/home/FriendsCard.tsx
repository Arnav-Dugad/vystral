import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, CloudOff, Gamepad2, Library, Lock, RefreshCw, Settings2, Users } from 'lucide-react';
import { call } from '../../bridge/bridge';
import type { Friend, FriendsActivity } from '../../bridge/types';
import { cardVisible, FRIENDS_POLL_MS, friendNames, friendsHeadline, groupFriends, initials, isPlaying, STATE_LABEL, stateTone, statusCopy, type FriendGroup } from '../../lib/friends';
import { formatRelative } from '../../lib/format';
import { spring } from '../../lib/motion';
import { titleHue } from '../../lib/palette';
import { useReducedMotion, useStore } from '../../state/store';
import { GameCover } from '../../components/game/GameCover';
import { Button, IconButton } from '../../components/ui/primitives';
import './friends.css';

/**
 * Track P: "Friends playing now" (opt-in, Settings → Library & stores → Steam Web API). Asks the
 * native side every 2½ minutes while Home is on screen and the window is visible; the native side
 * decides whether to actually ask Steam (never more than every 100 s, never offline or in a game,
 * backing off after errors). Renders nothing when switched off or without a key/account.
 */
export function FriendsCard() {
  const [data, setData] = useState<FriendsActivity | null>(null);
  const [busy, setBusy] = useState(false);
  const localOnly = useStore((s) => s.settings?.['privacy.localOnly'] ?? false);
  const enabled = useStore((s) => s.settings?.['home.friendsActivity'] ?? false);
  const dataSaver = useStore((s) => s.settings?.['dataSaver.enabled'] ?? false);
  const lastAsk = useRef(0);

  const load = useCallback(async (force = false) => {
    lastAsk.current = Date.now();
    if (force) setBusy(true);
    try {
      const r = await call<FriendsActivity>('friends.activity', { force });
      if (r && typeof r.status === 'string') setData(r);
    } catch {
      // Keep what we had; the next poll tries again.
    } finally {
      if (force) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const tick = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastAsk.current >= FRIENDS_POLL_MS - 1000) void load();
    };
    const timer = window.setInterval(tick, FRIENDS_POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [load, enabled, localOnly, dataSaver]);

  if (!cardVisible(data)) return null;
  return <FriendsCardBody data={data!} busy={busy} onRefresh={() => void load(true)} />;
}

function FriendsCardBody({ data, busy, onRefresh }: { data: FriendsActivity; busy: boolean; onRefresh: () => void }) {
  const reduce = useReducedMotion();
  const gamesById = useStore((s) => s.gamesById);
  const navigate = useStore((s) => s.navigate);
  const { playing, online } = useMemo(() => groupFriends(data.friends, gamesById), [data.friends, gamesById]);
  const problem = statusCopy(data);
  const headline = problem ? problem.title : friendsHeadline(playing, online.length);

  return (
    <motion.section
      className="friends surface"
      aria-labelledby="friends-title"
      aria-busy={busy || undefined}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0.15 } : spring.panel}
    >
      <div className="friends__glow" aria-hidden />
      <header className="friends__head">
        <span className="friends__eyebrow caps"><Users size={13} aria-hidden /> Friends playing now</span>
        <div className="friends__tools">
          {data.fetchedAt && !problem && (
            <span className="friends__when" data-stale={data.stale || undefined}>
              {data.stale ? 'Last checked' : 'Updated'} {formatRelative(data.fetchedAt).toLowerCase()}
            </span>
          )}
          <IconButton label="Refresh friends" size="sm" onClick={onRefresh} disabled={busy}>
            <RefreshCw size={14} className={busy && !reduce ? 'friends__spin' : undefined} />
          </IconButton>
        </div>
      </header>
      <h2 id="friends-title" className="friends__title">{headline}</h2>

      {problem ? (
        <Problem problem={problem} status={data.status} busy={busy} onRetry={onRefresh} onSettings={() => navigate({ name: 'settings', section: data.status === 'offline' ? 'privacy' : 'library' })} />
      ) : (
        <>
          {data.message && <p className="friends__note" role="status">{data.message}</p>}
          {playing.length > 0 && (
            <ul className="friends__games" aria-label="Games your friends are playing">
              <AnimatePresence initial={false}>
                {playing.map((g, i) => (
                  <motion.li
                    key={g.key}
                    layout={reduce ? false : 'position'}
                    initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, transition: { duration: 0.18 } }}
                    transition={reduce ? { duration: 0.15 } : { ...spring.panel, delay: Math.min(i, 6) * 0.04 }}
                  >
                    <GameRow group={g} reduce={reduce} onOpen={g.gameId ? () => navigate({ name: 'game', id: g.gameId! }) : undefined} />
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
          {online.length > 0 && <OnlineStrip friends={online} reduce={reduce} />}
          {playing.length === 0 && online.length === 0 && <Quiet data={data} />}
          <p className="friends__privacy">
            <Lock size={12} aria-hidden /> From your friends’ public Steam profiles, read with your own key. Nothing is shared or stored.
          </p>
        </>
      )}
    </motion.section>
  );
}

function GameRow({ group, onOpen, reduce }: { group: FriendGroup; onOpen?: () => void; reduce: boolean }) {
  const game = useStore((s) => (group.gameId ? s.gamesById.get(group.gameId) : undefined));
  const names = friendNames(group.friends);
  return (
    <div className="friends__game" style={{ ['--fg-hue' as string]: titleHue(group.title) }}>
      <span className="friends__cover" aria-hidden>
        {game ? <GameCover game={game} /> : <span className="friends__cover-blank"><Gamepad2 size={18} /></span>}
      </span>
      <span className="friends__game-text">
        <span className="friends__game-title truncate">{group.title}</span>
        <span className="friends__names truncate" title={group.friends.map((f) => f.name).join(', ')}>{names}</span>
      </span>
      <AvatarStack friends={group.friends} reduce={reduce} />
      {onOpen ? (
        <button className="friends__chip" onClick={onOpen} aria-label={`${group.title} is in your library. Open its page`}>
          <Library size={13} aria-hidden /> In your library
        </button>
      ) : (
        <span className="friends__chip friends__chip--muted">Not in your library</span>
      )}
    </div>
  );
}

function AvatarStack({ friends, reduce }: { friends: Friend[]; reduce: boolean }) {
  const shown = friends.slice(0, 4);
  const more = friends.length - shown.length;
  return (
    <ul className="friends__stack" aria-label={`${friends.length} ${friends.length === 1 ? 'friend' : 'friends'}: ${friends.map((f) => `${f.name} (${STATE_LABEL[f.state]})`).join(', ')}`}>
      <AnimatePresence initial={false}>
        {shown.map((f, i) => (
          <motion.li
            key={f.key}
            layout={reduce ? false : 'position'}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: reduce ? 1 : 0.6 }}
            transition={reduce ? { duration: 0.15 } : spring.focus}
            style={{ zIndex: shown.length - i }}
            aria-hidden
          >
            <Avatar friend={f} size={30} />
          </motion.li>
        ))}
      </AnimatePresence>
      {more > 0 && <li className="friends__more" aria-hidden>+{more}</li>}
    </ul>
  );
}

function OnlineStrip({ friends, reduce }: { friends: Friend[]; reduce: boolean }) {
  const shown = friends.slice(0, 14);
  return (
    <div className="friends__online">
      <span className="friends__label caps">Online · {friends.length}</span>
      <ul className="friends__online-list" aria-label="Friends online, not in a game">
        <AnimatePresence initial={false}>
          {shown.map((f) => (
            <motion.li
              key={f.key}
              layout={reduce ? false : 'position'}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={reduce ? { duration: 0.15 } : spring.effect}
              className="friends__person"
              title={`${f.name} · ${STATE_LABEL[f.state]}`}
            >
              <Avatar friend={f} size={24} />
              <span className="friends__person-name truncate">{f.name}</span>
              <span className="visually-hidden">, {STATE_LABEL[f.state]}</span>
            </motion.li>
          ))}
        </AnimatePresence>
        {friends.length > shown.length && <li className="friends__more friends__more--inline">+{friends.length - shown.length}</li>}
      </ul>
    </div>
  );
}

function Avatar({ friend, size }: { friend: Friend; size: number }) {
  const [broken, setBroken] = useState(false);
  const tone = stateTone(friend.state, isPlaying(friend));
  return (
    <span className="favatar" data-tone={tone} style={{ width: size, height: size }}>
      {friend.avatar && !broken ? (
        <img src={friend.avatar} alt="" width={size} height={size} loading="lazy" decoding="async" onError={() => setBroken(true)} />
      ) : (
        <span className="favatar__initials" style={{ ['--fa-hue' as string]: titleHue(friend.name) }}>{initials(friend.name)}</span>
      )}
    </span>
  );
}

function Quiet({ data }: { data: FriendsActivity }) {
  const recent = data.recentlyOnline;
  return (
    <div className="friends__quiet">
      <p>
        {data.friendCount > 0
          ? 'It’s quiet right now. When friends start a game, it shows up here.'
          : 'Your Steam friends list is empty. Friends you add on Steam show up here when they play.'}
      </p>
      {recent.length > 0 && (
        <div className="friends__online">
        <span className="friends__label caps" aria-hidden>Recently online</span>
        <ul className="friends__recent" aria-label="Recently online">
          {recent.map((f) => (
            <li key={f.key}>
              <Avatar friend={f} size={22} />
              <span className="truncate">{f.name}</span>
              {f.lastOnline && <span className="friends__ago">{formatRelative(f.lastOnline).toLowerCase()}</span>}
            </li>
          ))}
        </ul>
        </div>
      )}
    </div>
  );
}

function Problem({ problem, status, busy, onRetry, onSettings }: {
  problem: NonNullable<ReturnType<typeof statusCopy>>;
  status: FriendsActivity['status'];
  busy: boolean;
  onRetry: () => void;
  onSettings: () => void;
}) {
  const Icon = status === 'offline' ? CloudOff : status === 'private' ? Lock : AlertTriangle;
  return (
    <div className="friends__problem" data-status={status} role="status">
      <Icon size={18} aria-hidden />
      <p>{problem.body}</p>
      <div className="friends__problem-actions">
        {problem.action === 'retry' && <Button size="sm" icon={<RefreshCw size={14} />} loading={busy} onClick={onRetry}>Try again</Button>}
        {problem.action === 'settings' && <Button size="sm" icon={<Settings2 size={14} />} onClick={onSettings}>Open settings</Button>}
      </div>
    </div>
  );
}
