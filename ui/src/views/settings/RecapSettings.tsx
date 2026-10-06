import type { SettingKey } from '../../bridge/types';
import { Toggle } from '../../components/ui/primitives';
import { useStore } from '../../state/store';
import { useTimeToBeatMap } from '../../state/recap';
import { plural } from '../../lib/format';

function SwitchRow({ k, label, hint }: { k: SettingKey; label: string; hint: React.ReactNode }) {
  const value = useStore((s) => !!s.settings?.[k]);
  const set = useStore((s) => s.setSetting);
  return (
    <div className="srow">
      <div className="srow__text">
        <label className="srow__label" htmlFor={k}>{label}</label>
        <div className="srow__hint">{hint}</div>
      </div>
      <div className="srow__control">
        <Toggle id={k} label={label} checked={value} onChange={(v) => void set(k, v as never)} />
      </div>
    </div>
  );
}

/** Settings → Launching & sessions: informative kernel anti-cheat notes (Track M). */
export function AntiCheatNotesSettings() {
  return (
    <section className="sgroup">
      <h2 className="sgroup__title">Anti-cheat notes</h2>
      <p className="sgroup__desc">
        When AreWeAntiCheatYet lists a kernel-level anti-cheat for a game, a short note appears before it starts and on its page, with what VYSTRAL itself does
        (read-only). It’s information only: nothing is blocked or changed. Needs the AreWeAntiCheatYet source on in Library &amp; stores → Data sources.
      </p>
      <div className="sgroup__rows surface">
        <SwitchRow k="launch.antiCheatNotes" label="Show anti-cheat notes" hint="Before launch (pre-flight) and on game pages." />
      </div>
    </section>
  );
}

/** Settings → Library & stores: IGDB time-to-beat bars (Track M). */
export function TimeToBeatSettings() {
  const ttb = useTimeToBeatMap();
  const count = ttb ? Object.keys(ttb.games).length : 0;
  const status = !ttb
    ? null
    : ttb.reason === 'noKey'
      ? 'Connect IGDB above (your own Twitch application) to get estimates.'
      : ttb.reason === 'disabled'
        ? null
        : count > 0
          ? `${plural(count, 'game')} with an estimate so far.`
          : 'No estimates yet. They arrive as IGDB details are filled in for your games.';
  return (
    <section className="sgroup">
      <h2 className="sgroup__title">Time to beat</h2>
      <p className="sgroup__desc">
        A slim bar on library cards, list rows and game pages compares your playtime with IGDB’s player-reported estimates (main story, main + extras,
        completionist). It uses details already saved from IGDB, so it sends nothing new, and games without an estimate show no bar.
      </p>
      <div className="sgroup__rows surface">
        <SwitchRow k="library.timeToBeat" label="Show time-to-beat bars" hint={status ?? 'Labelled “IGDB estimate” wherever it appears.'} />
      </div>
    </section>
  );
}
