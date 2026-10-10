import { memo, useEffect, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUp, Copy, Lock, RefreshCw, Settings2, ShieldCheck, Square, TriangleAlert } from 'lucide-react';
import type { AssistantToolCall } from '../../bridge/types';
import { providerMark, suggestions, type ChatMessage } from '../../lib/assistant';
import { contextFromRoute } from '../../lib/assistant';
import { pick, spring } from '../../lib/motion';
import { useAiStatus } from '../../state/ai';
import { useAssistant } from '../../state/assistant';
import { useGameRunning, useReducedMotion, useStore } from '../../state/store';
import { RichText } from '../../views/assistant/RichText';
import { Button, IconButton, Kbd } from '../ui/primitives';
import { ServiceLogo } from '../ui/ServiceLogo';
import { ActionCard, ApprovalCard, AssistantCards } from './AssistantCards';
import { AssistantAvatar, Byline, SentNote, Thinking, ToolChips } from './AssistantBits';
import '../../views/assistant/assistant.css';
import './assistant-ui.css';

/**
 * Track D3: the one Assistant's conversation, used by the side panel (`compact`) and the full Assistant page. Streaming
 * text with a soft caret, sanitized markdown (React text only), look-up chips, rich cards, approvals before anything
 * goes to a cloud AI, and actions that wait for the user's click.
 */
export function AssistantChat({ compact }: { compact?: boolean }) {
  const messages = useAssistant((s) => s.conversation.messages);
  const busy = useAssistant((s) => !!s.activeRequest);
  const status = useAssistant((s) => s.status);
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastStatus = messages[messages.length - 1]?.status;

  const announce = lastStatus === 'done' ? 'Answer ready.' : lastStatus === 'error' ? 'The answer failed.' : lastStatus === 'stopped' ? 'Stopped.' : '';

  // Follow the stream while the reader is at the bottom.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const onScroll = () => { stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
  useEffect(() => { if (busy) stick.current = true; }, [busy]);

  const notReady = status && !status.engine.ready;
  return (
    <div className="asx-chat" data-compact={compact || undefined}>
      <div ref={logRef} className="asx-log" role="log" aria-live="off" aria-label="Conversation" tabIndex={-1}>
        {messages.length === 0 ? (
          notReady ? <SetupCard compact={compact} reason={status.engine.reason} /> : <Welcome compact={compact} />
        ) : (
          messages.map((m, i) =>
            m.role === 'user'
              ? <UserMessage key={m.id} m={m} />
              : <AssistantMessage key={m.id} m={m} last={i === messages.length - 1} compact={compact} />,
          )
        )}
      </div>
      <div className="visually-hidden" aria-live="polite">{announce}</div>
      <Composer compact={compact} disabledReason={notReady ? status.engine.reason ?? 'Set up an AI first.' : null} />
    </div>
  );
}

function Welcome({ compact }: { compact?: boolean }) {
  const reduce = useReducedMotion();
  const route = useStore((s) => s.route);
  const gamesById = useStore((s) => s.gamesById);
  const send = useAssistant((s) => s.send);
  const status = useAssistant((s) => s.status);
  const ctx = contextFromRoute(route as { name: string; id?: string; sessionId?: string });
  const game = ctx.gameId ? gamesById.get(ctx.gameId) : undefined;
  const prompts = suggestions(ctx, game?.title, !game || game.installations.some((i) => i.platform === 'steam'));
  return (
    <motion.div
      className="asx-welcome"
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={pick(reduce, spring.page)}
    >
      <AssistantAvatar provider={status?.engine.engine === 'none' ? null : status?.engine.engine} size="md" />
      <h2 className="asx-welcome__title">{game && !compact ? `Ask about ${game.title}, or anything else` : 'How can I help?'}</h2>
      <p className="asx-welcome__body">
        I can look things up across VYSTRAL: your library, play history, performance, storage, wishlist and more. I can also set up changes for you to confirm.
      </p>
      <div className="asx-suggest" role="group" aria-label="Suggestions">
        {prompts.map((p, i) => (
          <motion.button
            key={p}
            type="button"
            className="asx-suggestion"
            onClick={() => void send(p)}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...pick(reduce, spring.panel), delay: reduce ? 0 : 0.06 + i * 0.04 }}
          >
            {p}
          </motion.button>
        ))}
      </div>
    </motion.div>
  );
}

