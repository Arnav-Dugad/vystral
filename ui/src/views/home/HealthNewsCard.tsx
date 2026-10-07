import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertOctagon, AlertTriangle, ArrowRight, HardDrive, Link2Off, Wrench, X } from 'lucide-react';
import { call, errorMessage, on } from '../../bridge/bridge';
import type { HealthIssue, HealthNews, HealthReport } from '../../bridge/types';
import { newsCopy, oneTapFix } from '../../lib/libraryTools';
import { requestGameTab } from '../../lib/gameTab';
import { spring } from '../../lib/motion';
import { useReducedMotion, useStore } from '../../state/store';
import { Button, IconButton } from '../../components/ui/primitives';
import { GameCover } from '../../components/game/GameCover';
import './health-news.css';

const NATIVE = ['rescan', 'refetchArt', 'lookupMetadata', 'closeSession'];

/**
 * Track X: a small Home card when the background health check notices something new — a drive that was unplugged,
 * a shortcut that stopped working — with the top issue's one-tap safe fix and "See all". Each issue is shown once:
 * dismissing, fixing or opening the Health page acknowledges it, and it never comes back here.
 */
export function HealthNewsCard() {
  const [news, setNews] = useState<HealthNews | null>(null);
  const [busy, setBusy] = useState(false);
  const gamesById = useStore((s) => s.gamesById);
  const navigate = useStore((s) => s.navigate);
  const toast = useStore((s) => s.toast);
  const reduce = useReducedMotion();

  useEffect(() => {
    let live = true;
    call<HealthNews>('health.news').then((n) => live && setNews(n)).catch(() => {});
    const off = on('health.news', (n) => setNews(n));
    return () => { live = false; off(); };
  }, []);

  const top = news?.issues[0];
  const copy = useMemo(() => (news ? newsCopy(news) : null), [news]);
  const fix = top ? oneTapFix(top) : null;
  const covers = useMemo(() => (top ? top.gameIds.map((id) => gamesById.get(id)).filter((g) => !!g).slice(0, 4) : []), [top, gamesById]);

  const seen = async (ids: string[] | null) => {
    try {
      setNews(await call<HealthNews>('health.newsSeen', ids ? { issueIds: ids } : { all: true }));
    } catch {
      setNews((n) => (n ? { ...n, issues: ids ? n.issues.filter((i) => !ids.includes(i.id)) : [] } : n));
    }
  };

  const runFix = async (issue: HealthIssue) => {
    if (!fix) return;
    const game = issue.gameId ? gamesById.get(issue.gameId) : undefined;
    setBusy(true);
    try {
      if (fix.action === 'openVersions' || fix.action === 'openGame') {
        if (!issue.gameId) return;
        if (fix.action === 'openVersions') requestGameTab(issue.gameId, 'versions');
        await seen([issue.id]);
        navigate({ name: 'game', id: issue.gameId });
        return;
      }
      if (fix.action === 'locate') {
        if (!issue.installationId) return;
        const next = await call<HealthReport | null>('health.locateExecutable', { installationId: issue.installationId }, 600_000);
        if (!next) return; // cancelled
        toast({ tone: 'success', title: 'Found it', body: `${game?.title ?? 'The game'} starts from its new place now. Playtime and notes stayed.` });
      } else if (fix.action === 'enableStore') {
        if (!issue.platform) return;
        useStore.setState({ adapters: await call('library.setPlatformEnabled', { platform: issue.platform, enabled: true }) });
        toast({ tone: 'success', title: 'Scanning turned back on', body: 'Rescan to bring its games up to date.' });
      } else if (NATIVE.includes(fix.action)) {
        const next = await call<HealthReport>('health.fix', { issueId: issue.id, action: fix.action }, 180_000);
        const still = next.issues.some((i) => i.id === issue.id);
        toast(still ? { tone: 'info', title: 'Still there', body: 'That didn’t change it. See all for other ways to fix it.' } : { tone: 'success', title: 'Fixed', body: issue.title });
      }
      await seen([issue.id]);
      void useStore.getState().refreshLibrary();
    } catch (err) {
      toast({ tone: 'danger', title: 'That didn’t work', body: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const Icon = top?.kind === 'missingDrive' ? HardDrive : top?.kind === 'brokenShortcut' ? Link2Off : top?.severity === 'problem' ? AlertOctagon : AlertTriangle;
  const total = news?.issues.length ?? 0;

  return (
    <AnimatePresence>
      {top && copy && (
        <motion.section
          key="healthnews"
          className="hnews surface"
          data-severity={top.severity}
          aria-labelledby="hnews-title"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, transition: { duration: 0.2 } }}
          transition={reduce ? { duration: 0.15 } : spring.panel}
        >
          <div className="hnews__glow" aria-hidden />
          <span className="hnews__tile" aria-hidden>
            <Icon size={20} />
            {!reduce && <span className="hnews__pulse" />}
          </span>
          <div className="hnews__main">
            <p className="hnews__eyebrow caps">{copy.eyebrow}</p>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={top.id}
                className="hnews__text"
                initial={reduce ? { opacity: 0 } : { opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.12 } }}
                transition={reduce ? { duration: 0.15 } : spring.panel}
              >
                <h2 id="hnews-title" className="hnews__title">{copy.title}</h2>
                <p className="hnews__body">{copy.body}</p>
              </motion.div>
            </AnimatePresence>
            <div className="hnews__actions">
              {fix && (
                <Button variant="primary" size="sm" icon={<Wrench size={14} />} loading={busy} onClick={() => void runFix(top)} title={fix.safe ? 'Safe: never deletes anything' : undefined}>
                  {fix.label}
                </Button>
              )}
              <Button
                size="sm"
                variant={fix ? 'ghost' : 'secondary'}
                icon={<ArrowRight size={14} />}
                disabled={busy}
                onClick={() => { void seen(null); navigate({ name: 'health' }); }}
              >
                {total > 1 ? `See all ${total}` : 'See all'}
              </Button>
              {copy.more && <span className="hnews__more">{copy.more}</span>}
            </div>
          </div>
          {covers.length > 0 && (
            <div className="hnews__covers" aria-hidden data-count={covers.length}>
              {covers.map((g, i) => (
                <span key={g!.id} className="hnews__cover" style={{ ['--i' as string]: i }}><GameCover game={g!} /></span>
              ))}
            </div>
          )}
          {/* Dismissing hides everything new at once (still listed on the Health page), so the card never re-appears with the next one. */}
          <IconButton label="Dismiss" size="sm" className="hnews__close" disabled={busy} onClick={() => void seen(null)}>
            <X size={15} />
          </IconButton>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
