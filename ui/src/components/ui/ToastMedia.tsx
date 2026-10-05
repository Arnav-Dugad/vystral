import { Trophy } from 'lucide-react';
import type { Toast } from '../../state/store';
import './toast-media.css';
import './shimmer.css';

/**
 * A row of small images under a toast or notification (for example the achievements just unlocked).
 * With `shimmer`, each icon gets its own rarity-tinted sweep, one after another.
 */
export function ToastMedia({ media, shimmer = true }: { media: NonNullable<Toast['media']>; shimmer?: boolean }) {
  return (
    <ul className="toast-media" aria-label={media.map((m) => m.label).join(', ')}>
      {media.map((m, i) => (
        <li
          key={`${m.label}-${i}`}
          className={`toast-media__item${shimmer ? ' shimmer shimmer-ring' : ''}`}
          data-rare={m.rare ?? undefined}
          data-tier={shimmer ? (m.rare ?? 'common') : undefined}
          style={shimmer ? { ['--shimmer-delay' as string]: `${0.45 + i * 0.12}s` } : undefined}
          title={m.label}
        >
          {m.src ? <img src={m.src} alt="" draggable={false} /> : <Trophy size={14} aria-hidden />}
        </li>
      ))}
    </ul>
  );
}