/** No AI is ready: the two ways to get one, without clutter. */
function SetupCard({ compact, reason }: { compact?: boolean; reason: string | null }) {
  const navigate = useStore((s) => s.navigate);
  const settingsReady = useStore((s) => s.settings != null);
  const ai = useAiStatus();
  const go = () => {
    useAssistant.getState().closePanel();
    navigate({ name: 'settings', section: 'ai' });
  };
  return (
    <div className="asx-setup" data-compact={compact || undefined}>
      <AssistantAvatar size="md" />
      <h2 className="asx-welcome__title">Choose an AI for the Assistant</h2>
      <p className="asx-welcome__body">
        {reason ?? 'The Assistant is off until you choose an AI.'} Use local AI on this PC, or your own key for a cloud AI.
      </p>
      <ul className="asx-setup__options">
        <li>
          <ServiceLogo service="ollama" size={20} decorative />
          <span><strong>Local AI</strong><span>Ollama on this PC. Nothing leaves your computer.</span></span>
        </li>
        <li>
          <span className="asx-setup__marks" aria-hidden>
            <ServiceLogo service="claude" size={18} decorative brand />
            <ServiceLogo service="openai" size={18} decorative />
            <ServiceLogo service="gemini" size={18} decorative brand />
          </span>
          <span><strong>Claude, ChatGPT or Gemini</strong><span>Your own API key. You see what’s sent before it’s sent.</span></span>
        </li>
      </ul>
      <Button variant="primary" icon={<Settings2 size={15} aria-hidden />} onClick={go} disabled={!settingsReady}>
        Set up AI
      </Button>
      {ai?.localOnly && <p className="asx-setup__note"><Lock size={12} aria-hidden /> Offline mode is on, so cloud AI is paused.</p>}
    </div>
  );
}

const UserMessage = memo(function UserMessage({ m }: { m: ChatMessage }) {
  return (
    <div className="asx-msg asx-msg--user">
      <div className="asx-bubble selectable">{m.content}</div>
    </div>
  );
});

function runningLabel(tools: AssistantToolCall[] | undefined): string | null {
  const t = tools?.find((x) => x.status === 'running');
  return t ? `${t.label}…` : null;
}

const AssistantMessage = memo(function AssistantMessage({ m, last, compact }: { m: ChatMessage; last: boolean; compact?: boolean }) {
  const toast = useStore((s) => s.toast);
  const navigate = useStore((s) => s.navigate);
  const { approve, runAction, dismissAction, retry } = useAssistant.getState();
  const busy = useAssistant((s) => !!s.activeRequest);
  const streaming = m.status === 'streaming';
  const working = runningLabel(m.tools);
  const waitingForUser = m.approval?.state === 'pending';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.content);
      toast({ tone: 'success', title: 'Copied' });
    } catch {
      toast({ tone: 'warning', title: 'Couldn’t copy to the clipboard' });
    }
  };
  return (
    <div className="asx-msg asx-msg--ai" aria-busy={streaming}>
      <AssistantAvatar provider={m.provider} />
      <div className="asx-answer">
        {m.note && <p className="asx-note" role="note">{m.note}</p>}
        {m.content ? (
          <div className="selectable"><RichText text={m.content} streaming={streaming && !working && !waitingForUser} /></div>
        ) : streaming && !waitingForUser ? (
          <Thinking label={working} />
        ) : null}
        {m.content && streaming && working && <Thinking label={working} />}
        {m.cards && m.cards.length > 0 && <AssistantCards cards={m.cards} compact={compact} />}
        {m.approval && <ApprovalCard approval={m.approval} onAnswer={(allow, always) => void approve(allow, always)} />}
        <AnimatePresence initial={false}>
          {m.actions?.map((a) => (
            <motion.div key={a.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }}>
              <ActionCard action={a} onConfirm={() => void runAction(m.id, a.id)} onDismiss={() => dismissAction(m.id, a.id)} />
            </motion.div>
          ))}
        </AnimatePresence>
        {m.notices?.map((n) => <p key={n} className="asx-note" role="note">{n}</p>)}
        {m.status === 'error' && (
          <div className="asx-error" role="alert">
            <TriangleAlert size={14} aria-hidden />
            <span>{m.error ?? 'Something went wrong.'}</span>
            {m.setup ? (
              <Button size="sm" variant="secondary" icon={<Settings2 size={13} aria-hidden />} onClick={() => { useAssistant.getState().closePanel(); navigate({ name: 'settings', section: 'ai' }); }}>
                Set up AI
              </Button>
            ) : last && (
              <Button size="sm" variant="ghost" icon={<RefreshCw size={13} aria-hidden />} onClick={retry} disabled={busy}>Try again</Button>
            )}
          </div>
        )}
        {m.status === 'stopped' && <p className="asx-stopped">Stopped</p>}
        {!streaming && <ToolChips tools={m.tools ?? []} />}
        {m.status !== 'streaming' && m.status !== 'error' && (m.content || m.tools?.length) ? (
          <div className="asx-foot">
            <Byline provider={m.provider} engine={m.engine} cloud={m.cloud} />
            <SentNote sent={m.cloud ? m.sent : null} />
            <span className="asx-foot__tools">
              {m.content && <IconButton size="sm" label="Copy answer" onClick={() => void copy()}><Copy size={14} /></IconButton>}
              {last && <IconButton size="sm" label="Ask again" onClick={retry} disabled={busy}><RefreshCw size={14} /></IconButton>}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
});

