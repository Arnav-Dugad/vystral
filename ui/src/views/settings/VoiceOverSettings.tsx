import { useEffect } from 'react';
import { AudioLines } from 'lucide-react';
import type { PadFamily } from '../../lib/padFamily';
import { detectedFamily, FAMILY_LABEL, usePadFamily } from '../../lib/padFamily';
import { useLocalVoices } from '../../lib/useVoiceOver';
import { normalizePrefs, pickVoice, RATE, voiceLabel, voiceOver } from '../../lib/voiceover';
import { useStore } from '../../state/store';
import { Button, PadGlyph, Segmented, Slider, Toggle } from '../../components/ui/primitives';
import { CaptionBar } from '../../components/voiceover/CaptionBar';
import type { PadButton } from '../../lib/padGlyphs';

/**
 * Settings → Controller & sound (Track T): voice-over and captions for Immersive Mode (Windows'
 * own local voices only, off by default), and which controller's button glyphs to show.
 */
export function VoiceOverSettings() {
  const settings = useStore((s) => s.settings);
  const set = useStore((s) => s.setSetting);
  const voices = useLocalVoices();
  const family = usePadFamily();
  useEffect(() => () => voiceOver.stop(), []);
  if (!settings) return null;
  const prefs = normalizePrefs({
    enabled: settings['voiceover.enabled'],
    captionsOnly: settings['voiceover.captionsOnly'],
    voice: settings['voiceover.voice'],
    rate: settings['voiceover.rate'],
    volume: settings['voiceover.volume'],
  });
  const noVoices = voices.length === 0;
  const voice = pickVoice(voices, prefs.voice, navigator.language);
  const detected = detectedFamily();
  const glyphPref = settings['controller.glyphs'] ?? 'auto';
  const sample: PadButton[] = ['A', 'B', 'X', 'Y', 'LB', 'RT', 'View', 'Menu'];

  const test = () => {
    voiceOver.configure(prefs);
    voiceOver.say(
      noVoices || prefs.captionsOnly ? 'This is how captions look in Immersive Mode.' : `Hi, I'm ${voice ? voiceLabel(voice).split(' · ')[0] : 'your voice'}. This is how VYSTRAL sounds.`,
      'test',
      true,
    );
  };

  return (
    <>
      <section className="sgroup">
        <h2 className="sgroup__title">Voice-over &amp; captions</h2>
        <p className="sgroup__desc">
          In Immersive Mode, reads out the game, row, menu item or notice you’re on — “Hades. Installed, 42 hours played” — and shows the same words as
          captions. It uses the voices installed in Windows, on this PC; nothing is sent online. Also in Immersive under Menu.
        </p>
        <div className="sgroup__rows surface">
          <div className="srow">
            <div className="srow__text">
              <label className="srow__label" htmlFor="voiceover.enabled">Voice-over in Immersive Mode</label>
              <div className="srow__hint">
                {noVoices
                  ? 'No Windows voices are installed on this PC, so this shows captions only. Add one in Windows Settings › Time & language › Speech.'
                  : 'Off by default. Interface and ambient sounds dip while it speaks.'}
              </div>
            </div>
            <div className="srow__control">
              <Toggle id="voiceover.enabled" label="Voice-over in Immersive Mode" checked={prefs.enabled} onChange={(v) => void set('voiceover.enabled', v)} />
            </div>
          </div>
          {!noVoices && (
            <>
              <div className="srow">
                <div className="srow__text">
                  <label className="srow__label" htmlFor="voiceover.captionsOnly">Captions only</label>
                  <div className="srow__hint">Show the words without speaking.</div>
                </div>
                <div className="srow__control">
                  <Toggle id="voiceover.captionsOnly" label="Captions only" checked={prefs.captionsOnly} onChange={(v) => void set('voiceover.captionsOnly', v)} />
                </div>
              </div>
              <div className="srow">
                <div className="srow__text">
                  <label className="srow__label" htmlFor="voiceover.voice">Voice</label>
                  <div className="srow__hint">{voices.length} {voices.length === 1 ? 'voice' : 'voices'} installed in Windows</div>
                </div>
                <div className="srow__control">
                  <select id="voiceover.voice" className="input" value={voice?.voiceURI ?? ''} onChange={(e) => void set('voiceover.voice', e.target.value)}>
                    {voices.map((v) => (
                      <option key={v.voiceURI} value={v.voiceURI}>{voiceLabel(v)}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="srow">
                <div className="srow__text">
                  <span className="srow__label">Speed</span>
                  <div className="srow__hint num">{Math.round(prefs.rate * 100)}%</div>
                </div>
                <div className="srow__control" style={{ width: 200 }}>
                  <Slider label="Voice speed" value={prefs.rate} min={RATE.min} max={RATE.max} step={RATE.step} onChange={(v) => void set('voiceover.rate', Math.round(v * 10) / 10)} />
                </div>
              </div>
              <div className="srow">
                <div className="srow__text">
                  <span className="srow__label">Volume</span>
                  <div className="srow__hint num">{Math.round(prefs.volume * 100)}%</div>
                </div>
                <div className="srow__control" style={{ width: 200 }}>
                  <Slider label="Voice volume" value={prefs.volume} min={0} max={1} step={0.05} onChange={(v) => void set('voiceover.volume', Math.round(v * 100) / 100)} />
                </div>
              </div>
            </>
          )}
          <div className="srow">
            <div className="srow__text">
              <span className="srow__label">Try it</span>
              <div className="srow__hint">Plays a short phrase{noVoices || prefs.captionsOnly ? ' as a caption' : ''}.</div>
            </div>
            <div className="srow__control">
              <Button size="sm" icon={<AudioLines size={14} />} onClick={test}>
                {noVoices || prefs.captionsOnly ? 'Show a caption' : 'Test the voice'}
              </Button>
            </div>
          </div>
        </div>
      </section>
      <section className="sgroup">
        <h2 className="sgroup__title">Button glyphs</h2>
        <p className="sgroup__desc">
          Which controller’s buttons VYSTRAL draws in hints. Automatic follows the controller you’re using
          {detected ? ` (now: ${FAMILY_LABEL[detected]})` : ' once you press one of its buttons'}.
        </p>
        <div className="sgroup__rows surface">
          <div className="srow">
            <div className="srow__text">
              <span className="srow__label">Show buttons for</span>
              <div className="srow__hint glyph-preview" aria-label={`Preview: ${FAMILY_LABEL[family]} buttons`} role="img">
                {sample.map((b) => (
                  <PadGlyph key={b} button={b} family={family as PadFamily} />
                ))}
              </div>
            </div>
            <div className="srow__control">
              <Segmented
                label="Button glyphs"
                value={glyphPref}
                options={[
                  { value: 'auto', label: 'Automatic' },
                  { value: 'xbox', label: 'Xbox' },
                  { value: 'playstation', label: 'PlayStation' },
                  { value: 'nintendo', label: 'Nintendo' },
                ]}
                onChange={(v) => void set('controller.glyphs', v)}
              />
            </div>
          </div>
        </div>
      </section>
      <CaptionBar />
    </>
  );
}
