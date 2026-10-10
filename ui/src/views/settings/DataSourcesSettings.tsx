import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, CloudOff, ExternalLink, KeyRound, Lock, PauseCircle, RefreshCw, Unplug } from 'lucide-react';
import { call, errorMessage, on } from '../../bridge/bridge';
import type { DataSourceId, DataSourcesStatus, ProviderAction, ProviderStatus, ProviderTest } from '../../bridge/types';
import { formatRelative } from '../../lib/format';
import { keyLooksValid } from '../../lib/dataSources';
import { useStore } from '../../state/store';
import { Badge, Button, Skeleton, Toggle } from '../../components/ui/primitives';
import { HoldToConfirm } from '../../components/controller/HoldToConfirm';
import { Dialog } from '../../components/ui/Dialog';
import { ServiceLogo } from '../../components/ui/ServiceLogo';
import { DATA_SOURCE_SERVICE } from '../../lib/serviceMarks';
import { TrackD4Rows } from './TrackD4Rows';
import './data-sources.css';

const COUNTRIES: [string, string][] = [
  ['US', 'United States'], ['GB', 'United Kingdom'], ['DE', 'Germany'], ['FR', 'France'], ['ES', 'Spain'], ['IT', 'Italy'], ['NL', 'Netherlands'],
  ['PL', 'Poland'], ['SE', 'Sweden'], ['CA', 'Canada'], ['AU', 'Australia'], ['NZ', 'New Zealand'], ['BR', 'Brazil'], ['MX', 'Mexico'],
  ['JP', 'Japan'], ['KR', 'South Korea'], ['IN', 'India'], ['TR', 'Türkiye'], ['ZA', 'South Africa'],
];

const ACCESS_LABEL: Record<ProviderStatus['access'], string> = { key: 'Your key', twitch: 'Your Twitch app', keyless: 'No key' };

