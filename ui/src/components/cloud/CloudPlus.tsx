import { useEffect, useMemo, useState } from 'react';
import { Activity, Cable, ChevronDown, Cloud, ExternalLink, Gauge, HardDrive, Radio, Wifi } from 'lucide-react';
import { call } from '../../bridge/bridge';
import type { Game, Session } from '../../bridge/types';
import { formatHours, SERVICE_NAME, SERVICE_SHORT } from '../../lib/cloud';
import { bestWayToPlay, cloudInsights, linkText, READINESS_LABEL, readinessTone, trendText } from '../../lib/cloudPlus';
import { isInstalled, sizeOf } from '../../lib/format';
import { useCloudEnabled, useCloudMap, useCloudStatus, launchCloud } from '../../state/cloud';
import { useCloudReadiness } from '../../state/cloudReadiness';
import { useStore } from '../../state/store';
import { Button } from '../ui/primitives';
import { CloudMark } from './CloudBits';
import './cloud-plus.css';

/**
 * Track D5: the cloud readiness check. Opt-in by pressing the button: a handful of short connections to each service's
 * public website measure the round trip and how steady it is; Windows says the link type and speed. It says exactly
 * what that does and doesn't tell you.
 */
export function CloudReadinessCard({ compact }: { compact?: boolean }) {
  const { fresh, data, running, error, run } = useCloudReadiness();
  const offline = useStore((s) => !!s.settings?.['privacy.localOnly']);
  const [how, setHow] = useState(false);
  const r = fresh ?? null;
  const tone = r ? readinessTone(r.level) : 'muted';
  return (
    <div className="cready" data-tone={tone} data-compact={compact || undefined} aria-busy={running || undefined}>
      <div className="cready__head">
        <span className="cready__icon" aria-hidden>{r?.link === 'wifi' ? <Wifi size={18} /> : r?.link === 'ethernet' ? <Cable size={18} /> : <Activity size={18} />}</span>
        <div className="cready__titles">
          <strong className="cready__title">{r ? `Connection: ${READINESS_LABEL[r.level]}` : 'Is your connection ready for cloud play?'}</strong>
          <span className="cready__sub" role="status">
            {running ? 'Measuring… this takes a few seconds.' : r ? r.summary : offline ? 'Offline mode is on, so nothing is measured.' : 'A quick, read-only check of the round trip to each service, only when you ask.'}
          </span>
        </div>
        <Button size="sm" variant={r ? 'ghost' : 'secondary'} icon={<Gauge size={14} />} loading={running} disabled={offline} onClick={() => void run()}>
          {r ? 'Check again' : 'Check my connection'}
        </Button>
      </div>
      {error && <p className="cready__error" role="alert">{error}</p>}
      {r && (
        <>
          <ul className="cready__probes" aria-label="Measurements">
            {r.probes.map((p) => (
              <li key={p.service} className="cready__probe">
                <CloudMark service={p.service} size={14} />
                <span className="cready__probe-name">{SERVICE_SHORT[p.service]}</span>
                {p.latencyMs != null ? (
                  <>
                    <span className="cready__num num" title="Median time to open a connection: about one round trip">{Math.round(p.latencyMs)} ms</span>
                    <span className="cready__dim">round trip</span>
                    {p.jitterMs != null && <><span className="cready__num num" title="How much the round trip varied between attempts">± {Math.round(p.jitterMs)} ms</span><span className="cready__dim">jitter</span></>}
                    {p.loss > 0 && <span className="cready__loss">{Math.round(p.loss * 100)}% no answer</span>}
                  </>
                ) : <span className="cready__dim">{p.error ?? 'No answer'}</span>}
              </li>
            ))}
          </ul>
          <p className="cready__link"><span>{linkText(r)}</span>{r.metered && <span className="cready__metered">Metered connection</span>}</p>
          {r.tips.length > 0 && <ul className="cready__tips">{r.tips.map((t) => <li key={t}>{t}</li>)}</ul>}
        </>
      )}
      {!compact && (
        <div className="cready__how">
          <button type="button" className="cready__how-btn" aria-expanded={how} onClick={() => setHow((v) => !v)}>
            <ChevronDown size={14} aria-hidden /> What this measures
          </button>
          {how && (
            <div className="cready__how-text">
              <p>{data?.method ?? 'Six short connections to each service’s public website (play.geforcenow.com, www.xbox.com): no game data and nothing about you. That shows the round trip to a nearby server and how steady it is. The stream itself runs from the service’s data centres, so in-game delay can differ. The link speed is your network adapter’s speed to your router, not your internet speed.'}</p>
              <p>For a full streaming test, GeForce NOW’s own app has one under Settings → Network test.</p>
              <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => void call('cloud.openLink', { link: 'gfnSystem' }).catch(() => {})}>GeForce NOW’s recommended speeds</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Track D5: on a game page, the best way to play it right now — installed or streamed — from disk space, the download
 * size, the measured connection, GeForce NOW hours left and whether the network is metered. Shown only when a cloud
 * service lists the game (otherwise there's no choice to make).
 */
export function BestWayToPlay({ game }: { game: Game }) {
  const enabled = useCloudEnabled();
  const badges = useCloudMap()?.[game.id];
  const drives = useStore((s) => s.drives);
  const status = useCloudStatus();
  const { fresh, run, running } = useCloudReadiness();
  const offline = useStore((s) => !!s.settings?.['privacy.localOnly']);
  const installed = isInstalled(game);
  const size = sizeOf(game) ?? game.installations.reduce<number | null>((m, i) => (i.sizeBytes != null ? Math.max(m ?? 0, i.sizeBytes) : m), null);
  const advice = useMemo(() => (badges?.length ? bestWayToPlay({
    installed, sizeBytes: size, freeBytes: drives.map((d) => d.freeBytes), cloud: badges,
    readiness: fresh, meter: status?.meter ?? null, metered: !!fresh?.metered,
  }) : null), [badges, installed, size, drives, fresh, status]);
  if (!enabled || !advice) return null;
  const Icon = advice.way === 'cloud' ? Cloud : advice.way === 'installed' ? HardDrive : advice.way === 'install' ? HardDrive : Radio;
  return (
    <section className="bestway surface" data-way={advice.way} data-tone={advice.tone} aria-labelledby={`bestway-${game.id}`}>
      <span className="bestway__icon" aria-hidden><Icon size={18} /></span>
      <div className="bestway__text">
        <span className="bestway__eyebrow caps">Best way to play</span>
        <strong id={`bestway-${game.id}`} className="bestway__title">{advice.title}</strong>
        <p className="bestway__detail">{advice.detail}{advice.alternative ? <span className="bestway__alt"> {advice.alternative.charAt(0).toUpperCase() + advice.alternative.slice(1)}.</span> : null}</p>
      </div>
      <div className="bestway__actions">
        {advice.way === 'cloud' && advice.service && (
          <Button size="sm" variant="secondary" icon={<Cloud size={14} />} onClick={() => void launchCloud(game.id, advice.service!)}>Stream with {SERVICE_SHORT[advice.service]}</Button>
        )}
        {!fresh && !installed && !offline && (
          <Button size="sm" variant="ghost" icon={<Gauge size={14} />} loading={running} onClick={() => void run()}>Check my connection</Button>
        )}
      </div>
    </section>
  );
}

/** Track D5: cloud session insights (Settings → Cloud play): what you streamed, how long, how it's trending. */
export function CloudInsightsCard() {
  const enabled = useCloudEnabled();
  const gamesById = useStore((s) => s.gamesById);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    call<Session[]>('sessions.list', { limit: 500 }).then((l) => alive && setSessions(Array.isArray(l) ? l : [])).catch(() => alive && setSessions([]));
    return () => { alive = false; };
  }, [enabled]);
  const now = useMemo(() => Date.now(), [sessions]); // eslint-disable-line react-hooks/exhaustive-deps
  const ins = useMemo(() => (sessions ? cloudInsights(sessions, now) : null), [sessions, now]);
  if (!enabled || !sessions) return null;
  if (!ins) {
    return (
      <div className="cinsights cinsights--empty">
        <strong>Cloud sessions</strong>
        <p>Once you stream a game from VYSTRAL, you’ll see how long you play in the cloud, which games and which service, here.</p>
      </div>
    );
  }
  const trend = trendText(ins.last30, ins.prev30);
  const hour = ins.usualHour != null ? new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(new Date(2000, 0, 1, ins.usualHour)) : null;
  return (
    <div className="cinsights" aria-label="Cloud sessions">
      <div className="cinsights__stats">
        <div className="cinsights__stat"><span className="cinsights__value num">{formatHours(ins.seconds)}</span><span className="cinsights__label">streamed in {ins.sessions} session{ins.sessions === 1 ? '' : 's'}</span></div>
        {ins.typicalSeconds != null && <div className="cinsights__stat"><span className="cinsights__value num">{formatHours(ins.typicalSeconds)}</span><span className="cinsights__label">a typical session</span></div>}
        <div className="cinsights__stat"><span className="cinsights__value num">{formatHours(ins.longestSeconds)}</span><span className="cinsights__label">longest session</span></div>
        <div className="cinsights__stat"><span className="cinsights__value num">{formatHours(ins.last30)}</span><span className="cinsights__label">last 30 days</span></div>
      </div>
      <ul className="cinsights__rows">
        {ins.byService.map((b) => (
          <li key={b.service}><CloudMark service={b.service} size={12} /> {SERVICE_NAME[b.service]}: <strong className="num">{formatHours(b.seconds)}</strong> · {b.sessions} session{b.sessions === 1 ? '' : 's'}</li>
        ))}
        {ins.topGames.map((g) => (
          <li key={g.gameId}><Cloud size={12} aria-hidden /> {gamesById.get(g.gameId)?.title ?? 'A game no longer in your library'}: <strong className="num">{formatHours(g.seconds)}</strong></li>
        ))}
      </ul>
      <p className="cinsights__foot">
        {[trend, hour ? `You usually start around ${hour}` : null].filter(Boolean).join(' · ')}{trend || hour ? '. ' : ''}From cloud sessions VYSTRAL started; time on other devices isn’t counted.
      </p>
    </div>
  );
}
