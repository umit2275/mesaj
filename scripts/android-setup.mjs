/**
 * `npx cap add android` sonrası Android projesini mesajlaşma uygulamasına uygun yapar:
 * - Dikey ekran; klavye açılınca sayfa küçülür (yazma kutusu klavyenin üstünde kalır)
 * - Uygulama simgesi (resources/ klasöründen)
 * Tekrar çalıştırmak güvenlidir.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const res = join(root, 'android', 'app', 'src', 'main', 'res');
const manifestPath = join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

if (!existsSync(manifestPath)) {
  console.error('[android-setup] AndroidManifest.xml yok. Önce "npx cap add android" çalıştırın.');
  process.exit(1);
}

let xml = readFileSync(manifestPath, 'utf8');
const m = xml.match(/<activity\b[^>]*android:name="[^"]*MainActivity"[^>]*>/);
if (!m) {
  console.error('[android-setup] MainActivity bulunamadı.');
  process.exit(1);
}
let tag = m[0];
const setAttr = (name, value) => {
  const re = new RegExp(`android:${name}="[^"]*"`);
  tag = re.test(tag) ? tag.replace(re, `android:${name}="${value}"`) : tag.replace(/<activity\b/, `<activity android:${name}="${value}"`);
};
setAttr('screenOrientation', 'portrait');
setAttr('windowSoftInputMode', 'adjustResize');
xml = xml.replace(m[0], tag);
// İzinler: bildirim (Android 13+), eski telefonlarda galeriye yazma (Android 9 ve öncesi)
const perms = [
  '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
  '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />',
  '<uses-permission android:name="android.permission.VIBRATE" />',
];
for (const p of perms) {
  const name = p.match(/android:name="([^"]+)"/)[1];
  if (!xml.includes(`"${name}"`)) xml = xml.replace('</manifest>', `    ${p}\n</manifest>`);
}
// Firebase bildirimleri varsayılan olarak kısa titreşimli "mesajlar_v2" kanalını kullanır
const meta = '<meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="mesajlar_v2" />';
if (!xml.includes('default_notification_channel_id')) xml = xml.replace('</application>', `    ${meta}\n    </application>`);
writeFileSync(manifestPath, xml);
console.log('[android-setup] manifest: dikey ekran, klavyede yeniden boyutlanma, izinler, bildirim kanalı');

// Simge: uyarlanabilir simge tanımlarını kaldır, PNG'leri koy
rmSync(join(res, 'mipmap-anydpi-v26'), { recursive: true, force: true });
for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
  const dir = join(res, `mipmap-${d}`);
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(root, 'resources', `ic_launcher_${d}.png`), join(dir, 'ic_launcher.png'));
  copyFileSync(join(root, 'resources', `ic_launcher_round_${d}.png`), join(dir, 'ic_launcher_round.png'));
  rmSync(join(dir, 'ic_launcher_foreground.png'), { force: true });
}
console.log('[android-setup] uygulama simgesi kondu');

// Bildirim çubuğu simgesi ve zil sesi
for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
  const dir = join(res, `drawable-${d}`);
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(root, 'resources', `ic_stat_suhbet_${d}.png`), join(dir, 'ic_stat_suhbet.png'));
}
mkdirSync(join(res, 'raw'), { recursive: true });
copyFileSync(join(root, 'resources', 'chime.wav'), join(res, 'raw', 'chime.wav'));
console.log('[android-setup] bildirim simgesi ve zil sesi kondu');

// Uygulamanın kendi eklentisi (galeriye kaydet, bildirim) ve onu kaydeden MainActivity
const javaDir = join(root, 'android', 'app', 'src', 'main', 'java', 'com', 'umit', 'mesaj');
mkdirSync(javaDir, { recursive: true });
for (const f of ['MainActivity.java', 'SuhbetPlugin.java']) copyFileSync(join(root, 'resources', 'android', f), join(javaDir, f));
console.log('[android-setup] Suhbet eklentisi eklendi');

// Firebase bildirimleri: google-services.json olmadan bildirim kaydı uygulamayı çökertir
const gs = join(root, 'resources', 'google-services.json');
if (!existsSync(gs)) {
  console.error('[android-setup] resources/google-services.json yok (Firebase). Derleme durduruldu.');
  process.exit(1);
}
copyFileSync(gs, join(root, 'android', 'app', 'google-services.json'));
console.log('[android-setup] Firebase ayarı (google-services.json) kondu');
