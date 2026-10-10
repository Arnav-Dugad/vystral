import { forwardRef, lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, LayoutGroup, motion, useIsPresent } from 'motion/react';
import { exit, pick, spring } from './lib/motion';
import { startInput } from './lib/input';
import { watchAmbient } from './lib/sound';
import { startRecordWatch } from './state/records';
import { useGameRunning, useReducedMotion, useStore, type Route } from './state/store';
import { LivingCanvas } from './components/shell/LivingCanvas';
import { SystemBackdrop } from './components/shell/SystemBackdrop';
import { TitleBar } from './components/shell/TitleBar';
import { Sidebar } from './components/shell/Sidebar';
import { CommandBar } from './components/shell/CommandBar';
import { LaunchOverlay } from './components/shell/LaunchOverlay';
import { ReplayHost } from './components/replay/ReplayHost';
import { ModeTransition } from './components/shell/ModeTransition';
import { Intro, rememberIntroPreference } from './components/shell/Intro';
import { UpdateCenterDialog } from './components/shell/UpdateCenter';
import { WhatsNewHost } from './whatsnew/WhatsNewHost';
import { Toaster } from './components/ui/Toaster';
import { CloudSessionPill } from './components/cloud/CloudPlayButton';
import { Dialog } from './components/ui/Dialog';
import { Button, Skeleton } from './components/ui/primitives';
import { createCollection } from './state/actions';
import { call } from './bridge/bridge';
import { HomeView } from './views/Home';
import { LibraryView } from './views/Library';
// Loaded eagerly: the card → page cover flight needs the page to mount in the same frame.
import { GameDetailView } from './views/GameDetail';
// Track U: eager for the same reason (the search result → page cover flight).
import { DiscoverGameView } from './views/DiscoverGame';
import { FieldKeyboardHost } from './components/controller/FieldKeyboard';
import './components/shell/shell.css';

const SettingsView = lazy(() => import('./views/Settings').then((m) => ({ default: m.SettingsView })));
const JournalView = lazy(() => import('./views/Journal').then((m) => ({ default: m.JournalView })));
const PerformanceView = lazy(() => import('./views/Performance').then((m) => ({ default: m.PerformanceView })));
const MomentsView = lazy(() => import('./views/Moments').then((m) => ({ default: m.MomentsView })));
const ConstellationView = lazy(() => import('./views/Constellation').then((m) => ({ default: m.ConstellationView })));
const AssistantView = lazy(() => import('./views/Assistant').then((m) => ({ default: m.AssistantView })));
const StorageStudioView = lazy(() => import('./views/StorageStudio').then((m) => ({ default: m.StorageStudioView })));
const OnboardingView = lazy(() => import('./views/Onboarding').then((m) => ({ default: m.OnboardingView })));
const ImmersiveView = lazy(() => import('./views/Immersive').then((m) => ({ default: m.ImmersiveView })));
const HealthView = lazy(() => import('./views/Health').then((m) => ({ default: m.HealthView })));
const DiscoverView = lazy(() => import('./views/Discover').then((m) => ({ default: m.DiscoverView })));
const WishlistView = lazy(() => import('./views/Wishlist').then((m) => ({ default: m.WishlistView }))); // Track W

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
    watchAmbient(); // Track K: mood-following ambient sound (off unless enabled in Settings)
    startRecordWatch(); // Track C6: a toast when a finished session beats a personal record
    void init();
  }, [init]);

  // Theme, motion, quality and Performance Mode are expressed as root attributes for CSS.
  useEffect(() => {
    const root = document.documentElement;
    // Track AA: until settings arrive, keep the first-paint snapshot's theme (set before the first render).
    const early = useStore.getState().firstPaint?.appearance;
    root.dataset.theme = settings?.['appearance.theme'] ?? early?.theme ?? 'obsidian';
    root.dataset.reducedMotion = String(reduce);
    root.dataset.performance = String(running);
    root.dataset.mode = mode;
    const q = settings?.['appearance.quality'] ?? early?.quality ?? 'auto';
    root.dataset.quality = q === 'auto' ? ((navigator.hardwareConcurrency ?? 8) <= 4 ? 'low' : 'balanced') : q;
    if (settings) rememberIntroPreference(settings['startup.intro'] && !reduce);
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
      <SystemBackdrop />
      <Intro />
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
          <CloudSessionPill />
        </div>
      )}
      {onboarding && (
        <Suspense fallback={null}>
          <OnboardingView />
        </Suspense>
      )}
      <CommandBar />
      <LaunchOverlay />
      <ReplayHost />
      <ModeTransition />
      <UpdateCenterDialog />
      <WhatsNewHost />
      <NewCollectionDialog />
      <Toaster />
      <FieldKeyboardHost />
    </>
  );
}

/** Per-route scroll position and focused game, restored on Back/Forward ("exact return"). */
const routeMemory = new Map<string, { top: number; focusId: string | null }>();

