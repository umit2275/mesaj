// İki telefonlu uçtan uca deneme (deneme sunucusu + başsız Chromium).
// node tools/e2e.mjs <uygulama-url> <ekran-görüntüsü-klasörü>
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');

const [APP = 'http://localhost:4174/', OUT = '.'] = process.argv.slice(2);
const browser = await chromium.launch();
const phone = { viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: process.env.DARK ? 'dark' : 'light' };
const NOWS = !!process.env.NOWS; // anlık bağlantı yokken (yedek yoklama) deneme
const ctx = async () => { const c = await browser.newContext(phone); if (NOWS) await c.addInitScript(() => { delete window.WebSocket; window.WebSocket = undefined; }); return c; };
const ali = await (await ctx()).newPage();
const ayse = await (await ctx()).newPage();
const errors = [];
for (const [n, p] of [['ali', ali], ['ayse', ayse]]) {
  p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${n} konsol: ${m.text()}`); });
}
const shot = (p, name) => p.screenshot({ path: `${OUT}/e2e_${name}.png` });
const ok = (cond, msg) => { if (!cond) throw new Error('BAŞARISIZ: ' + msg); console.log('✓', msg); };

async function signup(p, user, name) {
  await p.goto(APP);
  await p.getByRole('button', { name: 'Kayıt ol' }).click();
  await p.getByPlaceholder('Kullanıcı adı').fill(user);
  await p.getByPlaceholder('Görünen ad (ör. Ümit)').fill(name);
  await p.getByPlaceholder('Şifre').fill('gizli123');
  await p.getByRole('button', { name: 'Hesap oluştur' }).click();
  await p.getByText('Mesajlar', { exact: true }).waitFor({ timeout: 10000 });
}

await fetch(new URL('/__reset', process.env.MOCK || 'http://localhost:54321'), { method: 'POST' });
await ali.goto(APP);
await shot(ali, '01_giris');
await signup(ali, 'Ümit Ali', 'Ali');
await signup(ayse, 'ayse', 'Ayşe');
await shot(ali, '02_bos_liste');

// Aynı kullanıcı adıyla ikinci kayıt
const third = await (await browser.newContext(phone)).newPage();
await third.goto(APP);
await third.getByRole('button', { name: 'Kayıt ol' }).click();
await third.getByPlaceholder('Kullanıcı adı').fill('ayse');
await third.getByPlaceholder('Şifre').fill('gizli123');
await third.getByRole('button', { name: 'Hesap oluştur' }).click();
await third.getByText('Bu kullanıcı adı alınmış').waitFor({ timeout: 5000 });
ok(true, 'alınmış kullanıcı adı uyarısı');
await third.getByRole('button', { name: 'Giriş', exact: true }).click();
await third.getByPlaceholder('Kullanıcı adı').fill('ayse');
await third.getByPlaceholder('Şifre').fill('yanlis1');
await third.getByRole('button', { name: 'Giriş yap' }).click();
await third.getByText('Kullanıcı adı ya da şifre yanlış').waitFor({ timeout: 5000 });
ok(true, 'yanlış şifre uyarısı');

// Ali Ayşe'yi bulur
await ali.getByRole('button', { name: 'Yeni sohbet' }).click();
await ali.getByPlaceholder('Kullanıcı adı ara').fill('ay');
await ali.getByText('@ayse').waitFor();
await shot(ali, '03_arama');
await ali.getByText('@ayse').click();
await ali.getByPlaceholder('Mesaj').waitFor();
await ali.waitForTimeout(800);
if (!NOWS) ok(/çevrimiçi/.test(await ali.locator('.title-sub').innerText()), 'Ayşe çevrimiçi görünüyor');
await ali.getByPlaceholder('Mesaj').fill('Merhaba Ayşe! Nasılsın?');
await ali.getByRole('button', { name: 'Gönder', exact: true }).click();
await ali.locator('.msg.out .st.ticks').first().waitFor();
ok(true, 'mesaj gönderildi (tek tik)');

// Ayşe: liste anlık güncellenir, okunmamış 1
await ayse.locator('.badge').waitFor({ timeout: 8000 });
ok((await ayse.locator('.badge').innerText()) === '1', 'Ayşe listesinde 1 okunmamış');
await shot(ayse, '04_liste_okunmamis');
await ayse.getByText('Ali', { exact: true }).click();
await ayse.getByText('Merhaba Ayşe! Nasılsın?').waitFor();

// Ali: mavi çift tik
await ali.locator('.msg.out .st.read').first().waitFor({ timeout: 8000 });
ok(true, 'Ali okundu bilgisini (mavi çift tik) anında gördü');

// Ayşe cevap + fotoğraf
await ayse.getByPlaceholder('Mesaj').fill('İyiyim, sen? 😊\nBak deniz fotoğrafı:');
await ayse.getByRole('button', { name: 'Gönder', exact: true }).click();
writeFileSync(`${OUT}/deneme.png`, makePng(640, 420));
await ayse.locator('input[type=file]').setInputFiles(`${OUT}/deneme.png`);
await ayse.locator('.msg.out img.photo').waitFor();
await ali.locator('.msg.in img.photo').waitFor({ timeout: 8000 });
await ali.waitForFunction(() => { const i = document.querySelector('.msg.in img.photo'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 8000 });
ok(true, 'fotoğraf Ali\'ye ulaştı ve açıldı');
await ali.waitForTimeout(600);
await shot(ali, '05_sohbet_ali');
await shot(ayse, '06_sohbet_ayse');
await ali.locator('.msg.in img.photo').click();
await ali.locator('#viewer img').waitFor();
await shot(ali, '07_foto_buyuk');
await ali.locator('#viewer').click();

// Ayşe uygulamadan çıkınca (arka plan) Ali "son görülme" görür
if (!NOWS) {
await ayse.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
await ali.waitForFunction(() => /son görülme/.test(document.querySelector('.title-sub')?.textContent || ''), null, { timeout: 8000 }).catch(async (e) => { console.log('başlık:', await ali.locator('.title-sub').innerText()); throw e; });
ok(true, 'Ayşe arka plana geçince "son görülme" yazıyor');
}

// Geri → liste; son mesaj önizlemesi
await ali.goBack();
await ali.getByText('Mesajlar', { exact: true }).waitFor();
await ali.waitForTimeout(500);
ok(/Fotoğraf/.test(await ali.locator('.chat-preview').first().innerText()), 'listede son mesaj "Fotoğraf"');
await shot(ali, '08_liste_ali');

// Uygulama yeniden açılınca oturum sürer
await ali.reload();
await ali.getByText('Mesajlar', { exact: true }).waitFor({ timeout: 8000 });
ok(true, 'yeniden açılışta oturum korunuyor');

// Profil, çıkış
await ali.getByRole('button', { name: 'Profil' }).click();
await shot(ali, '09_profil');
await ali.getByRole('button', { name: 'Çıkış yap' }).click();
await ali.getByRole('button', { name: 'Giriş yap' }).waitFor();
ok(true, 'çıkış yapıldı');

console.log(errors.length ? 'HATALAR:\n' + errors.join('\n') : 'sayfa hatası yok');
await browser.close();

function makePng(w, hgt) {
  const raw = Buffer.alloc((w * 3 + 1) * hgt);
  for (let y = 0; y < hgt; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      const sky = y < hgt * 0.45;
      raw[o] = sky ? 120 + (y / hgt) * 200 : 20;
      raw[o + 1] = sky ? 180 + (y / hgt) * 100 : 90 + Math.sin(x / 9 + y / 5) * 30;
      raw[o + 2] = sky ? 240 : 160 + Math.sin(x / 13) * 40;
    }
  }
  const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let r = 0xffffffff; for (const x of b) r = t[(r ^ x) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(hgt, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