/** Settings → Library & stores → Data sources. Keys never reach the page; it only learns a masked suffix. */
export function DataSourcesSettings() {
  const localOnly = useStore((s) => s.settings?.['privacy.localOnly'] ?? false);
  const enrichment = useStore((s) => s.settings?.['dataSources.enrichment'] ?? true);
  const storePrices = useStore((s) => s.settings?.['dataSources.storePrices'] ?? true);
  const searchOnline = useStore((s) => s.settings?.['discover.searchOnline'] ?? true); // Track U
  const storeShelves = useStore((s) => s.settings?.['discover.storeShelves'] ?? false); // Track C3
  const country = useStore((s) => s.settings?.['dataSources.priceCountry'] ?? 'US');
  const setSetting = useStore((s) => s.setSetting);
  const [status, setStatus] = useState<DataSourcesStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await call<DataSourcesStatus>('dataSources.status'));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);
  useEffect(() => void refresh(), [refresh, localOnly, enrichment]);
  useEffect(() => on('dataSources.changed', (s) => setStatus(s)), []);

  const keyed = status?.providers.filter((p) => p.access !== 'keyless') ?? [];
  const keyless = status?.providers.filter((p) => p.access === 'keyless') ?? [];

  return (
    <section className="sgroup dsrc" aria-labelledby="dsrc-title">
      <h2 className="sgroup__title" id="dsrc-title">
        Data sources <Badge>Optional</Badge>
      </h2>
      <p className="sgroup__desc">
        Extra artwork, details, prices and compatibility from public game databases. Sources that need a key use <strong>your own</strong> free key,
        kept in Windows Credential Manager. Nothing is sent while Offline mode is on, and every source can be turned off.
      </p>
      <div className="sgroup__rows surface">
        {localOnly && (
          <div className="srow dsrc__notice" role="status">
            <CloudOff size={18} aria-hidden />
            <div className="srow__text">
              <div className="srow__label">Offline mode is on</div>
              <div className="srow__hint">No data source is contacted. Cached details stay visible.</div>
            </div>
          </div>
        )}
        <div className="srow">
          <div className="srow__text">
            <label className="srow__label" htmlFor="dsrc-enrich">Fill in missing game details</label>
            <div className="srow__hint">With an IGDB or RAWG connection, VYSTRAL fills only empty fields (never ones you or your stores already set), matching games by Steam app ID first. Paused while you play.</div>
          </div>
          <div className="srow__control"><Toggle id="dsrc-enrich" label="Fill in missing game details" checked={enrichment} onChange={(v) => void setSetting('dataSources.enrichment', v)} /></div>
        </div>
        <div className="srow" id="dsrc-discover">
          <div className="srow__text">
            <label className="srow__label" htmlFor="dsrc-discover-toggle">Search stores and game databases</label>
            <div className="srow__hint">The command bar and Discover also send what you type to Steam’s store search and Wikidata (and IGDB and RAWG when connected) to find games that aren’t in your library. Your library itself is always searched on this PC.</div>
          </div>
          <div className="srow__control"><Toggle id="dsrc-discover-toggle" label="Search stores and game databases" checked={searchOnline} onChange={(v) => void setSetting('discover.searchOnline', v)} /></div>
        </div>
        <TrackD4Rows />
        <div className="srow" id="dsrc-store-shelves">
          <div className="srow__text">
            <label className="srow__label" htmlFor="dsrc-store-shelves-toggle">Steam store shelves in Discover</label>
            <div className="srow__hint">Trending, deals, new releases, coming soon, free to play and genres, from Steam’s public store lists for your price country. Asked at most every few hours, only while this is on; nothing about you is sent.</div>
          </div>
          <div className="srow__control"><Toggle id="dsrc-store-shelves-toggle" label="Steam store shelves in Discover" checked={storeShelves} onChange={(v) => void setSetting('discover.storeShelves', v)} /></div>
        </div>
        <div className="srow">
          <div className="srow__text">
            <label className="srow__label" htmlFor="dsrc-prices">Current store prices for library value</label>
            <div className="srow__hint">The Journal’s library value uses today’s Steam store price, fetched in batches when you open it. It is never what you paid.</div>
          </div>
          <div className="srow__control dsrc__pricecontrols">
            <select className="input dsrc__country" aria-label="Price country" value={country} onChange={(e) => void setSetting('dataSources.priceCountry', e.target.value)}>
              {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
            <Toggle id="dsrc-prices" label="Current store prices for library value" checked={storePrices} onChange={(v) => void setSetting('dataSources.storePrices', v)} />
          </div>
        </div>
      </div>

      {loadError && (
        <div className="surface dsrc__error" role="alert">
          <AlertTriangle size={18} aria-hidden />
          <span>{loadError}</span>
          <Button size="sm" onClick={() => void refresh()}>Retry</Button>
        </div>
      )}

      {!status && !loadError && (
        <div className="dsrc__grid" aria-busy="true" aria-label="Loading data sources">
          {Array.from({ length: 4 }, (_, i) => <div key={i} className="dsrc-card surface"><Skeleton height={22} width="45%" /><Skeleton height={14} /><Skeleton height={14} width="70%" /><Skeleton height={36} /></div>)}
        </div>
      )}

      {status && (
        <>
          <h3 className="dsrc__subhead">With your own key</h3>
          <div className="dsrc__grid">
            {keyed.map((p) => <ProviderCard key={p.id} p={p} localOnly={status.localOnly} onStatus={setStatus} />)}
          </div>
          <h3 className="dsrc__subhead">Keyless</h3>
          <div className="dsrc__grid">
            {keyless.map((p) => <ProviderCard key={p.id} p={p} localOnly={status.localOnly} onStatus={setStatus} fetchMetadata={status.fetchMetadata} />)}
          </div>
          <p className="dsrc__footnote">
            <Lock size={13} aria-hidden /> Keys are stored only in Windows Credential Manager (as “VYSTRAL/&lt;source&gt;”), never in VYSTRAL’s database, logs or this page.
            IGDB’s access token stays in memory. See the privacy statement for exactly what each source receives.
          </p>
        </>
      )}
    </section>
  );
}

const OUTCOME: Record<ProviderTest['outcome'], { tone: 'ok' | 'warn' | 'danger'; title: string }> = {
  ok: { tone: 'ok', title: 'Working' },
  invalidKey: { tone: 'danger', title: 'Key not accepted' },
  notConfigured: { tone: 'warn', title: 'No key yet' },
  rateLimited: { tone: 'warn', title: 'Asked to slow down' },
  unavailable: { tone: 'warn', title: 'Couldn’t be reached' },
  malformed: { tone: 'warn', title: 'Unexpected answer' },
  offline: { tone: 'warn', title: 'Offline mode is on' },
  disabled: { tone: 'warn', title: 'Turned off' },
};

