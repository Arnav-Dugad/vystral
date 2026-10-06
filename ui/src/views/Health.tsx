import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertOctagon, AlertTriangle, ArrowLeft, ChevronDown, Eye, HeartPulse, Info, RefreshCw, ShieldCheck, Sparkles, Wrench, X,
} from 'lucide-react';
import { call, errorMessage, on } from '../bridge/bridge';
import type { Game, HealthFix, HealthFixAllResult, HealthIssue, HealthProgress, HealthReport, HealthSeverity, PickerKind, PlatformKey } from '../bridge/types';
import { checkedLabel, headline, safeIssues, sections, SEVERITY_LABEL, tier, TIER_LABEL, type IssueSection } from '../lib/health';
import { exit, pick, spring } from '../lib/motion';
import { requestGameTab } from '../lib/gameTab';
import { useReducedMotion, useStore } from '../state/store';
import { Button, EmptyState, IconButton, ProgressBar, Skeleton } from '../components/ui/primitives';
import { StoreLogos } from '../components/ui/StoreLogo';
import { GameCover } from '../components/game/GameCover';
import { ArtPickerDialog } from '../components/game/ArtPicker';
import { ScoreRing } from './health/ScoreRing';
import './health/health.css';

const PAGE = 30;
const SEVERITY_ICON: Record<HealthSeverity, typeof AlertOctagon> = { problem: AlertOctagon, warning: AlertTriangle, info: Info };

/**
 * Track Q: the library health check. One page listing everything wrong with the library, grouped, each with a
 * safe fix beside it. The check runs natively off the UI thread with no network; nothing here deletes user data.
 */