function Composer({ compact, disabledReason }: { compact?: boolean; disabledReason: string | null }) {
  const draft = useAssistant((s) => s.draft);
  const setDraft = useAssistant((s) => s.setDraft);
  const send = useAssistant((s) => s.send);
  const stop = useAssistant((s) => s.stop);
  const busy = useAssistant((s) => !!s.activeRequest);
  const focusTick = useAssistant((s) => s.focusTick);
  const status = useAssistant((s) => s.status);
  const ai = useAiStatus();
  const running = useGameRunning();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const engine = status?.engine;
  const localPaused = running && engine?.engine === 'local';
  const disabled = !!disabledReason || localPaused;

  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, [focusTick]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, compact ? 140 : 200)}px`;
  }, [draft, compact]);

  const submit = () => {
    if (!draft.trim() || busy || disabled) return;
    void send();
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  const company = engine?.cloud ? ai?.providers.find((p) => p.id === engine.engine)?.company : null;
  const mark = engine && engine.engine !== 'none' ? providerMark(engine.engine) : null;
  return (
    <div className="asx-composer-wrap">
      <form className="asx-composer" data-disabled={disabled || undefined} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label htmlFor={compact ? 'asx-input-panel' : 'asx-input'} className="visually-hidden">Message the Assistant</label>
        <textarea
          id={compact ? 'asx-input-panel' : 'asx-input'}
          ref={inputRef}
          className="asx-composer__input"
          rows={1}
          value={draft}
          placeholder={disabledReason ? 'Set up an AI to start' : localPaused ? 'Local AI is paused while you play' : 'Ask anything about your games…'}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={4000}
        />
        {busy ? (
          <IconButton label="Stop" className="asx-send asx-send--stop" onClick={() => void stop()} type="button">
            <Square size={13} fill="currentColor" />
          </IconButton>
        ) : (
          <IconButton label="Send" className="asx-send" type="submit" disabled={!draft.trim() || disabled}>
            <ArrowUp size={17} />
          </IconButton>
        )}
      </form>
      <div className="asx-hint">
        {engine?.ready ? (
          engine.cloud ? (
            <span>
              {mark && <ServiceLogo service={mark} size={12} decorative />}
              Messages go to {company ?? 'the cloud AI'}; you approve look-ups first{status?.askBeforeSharing === false ? ' (off in Settings)' : ''}
            </span>
          ) : (
            <span><ShieldCheck size={12} aria-hidden /> Stays on this PC</span>
          )
        ) : <span />}
        {!compact && <span><Kbd>Enter</Kbd> send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> new line</span>}
      </div>
    </div>
  );
}