function routeKey(route: Route) {
  return route.name === 'game' ? `game-${route.id}` : route.name === 'library' ? `library-${route.collectionId ?? ''}`
    : route.name === 'discoverGame' ? `discover-${route.key}` : route.name;
}

function Routes() {
  const route = useStore((s) => s.route);
  const navKind = useStore((s) => s.navKind);
  const reduce = useReducedMotion();
  const key = routeKey(route);
  return (
    <LayoutGroup id="routes">
      <AnimatePresence mode="popLayout" initial={false}>
        <RoutePage key={key} routeKey={key} restore={navKind !== 'push'} reduce={reduce}>
          <Suspense fallback={<PageSkeleton />}>
            <View route={route} />
          </Suspense>
        </RoutePage>
      </AnimatePresence>
    </LayoutGroup>
  );
}

const RoutePage = forwardRef<HTMLDivElement, { routeKey: string; restore: boolean; reduce: boolean; children: ReactNode }>(function RoutePage(
  { routeKey: key, restore, reduce, children },
  forwarded,
) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Once a page starts leaving it can reflow (and the browser may re-anchor its scroll);
  // nothing that happens during the exit animation may overwrite what we remembered.
  const present = useIsPresent();
  const presentRef = useRef(present);
  presentRef.current = present;

  // Remember where we were: continuously for scroll, and the focused/hovered game on leave.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const remember = () => {
      if (!presentRef.current) return;
      const prev = routeMemory.get(key);
      routeMemory.set(key, { top: el.scrollTop, focusId: prev?.focusId ?? null });
    };
    const rememberFocus = (e: Event) => {
      if (!presentRef.current) return;
      const id = (e.target as HTMLElement)?.closest?.('[data-game-id]')?.getAttribute('data-game-id') ?? null;
      if (id) routeMemory.set(key, { top: el.scrollTop, focusId: id });
    };
    el.addEventListener('scroll', remember, { passive: true });
    el.addEventListener('focusin', rememberFocus);
    el.addEventListener('pointerdown', rememberFocus);
    return () => {
      el.removeEventListener('scroll', remember);
      el.removeEventListener('focusin', rememberFocus);
      el.removeEventListener('pointerdown', rememberFocus);
    };
  }, [key]);

  // Restore on Back/Forward. Virtualized pages need a frame or two to size themselves.
  useLayoutEffect(() => {
    const el = ref.current;
    const memory = routeMemory.get(key);
    if (!el || !restore || !memory) return;
    let tries = 0;
    let raf = 0;
    const apply = () => {
      el.scrollTop = memory.top;
      const reached = Math.abs(el.scrollTop - memory.top) < 2 || el.scrollHeight - el.clientHeight <= el.scrollTop + 1;
      const target = memory.focusId ? el.querySelector<HTMLElement>(`[data-game-id="${CSS.escape(memory.focusId)}"]`) : null;
      if ((reached && (!memory.focusId || target)) || ++tries > 30) {
        target?.focus({ preventScroll: true });
        return;
      }
      raf = requestAnimationFrame(apply);
    };
    apply();
    return () => cancelAnimationFrame(raf);
  }, [key, restore]);

  return (
    <motion.div
      ref={(el) => {
        ref.current = el;
        if (typeof forwarded === 'function') forwarded(el);
        else if (forwarded) forwarded.current = el;
      }}
      className="main__scroll"
      data-scroll-main
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10, filter: 'blur(4px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6, transition: exit }}
      transition={pick(reduce, spring.page)}
      style={restore ? { scrollBehavior: 'auto' } : undefined}
    >
      {children}
    </motion.div>
  );
});

function View({ route }: { route: Route }) {
  switch (route.name) {
    case 'home': return <HomeView />;
    case 'library': return <LibraryView collectionId={route.collectionId} quick={route.quick} />;
    case 'game': return <GameDetailView id={route.id} />;
    case 'journal': return <JournalView tab={route.tab} day={route.day} />;
    case 'performance': return <PerformanceView sessionId={route.sessionId} />;
    case 'moments': return <MomentsView />;
    case 'constellation': return <ConstellationView />;
    case 'assistant': return <AssistantView />;
    case 'settings': return <SettingsView section={route.section} />;
    case 'storage': return <StorageStudioView />;
    case 'health': return <HealthView />;
    case 'discover': return <DiscoverView query={route.query} />;
    case 'discoverGame': return <DiscoverGameView key={route.key} itemKey={route.key} title={route.title} />;
    case 'wishlist': return <WishlistView />;
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
      const typing = (e.target as HTMLElement)?.closest?.('input, textarea, [contenteditable]');
      if ((e.ctrlKey && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing)) {
        // Another dialog (or first-run onboarding) owns the keyboard; don't stack the command bar on it.
        if (document.querySelector('[data-dialog-open]:not(.cmd-backdrop):not(.launch-pill), .onb')) return;
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
      } else if (e.key === 'Escape' && !typing && !document.querySelector('[data-dialog-open], [data-menu-open]') && (s.route.name === 'game' || s.route.name === 'discoverGame') && s.window.mode !== 'immersive') {
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
