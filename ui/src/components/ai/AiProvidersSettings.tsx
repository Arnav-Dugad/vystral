import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { NewBadge } from '../../whatsnew/NewBadge';
import { AlertTriangle, CheckCircle2, CloudOff, Cpu, ExternalLink, KeyRound, Lock, PauseCircle, RefreshCw, ShieldCheck, Sparkles, Unplug } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { AiCloudStatus, AiFeature, AiProviderChoice, CloudAiAction, CloudAiProviderId, CloudAiProviderStatus, CloudAiTest, Settings } from '../../bridge/types';
import { formatRelative } from '../../lib/format';
import { useAiStatus, useAiStore } from '../../state/ai';
import { useStore } from '../../state/store';
import { Badge, Button, Skeleton, Toggle } from '../ui/primitives';
import { Dialog } from '../ui/Dialog';
import { HoldToConfirm } from '../controller/HoldToConfirm';
import './ai.css';

const MARK: Record<CloudAiProviderId, string> = { anthropic: 'C', openai: 'O', gemini: 'G', compatible: '{ }' };
const KEY_HINT: Record<CloudAiProviderId, string> = {
  anthropic: 'Starts with “sk-ant-”. Create one in the Anthropic Console.',
  openai: 'Starts with “sk-”. Create one on the OpenAI platform.',
  gemini: 'Starts with “AIza”. Create one in Google AI Studio.',
  compatible: 'The key for the service at the address above (OpenRouter, Groq, Together, a self-hosted server…).',
};

type ChoiceState = { tone: 'ok' | 'warn' | 'off'; text: string };

function choiceState(id: AiProviderChoice, st: AiCloudStatus): ChoiceState {
  if (id === 'local') return st.localEnabled ? { tone: 'ok', text: 'On this PC' } : { tone: 'off', text: 'Turned off' };
  const p = st.providers.find((x) => x.id === id)!;
  if (!p.configured) return { tone: 'off', text: 'Needs a key' };
  if (!p.optedIn) return { tone: 'warn', text: 'Not turned on' };
  if (st.localOnly) return { tone: 'warn', text: 'Paused offline' };
  return { tone: 'ok', text: 'Ready' };
}

/**
 * Settings → AI → "AI providers": pick what powers AI features (local Ollama or one cloud provider with your own key),
 * connect keys (kept only in Windows Credential Manager; the page only ever sees "…1234"), opt in per provider after
 * reading exactly what's sent, test, choose models, and switch individual AI features on or off.
 */
