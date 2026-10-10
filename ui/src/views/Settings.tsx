import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Bot, Cloud, Monitor, Database, Gamepad2, Info, LibraryBig, Palette, Rocket, Search, ShieldCheck, Sparkles, Download, AlertTriangle, CheckCircle2, XCircle,
} from 'lucide-react';
import { call, errorMessage } from '../bridge/bridge';
import type { AdapterInfo, DiagnosticsInfo, SettingKey, Settings } from '../bridge/types';
import { formatBytes, formatDate, formatRelative } from '../lib/format';
import { MOOD_LABEL } from '../lib/mood';
import { useStore } from '../state/store';
import { Badge, Button, rovingKey, Segmented, Slider, Toggle, PlatformBadge, PadHint, type PadButton } from '../components/ui/primitives';
import { HoldToConfirm } from '../components/controller/HoldToConfirm';
import { Dialog } from '../components/ui/Dialog';
import { UpdatePanel } from '../components/shell/UpdateCenter';
import { BackdropHint } from '../components/shell/SystemBackdrop';
import { useSystemAppearance } from '../state/systemAppearance';
import { SteamWebApiSettings } from './settings/SteamWebApiSettings';
import { SteamExtrasSettings } from './settings/SteamExtrasSettings'; // Track W
import { GamePageSettings } from './settings/GamePageSettings'; // Track C4
import { FpsCaptureSettings } from './settings/FpsCaptureSettings';
import { WindowsIntegrationSettings } from './settings/WindowsIntegrationSettings';
import { DataSaverSettings } from './settings/DataSaverSettings';
import { NetworkHealthSettings } from './settings/NetworkHealthSettings';
import { NewBadge, NewBadgeGroup } from '../whatsnew/NewBadge';
import { openWhatsNew } from '../whatsnew/state';
import { LiveTilesSettings, SoundSettings } from './settings/LiveTilesAndSoundSettings';
import { DataSourcesSettings } from './settings/DataSourcesSettings';
import { AntiCheatNotesSettings, TimeToBeatSettings } from './settings/RecapSettings';
import { BackgroundTrackingSettings } from './settings/BackgroundTrackingSettings';
import { ArtPacksSettings } from './settings/ArtPacksSettings';
import { ImmersiveSettings } from './settings/ImmersiveSettings';
import { OnScreenKeyboardRows } from './settings/KeyboardSettings';
import { ServiceLogo } from '../components/ui/ServiceLogo';
import { HealthSettings } from './settings/HealthSettings';
import { CloudSettings } from './settings/CloudSettings';
import { EnergySettings } from './settings/EnergySettings';
import { BatteryHistoryCard } from '../components/controller/BatteryHistoryCard';
import { CloudQueueAlertSettings, SubscriptionsSettings } from './settings/SubscriptionsSettings';
import { CompactionSettings, SelfCheckSettings } from './settings/MaintenanceSettings';
import './settings.css';

interface Section {
  id: string;
  label: string;
  icon: ReactNode;
  keywords: string;
}

