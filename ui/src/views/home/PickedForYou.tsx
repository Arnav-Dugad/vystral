import { useMemo } from 'react';
import { Cloud, Sparkles } from 'lucide-react';
import type { Game } from '../../bridge/types';
import type { Recommendation } from '../../lib/recommendV2';
import { preferredBadge } from '../../lib/cloudPlus';
import { SERVICE_SHORT } from '../../lib/cloud';
import { launchCloud, useCloudEnabled, useCloudMap } from '../../state/cloud';
import { useLibraryPicks } from '../../state/recommend';
import { useStore } from '../../state/store';
import { Shelf } from '../../components/game/Shelf';
import { PickCaption } from '../../components/recommend/PickCaption';
import '../../components/recommend/recommend.css';

/**
 * Track D5: Home's "Picked for you" from recommend.v2 — your library scored against your taste, the time you usually
 * have now, what's installed or streamable, friends playing and more, each pick with its reason and "Not interested".
 * Until the live library arrives, the cached first-paint picks show (same ids, so cards keep their identity).
 */
export function PickedForYou({ visible, fallback }: { visible: readonly Game[]; fallback: { game: Game; reason: string }[] }) {
  const loaded = useStore((s) => s.libraryLoaded);
  const picks = useLibraryPicks(visible, { limit: 12 });
  const byId = useStore((s) => s.gamesById);
  const live = useMemo(() => picks.flatMap((p) => {
    const game = byId.get(p.id);
    return game ? [{ game, pick: p }] : [];
  }), [picks, byId]);

  if (!loaded) {
    if (!fallback.length) return null;
    return (
      <Shelf
        title={<span className="home__title-icon"><Sparkles size={16} aria-hidden /> Picked for you</span>}
        meta="From what you play, on this PC"
        games={fallback.map((s) => s.game)}
        caption={(g) => fallback.find((s) => s.game.id === g.id)?.reason}
        live
      />
    );
  }
  if (!live.length) return null;
  const byGame = new Map(live.map((x) => [x.game.id, x.pick]));
  return (
    <Shelf
      title={<span className="home__title-icon"><Sparkles size={16} aria-hidden /> Picked for you</span>}
      meta="From what you play, on this PC: no AI, nothing sent"
      games={live.map((x) => x.game)}
      caption={(g) => {
        const p = byGame.get(g.id);
        return p ? <PickCaption pick={p} /> : null;
      }}
      live
    />
  );
}

/**
 * Track D5: "Play in the cloud" — games a cloud service lists that aren't installed, ranked by the same engine, each
 * with a one-press "Stream" (it starts the preferred service, exactly like the game page's button).
 */
export function CloudPlayRow({ visible }: { visible: readonly Game[] }) {
  const enabled = useCloudEnabled();
  const map = useCloudMap();
  const picks = useLibraryPicks(visible, { limit: 16, mode: 'cloud' });
  const byId = useStore((s) => s.gamesById);
  if (!enabled || !map || !picks.length) return null;
  const games = picks.flatMap((p) => byId.get(p.id) ?? []);
  const byGame = new Map<string, Recommendation>(picks.map((p) => [p.id, p]));
  return (
    <Shelf
      title={<span className="home__title-icon"><Cloud size={16} aria-hidden /> Play in the cloud</span>}
      meta="Not installed, ready to stream"
      games={games}
      caption={(g) => {
        const p = byGame.get(g.id);
        const badge = preferredBadge(map[g.id]);
        if (!p || !badge) return null;
        return (
          <PickCaption
            pick={p}
            extra={(
              <button type="button" className="pick-cap__act" aria-label={`Stream ${g.title} with ${SERVICE_SHORT[badge.service]}`}
                title={`Stream with ${SERVICE_SHORT[badge.service]}`} onClick={() => void launchCloud(g.id, badge.service)}>
                <Cloud size={12} aria-hidden /> Stream
              </button>
            )}
          />
        );
      }}
    />
  );
}
