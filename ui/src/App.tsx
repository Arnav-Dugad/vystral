import { lazy, Suspense, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { exit, pick, spring } from './lib/motion';
import { startInput } from './lib/input';
import { useGameRunning, useReducedMotion, useStore, type Route } from './state/store';
import { LivingCanvas } from './components/shell/LivingCanvas';
import { TitleBar } from './components/shell/TitleBar';
import { Sidebar } from './components/shell/Sidebar';
import { CommandBar } from './components/shell/CommandBar';
import { LaunchOverlay } from './components/shell/LaunchOverlay';
import { Intro } from './components/shell/Intro';
import { UpdateCenterDialog } from './components/shell/UpdateCenter';
import { Toaster } from './components/ui/Toaster';
import { Dialog } from './components/ui/Dialog';
import { Button, Skeleton } from './components/ui/primitives';
import { createCollection } from './state/actions';
import { call } from './bridge/bridge';
import { HomeView } from './views/Home';
import { LibraryView } from './views/Library';
import './components/shell/shell.css';

const GameDetailView = lazy(() => import('./views/GameDetail').then((m) => ({ default: m.GameDetailView })));
const SettingsView = lazy(() => import('./views/Settings').then((m) => ({ default: m.SettingsView })));
const JournalView = lazy(() => import('./views/Journal').then((m) => ({ default: m.JournalView })));
const PerformanceView = lazy(() => import('./views/Performance').then((m) => ({ default: m.PerformanceView })));
const MomentsView = lazy(() => import('./views/Moments').then((m) => ({ default: m.MomentsView })));
const ConstellationView = lazy(() => import('./views/Constellation').then((m) => ({ default: m.ConstellationView })));
const AssistantView = lazy(() => import('./views/Assistant').then((m) => ({ default: m.AssistantView })));
const OnboardingView = lazy(() => import('./views/Onboarding').then((m) => ({ default: m.OnboardingView })));
const ImmersiveView = lazy(() => import('./views/Immersive').then((m) => ({ default: m.ImmersiveView })));

export default function App() {
  const init = useStore((s) => s.init);
  const ready = useStore((s) => s.ready);
  const fatal = useStore((s) => s.fatal);
  const settings = useStore((s) => s.settings);
  const mode = useStore((s) => s.window.mode);
  const reduce = useReducedMotion();
  const running = useGameRunning();
  const [collapsed, setCollapsed] = useState(() => innerWidth < 1100);

  useEffect(() => {
    startInput();
    void init();
  }, [init]);

  // Theme, motion, quality and Performance Mode are expressed as root attributes for CSS.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings?.['appearance.theme'] ?? 'obsidian';
    root.dataset.reducedMotion = String(reduce);
    root.dataset.performance = String(running);
    root.dataset.mode = mode;
    const q = settings?.['appearance.quality'] ?? 'auto';
    root.dataset.quality = q === 'auto' ? ((navigator.hardwareConcurrency ?? 8) <= 4 ? 'low' : 'balanced') : q;
    if (settings) void call('window.captionTheme', { value: settings['appearance.theme'] !== 'light' }).catch(() => {});
  }, [settings, reduce, running, mode]);

  useEffect(() => {
    const onResize = () => setCollapsed(innerWidth < 1100);
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  }, []);

  useGlobalKeys();

  if (fatal) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%', padding: 32, textAlign: 'center' }}>
        <div style={{ maxWidth: 480 }}>
          <h1 style={{ fontSize: 24, marginBottom: 8 }}>VYSTRAL couldn’t start its interface</h1>
          <p style={{ color: 'var(--text-2)' }}>{fatal}</p>
          <Button variant="primary" style={{ marginTop: 16 }} onClick={() => location.reload()}>Try again</Button>
        </div>
      </div>
    );
  }

  const onboarding = ready && settings && !settings['onboarding.completed'];

  return (
    <>
      <LivingCanvas />
      <Intro enabled={!!settings?.['startup.intro'] && !reduce && !onboarding} />
      {mode === 'immersive' ? (
        <Suspense fallback={null}>
          <ImmersiveView />
        </Suspense>
      ) : (
        <div className="shell" data-collapsed={collapsed}>
          <TitleBar />
          <Sidebar />
          <main className="main" aria-busy={!ready}>
            <Routes />
          </main>
        </div>
      )}
      {onboarding && (
        <Suspense fallback={null}>
          <OnboardingView />
        </Suspense>
      )}
      <CommandBar />
      <LaunchOverlay />
      <UpdateCenterDialog />
      <NewCollectionDialog />
      <Toaster />
    </>
  );
}

