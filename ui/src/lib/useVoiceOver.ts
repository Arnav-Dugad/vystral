import { useEffect, useSyncExternalStore } from 'react';
import { useStore } from '../state/store';
import { setSoundDuck } from './sound';
import { normalizePrefs, sentence, spokenName, voiceOver, type Caption } from './voiceover';

/**
 * React glue for voice-over (Track T). A surface that wants voice-over calls
 * {@link useVoiceOverSurface} once; anything inside can then call `voiceOver.say()`.
 */

/** Settings → engine; notices; focus inside dialogs and menus; quiet while a game runs. */
export function useVoiceOverSurface({ focusRoot }: { focusRoot?: string } = {}) {
  const s = useStore((st) => st.settings);
  const gameActive = useStore((st) => !!st.launch && ['starting', 'waiting', 'running'].includes(st.launch.phase));
  const prefs = normalizePrefs({
    enabled: s?.['voiceover.enabled'],
    captionsOnly: s?.['voiceover.captionsOnly'],
    voice: s?.['voiceover.voice'],
    rate: s?.['voiceover.rate'],
    volume: s?.['voiceover.volume'],
  });
  const key = JSON.stringify(prefs);
  useEffect(() => {
    voiceOver.configure(JSON.parse(key));
  }, [key]);
  useEffect(() => {
    voiceOver.setBlocked(gameActive);
  }, [gameActive]);

  useEffect(() => {
    voiceOver.onDuck = setSoundDuck;
    voiceOver.setActive(true);
    // Important notices (toasts) are read after whatever is being said.
    let seen = new Set(useStore.getState().toasts.map((t) => t.id));
    const off = useStore.subscribe((st, prev) => {
      if (st.toasts === prev.toasts) return;
      for (const t of st.toasts) {
        if (seen.has(t.id)) continue;
        voiceOver.say(sentence(t.title, t.body), 'notice');
      }
      seen = new Set(st.toasts.map((t) => t.id));
    });
    return () => {
      off();
      voiceOver.setActive(false);
      setSoundDuck(false);
    };
  }, []);

  // Focus moving inside dialogs, menus and sheets: say the control (and the dialog's name when entering it).
  useEffect(() => {
    if (!focusRoot) return;
    let lastScope: Element | null = null;
    const onFocus = (e: FocusEvent) => {
      if (!voiceOver.on) return;
      const el = e.target as Element | null;
      if (!el?.closest?.(focusRoot)) return;
      const scope = el.closest('[role="dialog"], [role="menu"], [role="alertdialog"]');
      const name = spokenName(el);
      if (!name) return;
      const prefix = scope && scope !== lastScope && scope !== el && scope.matches('[aria-label], [aria-labelledby]') ? spokenName(scope) : '';
      lastScope = scope;
      voiceOver.say(prefix && prefix !== name ? sentence(prefix, name) : name, scope ? 'menu' : 'nav');
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, [focusRoot]);
}

/** The caption being shown (null = none). */
export function useCaption(): Caption | null {
  return useSyncExternalStore(voiceOver.subscribe, voiceOver.currentCaption, () => null);
}

const voicesSnapshot = () => voiceOver.localVoices();
let cached: SpeechSynthesisVoice[] = [];
let cachedKey = '';
/** Local Windows voices (stable array identity while unchanged). */
export function useLocalVoices(): SpeechSynthesisVoice[] {
  return useSyncExternalStore(
    (l) => voiceOver.subscribeVoices(l),
    () => {
      const v = voicesSnapshot();
      const k = v.map((x) => x.voiceURI).join('|');
      if (k !== cachedKey) {
        cachedKey = k;
        cached = v;
      }
      return cached;
    },
    () => cached,
  );
}
