import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { Cloud, CloudOff, Clock3, Download, FolderSearch, HardDrive, Heart, Info, Layers, ShieldCheck, Sparkles } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { Game, UninstallAdvice } from '../../bridge/types';
import { advise, type AdviceTone } from '../../lib/libraryTools';
import { formatBytes, formatDuration, formatRelative, lastPlayed, PLATFORM_NAMES, playSeconds } from '../../lib/format';
import { requestGameTab } from '../../lib/gameTab';
import { pick, spring } from '../../lib/motion';
import { useReducedMotion, useStore } from '../../state/store';
import { Dialog } from '../ui/Dialog';
import { Button, Skeleton } from '../ui/primitives';
import { StoreLogo } from '../ui/StoreLogo';
import { HoldToConfirm } from '../controller/HoldToConfirm';
import { GameCover } from './GameCover';
import './uninstall-advisor.css';

const TONE_ICON: Record<AdviceTone, typeof Heart> = { keep: Heart, think: Info, safe: ShieldCheck };

/**
 * Track X: before you uninstall in a store — your time with the game, whether its saves are in Steam Cloud, how much
 * you'd download to get it back, any subscription that lists it, and a gentle recommendation. Advice only: the button
 * opens the store's own uninstall (steam://uninstall/<appid>), the store app, or Windows' Installed apps.
 */