const SECTIONS: Section[] = [
  { id: 'appearance', label: 'Appearance', icon: <Palette size={17} />, keywords: 'theme dark light oled contrast accent colour color living canvas background motion animation reduced intro quality grid home live tiles trailer' },
  { id: 'library', label: 'Library & stores', icon: <LibraryBig size={17} />, keywords: 'steam xbox epic gog ea ubisoft battle.net integrations scan metadata artwork download data sources steamgriddb igdb twitch rawg isthereanydeal cheapshark prices deals wikidata deck anti-cheat api key art packs style covers logos backgrounds blurred material health broken shortcuts missing drive duplicates fix subscriptions game pass ultimate premium essential play ubisoft+ humble choice prime gaming luna leaving soon included price cost per hour wishlist sale lowest release friends played news patch notes updates' },
  { id: 'cloud', label: 'Cloud play', icon: <Cloud size={17} />, keywords: 'cloud streaming stream geforce now gfn nvidia xbox gaming game pass xcloud hours meter membership performance ultimate edge browser region queue alerts position' },
  { id: 'launching', label: 'Launching & sessions', icon: <Rocket size={17} />, keywords: 'launch cinematic instant minimize restore performance mode pulse metrics cpu gpu background apps processes driver tracker outside closed startup detected energy power watts electricity kwh cost price' },
  { id: 'controller', label: 'Controller & sound', icon: <Gamepad2 size={17} />, keywords: 'gamepad xbox controller vibration rumble on-screen keyboard typing text suggestions battery charge sound audio ambient volume mood immersive fullscreen' },
  { id: 'windows', label: 'Windows integration', icon: <Monitor size={17} />, keywords: 'hotkey shortcut summon notifications toast windows tray achievements' },
  { id: 'ai', label: 'Local AI', icon: <Bot size={17} />, keywords: 'ollama assistant model ai natural language' },
  { id: 'updates', label: 'Updates', icon: <Download size={17} />, keywords: 'update version release automatic download self-check health check after update rollback' },
  { id: 'privacy', label: 'Privacy', icon: <ShieldCheck size={17} />, keywords: 'privacy telemetry network offline local data' },
  { id: 'data', label: 'Data & recovery', icon: <Database size={17} />, keywords: 'backup export delete history cache logs reset database safe mode recovery compact compaction vacuum size upkeep' },
  { id: 'about', label: 'About', icon: <Info size={17} />, keywords: 'version licence license github credits' },
];

export function SettingsView({ section }: { section?: string }) {
  const [active, setActive] = useState(section ?? 'appearance');
  const [query, setQuery] = useState('');
  const settings = useStore((s) => s.settings);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? SECTIONS.filter((s) => `${s.label} ${s.keywords}`.toLowerCase().includes(q)) : SECTIONS;
  }, [query]);
  useEffect(() => {
    if (shown.length && !shown.some((s) => s.id === active)) setActive(shown[0].id);
  }, [shown, active]);
  // A deep link (e.g. from "What's new") to another section while Settings is already open.
  const [linked, setLinked] = useState(section);
  if (section !== linked) {
    setLinked(section);
    if (section) setActive(section);
  }

  if (!settings) return null;
  return (
    <div className="page settings">
      <h1 className="lib-head__title">Settings</h1>
      <div className="settings__layout">
        <nav className="settings__nav" aria-label="Settings sections">
          <label className="settings__search">
            <Search size={15} aria-hidden />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search settings" aria-label="Search settings" />
          </label>
          {shown.map((s) => (
            <button
              key={s.id}
              className="settings__navitem"
              aria-current={active === s.id ? 'true' : undefined}
              onClick={() => {
                setActive(s.id);
                // Keep the route in step, so a later deep link to a section always lands.
                useStore.getState().navigate({ name: 'settings', section: s.id }, { replace: true });
              }}
            >
              {s.icon}
              {s.label}
              <NewBadgeGroup prefix={`settings.${s.id}.`} />
            </button>
          ))}
          {shown.length === 0 && <p className="stat__hint" style={{ padding: 12 }}>No settings match “{query}”.</p>}
        </nav>
        <div className="settings__content">
          {active === 'appearance' && <><Appearance s={settings} /><LiveTilesSettings /></>}
          {active === 'library' && <><LibrarySection s={settings} /><SubscriptionsSettings /><HealthSettings /><SteamWebApiSettings /><SteamExtrasSettings /><GamePageSettings /><DataSourcesSettings /><TimeToBeatSettings /><ArtPacksSettings /></>}
          {active === 'cloud' && <><CloudSettings /><CloudQueueAlertSettings /></>}
          {active === 'launching' && <><Launching s={settings} /><BackgroundTrackingSettings /><FpsCaptureSettings /><EnergySettings /><AntiCheatNotesSettings /></>}
          {active === 'controller' && <><Controller s={settings} /><BatteryHistoryCard variant="settings" /><ImmersiveSettings /><SoundSettings /></>}
          {active === 'ai' && <AiSection s={settings} />}
          {active === 'updates' && <Updates s={settings} />}
          {active === 'privacy' && <><Privacy s={settings} /><DataSaverSettings /><NetworkHealthSettings /></>}
          {active === 'windows' && <WindowsIntegrationSettings />}
          {active === 'data' && <DataSection />}
          {active === 'about' && <About />}
        </div>
      </div>
    </div>
  );
}