export function HealthView() {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<HealthProgress | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [picker, setPicker] = useState<{ game: Game; kind: PickerKind } | null>(null);
  const toast = useStore((s) => s.toast);
  const navigate = useStore((s) => s.navigate);
  const goBack = useStore((s) => s.goBack);
  const canGoBack = useStore((s) => s.back.length > 0);
  const gamesById = useStore((s) => s.gamesById);
  const reduce = useReducedMotion();

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setReport(await call<HealthReport>('health.check', undefined, 120_000));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);
  useEffect(() => on('health.progress', (p) => setProgress(p)), []);

  const refreshAll = async (next?: HealthReport) => {
    if (next) setReport(next);
    else await check();
    void useStore.getState().refreshLibrary();
  };

  const dismiss = async (issue: HealthIssue) => {
    try {
      const next = await call<HealthReport>('health.dismiss', { issueId: issue.id });
      setReport(next);
      toast({
        tone: 'info', title: 'Dismissed', body: `“${issue.title}” won’t be listed again.`,
        action: { label: 'Undo', run: () => void call<HealthReport>('health.restore', { issueId: issue.id }).then(setReport).catch(() => {}) },
      });
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t dismiss that', body: errorMessage(err) });
    }
  };

  const runFix = async (issue: HealthIssue, fix: HealthFix) => {
    const game = issue.gameId ? gamesById.get(issue.gameId) : undefined;
    const mark = (on: boolean) => setBusy((b) => {
      const n = { ...b };
      if (on) n[issue.id] = fix.action;
      else delete n[issue.id];
      return n;
    });
    try {
      switch (fix.action) {
        case 'locate': {
          if (!issue.installationId) return;
          mark(true);
          const next = await call<HealthReport | null>('health.locateExecutable', { installationId: issue.installationId }, 600_000);
          if (next) {
            await refreshAll(next);
            toast({ tone: 'success', title: 'Found it', body: `${game?.title ?? 'The game'} starts from its new place now. Playtime and notes stayed.` });
          }
          return;
        }
        case 'rescan': case 'refetchArt': case 'lookupMetadata': case 'closeSession': {
          mark(true);
          const next = await call<HealthReport>('health.fix', { issueId: issue.id, action: fix.action }, 180_000);
          await refreshAll(next);
          const still = next.issues.some((i) => i.id === issue.id);
          toast(still
            ? { tone: 'info', title: 'Still there', body: fix.action === 'rescan' ? 'The rescan finished, but this one is unchanged.' : 'That didn’t change this one.' }
            : { tone: 'success', title: FIX_DONE[fix.action] ?? 'Fixed' });
          return;
        }
        case 'pickArt':
          if (game && issue.artKind && issue.artKind !== 'header') setPicker({ game, kind: issue.artKind });
          return;
        case 'hide': {
          if (!issue.gameId) return;
          mark(true);
          await call('game.setHidden', { gameId: issue.gameId, value: true });
          await refreshAll();
          toast({
            tone: 'success', title: `${game?.title ?? 'Game'} hidden`, body: 'Find it any time under Library › Hidden. Nothing was deleted.',
            action: { label: 'Undo', run: () => void call('game.setHidden', { gameId: issue.gameId, value: false }).then(() => refreshAll()).catch(() => {}) },
          });
          return;
        }
        case 'merge':
          if (!issue.gameId || !issue.otherGameId) return;
          mark(true);
          await call('game.merge', { targetGameId: issue.gameId, sourceGameId: issue.otherGameId });
          await refreshAll();
          toast({ tone: 'success', title: 'Merged into one entry', body: 'Both versions keep their own install details. You can separate them again from the game’s Versions tab.' });
          return;
        case 'keepSeparate':
          if (!issue.gameId || !issue.otherGameId) return;
          mark(true);
          await call('game.dismissDuplicate', { gameIdA: issue.gameId, gameIdB: issue.otherGameId });
          await refreshAll();
          toast({ tone: 'info', title: 'Kept separate', body: 'VYSTRAL won’t suggest these two again.' });
          return;
        case 'enableStore':
          if (!issue.platform) return;
          mark(true);
          useStore.setState({ adapters: await call('library.setPlatformEnabled', { platform: issue.platform, enabled: true }) });
          await refreshAll();
          toast({ tone: 'success', title: 'Scanning turned back on', body: 'Rescan to bring its games up to date.', action: { label: 'Rescan', run: () => void useStore.getState().scanLibrary() } });
          return;
        case 'openGame': case 'openVersions':
          if (!issue.gameId) return;
          if (fix.action === 'openVersions') requestGameTab(issue.gameId, 'versions');
          navigate({ name: 'game', id: issue.gameId });
          return;
        case 'openSession':
          if (issue.sessionId) navigate({ name: 'performance', sessionId: issue.sessionId });
          return;
        case 'openSettings':
          navigate({ name: 'settings', section: 'library' });
          return;
      }
    } catch (err) {
      toast({ tone: 'danger', title: 'That didn’t work', body: errorMessage(err) });
    } finally {
      mark(false);
    }
  };

  const fixAll = async () => {
    setProgress({ done: 0, total: 1, label: 'Starting…' });
    try {
      const r = await call<HealthFixAllResult>('health.fixAll', undefined, 900_000);
      await refreshAll(r.report);
      toast({
        tone: r.fixed ? 'success' : 'info',
        title: r.fixed ? `Fixed ${r.fixed.toLocaleString()} ${r.fixed === 1 ? 'issue' : 'issues'}` : 'Nothing could be fixed automatically',
        body: [r.skipped ? `${r.skipped.toLocaleString()} need a hand from you.` : '', ...r.notes].filter(Boolean).join(' ') || undefined,
      });
    } catch (err) {
      toast({ tone: 'danger', title: 'Fixing stopped', body: errorMessage(err) });
    } finally {
      setProgress(null);
    }
  };

  const grouped = useMemo(() => (report ? sections(report.issues) : []), [report]);
  const safe = report ? safeIssues(report.issues).length : 0;
  const fixing = progress !== null;

  return (
    <div className="page health" aria-busy={checking && !report}>
      <div className="health__top">
        {canGoBack && <Button size="sm" variant="ghost" icon={<ArrowLeft size={14} />} onClick={goBack}>Back</Button>}
      </div>
      <header className="health-hero surface" data-tier={report ? tier(report.score) : undefined}>
        <ScoreRing score={report?.score ?? null} busy={checking || fixing} />
        <div className="health-hero__text">
          <p className="caps health-hero__eyebrow"><HeartPulse size={13} aria-hidden /> Library health</p>
          <h1 className="health-hero__title">{report ? (report.issues.length ? TIER_LABEL[tier(report.score)] : 'Everything’s healthy') : 'Checking your library…'}</h1>
          <p className="health-hero__line" aria-live="polite">{report ? headline(report) : 'Looking for broken shortcuts, missing drives, duplicates and art problems. Nothing leaves this PC.'}</p>
          {report && <p className="health-hero__meta">{checkedLabel(report)}{report.scanning ? ' · a scan is running' : ''}</p>}
          <div className="health-hero__actions">
            {safe > 0 && (
              <Button variant="primary" icon={<Wrench size={15} />} onClick={() => void fixAll()} loading={fixing} disabled={checking}>
                Fix {safe.toLocaleString()} safe {safe === 1 ? 'issue' : 'issues'}
              </Button>
            )}
            <Button variant={safe > 0 ? 'ghost' : 'secondary'} icon={<RefreshCw size={15} />} onClick={() => void check()} loading={checking && !!report} disabled={fixing}>
              Check again
            </Button>
            {!!report?.dismissedCount && (
              <Button variant="ghost" icon={<Eye size={15} />} disabled={fixing}
                onClick={() => void call<HealthReport>('health.restoreAll').then(setReport).catch((err) => toast({ tone: 'danger', title: 'Couldn’t restore', body: errorMessage(err) }))}>
                Show {report.dismissedCount.toLocaleString()} dismissed
              </Button>
            )}
          </div>
          {safe > 0 && !fixing && (
            <p className="health-hero__hint">Safe fixes only rescan your stores, fetch art again and look details up again. They never delete anything.</p>
          )}
          <AnimatePresence>
            {progress && (
              <motion.div className="health-progress" initial={{ opacity: 0, y: reduce ? 0 : 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: exit }} transition={pick(reduce, spring.panel)}>
                <ProgressBar value={progress.total ? (progress.done / progress.total) * 100 : 0} label="Fixing safe issues" />
                <span className="health-progress__label" role="status">{progress.label} <span className="num">{progress.done}/{progress.total}</span></span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </header>

      {!report && !error && (
        <div className="health-skeleton" aria-hidden>
          {[0, 1, 2].map((i) => <Skeleton key={i} height={84} radius={16} />)}
        </div>
      )}
      {error && !report && (
        <EmptyState art="none" icon={<AlertTriangle size={32} />} title="The check couldn’t run" body={error} actions={<Button onClick={() => void check()}>Try again</Button>} />
      )}
      {report && report.issues.length === 0 && <HealthyState report={report} reduce={reduce} />}
      {report && grouped.map((section, i) => (
        <Section key={section.id} section={section} index={i} busy={busy} disabled={fixing} reduce={reduce} gamesById={gamesById} onFix={runFix} onDismiss={dismiss} />
      ))}

      {picker && (
        <ArtPickerDialog
          game={picker.game}
          kind={picker.kind}
          open
          onClose={() => {
            setPicker(null);
            void check();
          }}
        />
      )}
    </div>
  );
}

const FIX_DONE: Partial<Record<HealthFix['action'], string>> = {
  rescan: 'Rescanned — fixed',
  refetchArt: 'Got new art',
  lookupMetadata: 'Looking up details in the background',
  closeSession: 'Session closed — its time now counts',
};

function HealthyState({ report, reduce }: { report: HealthReport; reduce: boolean }) {
  const empty = report.gameCount === 0;
  return (
    <motion.section className="health-ok" initial={{ opacity: 0, scale: reduce ? 1 : 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={pick(reduce, spring.hero)} aria-labelledby="health-ok-title">
      <div className="health-ok__badge" aria-hidden>
        <ShieldCheck size={30} />
        {!reduce && [0, 1, 2, 3, 4, 5].map((i) => <span key={i} className="health-ok__spark" style={{ ['--i' as string]: i }} />)}
      </div>
      <h2 id="health-ok-title" className="health-ok__title">{empty ? 'Nothing to check yet' : 'Your library is in perfect health'}</h2>
      <p className="health-ok__body">
        {empty
          ? 'Once your stores are scanned (or you add a game), this page keeps an eye on shortcuts, drives, duplicates and art.'
          : 'Every shortcut starts, every drive is connected, no duplicates are waiting and the art looks sharp. VYSTRAL checks again whenever you open this page.'}
      </p>
      <ul className="health-ok__list">
        {['Shortcuts and install folders', 'Drives', 'Duplicates', 'Covers and backgrounds', 'Game details', 'Play sessions'].map((t) => (
          <li key={t}><Sparkles size={13} aria-hidden /> {t}</li>
        ))}
      </ul>
    </motion.section>
  );
}

function Section({ section, index, busy, disabled, reduce, gamesById, onFix, onDismiss }: {
  section: IssueSection; index: number; busy: Record<string, string>; disabled: boolean; reduce: boolean; gamesById: Map<string, Game>;
  onFix: (i: HealthIssue, f: HealthFix) => void; onDismiss: (i: HealthIssue) => void;
}) {
  const [open, setOpen] = useState(true);
  const [limit, setLimit] = useState(PAGE);
  const id = useId();
  const platforms = useMemo(() => [...new Set(section.issues.flatMap((i) => i.platforms))].slice(0, 6) as PlatformKey[], [section.issues]);
  const Icon = SEVERITY_ICON[section.worst];
  const shown = section.issues.slice(0, limit);
  return (
    <motion.section
      className="hsec surface"
      data-severity={section.worst}
      initial={{ opacity: 0, y: reduce ? 0 : 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0.15 } : { ...spring.panel, delay: Math.min(index, 6) * 0.05 }}
      aria-labelledby={`${id}-title`}
    >
      <h2 className="hsec__heading">
        <button className="hsec__head" aria-expanded={open} aria-controls={`${id}-body`} onClick={() => setOpen(!open)}>
          <span className="hsec__icon" aria-hidden><Icon size={17} /></span>
          <span className="hsec__titles">
            <span id={`${id}-title`} className="hsec__title">{section.title}</span>
            <span className="hsec__blurb">{section.blurb}</span>
          </span>
          {platforms.length > 0 && <span className="hsec__stores"><StoreLogos platforms={platforms} size={14} decorative /></span>}
          <span className="hsec__counts">
            {(['problem', 'warning', 'info'] as const).filter((s) => section.counts[s]).map((s) => (
              <span key={s} className="hsec__count" data-severity={s} title={SEVERITY_LABEL[s]}>
                <span className="num">{section.counts[s].toLocaleString()}</span>
                <span className="visually-hidden"> {SEVERITY_LABEL[s].toLowerCase()}</span>
              </span>
            ))}
          </span>
          <ChevronDown className="hsec__chev" size={18} aria-hidden />
        </button>
      </h2>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={`${id}-body`}
            className="hsec__body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduce ? { duration: 0.15 } : spring.panel}
          >
            <ul className="hsec__list">
              <AnimatePresence initial={false}>
                {shown.map((issue) => (
                  <IssueRow key={issue.id} issue={issue} busy={busy[issue.id]} disabled={disabled} reduce={reduce} gamesById={gamesById} onFix={onFix} onDismiss={onDismiss} />
                ))}
              </AnimatePresence>
            </ul>
            {section.issues.length > limit && (
              <div className="hsec__more">
                <Button size="sm" variant="ghost" onClick={() => setLimit(limit + PAGE)}>
                  Show {Math.min(PAGE, section.issues.length - limit).toLocaleString()} more of {(section.issues.length - limit).toLocaleString()}
                </Button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}

function IssueRow({ issue, busy, disabled, reduce, gamesById, onFix, onDismiss }: {
  issue: HealthIssue; busy?: string; disabled: boolean; reduce: boolean; gamesById: Map<string, Game>;
  onFix: (i: HealthIssue, f: HealthFix) => void; onDismiss: (i: HealthIssue) => void;
}) {
  const [showGames, setShowGames] = useState(false);
  const game = issue.gameId ? gamesById.get(issue.gameId) : undefined;
  const other = issue.otherGameId ? gamesById.get(issue.otherGameId) : undefined;
  const Icon = SEVERITY_ICON[issue.severity];
  const many = issue.gameIds.length > 1 && issue.kind !== 'duplicateSuggestion';
  const listId = useId();
  return (
    <motion.li
      layout={!reduce}
      className="hissue"
      data-severity={issue.severity}
      data-kind={issue.kind}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={reduce ? { opacity: 0, transition: { duration: 0.12 } } : { opacity: 0, x: 24, transition: exit }}
    >
      <span className="hissue__sev" aria-hidden><Icon size={15} /></span>
      <div className="hissue__art" aria-hidden>
        {game ? <span className="hissue__thumb"><GameCover game={game} /></span> : <span className="hissue__glyph"><HeartPulse size={18} /></span>}
        {other && <span className="hissue__thumb hissue__thumb--second"><GameCover game={other} /></span>}
      </div>
      <div className="hissue__text">
        <h3 className="hissue__title">
          <span className="visually-hidden">{SEVERITY_LABEL[issue.severity]}: </span>
          {issue.title}
        </h3>
        <p className="hissue__detail">{issue.detail}</p>
        {(issue.path || issue.platforms.length > 0 || many) && (
          <div className="hissue__meta">
            {issue.platforms.length > 0 && <StoreLogos platforms={issue.platforms} size={14} />}
            {issue.path && <code className="hissue__path selectable" title={issue.path}>{issue.path}</code>}
            {many && (
              <button className="hissue__games" aria-expanded={showGames} aria-controls={listId} onClick={() => setShowGames(!showGames)}>
                {issue.gameIds.length.toLocaleString()} games <ChevronDown size={12} aria-hidden />
              </button>
            )}
          </div>
        )}
        {many && showGames && (
          <ul id={listId} className="hissue__gamelist">
            {issue.gameIds.slice(0, 40).map((gid) => <li key={gid}>{gamesById.get(gid)?.title ?? 'A game'}</li>)}
            {issue.gameIds.length > 40 && <li>…and {(issue.gameIds.length - 40).toLocaleString()} more</li>}
          </ul>
        )}
      </div>
      <div className="hissue__actions">
        {issue.fixes.map((f, i) => (
          <Button
            key={f.action}
            size="sm"
            variant={i === 0 ? 'secondary' : 'ghost'}
            loading={busy === f.action}
            disabled={disabled || (!!busy && busy !== f.action)}
            onClick={() => onFix(issue, f)}
            title={f.safe ? 'Safe: never deletes anything' : undefined}
          >
            {f.label}
          </Button>
        ))}
        <IconButton label={`Dismiss “${issue.title}”`} size="sm" disabled={disabled || !!busy} onClick={() => onDismiss(issue)}>
          <X size={14} />
        </IconButton>
      </div>
    </motion.li>
  );
}