export function UninstallAdvisor({ game, installationId, open, onClose }: { game: Game | null; installationId?: string | null; open: boolean; onClose: () => void }) {
  const [advice, setAdvice] = useState<UninstallAdvice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<Game | null>(game);
  const toast = useStore((s) => s.toast);
  const navigate = useStore((s) => s.navigate);
  const reduce = useReducedMotion();
  const g = game ?? last;

  useEffect(() => {
    if (game) setLast(game);
  }, [game]);

  useEffect(() => {
    if (!open || !game) return;
    let live = true;
    setAdvice(null);
    setError(null);
    call<UninstallAdvice>('uninstall.advice', { gameId: game.id, installationId: installationId ?? null })
      .then((a) => live && setAdvice(a))
      .catch((err) => live && setError(errorMessage(err)));
    return () => { live = false; };
  }, [open, game, installationId]);

  const store = advice ? PLATFORM_NAMES[advice.platform] : null;
  const verdict = g && advice ? advise(g, advice) : null;
  const ToneIcon = verdict ? TONE_ICON[verdict.tone] : Info;

  const proceed = async () => {
    if (!g || !advice) return;
    setBusy(true);
    try {
      await call('uninstall.open', { gameId: g.id, installationId: advice.installationId });
      onClose();
      toast(advice.action === 'steamUninstall'
        ? { tone: 'info', title: 'Steam’s uninstall window is open', body: `Confirm there to remove ${g.title}. VYSTRAL updates your library when Steam finishes.` }
        : advice.action === 'windowsApps'
          ? { tone: 'info', title: 'Installed apps is open', body: `Find ${g.title} there (or in ${store}) to uninstall it. Nothing happens until you confirm.` }
          : { tone: 'info', title: `${store} is open`, body: `Uninstall ${g.title} from its library page. Nothing happens until you confirm there.` });
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t open the uninstall', body: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const seeSaves = () => {
    if (!g) return;
    onClose();
    requestGameTab(g.id, 'files');
    navigate({ name: 'game', id: g.id });
  };

  const lp = g ? lastPlayed(g) : null;
  const seconds = g ? playSeconds(g) : 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={g ? `Before you uninstall ${g.title}` : 'Before you uninstall'}
      describedBy="uadv-verdict"
      actions={
        <>
          <Button variant="ghost" onClick={onClose} data-autofocus>Keep it</Button>
          {advice && advice.action !== 'none' && (
            <HoldToConfirm loading={busy} variant={verdict?.tone === 'keep' ? 'secondary' : 'danger'} onConfirm={() => void proceed()}
              icon={advice.action === 'windowsApps' ? <Layers size={16} /> : <StoreLogo platform={advice.platform} size={16} decorative />}>
              {advice.actionLabel}
            </HoldToConfirm>
          )}
        </>
      }
    >
      {g && (
        <div className="uadv">
          {error ? (
            <p className="uadv__error" role="alert">{error}</p>
          ) : !advice || !verdict ? (
            <div className="uadv__loading" aria-busy>
              <Skeleton height={64} radius={16} />
              <div className="uadv__facts">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={92} radius={14} />)}</div>
            </div>
          ) : (
            <>
              <motion.div
                id="uadv-verdict"
                className="uadv__verdict"
                data-tone={verdict.tone}
                initial={{ opacity: 0, y: reduce ? 0 : 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={pick(reduce, spring.panel)}
              >
                <span className="uadv__cover" aria-hidden><GameCover game={g} /></span>
                <div className="uadv__verdict-text">
                  <p className="uadv__eyebrow caps"><ToneIcon size={13} aria-hidden /> {verdict.tone === 'keep' ? 'Maybe keep it' : verdict.tone === 'think' ? 'Worth a thought' : 'Looks fine'}</p>
                  <p className="uadv__headline">{verdict.headline}</p>
                </div>
              </motion.div>

              <dl className="uadv__facts">
                <Fact i={0} icon={<Clock3 size={16} />} label="Your time">
                  <strong className="num">{seconds > 0 ? formatDuration(seconds) : 'Not played'}</strong>
                  <span>{lp?.at ? `Last played ${formatRelative(lp.at).toLowerCase()}${lp.source === 'imported' ? ` (from ${store})` : lp.source === 'estimated' ? ' (estimated from save data)' : ''}` : 'No play recorded yet'}</span>
                </Fact>
                <Fact i={1} icon={advice.saves.state === 'steamCloud' ? <Cloud size={16} /> : <CloudOff size={16} />} label="Saves" tone={advice.saves.state === 'localOnly' ? 'warn' : advice.saves.state === 'steamCloud' ? 'ok' : undefined}>
                  {advice.saves.state === 'steamCloud' ? (
                    <>
                      <strong>In Steam Cloud</strong>
                      <span>{advice.saves.files.toLocaleString()} {advice.saves.files === 1 ? 'file' : 'files'} · {formatBytes(advice.saves.bytes)}{advice.saves.lastSync ? ` · synced ${formatRelative(advice.saves.lastSync).toLowerCase()}` : ''}</span>
                    </>
                  ) : advice.saves.state === 'localOnly' ? (
                    <>
                      <strong>Maybe only on this PC</strong>
                      <span>Steam Cloud has nothing for it here.</span>
                    </>
                  ) : (
                    <>
                      <strong>Not known</strong>
                      <span>{store} doesn’t say. Check where it saves first.</span>
                    </>
                  )}
                </Fact>
                <Fact i={2} icon={<Download size={16} />} label="To get it back">
                  <strong className="num">{advice.sizeBytes ? formatBytes(advice.sizeBytes) : 'Unknown size'}</strong>
                  <span>{advice.sizeSource === 'manifest' ? 'Steam’s own figure for the install' : advice.sizeSource === 'scan' ? `As ${store} reported it` : 'Download size not reported'}{advice.drive ? ` · on ${advice.drive}` : ''}</span>
                </Fact>
                <Fact i={3} icon={<Sparkles size={16} />} label="Subscriptions">
                  {advice.services.length ? (
                    <>
                      <strong>{advice.services.map((s) => s.name).join(', ')}</strong>
                      <span>{advice.services[0].note}</span>
                    </>
                  ) : (
                    <>
                      <strong>None known</strong>
                      <span>Nothing VYSTRAL knows of also offers it.</span>
                    </>
                  )}
                </Fact>
              </dl>

              <ul className="uadv__reasons">
                {verdict.reasons.map((r) => <li key={r}>{r}</li>)}
              </ul>

              <div className="uadv__foot">
                <Button size="sm" variant="ghost" icon={<FolderSearch size={14} />} onClick={seeSaves}>Check save files</Button>
                <p className="uadv__safe">
                  <HardDrive size={13} aria-hidden /> Advice only.{' '}
                  {advice.action === 'none'
                    ? 'You added this one yourself, so remove it the way you installed it. VYSTRAL never deletes files.'
                    : `Nothing is removed until you confirm in ${advice.action === 'windowsApps' ? 'Windows' : store}. VYSTRAL deletes nothing, and the game stays in your library with its notes and history.`}
                </p>
              </div>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

function Fact({ i, icon, label, tone, children }: { i: number; icon: ReactNode; label: string; tone?: 'ok' | 'warn'; children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className="uadv__fact"
      data-tone={tone}
      initial={{ opacity: 0, y: reduce ? 0 : 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0.15 } : { ...spring.panel, delay: 0.04 + i * 0.05 }}
    >
      <dt><span className="uadv__icon" aria-hidden>{icon}</span>{label}</dt>
      <dd>{children}</dd>
    </motion.div>
  );
}
