import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowUp, Bot, Check, CloudOff, Copy, Download, ExternalLink, Pause, Power, RefreshCw, RotateCcw, ShieldCheck, Sparkles, Square, TriangleAlert, WifiOff,
} from 'lucide-react';
import type { AiStatus } from '../bridge/types';
import { call, errorMessage, on } from '../bridge/bridge';
import { Badge, Button, IconButton, Kbd, ProgressBar, Skeleton, Tabs, Toggle, tabPanelProps } from '../components/ui/primitives';
import { TonightPanel } from '../components/ai/TonightPanel'; // Track C5
import { Dialog } from '../components/ui/Dialog';
import { ServiceLogo } from '../components/ui/ServiceLogo';
import { useGameRunning, useReducedMotion, useStore } from '../state/store';
import { pick, spring } from '../lib/motion';
import { IDLE_PULL, describePull, formatModelBytes, newId, reducePull, toWireMessages, type ChatMessage, type PullEvent, type PullState } from './assistant/chat';
import { RichText } from './assistant/RichText';
import './assistant/assistant.css';

const SUGGESTIONS = [
  'What should I play tonight?',
  'Which installed games haven’t I played in a while?',
  'Summarize my gaming this month',
  'Organize my library into collections',
];

const OLLAMA_URL = 'https://ollama.com/download';

export function AssistantView() {
  const settingsLoaded = useStore((s) => s.settings != null);
  const enabled = useStore((s) => s.settings?.['ai.enabled'] ?? false);
  const modelSetting = useStore((s) => s.settings?.['ai.model'] ?? '');
  const running = useGameRunning();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track C5: "Tonight" (picks from your library, with or without AI) beside the local chat.
  const [view, setView] = useState<'chat' | 'tonight'>(() => (assistantView === 'tonight' ? 'tonight' : 'chat'));
  useEffect(() => { assistantView = view; }, [view]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await call<AiStatus>('ai.status', undefined, 20_000));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, modelSetting, refresh]);

  let body: ReactNode;
  if (!settingsLoaded) body = <Skeleton height={320} radius={22} />;
  else if (!enabled) body = <Intro />;
  else if (error && !status) body = <Problem title="Couldn’t check local AI" detail={error} onRetry={refresh} retrying={loading} />;
  else if (!status) body = <Skeleton height={320} radius={22} />;
  else if (!status.running) body = <NotRunning status={status} onRetry={refresh} retrying={loading} />;
  else if (!status.selectedModelInstalled) body = <ModelSetup status={status} onRefresh={refresh} />;
  else body = <Chat status={status} running={running} />;

  const chatMode = enabled && status?.running && status.selectedModelInstalled;

  return (
    <div className={`page as-page ${chatMode && view === 'chat' ? 'as-page--chat' : ''}`}>
      <div className="as-tabs">
        <Tabs label="Assistant" idBase="assistant" value={view} onChange={setView} tabs={[{ value: 'chat', label: 'Chat' }, { value: 'tonight', label: 'Tonight' }]} />
      </div>
      {view === 'tonight' ? (
        <div role="tabpanel" {...tabPanelProps('assistant', 'tonight')} className="as-tabpanel"><TonightPanel /></div>
      ) : (
      <div role="tabpanel" {...tabPanelProps('assistant', 'chat')} className="as-tabpanel">
      {enabled && running && (
        <div className="as-paused" role="status">
          <Pause size={16} aria-hidden />
          <span>
            <strong>Local AI is paused while you play.</strong> It resumes when your game closes, so it never competes with the game for your GPU.
          </span>
        </div>
      )}
      {body}
      </div>
      )}
    </div>
  );
}

/** Track C5: the Assistant remembers its tab while the app runs. */
let assistantView: 'chat' | 'tonight' = 'chat';

/* ---------------------------------------------------------------------------------- (a) */

