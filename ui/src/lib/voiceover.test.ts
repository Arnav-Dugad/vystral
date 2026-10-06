import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Game, Installation } from '../bridge/types';
import {
  captionHoldMs, gameState, localVoices, normalizePrefs, pickVoice, sentence, spokenDuration, spokenName, voiceLabel, VoiceOver, type VoiceLike,
} from './voiceover';

const v = (name: string, lang: string, localService: boolean, extra: Partial<VoiceLike> = {}): VoiceLike => ({ voiceURI: name, name, lang, localService, ...extra });
const VOICES = [
  v('Microsoft Aria Online (Natural) - English (United States)', 'en-US', false),
  v('Microsoft Zira - English (United States)', 'en-US', true),
  v('Microsoft David - English (United States)', 'en-US', true, { default: true }),
  v('Microsoft Hedda - German (Germany)', 'de-DE', true),
  v('Google UK English Female', 'en-GB', false),
];

function inst(over: Partial<Installation> = {}): Installation {
  return {
    id: 'i', platform: 'steam', platformGameId: '1', title: 't', state: 'installed', installPath: null, drive: null, sizeBytes: null, clientRequired: true,
    launchKind: 'Uri', importedLastPlayed: null, importedPlaytimeMinutes: 0, userLaunchArgs: null, manualLink: false, lastSeen: new Date().toISOString(), ...over,
  };
}
const game = (over: Partial<Game> = {}, installs = [inst()]) =>
  ({ id: 'g', title: 'Hades', sortTitle: 'hades', genres: [], favorite: false, hidden: false, installations: installs, collections: [], trackedSeconds: 0, sessionCount: 0, lastTrackedPlay: null, added: new Date().toISOString(), art: {}, ...over }) as unknown as Game;

describe('voice-over helpers', () => {
  it('only ever offers local Windows voices, interface language first', () => {
    const local = localVoices(VOICES, 'en-US');
    expect(local.every((x) => x.localService)).toBe(true);
    expect(local.map((x) => x.name.split(' ')[1])).toEqual(['David', 'Zira', 'Hedda']);
    expect(localVoices([v('Online', 'en-US', false)])).toEqual([]);
  });

  it('never picks an online voice, even if it was chosen before', () => {
    expect(pickVoice(VOICES, 'Microsoft Aria Online (Natural) - English (United States)', 'en-US')?.name).toContain('David');
    expect(pickVoice(VOICES, 'Microsoft Zira - English (United States)', 'en-US')?.name).toContain('Zira');
    expect(pickVoice([v('Online', 'en-US', false)], '', 'en-US')).toBeNull();
  });

  it('normalises settings into safe ranges', () => {
    expect(normalizePrefs(null)).toEqual({ enabled: false, captionsOnly: false, voice: '', rate: 1, volume: 1 });
    expect(normalizePrefs({ enabled: true, rate: 9, volume: -1, voice: 42 })).toMatchObject({ enabled: true, rate: 2, volume: 0, voice: '' });
    expect(normalizePrefs({ rate: 1.26 }).rate).toBe(1.3);
  });

  it('labels voices and durations the way people say them', () => {
    expect(voiceLabel(v('Microsoft Zira - English (United States)', 'en-US', true))).toBe('Zira · English (United States)');
    expect(voiceLabel(v('Custom', 'en', true))).toBe('Custom');
    expect(spokenDuration(30)).toBe('less than a minute');
    expect(spokenDuration(60)).toBe('1 minute');
    expect(spokenDuration(25 * 60)).toBe('25 minutes');
    expect(spokenDuration(3600)).toBe('1 hour');
    expect(spokenDuration(3900)).toBe('1 hour 5 minutes');
    expect(spokenDuration(42 * 3600 + 600)).toBe('42 hours');
  });

  it('describes a game with a short state, never the description', () => {
    expect(gameState(game({ trackedSeconds: 42 * 3600 }))).toBe('Installed, 42 hours played');
    expect(gameState(game({ favorite: true }, [inst({ state: 'notinstalled' })]))).toBe('Not installed, never played, favorite');
    expect(gameState(game({}, [inst({ importedPlaytimeMinutes: 90 })]))).toBe('Installed, 1 hour 30 minutes played');
  });

  it('joins sentences cleanly and holds captions for a reading-speed moment', () => {
    expect(sentence('Favorites', '', null, 'Hades.', 'Installed')).toBe('Favorites. Hades. Installed.');
    expect(captionHoldMs('Hi')).toBe(1600);
    expect(captionHoldMs('x'.repeat(500))).toBe(7000);
  });

  it('speaks an element’s accessible name with its state', () => {
    document.body.innerHTML = `<button role="switch" aria-checked="true" aria-label="Voice-over">x</button><div role="slider" aria-label="Speed" aria-valuetext="120%"></div><button role="tab" aria-selected="true">Media</button>`;
    const [sw, slider, tab] = [...document.body.children];
    expect(spokenName(sw)).toBe('Voice-over, on');
    expect(spokenName(slider)).toBe('Speed, 120%');
    expect(spokenName(tab)).toBe('Media, tab, selected');
  });
});

