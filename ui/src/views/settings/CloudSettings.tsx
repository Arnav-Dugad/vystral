import { useEffect, useState } from 'react';
import { NewBadge } from '../../whatsnew/NewBadge';
import { AlertTriangle, Cloud, CloudOff, ExternalLink, Gauge, Lock, PauseCircle, RefreshCw } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { CloudLink, CloudService, CloudServiceHealth, CloudServiceState, CloudStatus, GfnPlanId } from '../../bridge/types';
import { formatRelative } from '../../lib/format';
import { GFN_PLANS, healthTone } from '../../lib/cloud';
import { useCloudStatus, useCloudStore } from '../../state/cloud';
import { useStore } from '../../state/store';
import { Badge, Button, Segmented, Skeleton, Toggle } from '../../components/ui/primitives';
import { CloudMark, CloudMeterView, XboxCloudTime } from '../../components/cloud/CloudBits';
import './cloud-settings.css';

const MARKETS: [string, string][] = [
  ['US', 'United States'], ['CA', 'Canada'], ['GB', 'United Kingdom'], ['IE', 'Ireland'], ['DE', 'Germany'], ['FR', 'France'], ['ES', 'Spain'],
  ['IT', 'Italy'], ['NL', 'Netherlands'], ['BE', 'Belgium'], ['AT', 'Austria'], ['CH', 'Switzerland'], ['PL', 'Poland'], ['SE', 'Sweden'],
  ['NO', 'Norway'], ['DK', 'Denmark'], ['FI', 'Finland'], ['PT', 'Portugal'], ['CZ', 'Czechia'], ['HU', 'Hungary'], ['AU', 'Australia'],
  ['NZ', 'New Zealand'], ['JP', 'Japan'], ['KR', 'South Korea'], ['IN', 'India'], ['BR', 'Brazil'], ['MX', 'Mexico'], ['AR', 'Argentina'],
  ['CO', 'Colombia'], ['TR', 'Türkiye'], ['SA', 'Saudi Arabia'], ['ZA', 'South Africa'],
];

const STATE_TEXT: Record<CloudServiceState['state'], string> = {
  off: 'Turned off',
  never: 'Not downloaded yet',
  ok: 'Up to date',
  stale: 'Couldn’t update — showing the last copy',
  error: 'Couldn’t download',
  offline: 'Offline mode is on',
  refreshing: 'Updating…',
};

function openLink(link: CloudLink) {
  void call('cloud.openLink', { link }).catch(() => {});
}

/**
 * Settings → Cloud play (Track O). Opt-in, off by default. Explains exactly what is downloaded and from where, shows
 * each catalogue's state, the region, the browser fallback, the GeForce NOW membership and the hours meter.
 */
