import { Sparkles } from 'lucide-react';
import { COUCH_SAFE, COUCH_SCALE, couchSafe, couchScale, formatSafe, formatScale } from '../../lib/couch';
import { Button, Slider, Toggle } from '../../components/ui/primitives';
import { useStore } from '../../state/store';
import { VoiceOverSettings } from './VoiceOverSettings';

/**
 * Settings → Controller & sound → Immersive Mode (Track L): couch mode (text size, TV overscan
 * safe area), the cinematic mode switch, and replaying the short tour. The same couch controls
 * are in Immersive itself (system bar › Display, or the quick menu).
 */
export function ImmersiveSettings() {
  const settings = useStore((s) => s.settings);
  const set = useStore((s) => s.setSetting);
  if (!settings) return null;
  const scale = couchScale(settings['immersive.scale']);
  const safe = couchSafe(settings['immersive.safeArea']);
  return (
    <>
    <section className="sgroup">
      <h2 className="sgroup__title">Immersive Mode</h2>
      <p className="sgroup__desc">
        For a TV across the room: make everything larger, and keep it clear of the screen edges if your TV crops the picture (overscan).
        Both also live in Immersive under Display.
      </p>
      <div className="sgroup__rows surface">
        <div className="srow">
          <div className="srow__text">
            <span className="srow__label">Couch text size</span>
            <div className="srow__hint">{formatScale(scale)} of the normal Immersive size</div>
          </div>
          <div className="srow__control" style={{ width: 200 }}>
            <Slider label="Couch text size" value={scale} min={COUCH_SCALE.min} max={COUCH_SCALE.max} step={COUCH_SCALE.step} onChange={(v) => void set('immersive.scale', couchScale(v))} />
          </div>
        </div>
        <div className="srow">
          <div className="srow__text">
            <span className="srow__label">TV safe area</span>
            <div className="srow__hint">{safe ? `${formatSafe(safe)} margin on every edge` : 'Off — the interface uses the whole screen'}</div>
          </div>
          <div className="srow__control" style={{ width: 200 }}>
            <Slider label="TV safe area" value={safe} min={COUCH_SAFE.min} max={COUCH_SAFE.max} step={COUCH_SAFE.step} onChange={(v) => void set('immersive.safeArea', couchSafe(v))} />
          </div>
        </div>
        <div className="srow">
          <div className="srow__text">
            <label className="srow__label" htmlFor="immersive.cinematicSwitch">Cinematic mode switch</label>
            <div className="srow__hint">The art of the game you’re on fills the screen as you switch. Off, or with reduced motion, it’s a quick fade.</div>
          </div>
          <div className="srow__control">
            <Toggle id="immersive.cinematicSwitch" label="Cinematic mode switch" checked={settings['immersive.cinematicSwitch']} onChange={(v) => void set('immersive.cinematicSwitch', v)} />
          </div>
        </div>
        <div className="srow">
          <div className="srow__text">
            <span className="srow__label">Immersive tour</span>
            <div className="srow__hint">{settings['immersive.tourDone'] ? 'Seen. Show it again next time you open Immersive Mode.' : 'Shows the next time you open Immersive Mode.'}</div>
          </div>
          <div className="srow__control">
            <Button size="sm" icon={<Sparkles size={14} />} disabled={!settings['immersive.tourDone']} onClick={() => void set('immersive.tourDone', false)}>
              Show again
            </Button>
          </div>
        </div>
      </div>
    </section>
    {/* Track T */}
    <VoiceOverSettings />
    </>
  );
}
