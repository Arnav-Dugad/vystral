import { useCallback, useEffect, useReducer, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Bot, Download, ExternalLink, MessageSquarePlus, Pause, Power, RefreshCw, Trash2, TriangleAlert, WifiOff } from 'lucide-react';
import type { AiStatus } from '../bridge/types';
import { call, errorMessage, on } from '../bridge/bridge';
import { Badge, Button, IconButton, ProgressBar, Skeleton } from '../components/ui/primitives';
import { Dialog } from '../components/ui/Dialog';
import { ServiceLogo } from '../components/ui/ServiceLogo';
import { AssistantChat } from '../components/assistant/AssistantChat';
import { AssistantAvatar } from '../components/assistant/AssistantBits';
import { ProviderSwitcher } from '../components/assistant/ProviderSwitcher';
import { useAssistant } from '../state/assistant';
import { useGameRunning, useStore } from '../state/store';
import { formatRelative } from '../lib/format';
import { IDLE_PULL, describePull, formatModelBytes, reducePull, type PullEvent, type PullState } from './assistant/chat';
import './assistant/assistant.css';
import '../components/assistant/assistant-ui.css';

const OLLAMA_URL = 'https://ollama.com/download';

/**
 * The Assistant page (Track D3: the one Assistant). The same conversation as the side panel, with the conversation list
 * on the left. When local AI is chosen, Ollama's own setup (running? model installed?) is checked first.
 */
export function AssistantView() {
  const settingsLoaded = useStore((s) => s.settings != null);
  const provider = useStore((s) => s.settings?.['ai.provider'] ?? 'local');
  const localOn = useStore((s) => s.settings?.['ai.enabled'] ?? false);
  const modelSetting = useStore((s) => s.settings?.['ai.model'] ?? '');
  const running = useGameRunning();
  const engine = useAssistant((s) => s.status?.engine);
  const [ollama, setOllama] = useState<AiStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const localPath = provider === 'local' || engine?.engine === 'local';

  useEffect(() => {
    void useAssistant.getState().refreshStatus();
    void useAssistant.getState().loadList();
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOllama(await call<AiStatus>('ai.status', undefined, 20_000));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (localOn && localPath) void refresh();
  }, [localOn, localPath, modelSetting, refresh]);

  let gate: ReactNode = null;
  if (!settingsLoaded) gate = <Skeleton height={320} radius={22} />;
  else if (localOn && localPath) {
    if (error && !ollama) gate = <Problem title="Couldn’t check local AI" detail={error} onRetry={refresh} retrying={loading} />;
    else if (!ollama) gate = <Skeleton height={320} radius={22} />;
    else if (!ollama.running) gate = <NotRunning status={ollama} onRetry={refresh} retrying={loading} />;
    else if (!ollama.selectedModelInstalled) gate = <ModelSetup status={ollama} onRefresh={refresh} />;
  }

  return (
    <div className="page asx-page">
      <ConversationRail />
      <section className="asx-page__main" aria-labelledby="asx-page-title">
        <header className="asx-page__head">
          <div className="asx-page__id">
            <AssistantAvatar size="sm" provider={engine && engine.engine !== 'none' ? engine.engine : null} />
            <h1 id="asx-page-title" className="asx-page__title">Assistant</h1>
            <ProviderSwitcher />
          </div>
          <NewChatButton />
        </header>
        {localOn && localPath && running && (
          <div className="as-paused" role="status" style={{ margin: 'var(--s-4) var(--s-6) 0' }}>
            <Pause size={16} aria-hidden />
            <span>
              <strong>Local AI is paused while you play.</strong> It resumes when your game closes, so it never competes with the game for your GPU.
            </span>
          </div>
        )}
        {gate ? <div className="asx-page__gate">{gate}</div> : <AssistantChat />}
      </section>
    </div>
  );
}

function NewChatButton() {
  const newChat = useAssistant((s) => s.newChat);
  const has = useAssistant((s) => s.conversation.messages.length > 0);
  const busy = useAssistant((s) => !!s.activeRequest);
  if (!has) return null;
  return (
    <Button size="sm" variant="secondary" icon={<MessageSquarePlus size={15} aria-hidden />} onClick={newChat} disabled={busy}>
      New chat
    </Button>
  );
}

/** Saved conversations (on this PC only, when Settings → AI → Keep conversations is on). */
function ConversationRail() {
  const list = useAssistant((s) => s.list);
  const current = useAssistant((s) => s.conversation.id);
  const keep = useAssistant((s) => s.status?.keepHistory ?? true);
  const { open, remove } = useAssistant.getState();
  return (
    <nav className="asx-page__rail" aria-label="Conversations">
      <div className="asx-page__railhead">
        <h2 className="asx-page__railtitle">Conversations</h2>
      </div>
      {list.length === 0 ? (
        <p className="asx-convs__empty">{keep ? 'Your conversations will appear here. They stay on this PC.' : 'Conversations aren’t kept (Settings → AI).'}</p>
      ) : (
        <ul className="asx-convs">
          <AnimatePresence initial={false}>
            {list.map((c) => (
              <motion.li
                key={c.id}
                className="asx-conv"
                aria-current={c.id === current ? 'true' : undefined}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16 }}
              >
                <button type="button" className="asx-conv__open" onClick={() => void open(c.id)}>
                  <span className="asx-conv__title">{c.title || 'Untitled'}</span>
                  <span className="asx-conv__when">{formatRelative(c.updatedAt)}</span>
                </button>
                <IconButton size="sm" className="asx-conv__del" label={`Delete “${c.title || 'Untitled'}”`} onClick={() => void remove(c.id)}>
                  <Trash2 size={14} />
                </IconButton>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </nav>
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