function Routes() {
  const route = useStore((s) => s.route);
  const reduce = useReducedMotion();
  const key = route.name === 'game' ? `game-${route.id}` : route.name === 'library' ? `library-${route.collectionId ?? ''}` : route.name;
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.div
        key={key}
        className="main__scroll"
        data-scroll-main
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10, filter: 'blur(4px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6, transition: exit }}
        transition={pick(reduce, spring.page)}
      >
        <Suspense fallback={<PageSkeleton />}>
          <View route={route} />
        </Suspense>
      </motion.div>
    </AnimatePresence>
  );
}

function View({ route }: { route: Route }) {
  switch (route.name) {
    case 'home': return <HomeView />;
    case 'library': return <LibraryView collectionId={route.collectionId} />;
    case 'game': return <GameDetailView id={route.id} />;
    case 'journal': return <JournalView />;
    case 'performance': return <PerformanceView sessionId={route.sessionId} />;
    case 'moments': return <MomentsView />;
    case 'constellation': return <ConstellationView />;
    case 'assistant': return <AssistantView />;
    case 'settings': return <SettingsView section={route.section} />;
  }
}

function PageSkeleton() {
  return (
    <div className="page" aria-hidden>
      <Skeleton width="40%" height={36} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 20, marginTop: 28 }}>
        {Array.from({ length: 12 }, (_, i) => <Skeleton key={i} height={255} radius={16} />)}
      </div>
    </div>
  );
}

function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const typing = (e.target as HTMLElement)?.closest('input, textarea, [contenteditable]');
      if ((e.ctrlKey && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing)) {
        e.preventDefault();
        s.setCommandOpen(!s.commandOpen);
      } else if (e.ctrlKey && e.key === ',') {
        e.preventDefault();
        s.navigate({ name: 'settings' });
      } else if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        s.goBack();
      } else if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        s.goForward();
      } else if (e.key === 'F11') {
        e.preventDefault();
        void s.setMode(s.window.mode === 'immersive' ? 'desktop' : 'immersive');
      } else if (e.key === 'F5' || (e.ctrlKey && e.key.toLowerCase() === 'r')) {
        e.preventDefault();
        void s.scanLibrary();
      } else if (e.key === 'Escape' && !typing && !document.querySelector('[data-dialog-open], [data-menu-open]') && s.route.name === 'game') {
        s.goBack();
      }
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) useStore.getState().goBack();
      if (e.button === 4) useStore.getState().goForward();
    };
    addEventListener('keydown', onKey);
    addEventListener('mouseup', onMouse);
    return () => {
      removeEventListener('keydown', onKey);
      removeEventListener('mouseup', onMouse);
    };
  }, []);
}

function NewCollectionDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  useEffect(() => {
    const h = () => {
      setName('');
      setOpen(true);
    };
    addEventListener('vystral:new-collection', h);
    return () => removeEventListener('vystral:new-collection', h);
  }, []);
  const submit = async () => {
    if (!name.trim()) return;
    const id = await createCollection(name.trim());
    setOpen(false);
    if (id) useStore.getState().navigate({ name: 'library', collectionId: id });
  };
  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title="New collection"
      actions={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!name.trim()}>Create</Button>
        </>
      }
    >
      <p style={{ marginBottom: 12 }}>Group games however you like. Add games from their right-click menu or details page.</p>
      <input
        className="input"
        data-autofocus
        value={name}
        maxLength={60}
        placeholder="e.g. Couch co-op, Backlog, Weekend"
        aria-label="Collection name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void submit()}
      />
    </Dialog>
  );
}
