import { useEffect, useId, useState } from 'react';
import { ChevronDown, Lock, Trash2 } from 'lucide-react';
import type { Settings } from '../../bridge/types';
import { useAssistant } from '../../state/assistant';
import { useStore } from '../../state/store';
import { HoldToConfirm } from '../controller/HoldToConfirm';
import { Badge, Kbd, Toggle } from '../ui/primitives';
import { TOOL_ICONS } from './toolIcons';
import './assistant-ui.css';

/**
 * Track D3: Settings → AI → Assistant. The button on every page, asking before look-ups go to a cloud AI, keeping
 * conversations, and the full list of what the Assistant can look up and the changes it can prepare.
 */
export function AssistantSettings() {
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const status = useAssistant((s) => s.status);
  const list = useAssistant((s) => s.list);
  const [open, setOpen] = useState(false);
  const listId = useId();

  useEffect(() => {
    void useAssistant.getState().refreshStatus();
    void useAssistant.getState().loadList();
  }, []);

  if (!settings) return null;
  const row = (k: keyof Settings, label: string, hint: React.ReactNode) => (
    <div className="srow">
      <div className="srow__text">
        <label className="srow__label" htmlFor={`asx-set-${k}`}>{label}</label>
        <div className="srow__hint">{hint}</div>
      </div>
      <div className="srow__control">
        <Toggle id={`asx-set-${k}`} label={label} checked={!!settings[k]} onChange={(v) => void setSetting(k, v as never)} />
      </div>
    </div>
  );
  const reads = status?.tools.filter((t) => t.kind === 'read') ?? [];
  const actions = status?.tools.filter((t) => t.kind === 'action') ?? [];

  return (
    <section className="sgroup" aria-labelledby="asx-set-title" id="assistant-settings">
      <h2 className="sgroup__title" id="asx-set-title">Assistant <Badge>Optional</Badge></h2>
      <p className="sgroup__desc">
        One assistant for all of VYSTRAL, using the AI chosen above. It looks things up on this PC, and it can prepare changes such as a new
        collection, but nothing happens until you confirm. It can’t launch or install games, change settings, privacy or security options, or see keys.
      </p>
      <div className="sgroup__rows surface">
        {row('assistant.launcher', 'Assistant button on every page', <>A small button in the corner opens the side panel. <Kbd>Ctrl</Kbd>+<Kbd>J</Kbd> works either way. Hidden in Immersive Mode.</>)}
        {row('assistant.askBeforeSharing', 'Ask before sharing look-ups with a cloud AI', 'Shows exactly what the Assistant found on this PC and waits for your OK before it goes to a cloud provider. Local AI never sends anything.')}
        {row('assistant.keepHistory', 'Keep conversations on this PC', 'Saved in VYSTRAL’s data folder so you can come back to them. Nothing is synced anywhere.')}
        <div className="srow">
          <div className="srow__text">
            <span className="srow__label">Delete all conversations</span>
            <div className="srow__hint">{list.length ? `${list.length} saved ${list.length === 1 ? 'conversation' : 'conversations'}.` : 'No saved conversations.'}</div>
          </div>
          <div className="srow__control">
            <HoldToConfirm icon={<Trash2 size={14} />} onConfirm={() => void useAssistant.getState().clearAll()}>Delete all</HoldToConfirm>
          </div>
        </div>
      </div>

      <button type="button" className="asx-sent__toggle asx-set__toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)}>
        <ChevronDown size={13} aria-hidden data-open={open || undefined} /> What the Assistant can look up, and what each look-up includes
      </button>
      {open && (
        <div id={listId} className="asx-set__tools">
          <ul>
            {reads.map((t) => {
              const Icon = TOOL_ICONS[t.name];
              return <li key={t.name}>{Icon && <Icon size={14} aria-hidden />}<span><strong>{t.label}</strong> {t.sends}</span></li>;
            })}
          </ul>
          <h3 className="dsrc__subhead">Changes it can prepare (you confirm each one)</h3>
          <p className="srow__hint">{actions.map((t) => t.label).join(' · ')}</p>
        </div>
      )}
      <p className="dsrc__footnote">
        <Lock size={13} aria-hidden /> Look-ups never include folder paths, your notes, keys or account details. With a cloud AI, each answer lists what was sent.
      </p>
    </section>
  );
}