export function AiProvidersSettings() {
  const status = useAiStatus();
  const error = useAiStore((s) => s.error);
  const setSetting = useStore((s) => s.setSetting);

  if (!status)
    return (
      <section className="sgroup ai-set" aria-label="AI providers" aria-busy={!error}>
        <h2 className="sgroup__title">AI providers <Badge>Optional</Badge></h2>
        {error ? <p className="sgroup__desc" role="alert">{error}</p> : <Skeleton height={180} radius={16} />}
      </section>
    );

  const choices: { id: AiProviderChoice; name: string; sub: string }[] = [
    { id: 'local', name: 'Local AI', sub: 'Ollama on this PC' },
    ...status.providers.map((p) => ({ id: p.id as AiProviderChoice, name: p.name, sub: p.company === 'the endpoint you entered' ? 'Your endpoint' : p.company })),
  ];
  const choose = (id: AiProviderChoice) => void setSetting('ai.provider', id);
  const onKey = (e: KeyboardEvent<HTMLElement>, i: number) => {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = choices[(i + delta + choices.length) % choices.length];
    choose(next.id);
    (e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]')[(i + delta + choices.length) % choices.length])?.focus();
  };

  return (
    <section className="sgroup ai-set" aria-labelledby="ai-set-title" id="ai-providers">
      <h2 className="sgroup__title" id="ai-set-title">AI providers <Badge>Optional</Badge><NewBadge k="settings.ai.cloud" variant="pill" seenWhenVisible /></h2>
      <p className="sgroup__desc">
        Use Claude, ChatGPT, Gemini or any OpenAI-compatible service with <strong>your own API key</strong> instead of local AI. Cloud AI is off until you turn a
        provider on, and then it sends that company only what a feature needs. Each feature below says exactly what. Everything in VYSTRAL works without AI.
      </p>

      {status.localOnly && (
        <div className="surface ai-set__notice" role="status">
          <CloudOff size={18} aria-hidden />
          <div>
            <strong>Offline mode is on</strong>
            <span>Cloud AI is paused and nothing is sent. Local AI and VYSTRAL’s own answers still work.</span>
          </div>
        </div>
      )}

      <div className="ai-choice" role="radiogroup" aria-label="Which AI powers AI features">
        {choices.map((c, i) => {
          const st = choiceState(c.id, status);
          const checked = status.provider === c.id;
          return (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              className="ai-choice__item surface"
              onClick={() => choose(c.id)}
              onKeyDown={(e) => onKey(e, i)}
            >
              <span className="ai-choice__mark" aria-hidden>{c.id === 'local' ? <Cpu size={16} /> : MARK[c.id]}</span>
              <span className="ai-choice__text">
                <span className="ai-choice__name">{c.name}</span>
                <span className="ai-choice__sub">{c.sub}</span>
              </span>
              <span className="ai-choice__state" data-tone={st.tone}>{st.text}</span>
            </button>
          );
        })}
      </div>

      <p className="ai-set__now" role="status" data-ready={status.active.ready || undefined}>
        {status.active.ready ? <CheckCircle2 size={15} aria-hidden /> : <PauseCircle size={15} aria-hidden />}
        <span>
          {status.active.ready ? <>AI features use <strong>{status.active.label}</strong>{status.active.cloud ? ' (cloud).' : ' (on this PC).'}</> : <>AI features are using VYSTRAL’s own answers.</>}
          {status.active.reason && <> {status.active.reason}</>}
        </span>
      </p>

      <h3 className="dsrc__subhead">Cloud providers</h3>
      <div className="dsrc__grid">
        {status.providers.map((p) => <ProviderCard key={p.id} p={p} status={status} />)}
      </div>

      <h3 className="dsrc__subhead">AI features</h3>
      <div className="sgroup__rows surface">
        {status.features.map((f) => <FeatureRow key={f.id} f={f} />)}
      </div>

      <p className="dsrc__footnote">
        <Lock size={13} aria-hidden /> Keys are stored only in Windows Credential Manager (as “VYSTRAL/AI-&lt;provider&gt;”), never in VYSTRAL’s database,
        settings, logs or this page. VYSTRAL sends at most 30 requests every 10 minutes and 400 a day to a provider, gives each request 60 seconds, never
        follows redirects with your key, and never sends file paths, notes, other keys or anything a feature doesn’t list. Your provider may charge for use.
      </p>
    </section>
  );
}

function FeatureRow({ f }: { f: AiFeature }) {
  const setSetting = useStore((s) => s.setSetting);
  const id = `ai-feature-${f.id}`;
  return (
    <div className="srow">
      <div className="srow__text">
        <label className="srow__label" htmlFor={id}>{f.label}</label>
        <div className="srow__hint"><strong>Sends:</strong> {f.sends} <span className="ai-set__without">Without AI: {f.withoutAi}</span></div>
      </div>
      <div className="srow__control">
        <Toggle id={id} label={f.label} checked={f.enabled} onChange={(v) => void setSetting(`ai.features.${f.id}` as keyof Settings, v as never)} />
      </div>
    </div>
  );
}

