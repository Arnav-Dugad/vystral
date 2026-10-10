import { useId, useState } from 'react';
import { ChevronDown, ExternalLink, ShieldAlert } from 'lucide-react';
import { call } from '../../bridge/bridge';
import { useStore } from '../../state/store';
import { Toggle } from '../../components/ui/primitives';

/**
 * Track D4: two rows in Settings › Data sources — matching games across stores (on by default; it only uses sources that
 * are on) and "Allow YouTube trailers" (off by default), with exactly what turning it on means for privacy.
 */
export function TrackD4Rows() {
  const match = useStore((s) => s.settings?.['dataSources.identityMatch'] ?? true);
  const youtube = useStore((s) => s.settings?.['trailers.youtube'] ?? false);
  const setSetting = useStore((s) => s.setSetting);
  const [why, setWhy] = useState(false);
  const whyId = useId();

  return (
    <>
      <div className="srow" id="dsrc-identity">
        <div className="srow__text">
          <label className="srow__label" htmlFor="dsrc-identity-toggle">Match games across stores</label>
          <div className="srow__hint">
            Finds each Xbox, Epic, GOG, EA, Ubisoft, Battle.net or manual game’s Steam page (and its IGDB, RAWG, GOG and Wikidata entries) by exact title
            and year, so Steam reviews, tags, trailers, prices and news can show for it — always labelled as Steam data. Only confident matches are used;
            you can confirm or fix any match on the game’s Versions tab. Uses only the sources turned on here.
          </div>
        </div>
        <div className="srow__control"><Toggle id="dsrc-identity-toggle" label="Match games across stores" checked={match} onChange={(v) => void setSetting('dataSources.identityMatch', v)} /></div>
      </div>
      <div className="srow" id="dsrc-youtube">
        <div className="srow__text">
          <label className="srow__label" htmlFor="dsrc-youtube-toggle">Allow YouTube trailers</label>
          <div className="srow__hint">
            When a game has no trailer VYSTRAL can play itself, show the one IGDB or GOG lists on YouTube.{' '}
            <button type="button" className="dsrc__why" aria-expanded={why} aria-controls={whyId} onClick={() => setWhy((w) => !w)}>
              What this means <ChevronDown size={12} aria-hidden style={{ transform: why ? 'rotate(180deg)' : undefined }} />
            </button>
          </div>
          <div id={whyId} className="srow__hint dsrc__whytext" hidden={!why}>
            <ShieldAlert size={13} aria-hidden /> The trailer plays from YouTube’s privacy-enhanced site (youtube-nocookie.com), so Google sees your IP address
            and which video you watched, and may store data in VYSTRAL’s own browser storage once it plays. It runs in a locked-down frame that can’t open
            pages, windows or downloads, starts muted, never in Offline mode, with Data saver on or while you play.{' '}
            <button type="button" className="dsrc__why" onClick={() => void call('dataSources.openLink', { provider: 'youtube', link: 'privacy' })}>
              YouTube’s privacy-enhanced mode <ExternalLink size={11} aria-hidden />
            </button>
          </div>
        </div>
        <div className="srow__control"><Toggle id="dsrc-youtube-toggle" label="Allow YouTube trailers" checked={youtube} onChange={(v) => void setSetting('trailers.youtube', v)} /></div>
      </div>
    </>
  );
}