function Intro() {
  const reduce = useReducedMotion();
  const points = [
    { icon: <ServiceLogo service="ollama" size={20} decorative />, title: 'Runs entirely on this PC', body: 'Powered by Ollama, a free local model runner. Your questions and library never leave this PC.' },
    { icon: <CloudOff size={18} aria-hidden />, title: 'No account, no cloud', body: 'Nothing to sign in to and nothing sent to a server.' },
    { icon: <Pause size={18} aria-hidden />, title: 'Paused during gameplay', body: 'It stops while a game is running so it never costs you frames.' },
    { icon: <ShieldCheck size={18} aria-hidden />, title: 'Suggests, never acts', body: 'It can’t launch, install, delete or change anything. You stay in control.' },
  ];
  return (
    <motion.section
      className="as-intro"
      aria-labelledby="as-intro-title"
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={pick(reduce, spring.page)}
    >
      <div className="as-orb" aria-hidden>
        <Sparkles size={30} />
      </div>
      <div className="caps">Optional · Local AI</div>
      <h1 id="as-intro-title" className="as-intro__title">An assistant that knows your library — and stays on your PC</h1>
      <p className="as-intro__lead">Ask what to play tonight, find games you’ve forgotten, or get ideas for organizing collections.</p>
      <ul className="as-points">
        {points.map((p) => (
          <li key={p.title}>
            <span className="as-points__icon">{p.icon}</span>
            <span>
              <strong>{p.title}</strong>
              <span>{p.body}</span>
            </span>
          </li>
        ))}
      </ul>
      <label className="as-enable" htmlFor="as-enable-toggle">
        <span>
          <strong>Enable local AI</strong>
          <span>Requires Ollama and a one-time model download. You’ll see the size and confirm before anything downloads.</span>
        </span>
        <Toggle id="as-enable-toggle" label="Enable local AI" checked={false} onChange={(v) => void useStore.getState().setSetting('ai.enabled', v)} />
      </label>
    </motion.section>
  );
}

/* ---------------------------------------------------------------------------------- (b) */

function Problem({ title, detail, onRetry, retrying }: { title: string; detail: string; onRetry: () => void; retrying: boolean }) {
  return (
    <section className="as-card as-problem" aria-labelledby="as-problem-title">
      <span className="as-problem__icon" aria-hidden>
        <TriangleAlert size={22} />
      </span>
      <h1 id="as-problem-title" className="as-card__title">{title}</h1>
      <p className="as-card__body">{detail}</p>
      <div className="as-card__actions">
        <Button variant="primary" icon={<RefreshCw size={16} aria-hidden />} loading={retrying} onClick={onRetry}>
          Retry
        </Button>
      </div>
    </section>
  );
}

function NotRunning({ status, onRetry, retrying }: { status: AiStatus; onRetry: () => void; retrying: boolean }) {
  const openDownload = () => {
    void call('app.openExternal', { url: OLLAMA_URL }).catch((err) => useStore.getState().toast({ tone: 'danger', title: 'Couldn’t open the browser', body: errorMessage(err) }));
  };
  return (
    <section className="as-card as-problem" aria-labelledby="as-nr-title">
      <span className="as-problem__icon" aria-hidden>
        <WifiOff size={22} />
      </span>
      <div className="caps">Local AI</div>
      <h1 id="as-nr-title" className="as-card__title">Ollama isn’t running</h1>
      <p className="as-card__body">{status.problem ?? 'VYSTRAL couldn’t reach Ollama on this PC.'}</p>
      <ol className="as-steps">
        <li>Install Ollama for Windows — it’s free.</li>
        <li>Start it (it runs quietly in the system tray).</li>
        <li>Come back here and select Retry.</li>
      </ol>
      <div className="as-card__actions">
        <Button variant="primary" icon={<ExternalLink size={16} aria-hidden />} onClick={openDownload}>
          Get Ollama
        </Button>
        <Button variant="secondary" icon={<RefreshCw size={16} aria-hidden />} loading={retrying} onClick={onRetry}>
          Retry
        </Button>
        <Button variant="ghost" icon={<Power size={16} aria-hidden />} onClick={() => void useStore.getState().setSetting('ai.enabled', false)}>
          Turn off
        </Button>
      </div>
      <p className="as-card__foot">Opens ollama.com in your browser. VYSTRAL doesn’t install anything for you.</p>
    </section>
  );
}

