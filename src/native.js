/**
 * Telefona özgü işler: fotoğrafı galeriye kaydetme, bildirim, zil sesi.
 * Android'de uygulamanın kendi küçük eklentisi ("Suhbet") kullanılır;
 * tarayıcıda (deneme) web karşılıkları devreye girer.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

const Native = registerPlugin('Suhbet');
export const isNative = () => Capacitor.isNativePlatform();

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(new Error('Dosya okunamadı'));
    r.readAsDataURL(blob);
  });
}

/** Fotoğrafı cihaza kaydet (Android: Galeri → Resimler/Suhbet Edek) */
export async function saveImageToDevice(blob, name) {
  if (isNative()) {
    const data = await blobToBase64(blob);
    await Native.saveImage({ data, name });
    return 'gallery';
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return 'download';
}

/** Bildirim izni (Android 13+ sorar) */
export async function askNotificationPermission() {
  try {
    if (isNative()) return (await Native.requestNotifyPermission())?.granted !== false;
    if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  } catch {
    /* izin verilmezse sadece uygulama içi zil çalar */
  }
  return true;
}

/** Sistem bildirimi (uygulama arka plandayken) — zil sesiyle */
export async function showNotification(title, body, tag) {
  try {
    if (isNative()) {
      await Native.showNotification({ title, body, tag: tag || '' });
      return;
    }
    if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, tag });
  } catch {
    /* bildirim gösterilemedi */
  }
}

// ---- Zil sesi (uygulama açıkken) ----
let audio = null;
function getAudio() {
  if (!audio) {
    audio = new Audio(new URL('chime.wav', document.baseURI).href);
    audio.preload = 'auto';
    audio.volume = 0.8;
  }
  return audio;
}

/** İlk dokunuşta sesi hazırla (bazı tarayıcılar kullanıcı etkileşimi ister) */
export function unlockSound() {
  const once = () => {
    const a = getAudio();
    a.muted = true;
    a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; });
    window.removeEventListener('pointerdown', once);
  };
  window.addEventListener('pointerdown', once, { once: true });
}

let lastChime = 0;
export function playChime() {
  const now = Date.now();
  if (now - lastChime < 700) return; // art arda gelen mesajlarda üst üste çalmasın
  lastChime = now;
  try {
    const a = getAudio();
    a.currentTime = 0;
    a.play().catch(() => {});
  } catch {
    /* ses çalınamadı */
  }
}
