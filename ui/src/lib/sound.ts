import { useStore } from '../state/store';

/**
 * Optional UI sounds, synthesised with Web Audio (no audio files, ~0 CPU when silent).
 * Off by default; never plays while a game is running.
 */
let ctx: AudioContext | null = null;
let lastTick = 0;

function play(freqs: number[], duration: number, gain: number, type: OscillatorType = 'sine') {
  const s = useStore.getState();
  if (!s.settings?.['sounds.enabled'] || s.launch?.phase === 'running') return;
  ctx ??= new AudioContext();
  const volume = (s.settings['sounds.volume'] ?? 0.4) * gain;
  const t0 = ctx.currentTime;
  freqs.forEach((f, i) => {
    const osc = ctx!.createOscillator();
    const g = ctx!.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f * (1 + (Math.random() - 0.5) * 0.03), t0 + i * duration * 0.6);
    g.gain.setValueAtTime(0, t0 + i * duration * 0.6);
    g.gain.linearRampToValueAtTime(volume, t0 + i * duration * 0.6 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * duration * 0.6 + duration);
    osc.connect(g).connect(ctx!.destination);
    osc.start(t0 + i * duration * 0.6);
    osc.stop(t0 + i * duration * 0.6 + duration + 0.02);
  });
}

export const sound = {
  focus() {
    const now = performance.now();
    if (now - lastTick < 45) return; // throttle at fast repeat rates
    lastTick = now;
    play([1320], 0.035, 0.05, 'triangle');
  },
  select: () => play([660, 990], 0.07, 0.08),
  back: () => play([740, 520], 0.06, 0.06),
  launch: () => play([392, 523, 784], 0.16, 0.08),
};