/* ------------------------------------------------------------------ the engine, with a fake speechSynthesis */

class FakeUtterance {
  text: string;
  voice: unknown = null;
  lang = '';
  rate = 1;
  volume = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(t: string) {
    this.text = t;
  }
}

describe('voice-over engine', () => {
  let spoken: FakeUtterance[];
  let cancels: number;
  let voices: VoiceLike[];
  beforeEach(() => {
    vi.useFakeTimers();
    spoken = [];
    cancels = 0;
    voices = VOICES;
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { speak: (u: FakeUtterance) => spoken.push(u), cancel: () => cancels++, getVoices: () => voices, addEventListener: () => {} },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const engine = (prefs: Partial<ReturnType<typeof normalizePrefs>> = {}) => {
    const vo = new VoiceOver();
    vo.configure(normalizePrefs({ enabled: true, ...prefs }));
    vo.setActive(true);
    return vo;
  };

  it('debounces browsing: only the last focus is spoken, with the chosen local voice, rate and volume', () => {
    const vo = engine({ voice: 'Microsoft Zira - English (United States)', rate: 1.4, volume: 0.6 });
    vo.say('One');
    vo.say('Two');
    vo.say('Three');
    vi.advanceTimersByTime(400);
    expect(spoken.map((u) => u.text)).toEqual(['Three']);
    expect(spoken[0]).toMatchObject({ rate: 1.4, volume: 0.6 });
    expect((spoken[0].voice as VoiceLike).name).toContain('Zira');
    expect(vo.currentCaption()).toMatchObject({ text: 'Three', speaking: true });
  });

  it('a new focus cancels what is being said; notices queue instead', () => {
    const vo = engine();
    vo.say('First');
    vi.advanceTimersByTime(400);
    const before = cancels;
    vo.say('Second');
    vi.advanceTimersByTime(400);
    expect(cancels).toBeGreaterThan(before);
    const c = cancels;
    vo.say('Saved', 'notice');
    expect(cancels).toBe(c);
    expect(spoken.map((u) => u.text)).toEqual(['First', 'Second', 'Saved']);
  });

  it('ducks other sounds while speaking and restores them after', () => {
    const vo = engine();
    const duck: boolean[] = [];
    vo.onDuck = (on) => duck.push(on);
    vo.say('Hades');
    vi.advanceTimersByTime(400);
    expect(duck).toEqual([true]);
    spoken[0].onend?.();
    vi.advanceTimersByTime(300);
    expect(duck).toEqual([true, false]);
    vi.advanceTimersByTime(2000);
    expect(vo.currentCaption()).toBeNull();
  });

  it('captions only, or no local voice: shows the words and never speaks', () => {
    const vo = engine({ captionsOnly: true });
    vo.say('Favorites. Hades.');
    vi.advanceTimersByTime(400);
    expect(spoken).toEqual([]);
    expect(vo.currentCaption()?.text).toBe('Favorites. Hades.');
    voices = [v('Online', 'en-US', false)];
    const vo2 = engine();
    vo2.say('Online voices are never used');
    vi.advanceTimersByTime(400);
    expect(spoken).toEqual([]);
    expect(vo2.currentCaption()?.text).toBe('Online voices are never used');
  });

  it('is silent when off, inactive or while a game runs; the test phrase still plays', () => {
    const vo = engine({ enabled: false });
    vo.say('Nope');
    vi.advanceTimersByTime(400);
    expect(spoken).toEqual([]);
    vo.configure(normalizePrefs({ enabled: true }));
    vo.setBlocked(true);
    vo.say('Nope');
    vi.advanceTimersByTime(400);
    expect(spoken).toEqual([]);
    vo.setBlocked(false);
    vo.setActive(false);
    vo.say('Test', 'test', true);
    expect(spoken.map((u) => u.text)).toEqual(['Test']);
  });
});
