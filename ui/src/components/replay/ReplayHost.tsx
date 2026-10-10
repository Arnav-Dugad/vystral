import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Clipboard, Download, RotateCcw } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { Game, InsightSample, PerfSample, ReplayData } from '../../bridge/types';
import { formatDuration } from '../../lib/format';
import { peekPalette, titleHue } from '../../lib/palette';
import { buildReplayModel, CARD_H, CARD_W, REPLAY_SECONDS, replaySummary, toBase64Chunks, type ReplayModel } from '../../lib/replay';
import { useRecapStore } from '../../state/recap';
import { useReducedMotion, useStore } from '../../state/store';
import { Button, Skeleton } from '../ui/primitives';
import { Dialog } from '../ui/Dialog';
import { drawReplay, type ReplayImages, type ReplayTheme } from './drawReplay';
import { logoTone } from '../../lib/logoTone';
import './replay.css';
import { RecapCaption } from '../ai/RecapCaption'; // Track C5

/** Loads an image as a bitmap through fetch (art host or data: URL), so the canvas never becomes tainted. */
async function bitmap(url: string | null | undefined): Promise<ImageBitmap | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob());
  } catch {
    return null;
  }
}

function themeFor(game: Game | undefined): ReplayTheme {
  const css = getComputedStyle(document.documentElement);
  const accent = (game && peekPalette(game)?.accent) || (game ? `oklch(0.72 0.15 ${titleHue(game.title)})` : css.getPropertyValue('--accent').trim() || '#8b7bff');
  return {
    accent,
    fontDisplay: css.getPropertyValue('--font-display').trim() || 'sans-serif',
    fontUi: css.getPropertyValue('--font-ui').trim() || 'sans-serif',
  };
}

/** Sends the PNG to VYSTRAL in chunks (one bridge message is capped at 256 K characters). Returns the upload token. */
async function upload(sessionId: string, blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { token } = await call<{ token: string }>('replay.imageBegin', { sessionId, bytes: bytes.length });
  const chunks = toBase64Chunks(bytes);
  for (let i = 0; i < chunks.length; i++) await call('replay.imageChunk', { token, index: i, data: chunks[i] });
  return token;
}

/**
 * Track M: the session replay card (opened from Performance, the session-saved toast and the Journal).
 * A ~10 s animated summary drawn on a canvas; reduced motion shows the finished card at once.
 * "Save as image" renders it at 1920×1080 and saves it through the Windows save dialog;
 * "Copy image" puts the same PNG on the clipboard.
 */
export function ReplayHost() {
  const sessionId = useRecapStore((s) => s.replaySessionId);
  const close = useRecapStore((s) => s.closeReplay);
  return <ReplayDialog key={sessionId ?? 'none'} sessionId={sessionId} onClose={close} />;
}

