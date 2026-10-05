import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, CloudOff, EyeOff, KeyRound, Lock, RefreshCw, Search, ShieldAlert, Trophy, UserX } from 'lucide-react';
import { call, errorMessage, on } from '../../bridge/bridge';
import type { Achievement, AchievementsResult, Game } from '../../bridge/types';
import { formatDate, formatRelative } from '../../lib/format';
import { filterAchievements, rarityTier, type AchievementFilter } from '../../lib/installProgress';
import { spring } from '../../lib/motion';
import { useReducedMotion, useStore } from '../../state/store';
import { Badge, Button, EmptyState, Segmented, Skeleton } from '../ui/primitives';
import { ProgressRing } from './InstallProgress';
import './achievements.css';

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'done'; data: AchievementsResult };

/** Steam achievements for one game, read through the user's own Steam Web API key. */
export function AchievementsPanel({ game }: { game: Game }) {
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const isSteam = game.installations.some((i) => i.platform === 'steam');

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setState({ kind: 'loading' });
      try {
        const data = await call<AchievementsResult>('steam.achievements', { gameId: game.id }, 120_000);
        setState({ kind: 'done', data });
      } catch (err) {
        if (!quiet) setState({ kind: 'error', message: errorMessage(err) });
      }
    },
    [game.id],
  );

  useEffect(() => {
    if (!isSteam) {
      setState({ kind: 'done', data: { status: 'notSteam', message: null, fetchedAt: null, achievements: [], unlocked: 0, total: 0 } });
      return;
    }
    void load();
    return on('steam.achievementsUpdated', () => void load(true));
  }, [isSteam, load]);

  if (state.kind === 'loading') return <AchievementsSkeleton />;
  if (state.kind === 'error')
    return (
      <EmptyState
        icon={<AlertTriangle size={30} />}
        title="Achievements couldn’t be loaded"
        body={state.message}
        actions={<Button icon={<RefreshCw size={15} />} onClick={() => void load()}>Try again</Button>}
      />
    );
  return <AchievementsBody game={game} data={state.data} onRetry={() => void load()} />;
}

function AchievementsBody({ game, data, onRetry }: { game: Game; data: AchievementsResult; onRetry: () => void }) {
  const navigate = useStore((s) => s.navigate);
  const toSettings = (section: string) => navigate({ name: 'settings', section });

  switch (data.status) {
    case 'notSteam':
      return (
        <EmptyState
          icon={<Trophy size={30} />}
          title="No achievements to show"
          body="Achievements are available for Steam games when you connect the Steam Web API. This game isn’t from Steam."
        />
      );
    case 'notConnected':
      return (
        <EmptyState
          icon={<KeyRound size={30} />}
          title="Connect Steam to see achievements"
          body="Add your own free Steam Web API key in Settings. It stays in Windows Credential Manager on this PC, and VYSTRAL only talks to api.steampowered.com."
          actions={<Button variant="primary" onClick={() => toSettings('library')}>Set up in Settings</Button>}
        />
      );
    case 'noAccount':
      return (
        <EmptyState
          icon={<UserX size={30} />}
          title="No Steam account found on this PC"
          body={data.message ?? 'Sign in to Steam once on this PC, then come back.'}
          actions={<Button onClick={() => toSettings('library')}>Open Steam settings</Button>}
        />
      );
    case 'localOnly':
      return (
        <EmptyState
          icon={<CloudOff size={30} />}
          title="Offline mode is on"
          body="VYSTRAL isn’t contacting Steam, and no achievements were saved on this PC for this game yet."
          actions={<Button onClick={() => toSettings('privacy')}>Privacy settings</Button>}
        />
      );
    case 'private':
      return (
        <EmptyState
          icon={<ShieldAlert size={30} />}
          title="Your Steam game details are private"
          body={<>Steam only shares achievements when your profile’s <strong>Game details</strong> are public. Change it in Steam under Profile → Edit Profile → Privacy Settings, then reopen this tab (VYSTRAL checks again after six hours).</>}
          actions={<Button onClick={() => void call('app.openExternal', { url: 'https://steamcommunity.com/my/edit/settings' }).catch(() => undefined)}>Open Steam privacy settings</Button>}
        />
      );
    case 'none':
      return <EmptyState icon={<Trophy size={30} />} title="No Steam achievements" body={`${game.title} doesn’t have achievements on Steam.`} />;
    case 'error':
      return (
        <EmptyState
          icon={<AlertTriangle size={30} />}
          title="Steam didn’t return achievements"
          body={data.message ?? 'Try again in a little while.'}
          actions={<Button icon={<RefreshCw size={15} />} onClick={onRetry}>Try again</Button>}
        />
      );
    default:
      return <AchievementList data={data} />;
  }
}

