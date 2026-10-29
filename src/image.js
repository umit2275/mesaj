import { fitSize } from './util.js';

/**
 * Seçilen fotoğrafı küçült ve JPEG'e çevir (yükleme hızlı, kota az dolsun).
 * Döner: { blob, w, h }
 */
export async function prepareImage(file, max = 1600, quality = 0.82) {
  const src = await decode(file);
  const { w, h } = fitSize(src.width, src.height, max);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src.img, 0, 0, w, h);
  src.close?.();
  const blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Resim hazırlanamadı'))), 'image/jpeg', quality));
  return { blob, w, h };
}

async function decode(file) {
  if (globalThis.createImageBitmap) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { img: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      /* eski WebView: <img> ile dene */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('Bu dosya açılamadı'));
      i.src = url;
    });
    return { img, width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