function ReplayDialog({ sessionId, onClose }: { sessionId: string | null; onClose: () => void }) {
  const reduce = useReducedMotion();
  const toast = useStore((s) => s.toast);
  const [model, setModel] = useState<ReplayModel | null>(null);
  const [images, setImages] = useState<ReplayImages | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'copy' | null>(null);
  const [run, setRun] = useState(0);
  const [doneRun, setDoneRun] = useState(-1);
  const done = doneRun === run;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const game = useStore((s) => (model ? s.gamesById.get(model.gameId) : undefined));
  const theme = useMemo(() => (model ? themeFor(game) : null), [model, game]);

  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    (async () => {
      try {
        const [data, samples, insight] = await Promise.all([
          call<ReplayData>('replay.get', { sessionId }),
          call<PerfSample[]>('sessions.samples', { sessionId }).catch(() => [] as PerfSample[]),
          call<InsightSample[]>('sessions.insightSamples', { sessionId }).catch(() => [] as InsightSample[]),
        ]);
        if (!alive) return;
        const m = buildReplayModel(data, Array.isArray(samples) ? samples : [], Array.isArray(insight) ? insight : []);
        const g = useStore.getState().gamesById.get(m.gameId);
        const [logoTone_, backdrop, logo, ...icons] = await Promise.all([
          g?.art.logo ? logoTone(g.art.logo) : Promise.resolve(null),
          bitmap(g?.art.hero ?? g?.art.header ?? g?.art.cover),
          bitmap(g?.art.logo),
          ...m.achievements.map((a) => bitmap(a.icon)),
        ]);
        await document.fonts?.ready;
        if (!alive) return;
        const map = new Map<string, ImageBitmap>();
        m.achievements.forEach((a, i) => icons[i] && map.set(a.key, icons[i] as ImageBitmap));
        setImages({ backdrop: backdrop as ImageBitmap | null, logo: logo as ImageBitmap | null, logoDark: logoTone_ === 'dark', icons: map });
        setModel(m);
      } catch (err) {
        if (alive) setError(errorMessage(err));
      }
    })();
    return () => { alive = false; };
  }, [sessionId]);

  // Animate (or draw the final frame once with reduced motion).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !model || !images || !theme) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const fit = () => {
      const w = Math.max(320, Math.round(canvas.clientWidth * Math.min(2, devicePixelRatio || 1)));
      canvas.width = w;
      canvas.height = Math.round((w * CARD_H) / CARD_W);
    };
    fit();
    let raf = 0;
    if (reduce) {
      drawReplay(ctx, model, images, theme, REPLAY_SECONDS);
      raf = requestAnimationFrame(() => setDoneRun(run));
      return () => cancelAnimationFrame(raf);
    }
    const t0 = performance.now();
    const frame = (now: number) => {
      const t = (now - t0) / 1000;
      drawReplay(ctx, model, images, theme, t);
      if (t < REPLAY_SECONDS) raf = requestAnimationFrame(frame);
      else setDoneRun(run);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [model, images, theme, reduce, run]);

  const renderPng = useCallback(async (): Promise<Blob> => {
    const canvas = document.createElement('canvas');
    canvas.width = CARD_W;
    canvas.height = CARD_H;
    const ctx = canvas.getContext('2d');
    if (!ctx || !model || !images || !theme) throw new Error('The card isn’t ready yet.');
    drawReplay(ctx, model, images, theme, REPLAY_SECONDS);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('The image couldn’t be created.');
    return blob;
  }, [model, images, theme]);

  const save = async () => {
    if (!model) return;
    setBusy('save');
    try {
      const token = await upload(model.sessionId, await renderPng());
      const r = await call<{ path: string } | null>('replay.imageSave', { token }, 300_000);
      if (r?.path) toast({ tone: 'success', title: 'Replay saved', body: r.path });
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t save the image', body: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (!model) return;
    setBusy('copy');
    try {
      const token = await upload(model.sessionId, await renderPng());
      await call('replay.imageCopy', { token });
      toast({ tone: 'success', title: 'Replay copied', body: 'Paste it anywhere that takes images.' });
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t copy the image', body: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const summary = model ? replaySummary(model, formatDuration(model.durationSeconds)) : '';

  return (
    <Dialog
      open={!!sessionId}
      onClose={onClose}
      wide
      title={model ? `Replay · ${model.title}` : 'Session replay'}
      actions={
        <>
          {!reduce && <Button variant="ghost" icon={<RotateCcw size={15} />} disabled={!model} onClick={() => setRun((n) => n + 1)}>Replay</Button>}
          <Button icon={<Clipboard size={15} />} loading={busy === 'copy'} disabled={!model || !!busy} onClick={() => void copy()}>Copy image</Button>
          <Button variant="primary" icon={<Download size={15} />} loading={busy === 'save'} disabled={!model || !!busy} onClick={() => void save()} data-autofocus>Save as image</Button>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="replay">
        {error && <p className="replay__error">{error}</p>}
        {!model && !error && <Skeleton className="replay__skeleton" height="100%" />}
        {model && (
          <>
            <canvas ref={canvasRef} className="replay__canvas" role="img" aria-label={summary} data-done={done || undefined} />
            {model.achievementsNote && <p className="replay__note">{model.achievementsNote}.</p>}
            <RecapCaption sessionId={model.sessionId} />
            <p className="replay__foot">Saved images are 1920×1080 PNG. Nothing is uploaded anywhere; you choose where the file goes.</p>
          </>
        )}
      </div>
    </Dialog>
  );
}
