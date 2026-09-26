import { fetchViaProxy } from './net.js';

/** Download an image through the proxy and shrink it for storage. Returns null on failure. */
export async function downloadImage(url, { maxDim, signal } = {}) {
  try {
    const res = await fetchViaProxy(url, { signal, timeout: 15000 });
    const blob = await res.blob();
    if (!blob.type.startsWith('image/') || blob.size === 0) return null;
    return maxDim ? await resizeImage(blob, maxDim) : blob;
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'OfflineError') throw err;
    return null;
  }
}

/**
 * Scale an image down so its longest side is at most maxDim, re-encoded as
 * JPEG. Returns the original when it is already small or can't be decoded
 * (e.g. SVG, or no canvas support).
 */
export async function resizeImage(blob, maxDim, quality = 0.8) {
  if (typeof createImageBitmap !== 'function') return blob;
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return blob;
  }
  try {
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && blob.size < 250 * 1024) return blob;
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    let canvas;
    if (typeof OffscreenCanvas === 'function') canvas = new OffscreenCanvas(w, h);
    else {
      canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // JPEG has no alpha
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    const out = canvas.convertToBlob
      ? await canvas.convertToBlob({ type: 'image/jpeg', quality })
      : await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    return out && out.size < blob.size ? out : blob;
  } catch {
    return blob;
  } finally {
    bitmap.close?.();
  }
}
