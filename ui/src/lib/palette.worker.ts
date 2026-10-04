/// <reference lib="webworker" />
import { extractPalette } from './color';

// Decodes and analyses artwork off the main thread so palette extraction never drops frames.
self.onmessage = async (e: MessageEvent<{ id: number; url: string }>) => {
  const { id, url } = e.data;
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob, { resizeWidth: 64, resizeHeight: 64, resizeQuality: 'medium' });
    const canvas = new OffscreenCanvas(64, 64);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, 64, 64);
    bitmap.close();
    const { data } = ctx.getImageData(0, 0, 64, 64);
    (self as unknown as Worker).postMessage({ id, palette: extractPalette(data, 64, 64) });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
