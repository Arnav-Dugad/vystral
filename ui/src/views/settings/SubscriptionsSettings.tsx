import { useEffect, useState } from 'react';
import { AlertTriangle, BellRing, CloudOff, Lock, RefreshCw, Timer } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { SubsStatus } from '../../bridge/types';
import { formatRelative } from '../../lib/format';
import { CURRENCIES, defaultCurrency, gamePassPlan, hasListPlan, PLAN } from '../../lib/subs';
import { saveSubscriptions, usePlans, useSubsStatus, useSubsStore } from '../../state/subs';
import { useStore } from '../../state/store';
import { Badge, Button, Slider, Toggle } from '../../components/ui/primitives';
import { SubsPicker } from '../../components/subs/SubsPicker';
import '../../components/subs/subs.css';

const STATE_TEXT: Record<SubsStatus['state'], string> = {
  off: 'Off',
  noPlans: 'None of your plans has a public list',
  never: 'Not downloaded yet',
  ok: 'Up to date',
  stale: 'Couldn’t update — showing the last copy',
  error: 'Couldn’t download',
  offline: 'Offline mode is on',
  refreshing: 'Updating…',
};

/**
 * Settings → Library & stores → Your subscriptions (Track V). The answer is local only. The public Game Pass lists are
 * opt-in, and everything they feed (badges, the filter, the Home row, "leaving soon") says where it comes from.
 */
