import { useState } from 'react';
import { Hash } from 'lucide-react';
import type { GameTags } from '../../../bridge/types';
import { formatRelative } from '../../../lib/format';
import { requestLibraryTags } from '../../../lib/libraryTags';
import { useStore } from '../../../state/store';
import { StoreLogo } from '../../ui/StoreLogo';
import { useBridgeData } from './useBridgeData';
import './insights.css';

const SHOWN = 12;

/**
 * Track C4: what Steam players tagged this game, strongest first, each with a quiet bar for how strongly it was
 * applied (Steam's relative weight, not a vote count). A tag opens the Library filtered to games you own with it.
 */
export function CommunityTags({ params, cacheKey }: { params: { gameId: string } | { key: string; appId: string }; cacheKey: string }) {
  const settings = useStore((s) => `${s.settings?.['dataSources.steamTags']}${s.settings?.['library.fetchMetadata']}${s.settings?.['privacy.localOnly']}`);
  const { data } = useBridgeData<GameTags>('tags.get', params, `${cacheKey}|${settings}`);
  const navigate = useStore((s) => s.navigate);
  const [all, setAll] = useState(false);
  if (!data || !data.tags.length) return null;
  const max = Math.max(...data.tags.map((t) => t.weight), 1);
  const shown = all ? data.tags : data.tags.slice(0, SHOWN);
  return (
    <section className="gi-tags" aria-labelledby={`gi-tags-${cacheKey}`} data-testid="community-tags">
      <h2 className="gi-tags__title" id={`gi-tags-${cacheKey}`}><Hash size={14} aria-hidden /> What players call it</h2>
      <ul className="gi-tags__list">
        {shown.map((t) => (
          <li key={t.id}>
            <button className="gi-tag" title={`Show games in your library tagged ${t.name}`}
              onClick={() => { requestLibraryTags([t.id]); navigate({ name: 'library' }); }}
              aria-label={`${t.name}. Show games in your library with this tag.`}>
              <span>{t.name}</span>
              <span className="gi-tag__w" aria-hidden><span style={{ transform: `scaleX(${Math.max(0.12, t.weight / max)})` }} /></span>
            </button>
          </li>
        ))}
        {data.tags.length > SHOWN && (
          <li><button className="gi-link" aria-expanded={all} onClick={() => setAll((a) => !a)}>{all ? 'Fewer' : `All ${data.tags.length}`}</button></li>
        )}
      </ul>
      <p className="gi-tile__src">
        <StoreLogo platform="steam" size={12} decorative /> Community tags applied by Steam players, strongest first{data.fetchedAt ? ` · checked ${formatRelative(data.fetchedAt).toLowerCase()}` : ''}{data.stale ? ' · couldn’t refresh' : ''}
      </p>
    </section>
  );
}
