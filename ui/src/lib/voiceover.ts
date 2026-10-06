/**
 * Voice-over and captions (Track T). Speaks what has focus — a game and a short state, a row, a
 * menu item, a tab, a dialog, an important notice — with Windows' own voices through the Web
 * Speech API, and shows the same words as a caption, so people who can't hear get the same
 * information. Off by default.
 *
 * Privacy: only voices with `localService === true` are ever used (Windows' installed voices).
 * Online voices (for example the "Natural" ones that stream from a server) are never picked, even
 * if chosen earlier. Without a local voice it falls back to captions only.
 *
 * Behaviour: rapid navigation is debounced and each new focus cancels the previous utterance, so
 * it never reads a backlog; notices queue after what's being said. While speaking, interface and
 * ambient sounds are ducked. Nothing is spoken while a game starts or runs.
 *
 * Reusable: the engine knows nothing about Immersive; views call `voiceOver.say()` (or the hooks
 * in `lib/useVoiceOver.ts`) and mount a caption bar.
 */
import type { Game } from '../bridge/types';
import { formatRelative, importedMinutes, isInstalled, lastPlayed } from './format';

export type SpeechKind = 'focus' | 'nav' | 'menu' | 'dialog' | 'notice' | 'test';

export interface VoicePrefs {
  enabled: boolean;
  captionsOnly: boolean;
  /** voiceURI of the chosen voice; '' = the best local voice for the interface language. */
  voice: string;
  /** 0.5–2 (1 = normal). */
  rate: number;
  /** 0–1. */
  volume: number;
}

export const DEFAULT_VOICE_PREFS: VoicePrefs = { enabled: false, captionsOnly: false, voice: '', rate: 1, volume: 1 };
export const RATE = { min: 0.5, max: 2, step: 0.1 } as const;

export interface Caption {
  id: number;
  text: string;
  kind: SpeechKind;
  /** True while the voice is speaking it (captions-only: while it's shown). */
  speaking: boolean;
}

/** Minimal shape of a voice (so tests and the engine share it). */
export interface VoiceLike {
  voiceURI: string;
  name: string;
  lang: string;
  localService: boolean;
  default?: boolean;
}

/* ------------------------------------------------------------------ pure helpers (unit-tested) */

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function normalizePrefs(raw: Partial<Record<keyof VoicePrefs, unknown>> | null | undefined): VoicePrefs {
  const r = raw ?? {};
  return {
    enabled: r.enabled === true,
    captionsOnly: r.captionsOnly === true,
    voice: typeof r.voice === 'string' ? r.voice.slice(0, 200) : '',
    rate: Math.round(clamp(r.rate, RATE.min, RATE.max, 1) * 10) / 10,
    volume: Math.round(clamp(r.volume, 0, 1, 1) * 100) / 100,
  };
}

/** Only on-device voices; the interface language first, then Windows' default, then by name. */
export function localVoices<V extends VoiceLike>(voices: readonly V[], lang = 'en'): V[] {
  const base = lang.toLowerCase().split('-')[0];
  const score = (v: V) => (v.lang.toLowerCase() === lang.toLowerCase() ? 0 : v.lang.toLowerCase().startsWith(base) ? 1 : 2);
  return voices
    .filter((v) => v.localService === true)
    .slice()
    .sort((a, b) => score(a) - score(b) || Number(!!b.default) - Number(!!a.default) || a.name.localeCompare(b.name));
}

/** The voice to use: the chosen one if it is still installed and local, else the best local one. */
export function pickVoice<V extends VoiceLike>(voices: readonly V[], uri: string, lang = 'en'): V | null {
  const local = localVoices(voices, lang);
  return local.find((v) => v.voiceURI === uri) ?? local[0] ?? null;
}

/** A friendly voice name: "Microsoft Zira - English (United States)" → "Zira · English (United States)". */
export function voiceLabel(v: VoiceLike): string {
  const m = /^(?:Microsoft\s+)?(.+?)(?:\s+(?:Desktop|Mobile))?\s+-\s+(.+)$/.exec(v.name);
  return m ? `${m[1]} · ${m[2]}` : v.name;
}

/** "42 hours", "1 hour", "25 minutes", "less than a minute". */
export function spokenDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return 'less than a minute';
  const min = Math.round(s / 60);
  if (min < 60) return `${min} ${min === 1 ? 'minute' : 'minutes'}`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  if (h >= 10 || rest === 0) return `${h} ${h === 1 ? 'hour' : 'hours'}`;
  return `${h} ${h === 1 ? 'hour' : 'hours'} ${rest} ${rest === 1 ? 'minute' : 'minutes'}`;
}

