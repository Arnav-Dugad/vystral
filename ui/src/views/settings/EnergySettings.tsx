import { useState, type ReactNode } from 'react';
import type { SettingKey } from '../../bridge/types';
import { Toggle } from '../../components/ui/primitives';
import { useStore } from '../../state/store';
import { useMoneyContext } from '../../state/money'; // Track D6

/** A number field that saves on blur or Enter, within its setting's range; empty means 0. */
function NumberRow({ k, label, hint, min, max, step, unit, placeholder }: {
  k: SettingKey; label: string; hint: ReactNode; min: number; max: number; step: number; unit: string; placeholder: string;
}) {
  const value = useStore((s) => Number(s.settings?.[k] ?? 0));
  const set = useStore((s) => s.setSetting);
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const shown = draft ?? (value > 0 ? String(value) : '');
  const commit = () => {
    if (draft == null) return;
    const v = draft.trim() === '' ? 0 : Number(draft.replace(',', '.'));
    if (!Number.isFinite(v) || v < min || v > max) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(null);
    if (v !== value) void set(k, v as never);
  };
  return (
    <div className="srow">
      <div className="srow__text">
        <label className="srow__label" htmlFor={k}>{label}</label>
        <div className="srow__hint" id={`${k}-hint`}>{invalid ? `Enter a number from ${min} to ${max.toLocaleString()}, or leave it empty.` : hint}</div>
      </div>
      <div className="srow__control en-field">
        <input
          id={k}
          className="input"
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          placeholder={placeholder}
          value={shown}
          aria-invalid={invalid || undefined}
          aria-describedby={`${k}-hint`}
          onChange={(e) => { setDraft(e.target.value); setInvalid(false); }}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
        />
        <span className="en-field__unit">{unit}</span>
      </div>
    </div>
  );
}

/** Settings → Launching & sessions: the opt-in energy estimate (Track Y). */
export function EnergySettings() {
  const enabled = useStore((s) => !!s.settings?.['energy.enabled']);
  const currency = useStore((s) => s.settings?.['energy.currency'] ?? '');
  const set = useStore((s) => s.setSetting);
  const [cur, setCur] = useState<string | null>(null);
  const display = useMoneyContext().target; // Track D6
  const curInvalid = cur != null && cur !== '' && !/^[A-Za-z]{3}$/.test(cur);
  return (
    <section className="sgroup">
      <h2 className="sgroup__title">Energy estimate</h2>
      <p className="sgroup__desc">
        Estimates the electricity each session used from the GPU and CPU load VYSTRAL records, using typical power for your hardware or the wattage you enter.
        Shown in Performance per session, per game and per month, always labelled as an estimate. Calculated on this PC; nothing is sent anywhere.
      </p>
      <div className="sgroup__rows surface">
        <div className="srow">
          <div className="srow__text">
            <label className="srow__label" htmlFor="energy.enabled">Estimate energy use</label>
            <div className="srow__hint">Needs performance metrics (above). Sessions recorded without load samples aren’t counted.</div>
          </div>
          <div className="srow__control">
            <Toggle id="energy.enabled" label="Estimate energy use" checked={enabled} onChange={(v) => void set('energy.enabled', v)} />
          </div>
        </div>
        {enabled && (
          <>
            <NumberRow
              k="energy.watts" label="Your PC’s gaming wattage" unit="W" min={0} max={3000} step={10} placeholder="Automatic"
              hint="Optional. Measured at the wall with a power meter during a demanding game. Empty: typical power for your graphics card and processor."
            />
            <NumberRow
              k="energy.price" label="Electricity price" unit="per kWh" min={0} max={1000} step={0.01} placeholder="No cost"
              hint="Optional. From your bill, to show what your play costs."
            />
            <div className="srow">
              <div className="srow__text">
                <label className="srow__label" htmlFor="energy.currency">Currency</label>
                <div className="srow__hint" id="energy.currency-hint">{curInvalid ? 'Use a three-letter code such as EUR, GBP or USD.' : `The currency of that price, as a three-letter code. Empty: your display currency (${display}). Costs are shown in ${display}.`}</div>
              </div>
              <div className="srow__control">
                <input
                  id="energy.currency"
                  className="input en-currency"
                  maxLength={3}
                  autoCapitalize="characters"
                  spellCheck={false}
                  placeholder={display}
                  value={cur ?? currency}
                  aria-invalid={curInvalid || undefined}
                  aria-describedby="energy.currency-hint"
                  onChange={(e) => setCur(e.target.value.toUpperCase())}
                  onBlur={() => {
                    if (cur == null || curInvalid) return;
                    setCur(null);
                    if (cur !== currency) void set('energy.currency', cur);
                  }}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
