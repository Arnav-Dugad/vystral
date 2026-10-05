import { Moon, Radar } from 'lucide-react';
import { sessionOrigin } from '../../lib/sessions';
import './origin.css';

/**
 * Track H: a small, quiet note on sessions VYSTRAL didn't launch — "Background" (recorded by the background
 * tracker while VYSTRAL was closed) or "Detected" (started elsewhere, noticed while open). Renders nothing
 * for sessions started from VYSTRAL.
 */
export function SessionOriginChip({ source, compact }: { source: string | null | undefined; compact?: boolean }) {
  const origin = sessionOrigin(source);
  if (!origin) return null;
  const Icon = source === 'background' ? Moon : Radar;
  return (
    <span className="origin-chip" data-source={source} data-compact={compact || undefined} title={origin.title}>
      <Icon size={11} aria-hidden />
      <span className={compact ? 'visually-hidden' : undefined}>{origin.label}</span>
      <span className="visually-hidden">: {origin.title}</span>
    </span>
  );
}
