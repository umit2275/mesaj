/**
 * Telefona özgü işler: fotoğrafı galeriye kaydetme, bildirim, zil sesi.
 * Android'de uygulamanın kendi küçük eklentisi ("Suhbet") kullanılır;
 * tarayıcıda (deneme) web karşılıkları devreye girer.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

const Native = registerPlugin('Suhbet');
const Push = registerPlugin('PushNotifications');
export const isNative = () => Capacitor.isNativePlatform();

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(new Error('Dosya okunamadı'));
    r.readAsDataURL(blob);
  });
}

/** Fotoğrafı cihaza kaydet (Android: Galeri → Resimler/Chat X) */
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

/**
 * Firebase bildirimleri: uygulama kapalı/uykudayken de bildirim gelir.
 * onToken(token): telefonun bildirim adresi (sunucuya kaydedilir)
 * onOpen(conversationId): bildirime dokunulunca
 */
export async function setupPush({ onToken, onOpen }) {
  if (!isNative()) return false;
  try {
    let st = await Push.checkPermissions();
    if (st.receive !== 'granted') st = await Push.requestPermissions();
    if (st.receive !== 'granted') return false;
    await Native.prepareChannel(); // kısa titreşimli, zil sesli bildirim kanalı
    await Push.addListener('registration', (t) => onToken(t.value));
    await Push.addListener('registrationError', () => {});
    await Push.addListener('pushNotificationActionPerformed', (a) => {
      const id = a?.notification?.data?.conversation_id;
      if (id) onOpen(id);
    });
    await Push.register();
    return true;
  } catch {
    return false;
  }
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
/**
 * Mesaj geldiğinde uyarı (uygulama açıkken).
 * Telefonda: ses bildirim sesinden çalar ve zil ayarına uyar
 * (zil açık → ses + kısa titreşim, titreşim modu → yalnız titreşim, sessiz → hiçbiri).
 */
export function playChime() {
  const now = Date.now();
  if (now - lastChime < 700) return; // art arda gelen mesajlarda üst üste çalmasın
  lastChime = now;
  if (isNative()) {
    Native.alert().catch(() => {});
    return;
  }
  try {
    navigator.vibrate?.(220);
    const a = getAudio();
    a.currentTime = 0;
    a.play().catch(() => {});
  } catch {
    /* ses çalınamadı */
  }
}
