import { useEffect, useState } from 'react';

/** 'dark' when most of a logo's visible pixels are near-black, so it would vanish on a dark hero. */
export type LogoTone = 'dark' | 'light';

const cache = new Map<string, LogoTone | null>();
const inflight = new Map<string, Promise<LogoTone | null>>();

/**
 * Classifies RGBA pixels: only clearly visible pixels count, and a logo is "dark" when over 40%
 * of them have a relative luminance below 0.12 (black or near-black lettering).
 */
export function classifyLogo(data: Uint8ClampedArray): LogoTone | null {
  let visible = 0;
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 96) continue;
    visible++;
    const l = (0.2126 * lin(data[i]) + 0.7152 * lin(data[i + 1]) + 0.0722 * lin(data[i + 2]));
    if (l < 0.12) dark++;
  }
  if (visible < 24) return null;
  return dark / visible > 0.4 ? 'dark' : 'light';
}

function lin(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

async function analyse(url: string): Promise<LogoTone | null> {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) return null;
    const bitmap = await createImageBitmap(await res.blob(), { resizeWidth: 64, resizeHeight: 32, resizeQuality: 'low' });
    const canvas = new OffscreenCanvas(64, 32);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, 64, 32);
    bitmap.close();
    return classifyLogo(ctx.getImageData(0, 0, 64, 32).data);
  } catch {
    return null;
  }
}

export function logoTone(url: string): Promise<LogoTone | null> {
  if (cache.has(url)) return Promise.resolve(cache.get(url)!);
  let p = inflight.get(url);
  if (!p) {
    p = analyse(url).then((tone) => {
      cache.set(url, tone);
      inflight.delete(url);
      return tone;
    });
    inflight.set(url, p);
  }
  return p;
}

/** The tone of a logo image (null until known or when it can't be analysed). */
export function useLogoTone(url: string | null | undefined): LogoTone | null {
  const [tone, setTone] = useState<LogoTone | null>(() => (url ? cache.get(url) ?? null : null));
  useEffect(() => {
    if (!url) return setTone(null);
    let alive = true;
    void logoTone(url).then((t) => alive && setTone(t));
    return () => {
      alive = false;
    };
  }, [url]);
  return tone;
}
