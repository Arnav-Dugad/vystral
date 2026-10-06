import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Check, CloudOff, Eye, Pause, Play, RotateCcw, Settings2, Sparkles, Wand2, X } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { ArtPackKind, ArtPackPlan, ArtPackPreset, ArtPackPresetId, ArtPackRequest, ArtPackSample, ArtPacksStatus, Game } from '../../bridge/types';
import {
  ART_PACK_KINDS, effectiveKinds, formatEta, isActive, jobFraction, jobStatusLine, jobSummary, KIND_LABEL, presetSupports, previewKind, scopeLabel, scopeOptions,
} from '../../lib/artPacks';
import { PICKER_SLOTS } from '../../lib/dataSources';
import { plural } from '../../lib/format';
import { useReducedMotion, useStore } from '../../state/store';
import { Button, ProgressBar } from '../ui/primitives';
import { Dialog } from '../ui/Dialog';
import { refreshArtPacks, restoreArtPack, setArtPackJob, useArtPacks } from './artPacksState';
import './art-packs.css';

export interface ArtPacksInitial {
  preset?: ArtPackPresetId;
  kinds?: ArtPackKind[];
  scope?: string;
}

const SAMPLE_CONCURRENCY = 2;

/**
 * Track N: Art packs. Choose a SteamGridDB style, which slots, and which games; preview eight of them;
 * then apply it as a background job that can be paused, cancelled and undone. The job keeps running
 * when this closes; its progress also shows in Settings › Library & stores.
 */
