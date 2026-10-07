import { useMemo } from 'react';
import { motion } from 'motion/react';
import { Archive, BookmarkPlus, Moon, Play } from 'lucide-react';
import type { Game } from '../../bridge/types';
import { isInstalled, PLATFORM_NAMES, plural } from '../../lib/format';
import { ageLabel, ageSourceNote } from '../../lib/neverPlayed';
import { gamesFor, type HomeModel } from '../../lib/homeModel';
import { pick, spring } from '../../lib/motion';
import { setLaunchOrigin } from '../../lib/flight';
import { setGameStatus } from '../../state/statusActions';
import { useReducedMotion, useStore } from '../../state/store';
import { GameCover } from '../../components/game/GameCover';
import { LiveLayer } from '../../components/game/LiveTile';
import { Shelf } from '../../components/game/Shelf';
import { openInStore } from '../../components/game/InstallButton';
import { Button, SectionHead } from '../../components/ui/primitives';
import { StoreLogo, StoreLogos } from '../../components/ui/StoreLogo';
import './never-played.css';

/**
 * "Owned, never played": a few gentle picks for tonight, then everything else that has been
 * waiting, longest first, each labelled with how long VYSTRAL has known about it.
 */
export function NeverPlayedSection({ never, byId, live }: {
  /** Track AA: computed with the rest of Home (lib/homeModel.ts), live or from the first-paint snapshot. */
  never: HomeModel['never'];
  byId: ReadonlyMap<string, Game>;
  live?: boolean;
}) {
  const navigate = useStore((s) => s.navigate);
  const now = useMemo(() => Date.now(), []);
  const picks = useMemo(() => never.picks.flatMap((p) => {
    const game = byId.get(p.id);
    return game ? [{ game, reason: p.reason }] : [];
  }), [never, byId]);
  const rest = useMemo(() => gamesFor(never.restIds, byId), [never, byId]);
  if (never.count === 0) return null;

  return (
    <section className="never" aria-labelledby="never-title">
      <SectionHead
        title={<span id="never-title" className="home__title-icon"><Moon size={16} aria-hidden /> Owned, never played</span>}
        meta={<span title={ageSourceNote('firstSeen')}>{plural(never.count, 'game')} waiting · longest first</span>}
        action={<Button size="sm" variant="ghost" onClick={() => navigate({ name: 'library', quick: 'unplayed' })}>See all</Button>}
      />
      {picks.length > 0 && (
        <div className="never__picks" role="list" aria-label="Try it tonight">
          {picks.map((p, i) => (
            <TonightCard key={p.game.id} game={p.game} reason={p.reason} index={i} live={live} />
          ))}
        </div>
      )}
      {rest.length > 0 && <Shelf title="Still waiting" games={rest} caption={(g) => ageLabel(g, now)} live={live} />}
    </section>
  );
}

function TonightCard({ game, reason, index, live }: { game: Game; reason: string; index: number; live?: boolean }) {
  const reduce = useReducedMotion();
  const navigate = useStore((s) => s.navigate);
  const launchGame = useStore((s) => s.launchGame);
  const installed = isInstalled(game);
  const store = game.installations.find((i) => i.platform !== 'manual' && i.state !== 'installed');
  const backlog = game.status === 'backlog';
  return (
    <motion.article
      role="listitem"
      className="tonight"
      aria-label={`${game.title}. ${reason}`}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...pick(reduce, spring.panel), delay: reduce ? 0 : index * 0.06 }}
    >
      <button type="button" className="tile tonight__art" data-game-id={game.id} onClick={() => navigate({ name: 'game', id: game.id })} aria-label={`Open ${game.title}`}>
        <div className="card__frame" data-live={live || undefined}>
          <GameCover game={game} kind="hero" />
          {live && <LiveLayer game={game} />}
        </div>
      </button>
      <div className="tonight__body">
        <div className="tonight__eyebrow caps">Try it tonight</div>
        <h3 className="tonight__title truncate" title={game.title}>{game.title}</h3>
        <p className="tonight__reason">
          <StoreLogos platforms={game.installations.map((i) => i.platform)} />
          <span>{reason}</span>
        </p>
        <div className="tonight__actions">
          {installed ? (
            <Button size="sm" variant="primary" icon={<Play size={14} fill="currentColor" />} aria-label={`Play ${game.title}`} onClick={(e) => { setLaunchOrigin(game.id, e.currentTarget); void launchGame(game.id); }}>
              Play
            </Button>
          ) : store ? (
            <Button size="sm" variant="primary" icon={<StoreLogo platform={store.platform} size={14} decorative motion />} onClick={() => openInStore(store)} aria-label={`Install ${game.title} in ${PLATFORM_NAMES[store.platform]}`}>
              Install
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            icon={<BookmarkPlus size={14} />}
            aria-pressed={backlog}
            onClick={() => void setGameStatus(game, backlog ? null : 'backlog')}
          >
            {backlog ? 'On backlog' : 'Backlog'}
          </Button>
          <Button size="sm" variant="ghost" icon={<Archive size={14} />} onClick={() => void setGameStatus(game, 'abandoned')} title="Mark as abandoned: it leaves this shelf (undo from the notification)">
            Not for me
          </Button>
        </div>
      </div>
    </motion.article>
  );
}