export function SubscriptionsSettings() {
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const toast = useStore((s) => s.toast);
  const plans = usePlans();
  const status = useSubsStatus();
  const [busy, setBusy] = useState(false);
  const [price, setPrice] = useState('');
  const savedPrice = settings?.['subs.price'] ?? 0;
  useEffect(() => setPrice(savedPrice > 0 ? String(savedPrice) : ''), [savedPrice]);

  if (!settings) return null;
  const gfn = settings['cloud.gfnPlan'];
  const catalog = settings['subs.catalog'];
  const listPlans = hasListPlan(plans);
  const gp = gamePassPlan(plans);

  const refresh = async () => {
    setBusy(true);
    try {
      const s = await call<SubsStatus>('subs.refresh');
      useSubsStore.setState({ status: s });
      void useSubsStore.getState().loadData();
      toast(s.state === 'stale' || s.state === 'error' ? { tone: 'warning', title: 'The Game Pass lists couldn’t be updated', body: s.error ?? undefined } : { tone: 'success', title: 'Your plans’ lists are up to date' });
    } catch (err) {
      toast({ tone: 'warning', title: 'Couldn’t update the Game Pass lists', body: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const commitPrice = () => {
    const n = Number(price.replace(',', '.'));
    const v = price.trim() === '' || !Number.isFinite(n) ? 0 : Math.min(1000, Math.max(0, Math.round(n * 100) / 100));
    setPrice(v > 0 ? String(v) : '');
    if (v !== savedPrice) void setSetting('subs.price', v);
  };

  const waiting = !!status?.nextRefreshAt && Date.parse(status.nextRefreshAt) > Date.now();

  return (
    <section className="sgroup" id="settings-subs" aria-labelledby="subsset-title">
      <h2 className="sgroup__title" id="subsset-title">
        Your subscriptions <Badge icon={<Lock size={11} />}>Stays on this PC</Badge>
      </h2>
      <p className="sgroup__desc">
        Tell VYSTRAL what you pay for and it tailors itself: badges on games your plans include, an “In my subscriptions” filter, a Home row of included games
        you don’t own yet, “leaving soon” warnings, and cloud play that only offers your services. VYSTRAL never signs in to these services or checks your
        accounts.
      </p>

      <SubsPicker value={{ plans, gfn }} onChange={(v) => void saveSubscriptions(v.plans, v.gfn)} />

      <div className="sgroup__rows surface" style={{ marginTop: 'var(--s-4)' }}>
        <div className="srow">
          <div className="srow__text">
            <label className="srow__label" htmlFor="subs-catalog">Show what my plans include</label>
            <div className="srow__hint">
              Downloads Microsoft’s public Game Pass lists (the same ones xbox.com uses) at most once a day, plus Store names and posters for those games.
              Only your region is sent: no cookies, no account, nothing about your library. Covers Game Pass, EA Play and Ubisoft+; Humble Choice and Prime
              Gaming have no public list.
            </div>
            {catalog && status && (
              <div className="subsset__lists" role="status">
                <span className="srow__hint" data-tone={status.state === 'stale' || status.state === 'error' ? 'warn' : undefined}>
                  {(status.state === 'stale' || status.state === 'error') && <AlertTriangle size={12} aria-hidden />} {STATE_TEXT[status.state]}
                  {status.refreshedAt && status.state !== 'off' ? ` · ${formatRelative(status.refreshedAt).toLowerCase()}` : ''}
                  {status.pending > 0 ? ` · ${status.pending.toLocaleString()} names still to look up` : ''}
                  {status.error ? ` · ${status.error}` : ''}
                </span>
                {status.counts.some((c) => c.hasList && c.count > 0) && (
                  <div className="subsset__counts">
                    {status.counts.filter((c) => c.hasList && c.count > 0).map((c) => (
                      <Badge key={c.plan}>{c.name} · {c.count.toLocaleString()} games · {c.inLibrary.toLocaleString()} in your library</Badge>
                    ))}
                    {status.leaving > 0 && <Badge tone="warn">{status.leaving} leaving soon{status.leavingInLibrary ? ` · ${status.leavingInLibrary} of yours` : ''}</Badge>}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="srow__control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {catalog && listPlans && (
              <Button size="sm" icon={<RefreshCw size={14} />} loading={busy || status?.refreshing} disabled={!!status?.localOnly || waiting} onClick={() => void refresh()}>
                Check now
              </Button>
            )}
            <Toggle id="subs-catalog" label="Show what my plans include" checked={catalog} onChange={(v) => void setSetting('subs.catalog', v)} />
          </div>
        </div>
        {catalog && status?.localOnly && (
          <div className="srow" role="status">
            <CloudOff size={18} aria-hidden />
            <div className="srow__text">
              <div className="srow__label">Offline mode is on</div>
              <div className="srow__hint">The lists aren’t updated. What VYSTRAL already has stays visible.</div>
            </div>
          </div>
        )}
        <div className="srow">
          <div className="srow__text">
            <label className="srow__label" htmlFor="subs-leaving"><BellRing size={14} aria-hidden /> Tell me before a game leaves Game Pass</label>
            <div className="srow__hint">
              A Windows notification a few days before a game in your library leaves (as soon as it’s listed, when there’s no date). Xbox sets the final date.
              {!gp ? ' Needs a Game Pass plan above.' : !catalog ? ' Needs “Show what my plans include”.' : ''}
            </div>
          </div>
          <div className="srow__control">
            <Toggle id="subs-leaving" label="Tell me before a game leaves Game Pass" checked={settings['subs.leavingNotify']} disabled={!gp || !catalog}
              onChange={(v) => void setSetting('subs.leavingNotify', v)} />
          </div>
        </div>
        <div className="srow">
          <div className="srow__text">
            <label className="srow__label" htmlFor="subs-cloud-all">Cloud play: show every service</label>
            <div className="srow__hint">
              {settings['subs.cloudShowAll']
                ? 'Cloud play offers every service that lists a game, even ones you don’t have.'
                : `Cloud play only offers the services you have${gfn !== 'none' || plans.some((p) => PLAN[p].cloud) ? '' : ' (none yet, so cloud buttons are hidden)'}. Xbox Cloud Gaming comes with Game Pass Essential, Premium and Ultimate.`}
            </div>
          </div>
          <div className="srow__control">
            <Toggle id="subs-cloud-all" label="Cloud play: show every service" checked={settings['subs.cloudShowAll']} onChange={(v) => void setSetting('subs.cloudShowAll', v)} />
          </div>
        </div>
        <div className="srow">
          <div className="srow__text">
            <label className="srow__label" htmlFor="subs-price">What you pay a month (optional)</label>
            <div className="srow__hint">All your subscriptions together. Only used to show cost per hour on Home, worked out from the time VYSTRAL tracks. Leave it empty to hide it.</div>
          </div>
          <div className="srow__control subsset__price">
            <input id="subs-price" className="input" inputMode="decimal" placeholder="0.00" value={price} aria-describedby="subs-price-cur"
              onChange={(e) => setPrice(e.target.value.replace(/[^0-9.,]/g, '').slice(0, 8))} onBlur={commitPrice} onKeyDown={(e) => e.key === 'Enter' && commitPrice()} />
            <select id="subs-price-cur" className="input" aria-label="Currency" value={settings['subs.currency'] || ''} onChange={(e) => void setSetting('subs.currency', e.target.value)}>
              <option value="">{defaultCurrency()}</option>
              {CURRENCIES.filter((c) => c !== defaultCurrency()).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Settings → Cloud play → GeForce NOW queue alerts (Track V). */
export function CloudQueueAlertSettings() {
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  if (!settings?.['cloud.enabled']) return null;
  const on = settings['cloud.queueAlerts'];
  return (
    <section className="sgroup" aria-labelledby="queue-alerts-title">
      <h2 className="sgroup__title" id="queue-alerts-title"><Timer size={16} aria-hidden /> GeForce NOW queue alerts</h2>
      <div className="sgroup__rows surface">
        <div className="srow">
          <div className="srow__text">
            <label className="srow__label" htmlFor="queue-alerts">Tell me when my turn is close</label>
            <div className="srow__hint">
              While a GeForce NOW game you started from VYSTRAL waits in the queue, VYSTRAL reads the GeForce NOW window’s title (nothing else: no clicks, no
              memory, nothing injected). If the title shows your place, you get a Windows notification near the front; when the stream process starts, you
              get “Your stream is starting”. The app doesn’t always show the queue in its title, so the second one is the dependable alert.
            </div>
          </div>
          <div className="srow__control"><Toggle id="queue-alerts" label="Tell me when my turn is close" checked={on} onChange={(v) => void setSetting('cloud.queueAlerts', v)} /></div>
        </div>
        {on && (
          <div className="srow">
            <div className="srow__text">
              <div className="srow__label">Notify at position</div>
              <div className="srow__hint">Number {settings['cloud.queueAlertAt']} or closer.</div>
            </div>
            <div className="srow__control" style={{ minWidth: 200 }}>
              <Slider label="Notify at queue position" value={settings['cloud.queueAlertAt']} min={1} max={20} step={1} onChange={(v) => void setSetting('cloud.queueAlertAt', v)} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
