import { Clapperboard, Waves } from 'lucide-react';
import type { SettingKey } from '../../bridge/types';
import { Badge, Slider, Toggle } from '../../components/ui/primitives';
import { useLiveBlock } from '../../components/game/LiveTile';
import type { LiveBlock } from '../../lib/liveTiles';
import { MOOD_LABEL } from '../../lib/mood';
import { useStore } from '../../state/store';

function SwitchRow({ k, label, hint, disabled }: { k: SettingKey; label: string; hint: string; disabled?: boolean }) {
  const value = useStore((s) => !!s.settings?.[k]);
  const set = useStore((s) => s.setSetting);
  return (
    <div className="srow">
      <div className="srow__text">
        <label className="srow__label" htmlFor={k}>{label}</label>
        <div className="srow__hint">{hint}</div>
      </div>
      <div className="srow__control">
        <Toggle id={k} label={label} checked={value} disabled={disabled} onChange={(v) => void set(k, v as never)} />
      </div>
    </div>
  );
}

function VolumeRow({ k, label, disabled }: { k: 'sounds.volume' | 'sound.ambientVolume'; label: string; disabled?: boolean }) {
  const value = useStore((s) => s.settings?.[k] ?? 0.4);
  const set = useStore((s) => s.setSetting);
  return (
    <div className="srow" aria-disabled={disabled || undefined} style={disabled ? { opacity: 0.55 } : undefined}>
      <div className="srow__text">
        <span className="srow__label">{label}</span>
      </div>
      <div className="srow__control" style={{ width: 200 }}>
        <Slider label={label} value={value} min={0} max={1} step={0.05} onChange={(v) => void set(k, v)} />
      </div>
    </div>
  );
}

const LIVE_WHY: Partial<Record<LiveBlock, string>> = {
  dataSaver: 'Paused by Data saver',
  offline: 'Paused by Offline mode',
  reducedMotion: 'Paused by reduced motion',
  lowQuality: 'Paused at Low visual quality',
  safeMode: 'Off in safe mode',
  gameActive: 'Paused while a game runs',
};

/** Settings → Appearance: live tiles on Home (Track K). */
export function LiveTilesSettings() {
  const block = useLiveBlock();
  const live = useStore((s) => s.settings?.['home.liveTiles'] ?? true);
  const why = live && block ? LIVE_WHY[block] : null;
  return (
      <section className="sgroup">
        <h2 className="sgroup__title">Home</h2>
        <p className="sgroup__desc">
          Live tiles play the short, silent loops Steam makes for each store trailer, two at a time, only while a tile is on screen. They’re
          fetched through VYSTRAL (never straight from the page), kept in a small cache on this PC, and never downloaded in Offline mode,
          with Data saver on, on a metered connection with Data saver for metered connections, or while a game runs.
        </p>
        <div className="sgroup__rows surface">
          <SwitchRow k="home.liveTiles" label="Live tiles" hint="Steam games only. Other games keep their still artwork, which drifts gently when you point at it." />
          {why && (
            <div className="srow">
              <span className="srow__hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <Clapperboard size={14} aria-hidden /> {why}
              </span>
              <Badge>Paused</Badge>
            </div>
          )}
        </div>
      </section>
  );
}

/** Settings → Controller & sound: interface sounds and the mood-following ambient layer (Track K). */
export function SoundSettings() {
  const uiSounds = useStore((s) => !!s.settings?.['sounds.enabled']);
  const ambient = useStore((s) => !!s.settings?.['sound.ambient']);
  return (
      <section className="sgroup">
        <h2 className="sgroup__title">Sound</h2>
        <p className="sgroup__desc">
          Soft interface sounds, made on the fly (no audio files). Ambient sound adds a quiet bed and places focus sounds left or right
          where your focus lands, in the mood of the game you’re looking at ({Object.values(MOOD_LABEL).map((m) => m.split(' —')[0]).join(', ')}).
          Silent while a game runs, when VYSTRAL is minimized and when another window has focus.
        </p>
        <div className="sgroup__rows surface">
          <SwitchRow k="sounds.enabled" label="Interface sounds" hint="Short clicks for focus, select and back — mostly heard in Immersive Mode and with a controller." />
          <VolumeRow k="sounds.volume" label="Interface sound volume" disabled={!uiSounds} />
          <SwitchRow k="sound.ambient" label="Ambient sound" hint={uiSounds ? 'Follows the focused game’s mood.' : 'Needs interface sounds on.'} disabled={!uiSounds} />
          <VolumeRow k="sound.ambientVolume" label="Ambient volume" disabled={!uiSounds || !ambient} />
          {uiSounds && ambient && (
            <div className="srow">
              <span className="srow__hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <Waves size={14} aria-hidden /> Playing quietly while this window is focused.
              </span>
            </div>
          )}
        </div>
      </section>
  );
}
