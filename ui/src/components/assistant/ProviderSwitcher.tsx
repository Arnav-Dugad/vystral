import { useRef, useState } from 'react';
import { ChevronDown, Settings2 } from 'lucide-react';
import type { AiProviderChoice, CloudAiProviderId, Settings } from '../../bridge/types';
import { providerMark } from '../../lib/assistant';
import { useAiStatus } from '../../state/ai';
import { useAssistant } from '../../state/assistant';
import { useStore } from '../../state/store';
import { Menu, type MenuEntry } from '../ui/Menu';
import { ServiceLogo } from '../ui/ServiceLogo';

const LOCAL_LABEL = 'Local AI';

/**
 * Track D3: which AI answers, with its real mark, and a menu to switch provider or model. Choosing a provider that isn't
 * set up yet goes to Settings → AI (keys and consent live there, never here).
 */
export function ProviderSwitcher({ compact }: { compact?: boolean }) {
  const status = useAiStatus();
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const navigate = useStore((s) => s.navigate);
  const busy = useAssistant((s) => !!s.activeRequest);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  if (!status || !settings) return null;

  const provider = status.provider;
  const cloud = provider === 'local' ? null : status.providers.find((p) => p.id === provider) ?? null;
  const mark = providerMark(provider, cloud?.baseUrl);
  const label = !status.active.ready && status.active.engine === 'none' ? 'Choose an AI'
    : provider === 'local' ? `${LOCAL_LABEL} · ${settings['ai.model']}` : cloud ? cloud.modelLabel || cloud.name : 'AI';

  const ready = (id: AiProviderChoice) => {
    if (id === 'local') return status.localEnabled;
    const p = status.providers.find((x) => x.id === id);
    return !!p && p.configured && p.optedIn && !status.localOnly;
  };
  const toSettings = () => {
    useAssistant.getState().closePanel();
    navigate({ name: 'settings', section: 'ai' });
  };
  const choose = (id: AiProviderChoice) => (ready(id) ? void setSetting('ai.provider', id) : toSettings());

  const providers: { id: AiProviderChoice; name: string }[] = [
    { id: 'local', name: LOCAL_LABEL },
    ...status.providers.map((p) => ({ id: p.id as AiProviderChoice, name: p.name })),
  ];
  const models = provider === 'local' ? [] : (cloud?.models ?? []).slice(0, 8);
  const entries: MenuEntry[] = [
    { kind: 'label', label: 'Who answers' },
    ...providers.map((p): MenuEntry => ({
      label: p.name,
      icon: <ServiceLogo service={providerMark(p.id, p.id === 'compatible' ? status.providers.find((x) => x.id === 'compatible')?.baseUrl : null) ?? 'ollama'} size={16} decorative />,
      hint: p.id === provider ? 'In use' : ready(p.id) ? (p.id === 'local' ? 'On this PC' : 'Ready') : status.localOnly && p.id !== 'local' ? 'Offline' : 'Set up…',
      onSelect: () => choose(p.id),
    })),
  ];
  if (models.length > 1 && cloud) {
    entries.push({ kind: 'separator' }, { kind: 'label', label: 'Model' });
    for (const m of models)
      entries.push({
        label: m === cloud.model ? `${labelFor(m)} ✓` : labelFor(m),
        onSelect: () => void setSetting(`ai.cloud.${cloud.id as CloudAiProviderId}.model` as keyof Settings, m as never),
      });
  }
  entries.push({ kind: 'separator' }, { label: 'AI settings…', icon: <Settings2 size={16} />, onSelect: toSettings });

  const open = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setAt({ x: r.left, y: r.bottom + 6 });
  };

  return (
    <>
      <button
        ref={ref}
        type="button"
        className="asx-switch"
        data-compact={compact || undefined}
        aria-haspopup="menu"
        aria-expanded={!!at}
        disabled={busy}
        onClick={open}
        title={status.active.reason ?? `Answers come from ${status.active.label}`}
      >
        {mark && status.active.engine !== 'none' ? <ServiceLogo service={mark} size={16} decorative brand /> : null}
        <span className="asx-switch__label">{label}</span>
        <span className="visually-hidden">: change AI</span>
        <ChevronDown size={14} aria-hidden />
      </button>
      <Menu at={at} entries={entries} onClose={() => setAt(null)} label="Choose the AI" />
    </>
  );
}

function labelFor(model: string) {
  return ({ 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-haiku-4-5-20251001': 'Claude Haiku 4.5' } as Record<string, string>)[model] ?? model;
}
