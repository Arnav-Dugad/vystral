import type { Game } from '../bridge/types';

/**
 * Living Canvas moods. Each is a subtle ambient treatment chosen from genre metadata.
 * The shader receives the mood as an integer; see components/LivingCanvas.tsx.
 */
export type Mood = 'drift' | 'velocity' | 'cosmos' | 'ember' | 'dread' | 'tide';

export const MOOD_INDEX: Record<Mood, number> = { drift: 0, velocity: 1, cosmos: 2, ember: 3, dread: 4, tide: 5 };

export const MOOD_LABEL: Record<Mood, string> = {
  drift: 'Drift — slow flowing light',
  velocity: 'Velocity — light trails',
  cosmos: 'Cosmos — distant stars',
  ember: 'Ember — rising motes',
  dread: 'Dread — low fog, deep shadow',
  tide: 'Tide — calm waves',
};

const RULES: [Mood, RegExp][] = [
  ['dread', /horror|survival horror|psychological|thriller/i],
  ['velocity', /racing|driving|sports|motorsport|arcade/i],
  ['cosmos', /space|sci-?fi|science fiction|exploration/i],
  ['ember', /fantasy|rpg|role-?playing|souls|medieval|adventure/i],
  ['tide', /puzzle|casual|indie|simulation|relax|cozy/i],
];

export function moodFor(game: Game | null | undefined): Mood {
  if (!game) return 'drift';
  const text = `${game.genres.join(' ')} ${game.title}`;
  for (const [mood, re] of RULES) if (re.test(text)) return mood;
  return 'drift';
}

/** Horror slows everything down; racing gets slightly faster ambient motion. */
export function moodSpeed(mood: Mood): number {
  return { drift: 1, velocity: 1.6, cosmos: 0.8, ember: 1, dread: 0.5, tide: 0.9 }[mood];
}