function ProviderCard({ p, localOnly, onStatus, fetchMetadata = true }: { p: ProviderStatus; localOnly: boolean; onStatus: (s: DataSourcesStatus) => void; fetchMetadata?: boolean }) {
  const toast = useStore((s) => s.toast);
  const setSetting = useStore((s) => s.setSetting);
  const [busy, setBusy] = useState<'connect' | 'test' | 'disconnect' | null>(null);
  const [result, setResult] = useState<ProviderTest | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [details, setDetails] = useState(false);
  const detailsId = useId();
  const shown = result ?? p.lastTest;

  const act = async (kind: 'connect' | 'test', method: string, params: unknown) => {
    setBusy(kind);
    try {
      const r = await call<ProviderAction>(method, params, 60_000);
      onStatus(r.status);
      setResult(r.result);
      return r;
    } catch (err) {
      toast({ tone: 'danger', title: p.name, body: errorMessage(err) });
      return null;
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setConfirm(false);
    setBusy('disconnect');
    try {
      onStatus(await call<DataSourcesStatus>('dataSources.disconnect', { provider: p.id }));
      setResult(null);
      toast({ tone: 'success', title: `${p.name} disconnected`, body: 'The key was removed from Windows Credential Manager.' });
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t disconnect', body: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const openLink = (link: string) => void call('dataSources.openLink', { provider: p.id, link }).catch(() => undefined);
  const isKeyed = p.access !== 'keyless';
  const paused = p.pausedUntil && Date.parse(p.pausedUntil) > Date.now();
  const state = !p.configured ? 'off' : p.enabled ? 'on' : 'paused';
  const headingId = `dsrc-${p.id}`;

  return (
    <article className="dsrc-card surface logo-host" data-state={state} aria-labelledby={headingId}>
      <header className="dsrc-card__head">
        <span className="dsrc-card__mark" aria-hidden>
          {DATA_SOURCE_SERVICE[p.id] ? <ServiceLogo service={DATA_SOURCE_SERVICE[p.id]} size={20} decorative motion /> : p.name.slice(0, 1)}
        </span>
        <div className="dsrc-card__title">
          <h4 id={headingId}>{p.name}</h4>
          <span className="dsrc-card__access">{ACCESS_LABEL[p.access]}</span>
        </div>
        <StatusPill p={p} />
      </header>

      <p className="dsrc-card__uses">{p.uses}</p>

      {p.id === 'steamdeck' && !fetchMetadata && (
        <p className="dsrc-card__hint" role="note"><AlertTriangle size={13} aria-hidden /> Also needs “Fetch game details” (above) to be on.</p>
      )}
      {paused && (
        <p className="dsrc-card__hint" role="status"><PauseCircle size={13} aria-hidden /> {p.name} asked VYSTRAL to pause until {new Date(p.pausedUntil!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</p>
      )}

      {isKeyed && !p.configured && (
        <ConnectForm p={p} disabled={localOnly} busy={busy === 'connect'} onConnect={(key, secret) => act('connect', 'dataSources.connect', { provider: p.id, key, secret })} onLink={openLink} />
      )}

      {isKeyed && p.configured && (
        <div className="dsrc-card__keyrow">
          <KeyRound size={14} aria-hidden />
          <span>Stored in Credential Manager · <span className="num">{p.keyMasked}</span></span>
        </div>
      )}

      <div className="dsrc-card__actions">
        {!isKeyed && p.settingKey && (
          <Toggle id={`${p.id}-toggle`} label={`Use ${p.name}`} checked={p.enabled} onChange={(v) => void setSetting(p.settingKey!, v as never).then(() => call<DataSourcesStatus>('dataSources.status').then(onStatus))} />
        )}
        {(p.configured || !isKeyed) && (
          <Button size="sm" loading={busy === 'test'} disabled={localOnly || !!busy || (!isKeyed && !p.enabled)} icon={<RefreshCw size={14} />} onClick={() => void act('test', 'dataSources.test', { provider: p.id })}>
            Test
          </Button>
        )}
        {isKeyed && p.configured && (
          <Button size="sm" variant="ghost" loading={busy === 'disconnect'} disabled={!!busy} icon={<Unplug size={14} />} onClick={() => setConfirm(true)}>Disconnect</Button>
        )}
        <Button size="sm" variant="ghost" icon={<ExternalLink size={14} />} onClick={() => openLink('home')} aria-label={`Open ${p.name}’s website`}>Website</Button>
      </div>

      {shown && <Result result={shown} />}

      <button className="dsrc-card__more" aria-expanded={details} aria-controls={detailsId} onClick={() => setDetails((d) => !d)}>
        <ChevronDown size={14} aria-hidden data-open={details || undefined} /> What’s sent and licence
      </button>
      {details && (
        <dl className="dsrc-card__details" id={detailsId}>
          <div><dt>Sent</dt><dd>{p.sends}</dd></div>
          <div><dt>Hosts</dt><dd className="num">{p.host}</dd></div>
          <div><dt>Licence</dt><dd>{p.licence}</dd></div>
          <div><dt>Shown as</dt><dd>{p.attribution}</dd></div>
        </dl>
      )}

      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Disconnect ${p.name}?`}
        actions={<><Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button><HoldToConfirm icon={<Unplug size={14} />} onConfirm={() => void disconnect()}>Disconnect</HoldToConfirm></>}
      >
        The {p.access === 'twitch' ? 'client ID and secret are' : 'key is'} removed from Windows Credential Manager. Details already filled in stay in your library; artwork you picked stays yours.
      </Dialog>
    </article>
  );
}

function StatusPill({ p }: { p: ProviderStatus }) {
  if (p.access !== 'keyless' && !p.configured) return <span className="dsrc-pill">Not connected</span>;
  if (!p.enabled) return <span className="dsrc-pill">Off</span>;
  if (p.lastTest && p.lastTest.outcome !== 'ok' && p.lastTest.outcome !== 'offline') return <span className="dsrc-pill dsrc-pill--warn">Needs attention</span>;
  return <span className="dsrc-pill dsrc-pill--ok">{p.access === 'keyless' ? 'On' : 'Connected'}</span>;
}

function Result({ result }: { result: ProviderTest }) {
  const o = OUTCOME[result.outcome] ?? OUTCOME.malformed;
  return (
    <div className={`dsrc-card__result dsrc-card__result--${o.tone}`} role="status" aria-live="polite">
      {o.tone === 'ok' ? <CheckCircle2 size={15} aria-hidden /> : <AlertTriangle size={15} aria-hidden />}
      <div>
        <strong>{o.title}</strong> <span>{result.message}</span> <span className="dsrc-card__when">· {formatRelative(result.at)}</span>
      </div>
    </div>
  );
}

const KEY_HELP: Partial<Record<DataSourceId, ReactNode>> = {
  steamgriddb: <>Sign in at SteamGridDB, open Preferences → API, and generate a key.</>,
  rawg: <>Create a free RAWG account and copy the key from the API page. RAWG asks for a link back wherever its data appears, which VYSTRAL adds.</>,
  itad: <>Register an app on IsThereAnyDeal (My apps) and copy its API key.</>,
};

function ConnectForm({ p, disabled, busy, onConnect, onLink }: {
  p: ProviderStatus; disabled: boolean; busy: boolean; onConnect: (key: string, secret: string | null) => Promise<ProviderAction | null>; onLink: (link: string) => void;
}) {
  const id = useId();
  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  const twitch = p.access === 'twitch';
  const valid = keyLooksValid(p.id, key, twitch ? secret : undefined);
  const touched = key.trim().length > 0 && (!twitch || secret.trim().length > 0);

  const submit = async () => {
    if (!valid || disabled) return;
    const r = await onConnect(key.trim(), twitch ? secret.trim() : null);
    if (r?.result.outcome === 'ok') {
      setKey('');
      setSecret('');
    }
  };

  return (
    <form className="dsrc-connect" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {twitch ? (
        <div className="dsrc-connect__explain">
          <ServiceLogo service="twitch" size={16} decorative />
          <p>
            IGDB is run by Twitch. Create <strong>your own</strong> free application at dev.twitch.tv (Category: Application Integration, Client Type:
            Confidential, any OAuth redirect such as http://localhost), then paste its Client ID and a new Client Secret. VYSTRAL never shares a key between users.
          </p>
        </div>
      ) : (
        <p className="dsrc-connect__help">{KEY_HELP[p.id]}</p>
      )}
      <div className="dsrc-connect__links">
        <Button type="button" size="sm" variant="ghost" icon={<ExternalLink size={14} />} disabled={disabled} onClick={() => onLink('keys')}>
          {twitch ? 'Open dev.twitch.tv' : 'Get a key'}
        </Button>
        {twitch && <Button type="button" size="sm" variant="ghost" icon={<ExternalLink size={14} />} onClick={() => onLink('docs')}>IGDB’s setup guide</Button>}
      </div>
      <label className="visually-hidden" htmlFor={`${id}-key`}>{twitch ? 'Twitch client ID' : `${p.name} API key`}</label>
      <span className="dsrc-connect__field">
        <KeyRound size={14} aria-hidden />
        <input id={`${id}-key`} className="num" type={twitch ? 'text' : 'password'} autoComplete="off" spellCheck={false} maxLength={120}
          placeholder={twitch ? 'Client ID' : 'API key'} value={key} disabled={disabled} onChange={(e) => setKey(e.target.value)} aria-describedby={`${id}-hint`} />
      </span>
      {twitch && (
        <>
          <label className="visually-hidden" htmlFor={`${id}-secret`}>Twitch client secret</label>
          <span className="dsrc-connect__field">
            <Lock size={14} aria-hidden />
            <input id={`${id}-secret`} className="num" type="password" autoComplete="off" spellCheck={false} maxLength={120}
              placeholder="Client secret" value={secret} disabled={disabled} onChange={(e) => setSecret(e.target.value)} aria-describedby={`${id}-hint`} />
          </span>
        </>
      )}
      <div className="dsrc-connect__submit">
        <span className="srow__hint" id={`${id}-hint`}>
          {touched && !valid ? 'That doesn’t look right yet: keys are letters and digits, without spaces.' : 'VYSTRAL tests it with one request before saving it.'}
        </span>
        <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!valid || disabled}>Connect</Button>
      </div>
    </form>
  );
}
