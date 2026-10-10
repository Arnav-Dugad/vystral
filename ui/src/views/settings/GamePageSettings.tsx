import { type ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { useStore } from '../../state/store';
import { Toggle } from '../../components/ui/primitives';

/**
 * Track C4: Settings → Library & stores → Steam reviews and tags. Both use public Steam store data without a key,
 * only while "Fetch game details" is on, cached on this PC; neither is fetched in Offline mode or while a game runs.
 */
export function GamePageSettings() {
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  if (!settings) return null;
  const localOnly = settings['privacy.localOnly'];
  const details = settings['library.fetchMetadata'];
  const needs = !details ? ' Turn on “Fetch game details” above first.' : '';
  return (
    <section className="sgroup" aria-labelledby="gamepage-title">
      <h2 className="sgroup__title" id="gamepage-title">Steam reviews and tags</h2>
      <p className="sgroup__desc">What Steam players think of a game and what they call it, on game pages and in Library filters.</p>
      <div className="sgroup__rows surface">
        <Row
          id="gamepage-reviews" label="Review snapshot"
          hint={<>On Steam game pages, the share of positive reviews of all time and in the last 30 days, with which way it’s heading. Asked from the Steam store when you open a page, at most once a day per game.{needs}</>}
          control={<Toggle id="gamepage-reviews" label="Review snapshot" checked={settings['dataSources.steamReviews']} disabled={localOnly || !details}
            onChange={(v) => void setSetting('dataSources.steamReviews', v)} />}
        />
        <Row
          id="gamepage-tags" label="Community tags"
          hint={<>The tags Steam players gave a game (“Roguelike”, “Co-op”…), on game pages and as Library filters. Looked up 50 games at a time and kept for a week. Turning this off forgets them.{needs}</>}
          control={<Toggle id="gamepage-tags" label="Community tags" checked={settings['dataSources.steamTags']} disabled={localOnly || !details}
            onChange={(v) => void setSetting('dataSources.steamTags', v)} />}
        />
        <div className="srow steamapi__privacy">
          <Lock size={16} aria-hidden />
          <div className="srow__hint">
            Only Steam app IDs are sent (to store.steampowered.com and api.steampowered.com), never your account. Nothing is sent while a game runs or in Offline mode.
          </div>
        </div>
      </div>
    </section>
  );
}

function Row({ label, hint, control, id }: { label: ReactNode; hint?: ReactNode; control: ReactNode; id?: string }) {
  return (
    <div className="srow">
      <div className="srow__text">
        <label className="srow__label" htmlFor={id}>{label}</label>
        {hint && <div className="srow__hint">{hint}</div>}
      </div>
      <div className="srow__control">{control}</div>
    </div>
  );
}
