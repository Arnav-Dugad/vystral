import { ThumbsDown } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Recommendation } from '../../lib/recommendV2';
import { useDismiss } from '../../state/recommend';
import './recommend.css';

/**
 * Track D5: the line under a recommended card — why it was picked, in plain words — and "Not interested", which
 * removes it, remembers it on this PC and teaches the suggestions (undo from the toast).
 */
export function PickCaption({ pick, extra }: { pick: Pick<Recommendation, 'reason' | 'reasons' | 'dismissKey' | 'title' | 'features'>; extra?: ReactNode }) {
  const dismiss = useDismiss();
  const more = pick.reasons.length > 1 ? pick.reasons.slice(0, 4).map((r) => r.text).join('\n') : undefined;
  return (
    <div className="pick-cap">
      <p className="pick-cap__why" title={more}>{pick.reason}</p>
      <div className="pick-cap__tools">
        {extra}
        <button type="button" className="pick-cap__no" aria-label={`Not interested in ${pick.title}`} title="Not interested" onClick={() => dismiss(pick)}>
          <ThumbsDown size={13} aria-hidden />
        </button>
      </div>
    </div>
  );
}