function AchievementList({ data }: { data: AchievementsResult }) {
  const reduce = useReducedMotion();
  const [filter, setFilter] = useState<AchievementFilter>('all');
  const [query, setQuery] = useState('');
  const list = useMemo(() => filterAchievements(data.achievements, filter, query), [data.achievements, filter, query]);
  const fraction = data.total ? data.unlocked / data.total : 0;
  const rarestUnlocked = useMemo(
    () => data.achievements.filter((a) => a.achieved && a.globalPercent != null).sort((a, b) => a.globalPercent! - b.globalPercent!)[0],
    [data.achievements],
  );
  const hiddenLocked = data.achievements.filter((a) => a.hidden && !a.achieved).length;

  return (
    <div className="ach">
      <div className="ach__summary surface">
        <ProgressRing fraction={fraction} size={104} stroke={7} label={`${data.unlocked} of ${data.total} achievements unlocked`} tone={fraction >= 1 ? 'ok' : 'accent'} />
        <div className="ach__summary-text">
          <div className="ach__count num">
            {data.unlocked.toLocaleString()} <span>of {data.total.toLocaleString()}</span>
          </div>
          <div className="ach__sub">{fraction >= 1 ? 'Every achievement unlocked.' : 'achievements unlocked'}</div>
          {rarestUnlocked && (
            <div className="ach__sub">
              Rarest unlock: <strong>{rarestUnlocked.name}</strong> · <span className="num">{formatPercent(rarestUnlocked.globalPercent!)}</span> of players
            </div>
          )}
          <div className="ach__source">
            From Steam{data.fetchedAt ? ` · updated ${formatRelative(data.fetchedAt).toLowerCase()}` : ''}
            {hiddenLocked > 0 && ` · ${hiddenLocked} hidden ${hiddenLocked === 1 ? 'achievement stays' : 'achievements stay'} secret until unlocked`}
          </div>
        </div>
      </div>

      {data.message && (
        <p className="ach__note" role="status">
          <AlertTriangle size={14} aria-hidden /> {data.message}
        </p>
      )}

      <div className="ach__controls">
        <Segmented
          label="Show achievements"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'unlocked', label: 'Unlocked' },
            { value: 'locked', label: 'Locked' },
            { value: 'rarest', label: 'Rarest' },
          ]}
        />
        <label className="ach__search">
          <Search size={15} aria-hidden />
          <input type="search" value={query} placeholder="Search achievements" aria-label="Search achievements" maxLength={80} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>

      {list.length === 0 ? (
        <p className="ach__empty">{query ? `No achievements match “${query}”.` : filter === 'unlocked' ? 'None unlocked yet.' : 'Nothing left to unlock.'}</p>
      ) : (
        <ul className="ach__list" aria-label={`${list.length} achievements`}>
          {list.map((a, i) => (
            <motion.li
              key={a.apiName}
              className="ach-row"
              data-achieved={a.achieved || undefined}
              initial={reduce || i > 24 ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...spring.panel, delay: reduce ? 0 : Math.min(i, 24) * 0.018 }}
            >
              <AchievementRow a={a} />
            </motion.li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AchievementRow({ a }: { a: Achievement }) {
  const tier = rarityTier(a.globalPercent);
  const hiddenLocked = a.hidden && !a.achieved;
  return (
    <>
      <div className="ach-row__icon" aria-hidden>
        {a.icon ? <img src={a.icon} alt="" loading="lazy" decoding="async" draggable={false} /> : hiddenLocked ? <EyeOff size={20} /> : a.achieved ? <Trophy size={20} /> : <Lock size={18} />}
      </div>
      <div className="ach-row__main">
        <div className="ach-row__name">
          <span className="ach-row__title">{a.name}</span>
          {tier === 'ultra' && <Badge tone="accent">Ultra rare</Badge>}
          {tier === 'rare' && <Badge>Rare</Badge>}
          {a.hidden && <span className="visually-hidden">Hidden achievement.</span>}
        </div>
        <div className="ach-row__desc">
          {hiddenLocked ? <span className="ach-row__secret">Hidden achievement · details appear when you unlock it</span> : a.description || <span className="ach-row__secret">No description</span>}
        </div>
        {a.globalPercent != null && (
          <div className="ach-row__rarity" title={`${formatPercent(a.globalPercent)} of Steam players unlocked this`}>
            <span className="ach-row__bar" aria-hidden>
              <span style={{ transform: `scaleX(${Math.max(0.01, Math.min(1, a.globalPercent / 100))})` }} />
            </span>
            <span><span className="num">{formatPercent(a.globalPercent)}</span> of players</span>
          </div>
        )}
      </div>
      <div className="ach-row__status">
        {a.achieved ? (
          <>
            <span className="ach-row__unlocked">Unlocked</span>
            {a.unlockedAt && <span className="ach-row__date">{formatDate(a.unlockedAt)}</span>}
          </>
        ) : (
          <span className="ach-row__locked">Locked</span>
        )}
      </div>
    </>
  );
}

function formatPercent(p: number): string {
  if (p > 0 && p < 0.1) return '<0.1%';
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

function AchievementsSkeleton() {
  return (
    <div className="ach" aria-busy="true" aria-label="Loading achievements">
      <div className="ach__summary surface">
        <Skeleton width={104} height={104} radius={52} />
        <div style={{ display: 'grid', gap: 10, flex: 1 }}>
          <Skeleton width={160} height={28} />
          <Skeleton width={240} height={14} />
          <Skeleton width={200} height={12} />
        </div>
      </div>
      <div className="ach__list">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="ach-row">
            <Skeleton width={52} height={52} radius={12} />
            <div style={{ display: 'grid', gap: 8 }}>
              <Skeleton width="45%" height={14} />
              <Skeleton width="75%" height={12} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
