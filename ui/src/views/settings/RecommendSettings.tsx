import { RotateCcw, Trash2 } from 'lucide-react';
import { formatRelative } from '../../lib/format';
import { clearDismissed, undismiss, useDismissedList } from '../../state/recommend';
import { useCloudEnabled } from '../../state/cloud';
import { useStore } from '../../state/store';
import { Button, Toggle } from '../../components/ui/primitives';
import { CloudInsightsCard, CloudReadinessCard } from '../../components/cloud/CloudPlus';
import '../../components/recommend/recommend.css';

/**
 * Track D5: Settings → Library & stores → Suggestions: "Free this week" (opt-in, and its Home row) and what you said
 * "Not interested" to (each can be brought back; the list lives only on this PC).
 */
export function RecommendSettings() {
  const enabled = useStore((s) => !!s.settings?.['freebies.enabled']);
  const homeRow = useStore((s) => !!s.settings?.['freebies.homeRow']);
  const setSetting = useStore((s) => s.setSetting);
  const dismissed = useDismissedList();
  return (
    <section className="sgroup" aria-labelledby="recset-title" id="settings-suggestions">
      <h2 className="sgroup__title" id="recset-title">Suggestions</h2>
      <p className="sgroup__desc">
        “Picked for you” and “Recommended for you” are worked out on this PC from what you play: hours, how recently, your ratings and statuses, tags,
        time to beat and the time you usually have. No AI and nothing is sent anywhere.
      </p>
      <div className="sgroup__rows surface">
        <div className="srow" id="freebies-row">
          <div className="srow__text">
            <label className="srow__label" htmlFor="freebies-enabled">Free this week</label>
            <div className="srow__hint">Shows games you can keep for free on Epic, Steam, GOG, Prime Gaming and more in Discover, from GamerPower’s public giveaway list. Checked a few times a day while this is on; nothing about you is sent. Claiming always happens on the store’s own page in your browser.</div>
          </div>
          <div className="srow__control"><Toggle id="freebies-enabled" label="Free this week" checked={enabled} onChange={(v) => void setSetting('freebies.enabled', v)} /></div>
        </div>
        <div className="srow" aria-disabled={!enabled || undefined}>
          <div className="srow__text">
            <label className="srow__label" htmlFor="freebies-home">Also show it on Home</label>
            <div className="srow__hint">A “Free this week” row on Home, below your picks.</div>
          </div>
          <div className="srow__control"><Toggle id="freebies-home" label="Also show Free this week on Home" checked={homeRow} disabled={!enabled} onChange={(v) => void setSetting('freebies.homeRow', v)} /></div>
        </div>
        <div className="srow srow--stack">
          <div className="srow__text">
            <div className="srow__label">Not interested</div>
            <div className="srow__hint">
              {dismissed.length
                ? 'Games you dismissed stay out of suggestions, and similar ones show up less. Bring any of them back here.'
                : 'Press the thumbs-down under a suggestion to hide it. Suggestions learn from it, on this PC only.'}
            </div>
          </div>
          {dismissed.length > 0 && (
            <>
              <ul className="notint" aria-label="Not interested">
                {dismissed.slice(0, 50).map((d) => (
                  <li key={d.key} className="notint__row">
                    <span className="notint__title">{d.title}</span>
                    <span className="notint__when">{formatRelative(d.at)}</span>
                    <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} aria-label={`Bring back ${d.title}`} onClick={() => void undismiss(d.key)}>Bring back</Button>
                  </li>
                ))}
              </ul>
              <div><Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => void clearDismissed()}>Clear the list</Button></div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** Track D5: Settings → Cloud play: the readiness check and your cloud sessions. */
export function CloudPlusSettings() {
  const enabled = useCloudEnabled();
  if (!enabled) return null;
  return (
    <section className="sgroup" aria-labelledby="cloudplus-title" id="settings-cloud-readiness">
      <h2 className="sgroup__title" id="cloudplus-title">Connection and sessions</h2>
      <p className="sgroup__desc">Check whether your connection suits streaming right now, and see how you play in the cloud.</p>
      <div className="cloudplus-grid">
        <CloudReadinessCard />
        <CloudInsightsCard />
      </div>
    </section>
  );
}
