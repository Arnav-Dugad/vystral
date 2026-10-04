import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, Check, CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import type { Settings } from '../bridge/types';
import { ease, pick, spring } from '../lib/motion';
import { PLATFORM_NAMES } from '../lib/format';
import { useReducedMotion, useStore } from '../state/store';
import { Badge, Button, PlatformBadge, Toggle } from '../components/ui/primitives';
import './onboarding.css';

const STEPS = ['welcome', 'look', 'stores', 'features', 'privacy'] as const;
type Step = (typeof STEPS)[number];

/** First run. Skippable at every step; nothing here blocks the library from loading. */
export function OnboardingView() {
  const [step, setStep] = useState<Step>('welcome');
  const reduce = useReducedMotion();
  const setSetting = useStore((s) => s.setSetting);
  const index = STEPS.indexOf(step);
  const next = () => (index < STEPS.length - 1 ? setStep(STEPS[index + 1]) : finish());
  const finish = () => void setSetting('onboarding.completed', true);

  return (
    <div className="onb" role="dialog" aria-modal="true" aria-label="Welcome to VYSTRAL" data-nav-scope="overlay">
      <div className="onb__panel">
        <div className="onb__progress" aria-label={`Step ${index + 1} of ${STEPS.length}`}>
          {STEPS.map((s, i) => <span key={s} data-state={i < index ? 'done' : i === index ? 'active' : 'todo'} />)}
        </div>
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            className="onb__step"
            initial={reduce ? { opacity: 0 } : { opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, x: -24, transition: { duration: 0.16, ease: ease.in } }}
            transition={pick(reduce, spring.page)}
          >
            {step === 'welcome' && <Welcome />}
            {step === 'look' && <Look />}
            {step === 'stores' && <Stores />}
            {step === 'features' && <Features />}
            {step === 'privacy' && <Privacy />}
          </motion.div>
        </AnimatePresence>
        <div className="onb__footer">
          <Button variant="ghost" onClick={finish}>Skip setup</Button>
          <div style={{ display: 'flex', gap: 8 }}>
            {index > 0 && <Button onClick={() => setStep(STEPS[index - 1])}>Back</Button>}
            <Button variant="primary" icon={index === STEPS.length - 1 ? <Check size={16} /> : <ArrowRight size={16} />} onClick={next} data-autofocus>
              {index === 0 ? 'Get started' : index === STEPS.length - 1 ? 'Enter VYSTRAL' : 'Continue'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Welcome() {
  return (
    <div className="onb__welcome">
      <img src="./vystral-mark.svg" alt="" className="onb__mark" />
      <h1 className="onb__title">Welcome to VYSTRAL</h1>
      <p className="onb__lead">Every game you own, from every store, in one place — launched the way each store intends. No account, no subscription, and your data stays on this PC.</p>
    </div>
  );
}

function Look() {
  const s = useStore((st) => st.settings)!;
  const set = useStore((st) => st.setSetting);
  const themes: { v: Settings['appearance.theme']; label: string; bg: string }[] = [
    { v: 'obsidian', label: 'Obsidian', bg: 'linear-gradient(135deg, oklch(0.24 0.06 292), oklch(0.12 0.012 282) 70%)' },
    { v: 'oled', label: 'OLED black', bg: '#000' },
    { v: 'light', label: 'Light', bg: 'linear-gradient(135deg, #fff, oklch(0.92 0.02 282))' },
    { v: 'contrast', label: 'High contrast', bg: 'linear-gradient(135deg, #000 55%, oklch(0.9 0.18 100) 55%)' },
  ];
  return (
    <>
      <h2 className="onb__h2">Pick your look</h2>
      <p className="onb__p">You can change this any time in Settings.</p>
      <div className="onb__themes" role="radiogroup" aria-label="Theme">
        {themes.map((t) => (
          <button key={t.v} role="radio" aria-checked={s['appearance.theme'] === t.v} className="onb__theme" onClick={() => void set('appearance.theme', t.v)}>
            <span style={{ background: t.bg }} />
            {t.label}
          </button>
        ))}
      </div>
      <div className="onb__row">
        <div>
          <div className="srow__label">Living Canvas</div>
          <div className="srow__hint">A calm animated background that takes on each game’s colours. Pauses while you play.</div>
        </div>
        <Toggle label="Living Canvas" checked={s['appearance.livingCanvas']} onChange={(v) => void set('appearance.livingCanvas', v)} />
      </div>
    </>
  );
}

function Stores() {
  const adapters = useStore((s) => s.adapters);
  const scan = useStore((s) => s.scan);
  const games = useStore((s) => s.library.games.length);
  const scanLibrary = useStore((s) => s.scanLibrary);
  const refreshAdapters = useStore((s) => s.refreshAdapters);
  useEffect(() => void refreshAdapters(), [refreshAdapters]);
  return (
    <>
      <h2 className="onb__h2">Your stores</h2>
      <p className="onb__p">VYSTRAL reads what your store apps already keep on this PC. It never asks for store passwords and never changes store files.</p>
      <div className="onb__stores">
        {adapters.map((a) => {
          const count = scan.platforms[a.platform];
          return (
            <div key={a.platform} className="onb__store">
              <PlatformBadge platform={a.platform} />
              <span style={{ marginLeft: 'auto' }}>
                {a.status !== 'Available' ? (
                  <Badge>Not installed</Badge>
                ) : scan.running && count == null ? (
                  <Badge icon={<Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />}>Reading…</Badge>
                ) : (
                  <Badge tone="ok" icon={<CheckCircle2 size={12} />}>{(count ?? a.lastScanCount ?? 0).toLocaleString()} found</Badge>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <div className="onb__row">
        <span className="srow__hint">{scan.running ? 'Scanning…' : `${games.toLocaleString()} games in your library so far.`}</span>
        <Button size="sm" loading={scan.running} onClick={() => void scanLibrary()}>Scan again</Button>
      </div>
      <p className="srow__hint" style={{ marginTop: 8 }}>
        Not listed here? You can add any game or program yourself later. Supported: {Object.values(PLATFORM_NAMES).filter((n) => n !== 'Added by you').join(', ')}.
      </p>
    </>
  );
}

function Features() {
  const s = useStore((st) => st.settings)!;
  const set = useStore((st) => st.setSetting);
  const rows: { k: keyof Settings; label: string; hint: string }[] = [
    { k: 'library.fetchMetadata', label: 'Game details & artwork', hint: 'Looks up genres, descriptions and missing artwork on Steam’s public store pages. Exact matches only.' },
    { k: 'performance.collectMetrics', label: 'Session performance history', hint: 'Records CPU/GPU/memory load (read-only) while games you launch from VYSTRAL run.' },
    { k: 'moments.enabled', label: 'Moments', hint: 'Shows your Steam screenshots and Xbox Game Bar captures. Files are never uploaded or changed.' },
    { k: 'updates.autoCheck', label: 'Check for VYSTRAL updates', hint: 'Looks for new versions on GitHub shortly after starting.' },
    { k: 'ai.enabled', label: 'Local AI (advanced)', hint: 'Needs Ollama installed separately. Runs on this PC only; you choose and approve any model download.' },
  ];
  return (
    <>
      <h2 className="onb__h2">Optional features</h2>
      <p className="onb__p">Everything here is optional. VYSTRAL launches your games either way.</p>
      <div className="onb__list">
        {rows.map((r) => (
          <div key={r.k} className="onb__row">
            <div>
              <div className="srow__label">{r.label}</div>
              <div className="srow__hint">{r.hint}</div>
            </div>
            <Toggle label={r.label} checked={!!s[r.k]} onChange={(v) => void set(r.k, v as never)} />
          </div>
        ))}
      </div>
    </>
  );
}

function Privacy() {
  return (
    <div className="onb__welcome">
      <div className="onb__shield"><ShieldCheck size={40} /></div>
      <h2 className="onb__h2">Private by design</h2>
      <ul className="onb__bullets">
        <li>No account, no telemetry, no ads.</li>
        <li>Your library, sessions and notes live only on this PC.</li>
        <li>VYSTRAL never modifies games, never touches anti-cheat, and never changes hardware settings.</li>
        <li>If VYSTRAL is ever removed, every game still works through its own store.</li>
      </ul>
    </div>
  );
}
