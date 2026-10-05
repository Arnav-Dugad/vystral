import { Trophy } from 'lucide-react';
import type { Toast } from '../../state/store';
import './toast-media.css';

/** A row of small images under a toast or notification (for example the achievements just unlocked). */
export function ToastMedia({ media }: { media: NonNullable<Toast['media']> }) {
  return (
    <ul className="toast-media" aria-label={media.map((m) => m.label).join(', ')}>
      {media.map((m, i) => (
        <li key={`${m.label}-${i}`} className="toast-media__item" data-rare={m.rare ?? undefined} title={m.label}>
          {m.src ? <img src={m.src} alt="" draggable={false} /> : <Trophy size={14} aria-hidden />}
        </li>
      ))}
    </ul>
  );
}