export function CloudSettings() {
  const enabled = useStore((s) => !!s.settings?.['cloud.enabled']);
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const toast = useStore((s) => s.toast);
  const status = useCloudStatus();
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<CloudServiceHealth | null>(null);

  useEffect(() => {
    if (!enabled || !settings?.['cloud.gfn'] || settings?.['privacy.localOnly']) return setHealth(null);
    let alive = true;
    call<CloudServiceHealth>('cloud.serviceStatus').then((h) => alive && setHealth(h)).catch(() => {});
    return () => { alive = false; };
  }, [enabled, settings]);

  if (!settings) return null;

  const refresh = async () => {
    setBusy(true);
    try {
      const s = await call<CloudStatus>('cloud.refresh');
      useCloudStore.setState({ status: s, active: s.active });
      const failed = s.services.filter((x) => x.enabled && (x.state === 'error' || x.state === 'stale'));
      toast(failed.length ? { tone: 'warning', title: 'Some catalogues couldn’t be updated', body: failed.map((f) => `${f.name}: ${f.error}`).join(' ') } : { tone: 'success', title: 'Cloud catalogues are up to date' });
    } catch (err) {
      toast({ tone: 'warning', title: 'Couldn’t update the cloud catalogues', body: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const nextAllowed = status?.services.filter((s) => s.enabled).map((s) => s.nextRefreshAt).filter((x): x is string => !!x && Date.parse(x) > Date.now()) ?? [];
  const allWaiting = !!status && status.services.some((s) => s.enabled) && nextAllowed.length === status.services.filter((s) => s.enabled).length;
  const soonest = nextAllowed.length ? nextAllowed.sort()[0] : null;
  const ht = healthTone(health);

  return (
    <section className="sgroup cloudset" aria-labelledby="cloudset-title">
      <h2 className="sgroup__title" id="cloudset-title">
        Cloud play <Badge>Optional</Badge>
      </h2>
      <p className="sgroup__desc">
        Stream games you own with <strong>GeForce NOW</strong> or <strong>Xbox Cloud Gaming</strong>. VYSTRAL checks the services’ public game lists against
        your library and opens the vendor’s own app or website. It never signs in for you, never sees your account, and never shows the stream itself.
      </p>

      {!enabled ? (
        <div className="cloudset-empty surface" data-testid="cloud-empty">
          <div className="cloudset-empty__art" aria-hidden>
            <Cloud size={40} strokeWidth={1.6} />
          </div>
          <div className="cloudset-empty__text">
            <h3>Play in the cloud is off</h3>
            <p>
              When you turn it on, VYSTRAL downloads two public game lists at most once a day: NVIDIA’s GeForce NOW list and Microsoft’s Xbox Cloud Gaming
              list (plus Microsoft Store details to recognise your Xbox games). Only your region is sent. No cookies, no account, nothing about your library.
            </p>
            <p className="cloudset-empty__small">Games you own then get a cloud badge, a “Playable in the cloud” filter and a Play in the cloud button.</p>
          </div>
          <Button variant="primary" icon={<Cloud size={16} />} onClick={() => void setSetting('cloud.enabled', true)}>Turn on cloud play</Button>
        </div>
      ) : (
        <>
          <div className="sgroup__rows surface">
            <div className="srow">
              <div className="srow__text">
                <label className="srow__label" htmlFor="cloud-enabled">Cloud play<NewBadge k="settings.cloud.play" variant="pill" seenWhenVisible /></label>
                <div className="srow__hint">Badges, the library filter and Play in the cloud. Turning it off keeps your cloud sessions in the Journal.</div>
              </div>
              <div className="srow__control"><Toggle id="cloud-enabled" label="Cloud play" checked={enabled} onChange={(v) => void setSetting('cloud.enabled', v)} /></div>
            </div>
            {status?.localOnly && (
              <div className="srow cloudset__notice" role="status">
                <CloudOff size={18} aria-hidden />
                <div className="srow__text">
                  <div className="srow__label">Offline mode is on</div>
                  <div className="srow__hint">The game lists aren’t updated. What VYSTRAL already has stays visible.</div>
                </div>
              </div>
            )}
            {status?.dataSaver && !status.localOnly && (
              <div className="srow cloudset__notice" role="status">
                <PauseCircle size={18} aria-hidden />
                <div className="srow__text">
                  <div className="srow__label">Data saver is on</div>
                  <div className="srow__hint">Game lists only update when you press “Check now”.</div>
                </div>
              </div>
            )}
          </div>

          <div className="cloudset__services">
            {(status?.services ?? []).map((s) => <ServiceCard key={s.service} s={s} status={status!} />)}
            {!status && Array.from({ length: 2 }, (_, i) => <div key={i} className="cloudset-card surface"><Skeleton height={22} width="50%" /><Skeleton height={14} /><Skeleton height={14} width="70%" /></div>)}
          </div>
          <div className="cloudset__refresh">
            <Button size="sm" icon={<RefreshCw size={14} />} loading={busy || status?.refreshing} disabled={!!status?.localOnly || allWaiting} onClick={() => void refresh()}>
              Check now
            </Button>
            <span className="cloudset__hint">
              {allWaiting && soonest ? `Lists are checked at most once a day. Next check after ${new Date(soonest).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.` : 'Lists are checked at most once a day, in the background.'}
            </span>
          </div>

          <div className="sgroup__rows surface">
            <div className="srow">
              <div className="srow__text">
                <label className="srow__label" htmlFor="cloud-market">Region</label>
                <div className="srow__hint">Which country’s lists to use. Games differ by region.{status?.marketSource === 'windows' ? ` From your Windows region (${status.market}).` : ''}</div>
              </div>
              <div className="srow__control">
                <select id="cloud-market" className="input cloudset__select" value={settings['cloud.market']} onChange={(e) => void setSetting('cloud.market', e.target.value)}>
                  <option value="">Windows region{status?.marketSource === 'windows' ? ` (${status.market})` : ''}</option>
                  {MARKETS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                </select>
              </div>
            </div>
            <div className="srow">
              <div className="srow__text">
                <div className="srow__label" id="cloud-browser-label">Open web games in</div>
                <div className="srow__hint">
                  {settings['cloud.browser'] === 'edge'
                    ? 'A separate Microsoft Edge window with its own sign-in, so VYSTRAL can tell when you stop. VYSTRAL never reads that window or its folder.'
                    : 'Your normal browser and its sign-ins. VYSTRAL can’t see browser tabs, so press “I’m done” when you finish to save the session.'}
                  {' '}When the GeForce NOW or Xbox app is installed, games open there instead.
                </div>
              </div>
              <div className="srow__control">
                <Segmented
                  label="Open web games in"
                  value={settings['cloud.browser']}
                  onChange={(v) => void setSetting('cloud.browser', v)}
                  options={[{ value: 'edge', label: 'Separate Edge window' }, { value: 'default', label: 'My browser' }]}
                />
              </div>
            </div>
          </div>

          <h3 className="cloudset__subhead" id="cloudset-hours"><Gauge size={14} aria-hidden /> Hours this month</h3>
          <div className="sgroup__rows surface" aria-labelledby="cloudset-hours">
            <div className="srow">
              <div className="srow__text">
                <label className="srow__label" htmlFor="cloud-plan">GeForce NOW membership</label>
                <div className="srow__hint">
                  {status?.meter.planNote ?? 'Sets the session length and monthly hours the meter uses.'}{' '}
                  <button className="cloud-link" onClick={() => openLink('gfnMemberships')}>Compare memberships <ExternalLink size={11} aria-hidden /></button>
                </div>
              </div>
              <div className="srow__control">
                <select id="cloud-plan" className="input cloudset__select" value={settings['cloud.gfnPlan']} onChange={(e) => void setSetting('cloud.gfnPlan', e.target.value as GfnPlanId)}>
                  {GFN_PLANS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
            </div>
            <div className="srow">
              <div className="srow__text">
                <label className="srow__label" htmlFor="cloud-reset">Hours reset on</label>
                <div className="srow__hint">The day your membership renews each month. In shorter months, a later day means the last day.</div>
              </div>
              <div className="srow__control">
                <select id="cloud-reset" className="input cloudset__select cloudset__select--day" value={settings['cloud.resetDay']} onChange={(e) => void setSetting('cloud.resetDay', Number(e.target.value))}>
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>Day {d}</option>)}
                </select>
              </div>
            </div>
            {status && (
              <div className="srow cloudset__meter">
                <CloudMeterView meter={status.meter} />
                <XboxCloudTime meter={status.meter} />
                <p className="cloudset__fine">
                  Counts only sessions started from VYSTRAL on this PC, so play on your phone, TV or another PC isn’t included. Xbox Cloud Gaming time is shown
                  without a meter. Limits as published by NVIDIA (checked {status.meter.asOf}).
                </p>
              </div>
            )}
          </div>

          {ht && (
            <p className="cloudset__status">
              <span className="cloud-health" data-tone={ht.tone}><span className="cloud-health__dot" aria-hidden /> GeForce NOW: {ht.text}</span>
              <button className="cloud-link" onClick={() => openLink('gfnStatus')}>Status page <ExternalLink size={11} aria-hidden /></button>
              <button className="cloud-link" onClick={() => openLink('xboxStatus')}>Xbox status <ExternalLink size={11} aria-hidden /></button>
            </p>
          )}

          <p className="cloudset__footnote">
            <Lock size={13} aria-hidden /> Game lists come from public data on NVIDIA’s and Microsoft’s own websites. They’re stored only on this PC, never shared,
            and VYSTRAL stops using them if a vendor asks. A match by title is marked “Likely match”; the vendor’s app or page always has the final answer.
          </p>
        </>
      )}
    </section>
  );
}

function ServiceCard({ s, status }: { s: CloudServiceState; status: CloudStatus }) {
  const setSetting = useStore((st) => st.setSetting);
  const key = s.service === 'gfn' ? 'cloud.gfn' : 'cloud.xbox';
  const app = s.service === 'gfn' ? status.apps.gfnApp : status.apps.xboxApp;
  const tone = s.state === 'ok' ? 'ok' : s.state === 'error' || s.state === 'stale' ? 'warn' : undefined;
  return (
    <div className="cloudset-card surface" data-service={s.service as CloudService} data-state={s.state}>
      <div className="cloudset-card__head">
        <CloudMark service={s.service} size={18} />
        <div className="cloudset-card__title">
          <span className="cloudset-card__name">{s.name}</span>
          <span className="cloudset-card__state" data-tone={tone}>
            {(s.state === 'error' || s.state === 'stale') && <AlertTriangle size={12} aria-hidden />}
            {STATE_TEXT[s.state]}
            {s.refreshedAt && s.state !== 'off' ? ` · ${formatRelative(s.refreshedAt).toLowerCase()}` : ''}
          </span>
        </div>
        <Toggle id={`cloud-${s.service}`} label={s.name} checked={s.enabled} onChange={(v) => void setSetting(key, v)} />
      </div>
      {s.enabled && (
        <>
          <dl className="cloudset-card__facts">
            <div><dt>In the list</dt><dd className="num">{s.count ? s.count.toLocaleString() : '—'}</dd></div>
            <div><dt>In your library</dt><dd className="num">{s.count ? s.matched.toLocaleString() : '—'}</dd></div>
          </dl>
          {s.error && <p className="cloudset-card__error">{s.error}</p>}
          <p className="cloudset-card__how">
            {s.service === 'gfn'
              ? app ? 'GeForce NOW app found: games start straight in it.' : 'Games open on play.geforcenow.com (NVIDIA’s documented link).'
              : app ? 'Xbox app found: games open on their page there; press Stream to play.' : 'Games open on xbox.com/play.'}
          </p>
          <div className="cloudset-card__links">
            {s.service === 'gfn'
              ? <button className="cloud-link" onClick={() => openLink('gfnSystem')}>Requirements <ExternalLink size={11} aria-hidden /></button>
              : <button className="cloud-link" onClick={() => openLink('xboxCloud')}>About Xbox Cloud Gaming <ExternalLink size={11} aria-hidden /></button>}
          </div>
        </>
      )}
    </div>
  );
}