/** The short state after a game's name: "Installed, 42 hours played" / "Not installed, never played". */
export function gameState(game: Game, opts: { favorite?: boolean; lastPlayed?: boolean } = {}): string {
  const parts: string[] = [isInstalled(game) ? 'Installed' : 'Not installed'];
  const played = game.trackedSeconds + (importedMinutes(game) ?? 0) * 60;
  parts.push(played > 0 ? `${spokenDuration(played)} played` : 'never played');
  if (opts.lastPlayed) {
    const lp = lastPlayed(game).at;
    if (lp) parts.push(`last played ${formatRelative(lp)}`);
  }
  if (opts.favorite !== false && game.favorite) parts.push('favorite');
  return parts.join(', ');
}

/** Joins sentences, dropping empty parts and doubled full stops. */
export function sentence(...parts: (string | null | undefined | false)[]): string {
  return parts
    .filter((p): p is string => !!p && !!p.trim())
    .map((p) => p.trim().replace(/[.!?…]+$/, ''))
    .join('. ')
    .concat('.');
}

/** How long a caption stays when there's no voice to time it: ~ reading speed, 1.6–7 s. */
export function captionHoldMs(text: string): number {
  return Math.round(Math.min(7000, Math.max(1600, 900 + text.length * 55)));
}

/** Debounce before speaking: browsing waits for focus to settle; notices and tests don't wait. */
export const SPEECH_DELAY: Record<SpeechKind, number> = { focus: 240, nav: 160, menu: 110, dialog: 60, notice: 0, test: 0 };

/* ------------------------------------------------------------------ the engine */

type Listener = () => void;
type DuckFn = (on: boolean) => void;

interface SpeechLike {
  speak(u: SpeechSynthesisUtterance): void;
  cancel(): void;
  getVoices(): SpeechSynthesisVoice[];
  addEventListener?(type: 'voiceschanged', l: () => void): void;
}

const synth = (): SpeechLike | null => (typeof window !== 'undefined' && 'speechSynthesis' in window ? (window.speechSynthesis as SpeechLike) : null);

export class VoiceOver {
  private prefs: VoicePrefs = DEFAULT_VOICE_PREFS;
  private active = false;
  private blocked = false;
  private timer: number | undefined;
  private holdTimer: number | undefined;
  private duckTimer: number | undefined;
  private leaveTimer: number | undefined;
  private seq = 0;
  private caption: Caption | null = null;
  private listeners = new Set<Listener>();
  private voices: SpeechSynthesisVoice[] = [];
  private voiceListeners = new Set<Listener>();
  private watchingVoices = false;
  private ducked = false;
  private lastText = '';
  private lastAt = 0;
  onDuck: DuckFn = () => {};

  /** Settings changed. */
  configure(prefs: VoicePrefs) {
    const wasOn = this.on;
    this.prefs = prefs;
    if (wasOn && !this.on) this.stop();
  }

  /** A surface that uses voice-over is on screen (Immersive); off = silent and no captions. */
  setActive(active: boolean) {
    // Leaving is applied a tick later, so a surface that unmounts and mounts again at once (React's
    // development double effects, a quick re-render) never cuts off what it just started to say.
    window.clearTimeout(this.leaveTimer);
    if (active) {
      this.active = true;
      return;
    }
    this.leaveTimer = window.setTimeout(() => {
      this.active = false;
      this.stop();
    }, 0);
  }

  /** A game is starting or running: say nothing at all. */
  setBlocked(blocked: boolean) {
    this.blocked = blocked;
    if (blocked) this.stop();
  }

  get on() {
    return this.prefs.enabled && this.active && !this.blocked;
  }

  get settings() {
    return this.prefs;
  }

  /** Local voices installed in Windows (empty until the engine has loaded them). */
  localVoices(): SpeechSynthesisVoice[] {
    this.watchVoices();
    return localVoices(this.voices, typeof navigator !== 'undefined' ? navigator.language : 'en');
  }

  /** True when speech is possible at all (an engine and at least one local voice). */
  canSpeak() {
    return !!synth() && this.localVoices().length > 0;
  }

  subscribeVoices(l: Listener) {
    this.watchVoices();
    this.voiceListeners.add(l);
    return () => this.voiceListeners.delete(l);
  }

  private watchVoices() {
    const s = synth();
    if (!s || this.watchingVoices) return;
    this.watchingVoices = true;
    const load = () => {
      try {
        this.voices = s.getVoices() ?? [];
      } catch {
        this.voices = [];
      }
      for (const l of this.voiceListeners) l();
    };
    load();
    s.addEventListener?.('voiceschanged', load);
  }

