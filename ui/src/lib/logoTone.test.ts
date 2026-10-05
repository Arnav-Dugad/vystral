import { describe, expect, it } from 'vitest';
import { classifyLogo } from './logoTone';

function pixels(list: [number, number, number, number][], repeat = 10): Uint8ClampedArray {
  return new Uint8ClampedArray(Array.from({ length: repeat }, () => list.flat()).flat());
}

describe('classifyLogo', () => {
  it('calls mostly-black lettering dark', () => {
    expect(classifyLogo(pixels([[0, 0, 0, 255], [10, 10, 12, 255], [255, 255, 255, 255]]))).toBe('dark');
  });

  it('calls white and colourful logos light', () => {
    expect(classifyLogo(pixels([[255, 255, 255, 255], [220, 40, 40, 255], [0, 0, 0, 255]]))).toBe('light');
  });

  it('ignores transparent pixels', () => {
    expect(classifyLogo(pixels([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [250, 250, 250, 255]], 30))).toBe('light');
  });

  it('returns null when almost nothing is visible', () => {
    expect(classifyLogo(pixels([[0, 0, 0, 255], [0, 0, 0, 0]], 5))).toBeNull();
  });
});