function useSet() {
  return useStore((s) => s.setSetting);
}

function Group({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="sgroup">
      <h2 className="sgroup__title">{title}</h2>
      {description && <p className="sgroup__desc">{description}</p>}
      <div className="sgroup__rows surface">{children}</div>
    </section>
  );
}

function Row({ label, hint, control, id }: { label: ReactNode; hint?: ReactNode; control: ReactNode; id?: string }) {
  return (
    <div className="srow">
      <div className="srow__text">
        <label className="srow__label" htmlFor={id}>{label}</label>
        {hint && <div className="srow__hint">{hint}</div>}
      </div>
      <div className="srow__control">{control}</div>
    </div>
  );
}

function BoolRow({ s, k, label, hint, badge }: { s: Settings; k: SettingKey; label: string; hint?: ReactNode; badge?: string }) {
  const set = useSet();
  const shown = badge ? <>{label}<NewBadge k={badge} variant="pill" seenWhenVisible /></> : label;
  return <Row id={k} label={shown} hint={hint} control={<Toggle id={k} label={label} checked={!!s[k]} onChange={(v) => void set(k, v as never)} />} />;
}

function Appearance({ s }: { s: Settings }) {
  const set = useSet();
  const themes: { value: Settings['appearance.theme']; label: string; swatch: string }[] = [
    { value: 'obsidian', label: 'Obsidian', swatch: 'linear-gradient(135deg, oklch(0.2 0.03 290), oklch(0.13 0.012 282))' },
    { value: 'oled', label: 'OLED black', swatch: '#000' },
    { value: 'light', label: 'Light', swatch: 'linear-gradient(135deg, #fff, oklch(0.93 0.01 282))' },
    { value: 'contrast', label: 'High contrast', swatch: 'linear-gradient(135deg, #000 50%, oklch(0.9 0.18 100) 50%)' },
  ];
  const accents: Settings['appearance.accent'][] = ['auto', 'system', 'violet', 'blue', 'cyan', 'rose', 'amber', 'emerald'];
  const accentLabel = (a: string) => (a === 'auto' ? 'Automatic' : a === 'system' ? 'Windows accent' : a);
  const sys = useSystemAppearance((x) => x.appearance);
  const systemSwatch = sys ? `linear-gradient(135deg, ${sys.accentLight[1] ?? sys.accent}, ${sys.accent} 55%, ${sys.accentDark[0] ?? sys.accent})` : '#0078d4';
  const accentColor: Record<string, string> = { violet: 'oklch(0.7 0.17 292)', blue: 'oklch(0.7 0.15 255)', cyan: 'oklch(0.78 0.12 210)', rose: 'oklch(0.74 0.16 5)', amber: 'oklch(0.82 0.15 75)', emerald: 'oklch(0.78 0.15 160)' };
  return (
    <>
      <Group title="Theme">
        <div className="theme-picker" role="radiogroup" aria-label="Theme">
          {themes.map((t) => (
            <button
              key={t.value}
              role="radio"
              aria-checked={s['appearance.theme'] === t.value}
              tabIndex={s['appearance.theme'] === t.value ? 0 : -1}
              className="theme-card"
              onClick={() => void set('appearance.theme', t.value)}
              onKeyDown={(e) => rovingKey(e, themes, s['appearance.theme'], (v) => void set('appearance.theme', v), true)}
            >
              <span className="theme-card__swatch" style={{ background: t.swatch }} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        <Row
          label={<>Accent colour<NewBadge k="settings.appearance.windows-accent" variant="pill" seenWhenVisible /></>}
          hint="Automatic follows the artwork of the game you’re looking at; Windows accent follows your Windows colour. Both are adjusted so text always stays readable."
          control={
            <div className="accent-picker" role="radiogroup" aria-label="Accent colour">
              {accents.map((a) => (
                <button key={a} role="radio" aria-checked={s['appearance.accent'] === a} tabIndex={s['appearance.accent'] === a ? 0 : -1} onKeyDown={(e) => rovingKey(e, accents.map((value) => ({ value })), s['appearance.accent'], (v) => void set('appearance.accent', v), true)} aria-label={accentLabel(a)} title={accentLabel(a)} className={a === 'system' ? 'accent-dot accent-dot--system' : 'accent-dot'} style={{ background: a === 'auto' ? 'conic-gradient(oklch(0.7 0.17 292), oklch(0.78 0.12 210), oklch(0.82 0.15 75), oklch(0.74 0.16 5), oklch(0.7 0.17 292))' : a === 'system' ? systemSwatch : accentColor[a] }} onClick={() => void set('appearance.accent', a)} />
              ))}
            </div>
          }
        />
      </Group>
      <Group title="Living Canvas" description={<>A subtle animated background that takes on each game’s colours and mood ({Object.values(MOOD_LABEL).map((m) => m.split(' —')[0]).join(', ')}). It pauses whenever VYSTRAL is hidden or a game is running.</>}>
        <BoolRow s={s} k="appearance.livingCanvas" label="Living Canvas" hint={<BackdropHint />} />
        <Row label="Intensity" control={<div style={{ width: 200 }}><Slider label="Living Canvas intensity" value={s['appearance.canvasIntensity']} min={0} max={1} step={0.05} onChange={(v) => void set('appearance.canvasIntensity', v)} /></div>} />
        <BoolRow s={s} k="canvas.followTrailer" label="Follow trailer colours" badge="settings.appearance.follow-trailer" hint="While a game’s trailer plays, the background slowly takes on its colours, then returns to the artwork. Off with reduced motion or low quality." />
        <Row
          label="Visual quality"
          hint="Low turns off blur and animated backgrounds — best for older or battery-powered PCs."
          control={<Segmented label="Visual quality" value={s['appearance.quality']} onChange={(v) => void set('appearance.quality', v)} options={[{ value: 'auto', label: 'Auto' }, { value: 'high', label: 'High' }, { value: 'balanced', label: 'Balanced' }, { value: 'low', label: 'Low' }]} />}
        />
      </Group>
      <Group title="Motion">
        <Row
          label="Reduce motion"
          hint="Replaces movement with quick fades and stops background animation. “System” follows Windows’ animation setting."
          control={<Segmented label="Reduce motion" value={s['motion.reduce']} onChange={(v) => void set('motion.reduce', v)} options={[{ value: 'system', label: 'System' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />}
        />
        <BoolRow s={s} k="startup.intro" label="Play the startup animation" hint="About three seconds, once per launch. Press any key, click or controller button to skip it." />
      </Group>
    </>
  );
}

function LibrarySection({ s }: { s: Settings }) {
  const adapters = useStore((st) => st.adapters);
  const refreshAdapters = useStore((st) => st.refreshAdapters);
  const scan = useStore((st) => st.scan);
  const scanLibrary = useStore((st) => st.scanLibrary);
  const lastScan = useStore((st) => st.library.lastScan);
  useEffect(() => void refreshAdapters(), [refreshAdapters]);
  const toggle = async (a: AdapterInfo, enabled: boolean) => {
    try {
      useStore.setState({ adapters: await call<AdapterInfo[]>('library.setPlatformEnabled', { platform: a.platform, enabled }) });
    } catch (err) {
      useStore.getState().toast({ tone: 'danger', title: 'Couldn’t change the integration', body: errorMessage(err) });
    }
  };
  return (
    <>
      <Group
        title="Store integrations"
        description="VYSTRAL reads what your store apps already keep on this PC. It never asks for your passwords, never signs in on your behalf, and never changes store files."
      >
        <div className="srow" style={{ justifyContent: 'space-between' }}>
          <span className="srow__hint">{lastScan ? `Last scanned ${formatRelative(lastScan).toLowerCase()}` : 'Not scanned yet'}</span>
          <Button size="sm" variant="primary" loading={scan.running} onClick={() => void scanLibrary()}>Rescan now</Button>
        </div>
        {adapters.map((a) => (
          <div key={a.platform} className="adapter logo-host">
            <div className="adapter__head">
              <PlatformBadge platform={a.platform} size={20} motion />
              {a.status === 'Available' ? <Badge tone="ok" icon={<CheckCircle2 size={12} />}>Found</Badge> : a.status === 'NotInstalled' ? <Badge>Not installed</Badge> : <Badge tone="warn" icon={<AlertTriangle size={12} />}>Problem</Badge>}
              {a.lastScanCount != null && a.status === 'Available' && <span className="srow__hint">{a.lastScanCount} found{a.lastScanMs != null ? ` · ${a.lastScanMs} ms` : ''}</span>}
              <div style={{ marginLeft: 'auto' }}>
                <Toggle label={`Use ${a.displayName}`} checked={a.enabled} onChange={(v) => void toggle(a, v)} />
              </div>
            </div>
            {(a.detail || a.lastScanError) && <p className="adapter__error"><XCircle size={13} /> {a.lastScanError ?? a.detail}</p>}
            <div className="adapter__caps">
              {a.capabilities.map((c) => <Badge key={c}>{CAPABILITY_LABEL[c] ?? c}</Badge>)}
            </div>
            <ul className="adapter__limits">
              {a.limitations.map((l) => <li key={l}>{l}</li>)}
            </ul>
          </div>
        ))}
      </Group>
      <Group title="Details and artwork" description="Optional. When on, VYSTRAL looks up genres, descriptions and artwork on Steam’s public store pages (no account needed). Only exact title matches are used, so the wrong game’s art never appears.">
        <BoolRow s={s} k="library.fetchMetadata" label="Look up game details online" />
        <BoolRow s={s} k="library.fetchArtwork" label="Download missing artwork" hint="Uses images your stores already keep on this PC first." />
      </Group>
    </>
  );
}

const CAPABILITY_LABEL: Record<string, string> = {
  DiscoverInstalled: 'Finds installed games',
  ImportOwned: 'Imports owned games',
  Launch: 'Launches games',
  LocalArtwork: 'Local artwork',
  ImportPlaytime: 'Store playtime',
  ImportLastPlayed: 'Last played',
  Achievements: 'Achievements',
  InstallSize: 'Install size',
  OpenInClient: 'Opens store page',
};

function Launching({ s }: { s: Settings }) {
  return (
    <>
      <Group title="Launching">
        <BoolRow s={s} k="launch.cinematic" label="Cinematic launch" hint="A short full-screen transition while your game starts. Turn off for instant, minimal launches." />
        <BoolRow s={s} k="launch.minimizeOnStart" label="Get out of the way while playing" hint="Minimizes VYSTRAL and suspends its interface so it uses almost no CPU or GPU during your game." />
        <BoolRow s={s} k="launch.restoreOnExit" label="Come back when the game closes" hint="Restores VYSTRAL and shows a summary of your session." />
      </Group>
      <Group title="Sessions & performance" description="Readings come from Windows performance counters (and NVIDIA’s driver for GPU temperature when present). They are read-only: VYSTRAL never changes clocks, fans, power limits or game files.">
        <BoolRow s={s} k="performance.collectMetrics" label="Record CPU, GPU and memory while playing" hint="One light reading every two seconds, stored only on this PC. Frame rate needs the optional frame-rate capture below." />
        <BoolRow s={s} k="performance.backgroundApps" label="Note which other apps are running" badge="settings.launching.background-apps" hint="About every 30 seconds, VYSTRAL notes the program names of the heaviest other apps (memory and CPU only — no window titles or paths), so the Performance page can show which ones tend to run during rough sessions. Read-only, without opening any process. Needs the recording above." />
        <BoolRow s={s} k="pulse.enabled" label="Show the Pulse window during games" hint="A tiny always-on-top window with your session timer and system load. It’s a normal window — nothing is injected into games. It can’t appear over exclusive-fullscreen games." />
        <Row label="Preview the Pulse window" control={<Button size="sm" onClick={() => void call('window.pulse', { visible: true }).catch(() => {})}>Show preview</Button>} />
      </Group>
    </>
  );
}

function Controller({ s }: { s: Settings }) {
  const setMode = useStore((st) => st.setMode);
  return (
    <>
      <Group title="Controller" description="Works with Xbox-compatible controllers. VYSTRAL only reads the controller while its own window is focused, and stops completely while a game is running.">
        <BoolRow s={s} k="controller.enabled" label="Navigate with a controller" />
        <BoolRow s={s} k="controller.vibration" label="Gentle vibration feedback" />
        <OnScreenKeyboardRows />
        <BoolRow s={s} k="startup.immersive" label="Start in Immersive Mode" hint="The full-screen, controller-first layout. Press F11 to switch any time; in Immersive Mode the Menu button opens the guide." />
        <BoolRow s={s} k="immersive.attract" label="Screensaver in Immersive Mode" hint="After a few idle minutes, slowly cycles your games' artwork and your own screenshots. Any button returns you exactly where you were." />
        <Row
          label="Start the screensaver after"
          hint={`${s['immersive.attractMinutes']} minute${s['immersive.attractMinutes'] === 1 ? '' : 's'} without input`}
          control={<div style={{ width: 200 }}><Slider label="Screensaver delay in minutes" value={s['immersive.attractMinutes']} min={1} max={30} step={1} onChange={(v) => void useStore.getState().setSetting('immersive.attractMinutes', v)} /></div>}
        />
        {/* Track Z: trailer loops and the big clock in the screensaver; your own Home row order. */}
        <BoolRow s={s} k="immersive.attractTrailers" label="Trailers in the screensaver" hint="Silent trailer loops of games you haven't played in a while. Never with Data saver, Offline mode or Low quality, and paused on battery saver." />
        <BoolRow s={s} k="immersive.attractClock" label="Big clock in the screensaver" hint="A large, quiet clock for TVs. It moves a little every minute so it can't burn in, and follows your Windows 12- or 24-hour format." />
        <Row
          label="Immersive Home row order"
          hint={`${s['immersive.rowOrder'] ? 'Your own order.' : 'By time of day.'} In Immersive Mode, go left past a row’s first game and hold Y to move it.`}
          control={<Button size="sm" disabled={!s['immersive.rowOrder']} onClick={() => void useStore.getState().setSetting('immersive.rowOrder', '')}>Reset row order</Button>}
        />
        <Row label="Try Immersive Mode" control={<Button size="sm" icon={<Gamepad2 size={14} />} onClick={() => void setMode('immersive')}>Open</Button>} />
      </Group>
      <div className="pad-legend surface">
        {([[['A'], 'Select'], [['B'], 'Back'], [['X'], 'Options'], [['A'], 'Type in a text box'], [['Y'], 'Search'], [['LB', 'RB'], 'Back / forward'], [['Menu'], 'Immersive Mode'], [['RS'], 'Scroll']] as [PadButton[], string][]).map(([b, d]) => (
          <PadHint key={d} button={b.length === 1 ? b[0] : b}>{d}</PadHint>
        ))}
      </div>
    </>
  );
}

function AiSection({ s }: { s: Settings }) {
  const navigate = useStore((st) => st.navigate);
  return (
    <Group title="Local AI (optional)" description={<>Uses <span className="svc-name"><ServiceLogo service="ollama" size={14} decorative />Ollama</span> running on this PC. Nothing is sent to the cloud, no account is needed, and AI pauses while you play. Everything in VYSTRAL works without it.</>}>
      <BoolRow s={s} k="ai.enabled" label="Enable local AI" hint="Adds natural-language search to the command bar and the Assistant page." />
      <Row label="Model" hint={<span className="num">{s['ai.model']}</span>} control={<Button size="sm" icon={<Sparkles size={14} />} onClick={() => navigate({ name: 'assistant' })}>Manage in Assistant</Button>} />
    </Group>
  );
}

function Updates({ s }: { s: Settings }) {
  return (
    <>
      <Group title="Updates">
        <div style={{ padding: 'var(--s-5)' }}>
          <UpdatePanel />
        </div>
      </Group>
      <Group title="Automatic updates">
        <BoolRow s={s} k="updates.autoCheck" label="Check for updates automatically" hint="Once shortly after starting VYSTRAL. Only contacts github.com." />
        <BoolRow s={s} k="updates.autoDownload" label="Download updates in the background" hint="Never while a game is running. Updates install when you restart VYSTRAL." />
      </Group>
      <SelfCheckSettings />
    </>
  );
}

function Privacy({ s }: { s: Settings }) {
  return (
    <>
      <Group title="Your data stays on this PC" description="VYSTRAL has no accounts, no telemetry, no ads and no tracking. Your library, sessions and notes are stored locally in VYSTRAL’s data folder.">
        <BoolRow s={s} k="privacy.localOnly" label="Offline mode" hint="Stops all optional network access: game details, artwork downloads and update checks. Launching games is unaffected." />
      </Group>
      <div className="privacy-list surface">
        <h3>When VYSTRAL uses the network</h3>
        <ul>
          <li><strong>Game details & artwork</strong> — Steam’s public store pages, only if enabled.</li>
          <li><strong>Trailers</strong> — streamed from Steam’s video servers when you open a game page, only if game details are on and Data saver is off. Nothing is stored.</li>
          <li><strong>Update checks</strong> — github.com, only if enabled.</li>
          <li><strong>Local AI</strong> — talks to Ollama on this PC (localhost) only.</li>
          <li><strong>Your games and stores</strong> — they connect to their own services as usual; VYSTRAL doesn’t see or change that traffic.</li>
        </ul>
      </div>
    </>
  );
}

function DataSection() {
  const [diag, setDiag] = useState<DiagnosticsInfo | null>(null);
  const [confirm, setConfirm] = useState<'history' | 'reset' | null>(null);
  const toast = useStore((s) => s.toast);
  const load = () => call<DiagnosticsInfo>('diagnostics.info').then(setDiag).catch(() => {});
  useEffect(() => void load(), []);

  const run = async (method: string, ok: (r: any) => string) => {
    try {
      const r = await call<any>(method, undefined, 120_000);
      if (r !== null) toast({ tone: 'success', title: ok(r) });
      void load();
    } catch (err) {
      toast({ tone: 'danger', title: 'That didn’t work', body: errorMessage(err) });
    }
  };

  return (
    <>
      <Group title="Your data">
        <Row label="Data folder" hint={<span className="selectable num">{diag?.dataPath ?? '…'}</span>} control={<Button size="sm" onClick={() => void call('app.openDataFolder')}>Open</Button>} />
        <Row label="Library database" hint={diag ? `${formatBytes(diag.database.sizeBytes)} · schema v${diag.database.schemaVersion}` : '…'} control={
          <div style={{ display: 'flex', gap: 6 }}>
            <Button size="sm" onClick={() => void run('diagnostics.checkDatabase', (r) => (r.result === 'ok' ? 'Database is healthy' : `Database check: ${r.result}`))}>Check</Button>
            <Button size="sm" onClick={() => void run('diagnostics.backupNow', (r) => `Backup saved to ${r.path}`)}>Back up now</Button>
          </div>
        } />
        <Row label="Artwork cache" hint={diag ? formatBytes(diag.artCacheBytes) : '…'} control={<Button size="sm" onClick={() => void run('data.clearArtCache', (r) => `Freed ${formatBytes(r.freedBytes)}. Store artwork will be re-imported on the next scan.`)}>Clear</Button>} />
        <Row label="Export your journal" hint="Sessions, playtime, notes and ratings as a JSON file." control={<Button size="sm" onClick={() => void run('data.exportJournal', (r) => `Exported to ${r.path}`)}>Export…</Button>} />
      </Group>
      <CompactionSettings />

      <Group title="Reset & delete">
        <Row label="Delete tracked play history" hint="Removes sessions and performance readings recorded by VYSTRAL. Store playtime and your games are not affected." control={<Button size="sm" variant="danger" onClick={() => setConfirm('history')}>Delete…</Button>} />
        <Row label="Reset all settings" hint="Restores defaults. Your library, notes and history are kept." control={<Button size="sm" variant="danger" onClick={() => setConfirm('reset')}>Reset…</Button>} />
      </Group>
      <Group title="Troubleshooting" description="If VYSTRAL ever misbehaves, hold Shift while starting it to open safe mode (no visual effects, AI or background downloads).">
        <Row label="Logs" hint="Diagnostic logs from the last 7 days. They contain file paths but never passwords." control={<Button size="sm" onClick={() => void call('app.openLogs')}>Open logs folder</Button>} />
        {diag && diag.recentAudit.length > 0 && (
          <details className="audit">
            <summary>Recent changes made by VYSTRAL ({diag.recentAudit.length})</summary>
            <ul>
              {diag.recentAudit.map((a, i) => (
                <li key={i}><span className="num">{formatDate(a.at, { dateStyle: 'short', timeStyle: 'short' })}</span> {a.action} <span className="srow__hint">{a.detail}</span></li>
              ))}
            </ul>
          </details>
        )}
      </Group>
      <Dialog
        open={confirm === 'history'}
        onClose={() => setConfirm(null)}
        title="Delete your tracked play history?"
        actions={<><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button><HoldToConfirm onConfirm={() => { setConfirm(null); void run('data.deleteHistory', (r) => `Deleted ${r.deletedSessions} sessions`); }}>Delete history</HoldToConfirm></>}
      >
        This permanently removes every session and performance reading VYSTRAL recorded. Your games, notes, ratings, collections and the playtime your stores report are kept. Consider exporting your journal first.
      </Dialog>
      <Dialog
        open={confirm === 'reset'}
        onClose={() => setConfirm(null)}
        title="Reset all settings?"
        actions={<><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button><HoldToConfirm onConfirm={() => { setConfirm(null); void run('settings.reset', () => 'Settings restored to defaults'); }}>Reset settings</HoldToConfirm></>}
      >
        Appearance, launching, controller, AI and update preferences go back to their defaults. Your library and history are not affected.
      </Dialog>
    </>
  );
}

function About() {
  const info = useStore((s) => s.info);
  return (
    <div className="about surface">
      <img src="./vystral-mark.svg" alt="" width={72} height={72} />
      <div>
        <div className="wordmark" style={{ fontSize: 20 }}>VYSTRAL</div>
        <p className="srow__hint">Your Universe of Play</p>
        <p style={{ marginTop: 12 }}>Version <span className="num">{info?.version}</span></p>
        <p className="srow__hint" style={{ marginTop: 12, maxWidth: 520 }}>
          Free, local-first and open source. Built with .NET, WinUI 3, WebView2, React and SQLite. Fonts: Geist, Geist Mono and Unbounded (SIL Open Font License). Icons: Lucide (ISC). Game names, artwork and descriptions belong to their respective owners. VYSTRAL is not affiliated with Valve, Microsoft, Epic Games, GOG, Electronic Arts, Ubisoft or Blizzard.
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <Button size="sm" onClick={() => void call('app.openExternal', { url: 'https://github.com/Arnav-Dugad/vystral' }).catch(() => {})}>GitHub</Button>
          <Button size="sm" variant="ghost" onClick={() => void call('update.openReleases').catch(() => {})}>Release notes</Button>
          <Button size="sm" variant="ghost" icon={<Sparkles size={14} />} onClick={openWhatsNew}>
            See what’s new<NewBadge k="settings.about.whats-new" variant="pill" seenWhenVisible />
          </Button>
        </div>
        {info?.os && <p className="srow__hint num" style={{ marginTop: 16 }}>{info.os} · {info.cpuCount} logical CPUs</p>}
      </div>
    </div>
  );
}