  /**
   * Says (and captions) `text`. Focus-like kinds replace whatever is pending or being said;
   * notices queue after it. `force` speaks even when off (the Test button).
   */
  say(text: string, kind: SpeechKind = 'focus', force = false) {
    const t = text.replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!t || (!this.on && !force)) return;
    // The same words twice in a row within a moment (a re-render, a repeated focus) are said once.
    const now = Date.now();
    if (t === this.lastText && now - this.lastAt < 1200 && kind !== 'test') return;
    this.lastText = t;
    this.lastAt = now;
    const queue = kind === 'notice';
    if (!queue) window.clearTimeout(this.timer);
    const delay = SPEECH_DELAY[kind];
    const go = () => this.speakNow(t, kind, queue, force);
    if (delay > 0) this.timer = window.setTimeout(go, delay);
    else go();
  }

  /** Stops speaking and clears the caption. */
  stop() {
    window.clearTimeout(this.timer);
    window.clearTimeout(this.holdTimer);
    try {
      synth()?.cancel();
    } catch {
      /* no engine */
    }
    this.setDuck(false);
    this.setCaption(null);
  }

  private speakNow(text: string, kind: SpeechKind, queue: boolean, force: boolean) {
    if (!this.on && !force) return;
    // A notice being read is never cut off by browsing: what comes next waits its turn.
    if (!queue && this.caption?.kind === 'notice' && this.caption.speaking && kind !== 'test') queue = true;
    const id = ++this.seq;
    window.clearTimeout(this.holdTimer);
    const s = synth();
    const voice = s && !this.prefs.captionsOnly ? pickVoice(this.voicesNow(), this.prefs.voice, typeof navigator !== 'undefined' ? navigator.language : 'en') : null;
    this.setCaption({ id, text, kind, speaking: true });
    if (!s || !voice) {
      // Captions only (chosen, or no local voice): show it for a reading-speed moment.
      this.holdTimer = window.setTimeout(() => this.endCaption(id), captionHoldMs(text));
      return;
    }
    if (!queue) {
      try {
        s.cancel();
      } catch {
        /* ignore */
      }
    }
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = this.prefs.rate;
    u.volume = this.prefs.volume;
    u.onstart = () => this.setDuck(true);
    const done = () => {
      if (this.caption?.id === id) {
        this.setDuck(false);
        this.endCaption(id);
      }
    };
    u.onend = done;
    u.onerror = done;
    try {
      s.speak(u);
      this.setDuck(true);
    } catch {
      done();
    }
  }

  private voicesNow() {
    this.watchVoices();
    if (!this.voices.length) {
      try {
        this.voices = synth()?.getVoices() ?? [];
      } catch {
        /* ignore */
      }
    }
    return this.voices;
  }

  /** The caption lingers a little after the voice stops, then fades. */
  private endCaption(id: number) {
    if (this.caption?.id !== id) return;
    this.setCaption({ ...this.caption, speaking: false });
    window.clearTimeout(this.holdTimer);
    this.holdTimer = window.setTimeout(() => {
      if (this.caption?.id === id) this.setCaption(null);
    }, 1400);
  }

  private setDuck(on: boolean) {
    window.clearTimeout(this.duckTimer);
    if (on) {
      if (!this.ducked) this.onDuck(true);
      this.ducked = true;
      return;
    }
    // Let go a beat later so back-to-back phrases don't pump the sound up and down.
    this.duckTimer = window.setTimeout(() => {
      if (this.ducked) this.onDuck(false);
      this.ducked = false;
    }, 250);
  }

  private setCaption(c: Caption | null) {
    this.caption = c;
    for (const l of this.listeners) l();
  }

  currentCaption = () => this.caption;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
}

export const voiceOver = new VoiceOver();

/** The accessible name of an element plus its state, the way a screen reader would say it. */
export function spokenName(el: Element): string {
  const h = el as HTMLElement;
  const byId = (ids: string | null) =>
    (ids ?? '')
      .split(/\s+/)
      .map((id) => (id ? document.getElementById(id)?.textContent ?? '' : ''))
      .join(' ')
      .trim();
  const name = (h.getAttribute('aria-label') ?? '').trim() || byId(h.getAttribute('aria-labelledby')) || (h.textContent ?? '').trim();
  const role = h.getAttribute('role');
  const parts = [name];
  const valueText = h.getAttribute('aria-valuetext') ?? h.getAttribute('aria-valuenow');
  if (role === 'slider' && valueText) parts.push(valueText);
  if (role === 'switch') parts.push(h.getAttribute('aria-checked') === 'true' ? 'on' : 'off');
  if (role === 'tab') parts.push(h.getAttribute('aria-selected') === 'true' ? 'tab, selected' : 'tab');
  if (role === 'radio' || role === 'menuitemradio') parts.push(h.getAttribute('aria-checked') === 'true' ? 'selected' : '');
  if (role === 'menuitemcheckbox' && h.getAttribute('aria-checked') === 'true') parts.push('checked');
  if (h.getAttribute('aria-pressed') === 'true') parts.push('on');
  if (h.getAttribute('aria-disabled') === 'true' || (h as HTMLButtonElement).disabled) parts.push('unavailable');
  return parts.filter(Boolean).join(', ').replace(/\s+/g, ' ').slice(0, 300);
}