const OUTCOME: Record<CloudAiTest['outcome'], { tone: 'ok' | 'warn' | 'danger'; title: string }> = {
  ok: { tone: 'ok', title: 'Working' },
  invalidKey: { tone: 'danger', title: 'Key not accepted' },
  notConfigured: { tone: 'warn', title: 'No key yet' },
  rateLimited: { tone: 'warn', title: 'Asked to slow down' },
  unavailable: { tone: 'warn', title: 'Couldn’t be reached' },
  malformed: { tone: 'warn', title: 'Something didn’t fit' },
  offline: { tone: 'warn', title: 'Offline mode is on' },
  disabled: { tone: 'warn', title: 'Turned off' },
};

function ProviderCard({ p, status }: { p: CloudAiProviderStatus; status: AiCloudStatus }) {
  const toast = useStore((s) => s.toast);
  const setSetting = useStore((s) => s.setSetting);
  const features = status.features.filter((f) => f.enabled);
  const [busy, setBusy] = useState<'connect' | 'test' | 'models' | 'disconnect' | null>(null);
  const [result, setResult] = useState<CloudAiTest | null>(null);
  const [consent, setConsent] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const shown = result ?? p.lastTest;
  const headingId = `ai-card-${p.id}`;
  const state = !p.configured ? 'off' : p.optedIn ? 'on' : 'paused';
  const refresh = () => useAiStore.getState().refresh();

  const act = async (kind: 'connect' | 'test', method: string, params: unknown) => {
    setBusy(kind);
    try {
      const r = await call<CloudAiAction>(method, params, 90_000);
      setResult(r.result);
      await refresh();
      return r;
    } catch (err) {
      toast({ tone: 'danger', title: p.name, body: errorMessage(err) });
      return null;
    } finally {
      setBusy(null);
    }
  };

  const loadModels = async () => {
    setBusy('models');
    try {
      await call('aiCloud.models', { provider: p.id }, 60_000);
      await refresh();
    } catch (err) {
      toast({ tone: 'danger', title: `Couldn’t list ${p.name} models`, body: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setConfirmDisconnect(false);
    setBusy('disconnect');
    try {
      await call('aiCloud.disconnect', { provider: p.id });
      setResult(null);
      await refresh();
      toast({ tone: 'success', title: `${p.name} disconnected`, body: 'The key was removed from Windows Credential Manager.' });
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t disconnect', body: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const optIn = async () => {
    setConsent(false);
    await setSetting(`ai.cloud.${p.id}.optIn` as keyof Settings, true as never);
    await setSetting('ai.provider', p.id);
  };

  return (
    <article className="dsrc-card surface ai-card" data-state={state} aria-labelledby={headingId}>
      <header className="dsrc-card__head">
        <span className="dsrc-card__mark" aria-hidden>{MARK[p.id]}</span>
        <div className="dsrc-card__title">
          <h4 id={headingId}>{p.name}</h4>
          <span className="dsrc-card__access">{p.id === 'compatible' ? 'Any OpenAI-compatible HTTPS endpoint' : `${p.company} · your key`}</span>
        </div>
        <span className="ai-pill" data-tone={state === 'on' ? (status.localOnly ? 'warn' : 'ok') : state === 'paused' ? 'warn' : 'off'}>
          {state === 'on' ? (status.localOnly ? 'Paused' : 'On') : state === 'paused' ? 'Key saved' : 'Not set up'}
        </span>
      </header>

      {p.pausedUntil && Date.parse(p.pausedUntil) > Date.now() && (
        <p className="dsrc-card__hint" role="status"><PauseCircle size={13} aria-hidden /> {p.name} asked VYSTRAL to pause until {new Date(p.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</p>
      )}

      {!p.configured && (
        <ConnectForm p={p} disabled={status.localOnly} busy={busy === 'connect'} onConnect={(key, baseUrl) => act('connect', 'aiCloud.connect', { provider: p.id, key, baseUrl })} />
      )}

      {p.configured && (
        <>
          <div className="dsrc-card__keyrow">
            <KeyRound size={14} aria-hidden />
            <span>Saved · ends in <span className="num">{p.keyMasked ?? '…'}</span> · Windows Credential Manager</span>
          </div>
          {p.baseUrl && <p className="ai-card__url num">{p.baseUrl}</p>}
          <ModelPicker p={p} busy={busy === 'models'} onLoad={loadModels} />
          <div className="ai-card__optin">
            <div>
              <label htmlFor={`ai-optin-${p.id}`} className="ai-card__optin-label">Send data to {p.name}</label>
              <span className="ai-card__optin-hint">{p.optedIn ? 'Only for the AI features that are on, and never while Offline mode is on.' : 'Off. Nothing is sent until you turn this on.'}</span>
            </div>
            <Toggle
              id={`ai-optin-${p.id}`}
              label={`Send data to ${p.name}`}
              checked={p.optedIn}
              onChange={(v) => (v ? setConsent(true) : void setSetting(`ai.cloud.${p.id}.optIn` as keyof Settings, false as never))}
            />
          </div>
        </>
      )}

      <div className="dsrc-card__actions">
        {p.configured && (
          <Button size="sm" loading={busy === 'test'} disabled={status.localOnly || !!busy} icon={<RefreshCw size={14} />} onClick={() => void act('test', 'aiCloud.test', { provider: p.id })}>
            Test
          </Button>
        )}
        {p.configured && (
          <Button size="sm" variant="ghost" loading={busy === 'disconnect'} disabled={!!busy} icon={<Unplug size={14} />} onClick={() => setConfirmDisconnect(true)}>Disconnect</Button>
        )}
        {p.id !== 'compatible' && (
          <Button size="sm" variant="ghost" icon={<ExternalLink size={14} />} onClick={() => void call('aiCloud.openLink', { provider: p.id, link: p.configured ? 'privacy' : 'keys' }).catch(() => undefined)}>
            {p.configured ? 'Privacy policy' : 'Get a key'}
          </Button>
        )}
      </div>

      {shown && (
        <p className={`dsrc-card__result dsrc-card__result--${OUTCOME[shown.outcome].tone}`} role="status">
          {OUTCOME[shown.outcome].tone === 'ok' ? <CheckCircle2 size={14} aria-hidden /> : <AlertTriangle size={14} aria-hidden />}
          <span><strong>{OUTCOME[shown.outcome].title}.</strong> {shown.message} <span className="dsrc-card__when">{formatRelative(shown.at)}</span></span>
        </p>
      )}

      <Dialog
        open={consent}
        onClose={() => setConsent(false)}
        title={`Send data to ${p.name}?`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConsent(false)}>Not now</Button>
            <Button variant="primary" icon={<ShieldCheck size={15} />} onClick={() => void optIn()}>Turn on and use {p.name}</Button>
          </>
        }
      >
        <div className="ai-consent">
          <p>
            AI features will send the data below to <strong>{p.company}</strong> ({p.host}) using your key, and {p.company === 'the endpoint you entered' ? 'that service’s' : `${p.company}’s`} terms
            and privacy policy apply. Your provider may charge for each request.
          </p>
          <h4>What each feature sends</h4>
          {features.length ? (
            <ul>
              {features.map((f) => <li key={f.id}><strong>{f.label}:</strong> {f.sends}</li>)}
            </ul>
          ) : <p>All AI features are switched off, so nothing will be sent until you turn one on.</p>}
          <h4>Never sent</h4>
          <p>File paths, notes, store accounts, other API keys, Steam IDs, or anything a feature doesn’t list. Nothing is sent while Offline mode is on, and you can turn this off at any time.</p>
        </div>
      </Dialog>

      <Dialog
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        title={`Disconnect ${p.name}?`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmDisconnect(false)}>Keep it</Button>
            <HoldToConfirm icon={<Unplug size={14} />} onConfirm={() => void disconnect()}>Disconnect</HoldToConfirm>
          </>
        }
      >
        The key is deleted from Windows Credential Manager and {p.name} is turned off. Saved summaries and captions stay on this PC.
      </Dialog>
    </article>
  );
}

function ConnectForm({ p, disabled, busy, onConnect }: { p: CloudAiProviderStatus; disabled: boolean; busy: boolean; onConnect: (key: string, baseUrl?: string) => Promise<CloudAiAction | null> }) {
  const [key, setKey] = useState('');
  const [url, setUrl] = useState('');
  const keyId = useId();
  const urlId = useId();
  const hintId = useId();
  const urlOk = p.id !== 'compatible' || /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\-/]*)?$/.test(url.trim());
  const ready = key.trim().length >= 16 && urlOk;
  return (
    <form
      className="ai-connect"
      onSubmit={(e) => {
        e.preventDefault();
        // The pasted key is cleared once it's saved; a rejected key stays so it can be corrected.
        if (ready && !busy) void onConnect(key.trim(), p.id === 'compatible' ? url.trim() : undefined).then((r) => r?.result.outcome === 'ok' && setKey(''));
      }}
    >
      {p.id === 'compatible' && (
        <>
          <label htmlFor={urlId} className="ai-connect__label">Address</label>
          <input
            id={urlId}
            className="input"
            inputMode="url"
            placeholder="https://openrouter.ai/api/v1"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            disabled={disabled || busy}
            aria-invalid={url.length > 0 && !urlOk ? true : undefined}
          />
          {url.length > 0 && !urlOk && <span className="ai-connect__err">Use an https:// address without a password, “?” or “#”.</span>}
        </>
      )}
      <label htmlFor={keyId} className="ai-connect__label">API key</label>
      <div className="ai-connect__row">
        <input
          id={keyId}
          className="input"
          type="password"
          placeholder="Paste your key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          disabled={disabled || busy}
          aria-describedby={hintId}
        />
        <Button size="sm" variant="primary" type="submit" loading={busy} disabled={disabled || !ready}>Save key</Button>
      </div>
      <span id={hintId} className="ai-connect__hint">
        {disabled ? 'Turn off Offline mode to check and save a key.' : KEY_HINT[p.id]} The key is checked with {p.company === 'the endpoint you entered' ? 'the service' : p.company} (a free models list) before it’s saved.
      </span>
    </form>
  );
}

function ModelPicker({ p, busy, onLoad }: { p: CloudAiProviderStatus; busy: boolean; onLoad: () => void }) {
  const setSetting = useStore((s) => s.setSetting);
  const id = useId();
  const key = `ai.cloud.${p.id}.model` as keyof Settings;
  const [typed, setTyped] = useState(p.model);
  useEffect(() => setTyped(p.model), [p.model]);
  const options = p.models.includes(p.model) || !p.model ? p.models : [p.model, ...p.models];
  return (
    <div className="ai-model">
      <label htmlFor={id} className="ai-connect__label">Model</label>
      <div className="ai-connect__row">
        {options.length > 0 ? (
          <select id={id} className="input" value={p.model} onChange={(e) => void setSetting(key, e.target.value as never)}>
            {options.map((m) => (
              <option key={m} value={m}>
                {p.id === 'anthropic' ? `${m === 'claude-sonnet-5-5' ? 'Claude Sonnet 5.5 (recommended)' : m === 'claude-opus-5-5' ? 'Claude Opus 5.5 (most capable)' : 'Claude Haiku 4.5 (fastest)'}` : m}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={id}
            className="input"
            value={typed}
            placeholder="Model name"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
            onBlur={() => typed.trim() !== p.model && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(typed.trim()) && void setSetting(key, typed.trim() as never)}
          />
        )}
        {p.id !== 'anthropic' && (
          <Button size="sm" variant="ghost" loading={busy} icon={<Sparkles size={14} />} onClick={onLoad}>{p.modelsListed ? 'Refresh list' : 'Load models'}</Button>
        )}
      </div>
      {p.id !== 'anthropic' && !p.modelsListed && <span className="ai-connect__hint">Using {p.model || 'no model yet'}. Load the list to choose another.</span>}
    </div>
  );
}
