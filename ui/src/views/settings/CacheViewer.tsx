import { useCallback, useEffect, useState } from 'react';
import {
  Bot, Clapperboard, Coins, Compass, FileSearch, FolderClock, Gift, HardDrive, Heart, Image, Images, Newspaper, ShieldCheck, Tags, Trash2, Users, Zap,
  type LucideIcon,
} from 'lucide-react';
import { call, errorMessage, on } from '../../bridge/bridge';
import type { CacheClearResult, CacheInfo } from '../../bridge/types';
import { cacheAgeLine, cacheCopy, cacheSizeLine, totalBytes } from '../../lib/caches';
import { formatBytes } from '../../lib/format';
import { useGameRunning, useStore } from '../../state/store';
import { Skeleton } from '../../components/ui/primitives';
import { HoldToConfirm } from '../../components/controller/HoldToConfirm';
import './cache-viewer.css';

const ICONS: Record<string, LucideIcon> = {
  art: Image, thumbs: Images, trailers: Clapperboard, news: Newspaper, prices: Coins, ai: Bot, discover: Compass, tags: Tags, friends: Users,
  wishlist: Heart, catalogs: Gift, gamePages: FileSearch, lookups: FolderClock, fx: Coins, firstPaint: Zap,
};

/**
 * Track D6: Settings › Data & recovery › Caches. Everything VYSTRAL downloaded and keeps so it works offline and opens
 * fast, with its size on disk, how many items and how old. Each can be cleared with a hold (it's downloaded again when
 * needed); the page names a cache only by id, and the backend deletes only inside its known cache folders.
 */
export function CacheViewer() {
  const [list, setList] = useState<CacheInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useStore((s) => s.toast);
  const running = useGameRunning();

  const load = useCallback(() => call<CacheInfo[]>('caches.list', undefined, 30_000).then((l) => { setList(l); setError(null); }).catch((e) => setError(errorMessage(e))), []);
  useEffect(() => {
    void load();
    return on('caches.cleared', () => void load());
  }, [load]);

  const clear = async (c: CacheInfo) => {
    setBusy(c.id);
    try {
      const r = await call<CacheClearResult>('caches.clear', { id: c.id }, 120_000);
      const copy = cacheCopy(c.id);
      toast({
        tone: r.failed > 0 ? 'warning' : 'success',
        title: r.freedBytes > 0 ? `${copy.name} cleared · ${formatBytes(r.freedBytes)} freed` : `${copy.name} cleared`,
        body: r.failed > 0 ? `${r.failed} file${r.failed === 1 ? ' was' : 's were'} in use and stayed. ${copy.after}` : copy.after,
      });
      await load();
    } catch (err) {
      toast({ tone: 'danger', title: 'That cache wasn’t cleared', body: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const total = list ? totalBytes(list) : 0;
  return (
    <section className="sgroup cachev" aria-labelledby="cachev-title" data-testid="cache-viewer">
      <h2 className="sgroup__title" id="cachev-title">Caches</h2>
      <p className="sgroup__desc">
        What VYSTRAL downloaded so it opens fast and works offline. Clearing one only frees space: it’s downloaded again when it’s needed.
      </p>
      <div className="sgroup__rows surface">
        <div className="cachev__total">
          <HardDrive size={18} aria-hidden />
          <div>
            <div className="srow__label">{list ? `${formatBytes(total)} in ${list.filter((c) => c.items > 0).length} caches` : 'Measuring…'}</div>
            <div className="srow__hint cachev__promise"><ShieldCheck size={12} aria-hidden /> Your library, notes, play history, settings and keys are never touched.</div>
          </div>
        </div>
        {error && !list && <div className="srow"><span className="srow__hint">{error}</span></div>}
        {!list && !error && Array.from({ length: 4 }, (_, i) => <div key={i} className="srow"><Skeleton height={36} /></div>)}
        {list?.map((c) => {
          const copy = cacheCopy(c.id);
          const Icon = ICONS[c.id] ?? HardDrive;
          const empty = c.items <= 0 && c.bytes <= 0;
          const age = cacheAgeLine(c);
          const share = total > 0 ? Math.max(0.01, c.bytes / total) : 0;
          return (
            <div key={c.id} className="srow cachev-row" data-empty={empty || undefined} data-row={`cache-${c.id}`} data-testid={`cache-${c.id}`}>
              <span className="cachev-row__icon" aria-hidden><Icon size={17} /></span>
              <div className="srow__text">
                <div className="srow__label">{copy.name}</div>
                <div className="srow__hint">{copy.what}</div>
                <div className="cachev-row__stats">
                  <span className="num">{cacheSizeLine(c, copy.rows)}</span>
                  {age && <span>{age}</span>}
                </div>
                {!empty && <span className="cachev-row__bar" aria-hidden><span style={{ transform: `scaleX(${share})` }} /></span>}
              </div>
              <div className="srow__control">
                <HoldToConfirm size="sm" variant="secondary" icon={<Trash2 size={13} />} onConfirm={() => void clear(c)}
                  disabled={empty || running || (busy != null && busy !== c.id)} loading={busy === c.id}
                  aria-label={`Clear ${copy.name}: hold to confirm. ${copy.after}`} title={running ? 'Not while a game is running' : copy.after}>
                  Clear
                </HoldToConfirm>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
