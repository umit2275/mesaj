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
writeFileSync(manifestPath, xml);
console.log('[android-setup] manifest: dikey ekran, klavyede yeniden boyutlanma');

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