/* ---------------------------------------------------------------------------------- (c) */

function ModelSetup({ status, onRefresh }: { status: AiStatus; onRefresh: () => Promise<void> }) {
  const rec = status.recommended;
  const [consent, setConsent] = useState(false);
  const [pull, dispatch] = useReducer((s: PullState, e: PullEvent | null) => (e ? reducePull(s, e) : IDLE_PULL), IDLE_PULL);
  const [starting, setStarting] = useState(false);
  const toast = useStore((s) => s.toast);

  useEffect(() => on('ai.pull', (e) => dispatch(e as PullEvent)), []);

  useEffect(() => {
    if (pull.phase !== 'done' || !pull.model) return;
    const model = pull.model;
    void (async () => {
      if (useStore.getState().settings?.['ai.model'] !== model) await useStore.getState().setSetting('ai.model', model);
      toast({ tone: 'success', title: `${model} is ready`, body: 'You can start chatting now.' });
      await onRefresh();
    })();
  }, [pull.phase, pull.model, onRefresh, toast]);

  const start = async () => {
    setConsent(false);
    setStarting(true);
    dispatch({ model: rec.name, status: 'pulling manifest' });
    try {
      await call('ai.pull', { model: rec.name }, 6 * 60 * 60_000);
      // Some backends finish the pull before resolving; the status check is cheap either way.
      void onRefresh();
    } catch (err) {
      dispatch({ model: rec.name, status: 'error', error: errorMessage(err) });
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    try {
      await call('ai.cancelPull');
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t cancel the download', body: errorMessage(err) });
    }
  };

  const pulling = pull.phase === 'pulling' || starting;
  const others = status.models;

  return (
    <section className="as-setup" aria-labelledby="as-setup-title">
      <div className="as-setup__head">
        <div className="caps">Local AI · <span className="svc-name"><ServiceLogo service="ollama" size={14} decorative />Ollama</span> {status.version ? <span className="num">v{status.version}</span> : null}</div>
        <h1 id="as-setup-title" className="as-card__title">Choose a model</h1>
        <p className="as-card__body">
          Ollama is running. {status.selectedModel ? <>The selected model, <code className="num">{status.selectedModel}</code>, isn’t installed yet.</> : 'No model is selected yet.'}
        </p>
      </div>

      <div className="as-card as-model">
        <div className="as-model__top">
          <span className="as-model__icon" aria-hidden>
            <Bot size={22} />
          </span>
          <div className="as-model__name">
            <span className="num">{rec.name}</span>
            <Badge tone="accent">Recommended</Badge>
          </div>
        </div>
        <p className="as-model__why">{rec.why}</p>
        <dl className="as-model__facts">
          <div>
            <dt className="caps">Download</dt>
            <dd className="num">{rec.downloadGb.toLocaleString(undefined, { maximumFractionDigits: 1 })} GB</dd>
          </div>
          <div>
            <dt className="caps">Licence</dt>
            <dd>{rec.license}</dd>
          </div>
          <div>
            <dt className="caps">Runs</dt>
            <dd>On this PC</dd>
          </div>
        </dl>

        <AnimatePresence mode="wait" initial={false}>
          {pulling ? (
            <motion.div key="progress" className="as-pull" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="as-pull__row">
                <span>{describePull(pull.status)}</span>
                <span className="num">
                  {pull.total != null && pull.completed != null
                    ? `${formatModelBytes(pull.completed)} of ${formatModelBytes(pull.total)}`
                    : pull.percent != null
                      ? `${Math.round(pull.percent)}%`
                      : ''}
                </span>
              </div>
              <ProgressBar label={`Downloading ${rec.name}`} value={pull.percent ?? undefined} indeterminate={pull.percent == null} />
              <div className="as-pull__row">
                <span className="as-pull__note">You can keep using VYSTRAL while this downloads.</span>
                <Button size="sm" variant="ghost" onClick={() => void cancel()}>
                  Cancel
                </Button>
              </div>
            </motion.div>
          ) : (
            <motion.div key="actions" className="as-card__actions" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {pull.phase === 'error' && (
                <p className="as-pull__error" role="alert">
                  <TriangleAlert size={14} aria-hidden /> {pull.error}
                </p>
              )}
              {pull.phase === 'cancelled' && <p className="as-pull__note" role="status">Download cancelled. Nothing else was changed.</p>}
              <Button variant="primary" icon={<Download size={16} aria-hidden />} onClick={() => setConsent(true)}>
                {pull.phase === 'error' || pull.phase === 'cancelled' ? 'Try download again…' : `Download ${rec.name}…`}
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {others.length > 0 && (
        <div className="as-card as-installed">
          <h2 className="as-installed__title">Or use a model you already have</h2>
          <ul className="as-installed__list">
            {others.map((m) => (
              <li key={m.name}>
                <span className="num as-installed__name">{m.name}</span>
                <span className="as-installed__size num">{formatModelBytes(m.sizeBytes)}</span>
                <Button size="sm" variant="secondary" onClick={() => void useStore.getState().setSetting('ai.model', m.name)}>
                  Use this model
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Dialog
        open={consent}
        onClose={() => setConsent(false)}
        title={`Download ${rec.name}?`}
        describedBy="as-consent-desc"
        actions={
          <>
            <Button variant="secondary" onClick={() => setConsent(false)}>
              Not now
            </Button>
            <Button variant="primary" icon={<Download size={16} aria-hidden />} onClick={() => void start()} data-autofocus>
              Download {rec.downloadGb.toLocaleString(undefined, { maximumFractionDigits: 1 })} GB
            </Button>
          </>
        }
      >
        <p id="as-consent-desc">
          Ollama will download about <strong className="num">{rec.downloadGb.toLocaleString(undefined, { maximumFractionDigits: 1 })} GB</strong> from the Ollama library and
          store it on this PC. On a metered connection this may cost data.
        </p>
        <ul className="as-consent">
          <li>
            <span>Model</span>
            <span className="num">{rec.name}</span>
          </li>
          <li>
            <span>Download size</span>
            <span className="num">{rec.downloadGb.toLocaleString(undefined, { maximumFractionDigits: 1 })} GB</span>
          </li>
          <li>
            <span>Licence</span>
            <span>{rec.license}</span>
          </li>
          <li>
            <span>Stored by</span>
            <span className="svc-name"><ServiceLogo service="ollama" size={14} decorative />Ollama, on this PC</span>
          </li>
        </ul>
        <p className="as-consent__note">You can cancel at any time. Nothing about your library is uploaded.</p>
      </Dialog>
    </section>
  );
}

/* ---------------------------------------------------------------------------------- (d) */

function Chat({ status, running }: { status: AiStatus; running: boolean }) {
  const reduce = useReducedMotion();
  const toast = useStore((s) => s.toast);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState('');
  const active = useRef<{ requestId: string; messageId: string } | null>(null);
  const pending = useRef('');
  const flushRaf = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const model = status.selectedModel;

  const patch = useCallback((id: string, fn: (m: ChatMessage) => ChatMessage) => setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m))), []);

  const flush = useCallback(() => {
    flushRaf.current = 0;
    const a = active.current;
    const text = pending.current;
    pending.current = '';
    if (a && text) patch(a.messageId, (m) => ({ ...m, content: m.content + text }));
  }, [patch]);

  const finish = useCallback(
    (outcome: 'done' | 'stopped' | 'error', err?: string) => {
      const a = active.current;
      if (!a) return;
      cancelAnimationFrame(flushRaf.current);
      flush();
      active.current = null;
      patch(a.messageId, (m) => ({ ...m, status: outcome === 'done' && !m.content.trim() ? 'error' : outcome, error: outcome === 'done' && !m.content.trim() ? 'The model returned an empty answer.' : err }));
      setBusy(false);
      setAnnounce(outcome === 'done' ? 'Answer ready.' : outcome === 'stopped' ? 'Stopped.' : 'The answer failed.');
    },
    [flush, patch],
  );

  // Stream deltas, coalesced to one render per frame.
  useEffect(
    () =>
      on('ai.chat', (e) => {
        const a = active.current;
        if (!a || e.requestId !== a.requestId) return;
        if (e.delta) {
          pending.current += e.delta;
          flushRaf.current ||= requestAnimationFrame(flush);
        }
        if (e.error) finish('error', e.error);
        else if (e.done) finish('done');
      }),
    [flush, finish],
  );

  // Leaving the view stops generation.
  useEffect(
    () => () => {
      if (active.current) void call('ai.cancelChat').catch(() => {});
      cancelAnimationFrame(flushRaf.current);
    },
    [],
  );

  // Follow the stream while the reader is at the bottom.
  useEffect(() => {
    const scroller = endRef.current?.closest<HTMLElement>('[data-scroll-main]');
    if (!scroller) return;
    const onScroll = () => {
      stick.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, []);
  useLayoutEffect(() => {
    if (!stick.current) return;
    const scroller = endRef.current?.closest<HTMLElement>('[data-scroll-main]');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [messages]);

  const ask = async (history: ChatMessage[]) => {
    const reply: ChatMessage = { id: newId('m'), role: 'assistant', content: '', model, status: 'streaming' };
    const requestId = newId('chat');
    const wire = toWireMessages(history);
    setMessages([...history, reply]);
    active.current = { requestId, messageId: reply.id };
    pending.current = '';
    stick.current = true;
    setBusy(true);
    setAnnounce('');
    try {
      await call('ai.chat', { requestId, messages: wire }, 15 * 60_000);
    } catch (err) {
      if (active.current?.requestId === requestId) finish('error', errorMessage(err));
    }
  };

  const send = (text: string) => {
    const content = text.trim();
    if (!content || busy || running) return;
    setDraft('');
    void ask([...messages, { id: newId('m'), role: 'user', content }]);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const stop = async () => {
    finish('stopped');
    try {
      await call('ai.cancelChat');
    } catch {
      // Generation already ended.
    }
  };

  const retry = () => {
    if (busy || running) return;
    const lastUser = messages.map((m) => m.role).lastIndexOf('user');
    if (lastUser < 0) return;
    void ask(messages.slice(0, lastUser + 1));
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ tone: 'success', title: 'Copied' });
    } catch {
      toast({ tone: 'warning', title: 'Couldn’t copy to the clipboard' });
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(draft);
    }
  };

  // Auto-size the composer up to ~8 lines.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [draft]);

  const switchModel = (name: string) => void useStore.getState().setSetting('ai.model', name);
  const empty = messages.length === 0;
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');

  return (
    <div className="as-chat">
      <header className="as-chat__head">
        <div className="as-chat__id">
          <span className="as-orb as-orb--sm" aria-hidden>
            <Sparkles size={16} />
          </span>
          <div>
            <h1 className="as-chat__title">Assistant</h1>
            <p className="as-chat__model">
              <span className="as-dot" data-on={!running} aria-hidden />
              {running ? 'Paused' : 'Local'} · <span className="num">{model}</span>
            </p>
          </div>
        </div>
        <div className="as-chat__actions">
          {status.models.length > 1 && (
            <label className="as-select">
              <span className="visually-hidden">Model</span>
              <select className="input" value={model} onChange={(e) => switchModel(e.target.value)} disabled={busy}>
                {status.models.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!empty && (
            <Button variant="ghost" size="sm" icon={<RotateCcw size={14} aria-hidden />} disabled={busy} onClick={() => setMessages([])}>
              New chat
            </Button>
          )}
          <IconButton label="Turn off local AI" onClick={() => void useStore.getState().setSetting('ai.enabled', false)}>
            <Power size={18} />
          </IconButton>
        </div>
      </header>

      <div className="as-log" role="log" aria-live="off" aria-label="Conversation">
        {empty ? (
          <motion.div className="as-welcome" initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={pick(reduce, spring.page)}>
            <span className="as-orb" aria-hidden>
              <Sparkles size={28} />
            </span>
            <h2 className="as-welcome__title">What’s on your mind tonight?</h2>
            <p className="as-welcome__body">Ask about your library. Answers are generated on this PC and may be imperfect — playtime and install data shown elsewhere in VYSTRAL are the verified source.</p>
            <div className="as-suggest" role="group" aria-label="Suggested questions">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="as-chip" disabled={running} onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </motion.div>
        ) : (
          messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="as-msg as-msg--user">
                <div className="as-bubble selectable">{m.content}</div>
              </div>
            ) : (
              <div key={m.id} className="as-msg as-msg--assistant" aria-busy={m.status === 'streaming'}>
                <span className="as-orb as-orb--xs" aria-hidden>
                  <Sparkles size={12} />
                </span>
                <div className="as-answer">
                  {m.status === 'streaming' && !m.content ? (
                    <div className="as-thinking" aria-label="Thinking">
                      <span />
                      <span />
                      <span />
                    </div>
                  ) : (
                    <div className="selectable">
                      <RichText text={m.content} streaming={m.status === 'streaming'} />
                    </div>
                  )}
                  {m.status === 'error' && (
                    <div className="as-answer__error" role="alert">
                      <TriangleAlert size={14} aria-hidden />
                      <span>{m.error ?? 'Something went wrong.'}</span>
                      {m === lastAssistant && (
                        <Button size="sm" variant="ghost" icon={<RefreshCw size={14} aria-hidden />} onClick={retry} disabled={running}>
                          Try again
                        </Button>
                      )}
                    </div>
                  )}
                  {m.status === 'stopped' && <div className="as-answer__stopped">Stopped</div>}
                  {m.status !== 'streaming' && m.content.trim() && (
                    <div className="as-answer__foot">
                      <span>Generated locally by <span className="num">{m.model}</span> — may be inaccurate; verified library data is shown in VYSTRAL.</span>
                      <IconButton size="sm" label="Copy answer" onClick={() => void copy(m.content)}>
                        <Copy size={14} />
                      </IconButton>
                    </div>
                  )}
                </div>
              </div>
            ),
          )
        )}
        <div ref={endRef} />
      </div>
      <div className="visually-hidden" aria-live="polite">{announce}</div>

      <div className="as-composer-wrap">
        <form
          className="as-composer"
          data-disabled={running}
          onSubmit={(e) => {
            e.preventDefault();
            send(draft);
          }}
        >
          <label htmlFor="as-input" className="visually-hidden">
            Message the assistant
          </label>
          <textarea
            id="as-input"
            ref={inputRef}
            className="as-composer__input"
            rows={1}
            value={draft}
            placeholder={running ? 'Paused while you play' : 'Ask about your games…'}
            disabled={running}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            maxLength={4000}
            data-autofocus
          />
          {busy ? (
            <IconButton label="Stop generating" className="as-composer__btn as-composer__btn--stop" onClick={() => void stop()} type="button">
              <Square size={14} fill="currentColor" />
            </IconButton>
          ) : (
            <IconButton label="Send" className="as-composer__btn" type="submit" disabled={!draft.trim() || running}>
              <ArrowUp size={18} />
            </IconButton>
          )}
        </form>
        <div className="as-composer__hint">
          <span>
            <Kbd>Enter</Kbd> send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> new line
          </span>
          <span className="as-composer__private">
            <Check size={12} aria-hidden /> Stays on this PC · can’t take actions
          </span>
        </div>
      </div>
    </div>
  );
}