export function ArtPacksDialog({ open, onClose, initial }: { open: boolean; onClose: () => void; initial?: ArtPacksInitial }) {
  const status = useArtPacks(open);
  const job = status?.job ?? null;
  // A finished job stays on screen until the user moves on, so its summary and undo are visible.
  const [showJob, setShowJob] = useState(false);
  useEffect(() => {
    if (open) setShowJob(isActive(job));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (isActive(job)) setShowJob(true);
  }, [job]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={<span className="artpacks__title"><Wand2 size={18} aria-hidden /> Art packs</span>}
    >
      {!status ? (
        <p className="artpacks__loading" role="status">Loading…</p>
      ) : showJob && job ? (
        <JobPanel status={status} onAnother={() => setShowJob(false)} onClose={onClose} />
      ) : (
        <PackForm status={status} initial={initial} onClose={onClose} onStarted={() => setShowJob(true)} />
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------- choosing */

function PackForm({ status, initial, onClose, onStarted }: { status: ArtPacksStatus; initial?: ArtPacksInitial; onClose: () => void; onStarted: () => void }) {
  const games = useStore((s) => s.library.games);
  const collections = useStore((s) => s.library.collections);
  const navigate = useStore((s) => s.navigate);
  const toast = useStore((s) => s.toast);
  const scopes = useMemo(() => scopeOptions(games, collections), [games, collections]);
  const [presetId, setPresetId] = useState<ArtPackPresetId>(initial?.preset ?? 'official');
  const [chosen, setChosen] = useState<ArtPackKind[]>(initial?.kinds ?? ['cover', 'hero', 'logo']);
  const [scope, setScope] = useState<string>(() => (initial?.scope && scopes.some((o) => o.value === initial.scope) ? initial.scope : 'all'));
  const [replaceMine, setReplaceMine] = useState(false);
  const [plan, setPlan] = useState<ArtPackPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [samples, setSamples] = useState<Record<string, ArtPackSample | 'loading' | 'failed'> | null>(null);
  const [compare, setCompare] = useState(false);
  const [starting, setStarting] = useState(false);
  const preset = status.presets.find((p) => p.id === presetId);
  const kinds = effectiveKinds(preset, chosen);
  const request: ArtPackRequest = useMemo(() => ({ preset: presetId, kinds, scope, replaceMine }), [presetId, kinds.join(), scope, replaceMine]); // eslint-disable-line react-hooks/exhaustive-deps
  const blocked = !status.configured ? 'key' : status.localOnly ? 'offline' : status.safeMode ? 'safeMode' : status.dataSaver ? 'dataSaver' : null;
  const lastRun = status.runs.find((r) => r.canRestore);

  // The plan follows every change (it's local and cheap); previews are only fetched on request.
  useEffect(() => {
    setSamples(null);
    if (!kinds.length) {
      setPlan(null);
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      call<ArtPackPlan>('artPacks.plan', request)
        .then((p) => alive && (setPlan(p), setPlanError(null)))
        .catch((err) => alive && (setPlan(null), setPlanError(errorMessage(err))));
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [request, kinds.length]);

  const sampleKind = previewKind(kinds);
  const generation = useRef(0);
  const loadPreview = () => {
    if (!plan || !sampleKind) return;
    const gen = ++generation.current;
    const queue = [...plan.sample];
    setSamples(Object.fromEntries(queue.map((g) => [g.gameId, 'loading' as const])));
    const worker = async () => {
      while (queue.length && gen === generation.current) {
        const g = queue.shift()!;
        try {
          const s = await call<ArtPackSample>('artPacks.sample', { gameId: g.gameId, preset: presetId, kind: sampleKind }, 60_000);
          if (gen === generation.current) setSamples((cur) => (cur ? { ...cur, [g.gameId]: s } : cur));
        } catch {
          if (gen === generation.current) setSamples((cur) => (cur ? { ...cur, [g.gameId]: 'failed' } : cur));
        }
      }
    };
    for (let i = 0; i < SAMPLE_CONCURRENCY; i++) void worker();
  };

  const start = async () => {
    setStarting(true);
    try {
      const j = await call<ArtPacksStatus['job']>('artPacks.start', request);
      setArtPackJob(j);
      onStarted();
      void refreshArtPacks();
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t start the art pack', body: errorMessage(err) });
    } finally {
      setStarting(false);
    }
  };

  const toggleKind = (k: ArtPackKind) => setChosen((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  const gameById = useMemo(() => new Map(games.map((g) => [g.id, g])), [games]);

  return (
    <div className="artpacks">
      {blocked && <Gate why={blocked} onSettings={(section) => { onClose(); navigate({ name: 'settings', section }); }} />}

      <section className="artpacks__step" aria-labelledby="ap-style">
        <h3 id="ap-style" className="artpacks__h">Style</h3>
        <div className="artpacks__presets" role="radiogroup" aria-labelledby="ap-style">
          {status.presets.map((p) => (
            <PresetCard key={p.id} preset={p} checked={p.id === presetId} onPick={() => setPresetId(p.id)} />
          ))}
        </div>
      </section>

      <div className="artpacks__row">
        <section className="artpacks__step" aria-labelledby="ap-slots">
          <h3 id="ap-slots" className="artpacks__h">Artwork</h3>
          <div className="artpacks__slots">
            {ART_PACK_KINDS.map((k) => {
              const supported = presetSupports(preset, k);
              return (
                <label key={k} className="artpacks__check" data-disabled={!supported || undefined}>
                  <input type="checkbox" checked={supported && chosen.includes(k)} disabled={!supported} onChange={() => toggleKind(k)} />
                  <span>{KIND_LABEL[k]}</span>
                  {!supported && <span className="artpacks__muted">not in this style</span>}
                </label>
              );
            })}
          </div>
        </section>

        <section className="artpacks__step" aria-labelledby="ap-scope">
          <h3 id="ap-scope" className="artpacks__h">Games</h3>
          <select className="input artpacks__scope" aria-labelledby="ap-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
            {scopes.map((o) => (
              <option key={o.value} value={o.value}>{o.label} ({o.count.toLocaleString()})</option>
            ))}
          </select>
          <label className="artpacks__check artpacks__replace">
            <input type="checkbox" checked={replaceMine} onChange={(e) => setReplaceMine(e.target.checked)} />
            <span>Replace my picks</span>
          </label>
          <p className="artpacks__muted">
            {replaceMine
              ? 'Art you chose yourself is replaced too. “Restore previous art” brings it back.'
              : 'Art you chose yourself (in the artwork picker or from a file) is never replaced.'}
          </p>
        </section>
      </div>

      <section className="artpacks__summary" aria-live="polite">
        {!kinds.length ? (
          <p>Choose at least one kind of artwork this style offers.</p>
        ) : planError ? (
          <p className="artpacks__error">{planError}</p>
        ) : plan ? (
          <p>
            {plan.slots ? (
              <>
                Changes <strong className="num">{plural(plan.slots, 'image')}</strong> across <strong className="num">{plural(plan.games, 'game')}</strong>
                {plan.keptHandPicked > 0 && <> · <span className="num">{plan.keptHandPicked.toLocaleString()}</span> of your own picks stay as they are</>}
                {formatEta(plan.estimatedSeconds) && <> · takes {formatEta(plan.estimatedSeconds)}</>}
              </>
            ) : plan.keptHandPicked > 0 ? (
              'Every image in this selection is one you chose yourself. Tick “Replace my picks” to change them too.'
            ) : (
              'There’s nothing to change in this selection.'
            )}
          </p>
        ) : (
          <p className="artpacks__muted">Working out what changes…</p>
        )}
        <p className="artpacks__muted">
          Games are matched by Steam app ID, or by an exact title — never a guess. Games without a confident match, or without art in this style, keep what they have.
        </p>
      </section>

      {samples && plan && sampleKind && (
        <section className="artpacks__preview" aria-labelledby="ap-preview">
          <div className="artpacks__preview-head">
            <h3 id="ap-preview" className="artpacks__h">Preview · {KIND_LABEL[sampleKind].toLowerCase()} of {plural(plan.sample.length, 'game')}</h3>
            <Button size="sm" variant="ghost" icon={<Eye size={14} />} aria-pressed={compare} onClick={() => setCompare((c) => !c)}>
              {compare ? 'Showing current art' : 'Compare with current art'}
            </Button>
          </div>
          <div className="artpacks__samples" data-kind={sampleKind} data-compare={compare || undefined}>
            {plan.sample.map((g, i) => (
              <SampleTile key={g.gameId} index={i} title={g.title} game={gameById.get(g.gameId)} kind={sampleKind} sample={samples[g.gameId]} />
            ))}
          </div>
        </section>
      )}

      <div className="artpacks__actions">
        {lastRun && (
          <Button variant="ghost" size="sm" icon={<RotateCcw size={14} />} onClick={() => void restoreArtPack(lastRun.id)}>
            Restore previous art ({lastRun.presetLabel})
          </Button>
        )}
        <span className="artpacks__spacer" />
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button icon={<Eye size={15} />} disabled={!!blocked || !plan?.slots} onClick={loadPreview}>
          {samples ? 'Refresh preview' : `Preview ${plan?.sample.length ?? 8} games`}
        </Button>
        <Button variant="primary" icon={<Sparkles size={15} />} disabled={!!blocked || !plan?.slots} loading={starting} onClick={() => void start()}>
          {plan?.games ? `Apply to ${plural(plan.games, 'game')}` : 'Apply'}
        </Button>
      </div>
    </div>
  );
}

function Gate({ why, onSettings }: { why: 'key' | 'offline' | 'safeMode' | 'dataSaver'; onSettings: (section: string) => void }) {
  const text = {
    key: 'Art packs use SteamGridDB, the community artwork library. It needs your own free API key: create one in your SteamGridDB preferences, then add it in Settings › Library & stores › Data sources. Nothing is sent anywhere until you do.',
    offline: 'Offline mode is on, so VYSTRAL doesn’t contact SteamGridDB. Turn it off in Settings › Privacy to apply an art pack.',
    dataSaver: 'Data saver is on, so art packs don’t download artwork. Turn it off in Settings › Privacy to apply one.',
    safeMode: 'VYSTRAL is in safe mode, so background downloads are off for this session.',
  }[why];
  return (
    <div className="artpacks__gate" role="alert">
      {why === 'key' ? <Settings2 size={16} aria-hidden /> : <CloudOff size={16} aria-hidden />}
      <p>{text}</p>
      {why === 'key' && <Button size="sm" onClick={() => onSettings('library')}>Open Data sources settings</Button>}
      {(why === 'offline' || why === 'dataSaver') && <Button size="sm" onClick={() => onSettings('privacy')}>Open Privacy settings</Button>}
    </div>
  );
}

function PresetCard({ preset, checked, onPick }: { preset: ArtPackPreset; checked: boolean; onPick: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={checked} className="ap-preset" onClick={onPick} data-preset={preset.id}>
      <span className="ap-swatch" data-preset={preset.id} aria-hidden>
        <i /><i /><i />
      </span>
      <span className="ap-preset__label">{preset.label}</span>
      <span className="ap-preset__desc">{preset.description}</span>
      {checked && <span className="ap-preset__check" aria-hidden><Check size={12} /></span>}
    </button>
  );
}

const ratioOf = (kind: ArtPackKind) => PICKER_SLOTS.find((s) => s.kind === kind)!.ratio;

function SampleTile({ index, title, game, kind, sample }: { index: number; title: string; game: Game | undefined; kind: ArtPackKind; sample: ArtPackSample | 'loading' | 'failed' | undefined }) {
  const reduce = useReducedMotion();
  const current = game?.art[kind] ?? null;
  const s = typeof sample === 'object' ? sample : null;
  const note = sample === 'failed' ? 'Preview couldn’t be loaded'
    : s?.reason === 'noMatch' ? 'No confident match — keeps its art'
    : s?.reason === 'noArt' ? 'Nothing in this style — keeps its art'
    : s?.reason === 'noPreview' ? 'Preview unavailable'
    : s?.author ? `by ${s.author}` : null;
  return (
    <motion.figure
      className="ap-sample"
      data-state={sample === 'loading' || !sample ? 'loading' : s?.thumb ? 'ready' : 'none'}
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: reduce ? 0 : index * 0.04 }}
    >
      <div className="ap-sample__frame" style={{ aspectRatio: ratioOf(kind) }}>
        {current ? <img className="ap-sample__now" src={current} alt="" draggable={false} /> : <span className="ap-sample__empty" aria-hidden>{title.slice(0, 1)}</span>}
        {s?.thumb && <img className="ap-sample__new" src={s.thumb} alt="" draggable={false} />}
        {(sample === 'loading' || !sample) && <span className="skeleton ap-sample__skeleton" aria-hidden />}
      </div>
      <figcaption>
        <span className="ap-sample__title truncate">{title}</span>
        {note && <span className="ap-sample__note truncate">{note}</span>}
      </figcaption>
    </motion.figure>
  );
}

/* ------------------------------------------------------------- applying */

function JobPanel({ status, onAnother, onClose }: { status: ArtPacksStatus; onAnother: () => void; onClose: () => void }) {
  const job = status.job!;
  const collections = useStore((s) => s.library.collections);
  const [busy, setBusy] = useState(false);
  const active = ['running', 'paused', 'waiting'].includes(job.state);
  const run = status.runs.find((r) => r.id === job.id);
  const act = async (method: 'artPacks.pause' | 'artPacks.resume' | 'artPacks.cancel') => {
    setBusy(true);
    try {
      const j = await call<ArtPacksStatus['job']>(method);
      if (j) setArtPackJob(j);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="artpacks artpacks__job" data-state={job.state}>
      <div className="artpacks__job-head">
        <span className="ap-swatch ap-swatch--sm" data-preset={job.presetId} aria-hidden><i /><i /><i /></span>
        <div>
          <p className="artpacks__job-title">{job.presetLabel} · {scopeLabel(job.scope, collections)}</p>
          <p className="artpacks__muted">{job.kinds.map((k) => KIND_LABEL[k]).join(', ')}{job.replaceHandPicked ? ' · replacing your picks' : ''}</p>
        </div>
      </div>
      <ProgressBar value={jobFraction(job) * 100} label="Art pack progress" />
      <p className="artpacks__status" role="status" aria-live="polite">{jobStatusLine(job)}</p>
      {active && job.current && <p className="artpacks__muted truncate">Now: {job.current}</p>}
      {active && job.done > 0 && <p className="artpacks__muted">{jobSummary(job)}</p>}
      <p className="artpacks__muted">
        {active
          ? 'It keeps going in the background — close this any time. It pauses by itself while a game runs, offline or with Data saver on.'
          : 'Everything it replaced is recorded, so it can be undone in one go.'}
      </p>
      <div className="artpacks__actions">
        {active ? (
          <>
            <span className="artpacks__spacer" />
            {job.state === 'paused' ? (
              <Button icon={<Play size={14} />} loading={busy} onClick={() => void act('artPacks.resume')}>Resume</Button>
            ) : (
              <Button icon={<Pause size={14} />} loading={busy} onClick={() => void act('artPacks.pause')}>Pause</Button>
            )}
            <Button variant="danger" icon={<X size={14} />} disabled={busy} onClick={() => void act('artPacks.cancel')}>Cancel</Button>
            <Button variant="primary" onClick={onClose}>Hide</Button>
          </>
        ) : (
          <>
            {run?.canRestore && (
              <Button icon={<RotateCcw size={14} />} onClick={() => void restoreArtPack(job.id)}>Restore previous art</Button>
            )}
            <span className="artpacks__spacer" />
            <Button variant="ghost" onClick={onAnother}>Apply another style</Button>
            <Button variant="primary" onClick={onClose}>Done</Button>
          </>
        )}
      </div>
    </div>
  );
}
