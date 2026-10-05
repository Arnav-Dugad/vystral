import { useEffect, useRef } from 'react';
import { AnimatePresence } from 'motion/react';
import { call } from '../bridge/bridge';
import { useStore } from '../state/store';
import { featureFor, featuresSeenOn, isBadgeVisible } from './badges';
import { RELEASES } from './releases';
import { OPEN_WHATS_NEW, useWhatsNew } from './state';
import { selectTour } from './tours';
import { compareVersions } from './version';
import { WhatsNewSheet } from './WhatsNewSheet';

/** Waits until the startup animation has gone (it never takes longer than ~4.5 s). */
function whenIntroDone(cb: () => void): () => void {
  let timer = 0;
  const check = () => {
    if (document.querySelector('.intro')) timer = window.setTimeout(check, 300);
    else timer = window.setTimeout(cb, 700);
  };
  check();
  return () => window.clearTimeout(timer);
}

/**
 * Mounted once in App. After start-up: explains a silent rollback (once), shows the "What's new"
 * tour once per new version (desktop mode only: in Immersive it waits for the next desktop
 * session), and marks "New" badges seen when their page is visited.
 */
export function WhatsNewHost() {
  const ready = useStore((s) => s.ready);
  const mode = useStore((s) => s.window.mode);
  const gameActive = useStore((s) => ['starting', 'waiting', 'running'].includes(s.launch?.phase ?? ''));
  const onboardingCompleted = useStore((s) => !!s.settings?.['onboarding.completed']);
  const loaded = useWhatsNew((s) => s.loaded);
  const tour = useWhatsNew((s) => s.tour);
  const noticeShown = useRef(false);

  // Load once the shell is ready, and explain a rollback right away.
  useEffect(() => {
    if (!ready) return;
    void useWhatsNew.getState().load().then((info) => {
      const n = info?.rollbackNotice;
      if (!n || noticeShown.current) return;
      noticeShown.current = true;
      useStore.getState().toast({
        tone: 'warning',
        sticky: true,
        title: `You’re back on VYSTRAL ${n.to}`,
        body: `VYSTRAL ${n.from} didn’t start correctly, so you’re back on ${n.to}. It will try again with the next update.`,
      });
      void call('update.dismissRollbackNotice').catch(() => {});
    });
  }, [ready]);

  // The automatic tour: once per new version, desktop only, never during a game or onboarding.
  useEffect(() => {
    if (!ready || !loaded || mode !== 'desktop' || gameActive || !onboardingCompleted) return;
    const w = useWhatsNew.getState();
    if (!w.current || w.tour) return;
    if (w.lastSeenVersion && compareVersions(w.lastSeenVersion, w.current) >= 0) return;
    const pickTour = selectTour({ current: w.current, lastSeen: w.lastSeenVersion, onboardingCompleted, releases: RELEASES });
    if (!pickTour) {
      w.markVersionSeen(w.current); // nothing to show for this version (e.g. a fixes-only release)
      return;
    }
    let retry = 0;
    const tryShow = () => {
      const s = useStore.getState();
      // Something else is open (a dialog, the command bar): wait politely.
      if (s.commandOpen || document.querySelector('[data-dialog-open]')) retry = window.setTimeout(tryShow, 2000);
      else if (s.window.mode === 'desktop') useWhatsNew.getState().showTour(pickTour);
    };
    const cancelIntroWait = whenIntroDone(tryShow);
    return () => {
      cancelIntroWait();
      window.clearTimeout(retry);
    };
  }, [ready, loaded, mode, gameActive, onboardingCompleted]);

  // Switching to Immersive (or a game starting) puts the tour away unseen: it returns next desktop session.
  useEffect(() => {
    if ((mode !== 'desktop' || gameActive) && useWhatsNew.getState().tour) useWhatsNew.getState().closeTour();
  }, [mode, gameActive]);

  // About / Updates: "See what's new".
  useEffect(() => {
    const open = () => {
      const w = useWhatsNew.getState();
      const t = selectTour({ current: w.current, lastSeen: null, onboardingCompleted: true, releases: RELEASES, manual: true });
      if (t) w.showTour(t);
      else useStore.getState().toast({ tone: 'info', title: 'Nothing new to show for this version' });
    };
    window.addEventListener(OPEN_WHATS_NEW, open);
    return () => window.removeEventListener(OPEN_WHATS_NEW, open);
  }, []);

  // Visiting a feature's page marks its badge seen.
  useEffect(() => {
    const mark = () => {
      const w = useWhatsNew.getState();
      if (!w.loaded) return;
      const keys = featuresSeenOn(useStore.getState().route).filter((k) => isBadgeVisible(featureFor(k), w));
      if (keys.length) w.markBadgesSeen(keys);
    };
    mark();
    const offRoute = useStore.subscribe((s, prev) => s.route !== prev.route && mark());
    const offLoad = useWhatsNew.subscribe((s, prev) => s.loaded && !prev.loaded && mark());
    return () => {
      offRoute();
      offLoad();
    };
  }, []);

  const close = () => {
    const w = useWhatsNew.getState();
    if (w.current && (!w.lastSeenVersion || compareVersions(w.lastSeenVersion, w.current) < 0)) w.markVersionSeen(w.current);
    w.closeTour();
  };

  return <AnimatePresence>{tour && <WhatsNewSheet key={tour.version} tour={tour} onClose={close} />}</AnimatePresence>;
}
