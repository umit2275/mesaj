// İki telefonlu uçtan uca deneme (deneme sunucusu + başsız Chromium).
// node tools/e2e.mjs <uygulama-url> <ekran-görüntüsü-klasörü>
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');

const [APP = 'http://localhost:4174/', OUT = '.'] = process.argv.slice(2);
const browser = await chromium.launch();
const phone = { viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: process.env.DARK ? 'dark' : 'light', acceptDownloads: true };
const NOWS = !!process.env.NOWS; // anlık bağlantı yokken (yedek yoklama) deneme
const ctx = async () => {
  const c = await browser.newContext(phone);
  // zil sesinin çaldığını saymak için
  await c.addInitScript(() => {
    window.__chimes = 0;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { if (!this.muted && /chime/.test(this.src)) window.__chimes++; return play.call(this).catch(() => {}); };
  });
  if (NOWS) await c.addInitScript(() => { delete window.WebSocket; window.WebSocket = undefined; });
  return c;
};
const ali = await (await ctx()).newPage();
const ayse = await (await ctx()).newPage();
const errors = [];
for (const [n, p] of [['ali', ali], ['ayse', ayse]]) {
  p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${n} konsol: ${m.text()}`); });
}
const shot = (p, name) => p.screenshot({ path: `${OUT}/e2e_${name}.png` });
const ok = (cond, msg) => { if (!cond) throw new Error('BAŞARISIZ: ' + msg); console.log('✓', msg); };
const chimes = (p) => p.evaluate(() => window.__chimes);
const longPress = async (p, loc) => {
  const b = await loc.boundingBox();
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await p.mouse.down();
  await p.waitForTimeout(650);
  await p.mouse.up();
};

async function signup(p, user, name, pass, avatarIndex) {
  await p.goto(APP);
  await p.getByRole('button', { name: 'Kayıt ol' }).click();
  await p.getByPlaceholder('Kullanıcı adı').fill(user);
  await p.getByPlaceholder('Görünen ad (ör. Ümit)').fill(name);
  await p.locator('input[type=password]').fill(pass);
  await p.locator('.avatar-grid .pick').nth(avatarIndex).click();
  await p.getByRole('button', { name: 'Hesap oluştur' }).click();
  await p.getByText('Suhbet Edek', { exact: true }).first().waitFor({ timeout: 10000 });
}

await fetch(new URL('/__reset', process.env.MOCK || 'http://localhost:54321'), { method: 'POST' });
await ali.goto(APP);
await ali.getByRole('button', { name: 'Kayıt ol' }).click();
await shot(ali, '01_kayit');
// Şifre en fazla 8 karakter (kutu 8'den fazlasını almıyor)
await ali.locator('input[type=password]').fill('123456789abc');
ok((await ali.locator('input[type=password]').inputValue()).length === 8, 'şifre kutusu en fazla 8 karakter alıyor');

await signup(ali, 'Ümit Ali', 'Ali', '1', 0); // tek karakterlik şifre bile olur
ok(true, 'tek karakterlik şifreyle kayıt oldu');
await signup(ayse, 'ayse', 'Ayşe', 'ş ğ*', 4); // boşluk, Türkçe harf, sembol
ok(true, 'boşluk/Türkçe harf/sembollü şifreyle kayıt oldu');

// Ali Ayşe'yi bulur — Ayşe'nin tavşan resmi görünür
await ali.getByRole('button', { name: 'Yeni sohbet' }).click();
await ali.getByPlaceholder('Kullanıcı adı ara').fill('ay');
await ali.getByText('@ayse').waitFor();
ok((await ali.locator('.chat-item .avatar .emoji').first().innerText()) === '🐰', 'aramada Ayşe\'nin seçtiği tavşan resmi görünüyor');
await ali.getByText('@ayse').click();
await ali.getByPlaceholder('Mesaj').waitFor();
await ali.waitForTimeout(800);
ok(!/çevrimiçi/.test(await ali.locator('.title-sub').innerText()), 'Ayşe sohbete girmediği için çevrimiçi görünmüyor');

// Yazıyor bilgisi
if (!NOWS) {
  // Ayşe sohbeti açar ki yazıyor kanalına katılsın
  await ayse.waitForTimeout(300);
}
await ali.getByPlaceholder('Mesaj').fill('Merhaba Ayşe! Nasılsın?');
await ali.getByRole('button', { name: 'Gönder', exact: true }).click();
await ali.locator('.msg.out .st.ticks').first().waitFor();
ok(true, 'mesaj gönderildi (tek tik)');

// Ayşe listede: zil + uygulama içi bildirim
await ayse.locator('.badge').waitFor({ timeout: 8000 });
ok((await ayse.locator('.badge').innerText()) === '1', 'Ayşe listesinde 1 okunmamış');
await ayse.waitForTimeout(300);
ok((await chimes(ayse)) >= 1, 'Ayşe\'de zil sesi çaldı');
ok(await ayse.locator('.banner').count() === 1, 'Ayşe\'de üstten bildirim kutusu çıktı');
await shot(ayse, '02_bildirim');
await ayse.locator('.banner').click();
await ayse.getByText('Merhaba Ayşe! Nasılsın?').waitFor();
ok(true, 'bildirime dokununca sohbet açıldı');
if (!NOWS) {
  await ali.waitForFunction(() => /çevrimiçi/.test(document.querySelector('.title-sub')?.textContent || ''), null, { timeout: 5000 });
  ok(true, 'Ayşe sohbete girince Ali onu çevrimiçi görüyor');
}

// Görüldü
await ali.locator('.seen').waitFor({ timeout: 8000 });
ok(/Görüldü/.test(await ali.locator('.seen').innerText()), 'Ali\'de "Görüldü" yazıyor (mavi çift tik)');

// Yazıyor
if (!NOWS) {
  await ayse.getByPlaceholder('Mesaj').pressSequentially('İyiyim', { delay: 40 });
  await ali.waitForFunction(() => /yazıyor/.test(document.querySelector('.title-sub')?.textContent || ''), null, { timeout: 5000 });
  ok(true, 'Ali "yazıyor…" görüyor');
  await shot(ali, '03_yaziyor');
  await ayse.getByPlaceholder('Mesaj').fill('');
}

// Ayşe cevap + fotoğraf
await ayse.getByPlaceholder('Mesaj').fill('İyiyim, sen? 😊');
await ayse.getByRole('button', { name: 'Gönder', exact: true }).click();
writeFileSync(`${OUT}/deneme.png`, makePng(640, 420));
await ayse.locator('input[type=file]').setInputFiles(`${OUT}/deneme.png`);
await ayse.locator('.msg.out img.photo').waitFor();
await ali.locator('.msg.in img.photo').waitFor({ timeout: 8000 });
await ali.waitForFunction(() => { const i = document.querySelector('.msg.in img.photo'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 8000 });
ok(true, 'fotoğraf Ali\'ye ulaştı');
ok((await chimes(ali)) >= 1, 'sohbet açıkken de Ali\'de zil çaldı');

// İsteğe bağlı indirme: büyük fotoğraf → "Cihaza indir"
await ali.locator('.msg.in img.photo').click();
await ali.locator('.viewer img').waitFor();
await shot(ali, '04_foto_indir');
const [dl] = await Promise.all([ali.waitForEvent('download', { timeout: 8000 }), ali.getByRole('button', { name: /Cihaza indir/ }).click()]);
ok(/\.jpg$/.test(dl.suggestedFilename()), 'fotoğraf cihaza indirildi (' + dl.suggestedFilename() + ')');
// Yakınlaştırma: çift dokunuş
await ali.locator('.viewer img').dblclick();
await ali.waitForTimeout(300);
ok(+(await ali.locator('.viewer img').getAttribute('data-scale')) > 2, 'çift dokunuşla fotoğraf yakınlaştı (' + (await ali.locator('.viewer img').getAttribute('data-scale')) + 'x)');
await ali.locator('.viewer img').dblclick();
await ali.waitForTimeout(300);
ok(+(await ali.locator('.viewer img').getAttribute('data-scale')) === 1, 'tekrar çift dokunuşla eski boyutuna döndü');
await ali.goBack(); // telefonun geri tuşu
await ali.waitForTimeout(400);
ok(await ali.locator('.viewer').count() === 0 && await ali.getByPlaceholder('Mesaj').isVisible(), 'geri tuşu fotoğrafı kapattı, sohbette kalındı');
await longPress(ali, ali.locator('.msg.in .bubble').first());
await ali.locator('.sheet').waitFor();
await ali.goBack();
await ali.waitForTimeout(400);
ok(await ali.locator('.sheet').count() === 0 && await ali.getByPlaceholder('Mesaj').isVisible(), 'geri tuşu menüyü kapattı, sohbette kalındı');

// Herkesten sil (okunmuş olsa bile): Ali kendi ilk mesajını siler
await longPress(ali, ali.locator('.msg.out .bubble').first());
await ali.locator('.sheet').waitFor();
await shot(ali, '05_islem_menusu');
await ali.getByRole('menuitem', { name: /Herkesten sil/ }).click();
await ali.getByText('Bu mesajı sildin').waitFor();
await ayse.locator('.msg', { hasText: 'Merhaba Ayşe! Nasılsın?' }).waitFor({ state: 'detached', timeout: 8000 });
ok(await ayse.getByText(/silindi|sildin/).count() === 0, 'okunmuş mesaj herkesten silindi: Ali\'de "Bu mesajı sildin", Ayşe\'de hiç iz yok');
await longPress(ali, ali.locator('.msg.out .bubble', { hasText: 'Bu mesajı sildin' }));
await ali.getByRole('menuitem', { name: /Benden sil/ }).click();
await ali.getByText('Bu mesajı sildin').waitFor({ state: 'detached' });
ok(true, '"Bu mesajı sildin" yazısı da Benden sil ile kaldırıldı');

// Benden sil: Ali, Ayşe'nin "İyiyim" mesajını kendinden siler, Ayşe'de durur
await longPress(ali, ali.locator('.msg.in .bubble', { hasText: 'İyiyim' }));
ok(await ali.getByRole('menuitem', { name: /Herkesten sil/ }).count() === 0, 'başkasının mesajında "Herkesten sil" yok');
await ali.getByRole('menuitem', { name: /Benden sil/ }).click();
await ali.waitForTimeout(500);
ok(await ali.locator('.msg', { hasText: 'İyiyim' }).count() === 0, '"Benden sil" Ali\'den kaldırdı');
await ayse.waitForTimeout(800);
ok(await ayse.locator('.msg', { hasText: 'İyiyim' }).count() === 1, 'Ayşe\'de mesaj duruyor');
await shot(ali, '06_sohbet_ali');
await shot(ayse, '07_sohbet_ayse');

// Sohbet içi ⋮ → Sohbeti sil: mesajlar Ali'den silinir, sohbet listede kalır
await ali.getByRole('button', { name: 'Sohbet menüsü' }).click();
await ali.getByRole('menuitem', { name: /Sohbeti sil/ }).click();
await ali.locator('.dialog').waitFor();
await ali.waitForTimeout(500); await shot(ali, '06b_onay');
await ali.getByRole('button', { name: 'Sil', exact: true }).click();
await ali.waitForTimeout(600);
ok(await ali.locator('.msg').count() === 0, 'sohbet içinden silinince Ali\'de mesaj kalmadı');
await ayse.waitForTimeout(500);
ok(await ayse.locator('.msg').count() > 0, 'Ayşe\'nin mesajları duruyor');
await ali.goBack();
await ali.locator('.chat-item').first().waitFor();
ok(await ali.locator('.chat-item').count() === 1 && /Mesaj yok/.test(await ali.locator('.chat-preview').first().innerText()), 'sohbet kutusu listede kaldı ("Mesaj yok")');
await ayse.getByPlaceholder('Mesaj').fill('Silince yeni mesaj gelir mi?');
await ayse.getByRole('button', { name: 'Gönder', exact: true }).click();
await ali.waitForFunction(() => /Silince yeni mesaj/.test(document.querySelector('.chat-preview')?.textContent || ''), null, { timeout: 8000 });
ok(true, 'temizlenen sohbete yeni mesaj geldi');
await ali.locator('.chat-item').first().click();
await ali.locator('.msg', { hasText: 'Silince yeni mesaj gelir mi?' }).waitFor();
await ali.waitForTimeout(500);
ok(await ali.locator('.msg').count() === 1, 'sohbette yalnızca yeni mesaj görünüyor');
await ali.goBack();

// Listede basılı tut → Sohbeti sil: sohbet listeden kalkar
await longPress(ali, ali.locator('.chat-item').first());
await ali.locator('.sheet').waitFor();
ok(await ali.getByPlaceholder('Mesaj').count() === 0, 'uzun basınca sohbet açılmadı, menü çıktı');
await ali.getByRole('menuitem', { name: /Sohbeti sil/ }).click();
await ali.getByRole('button', { name: 'Sil', exact: true }).click();
await ali.waitForTimeout(600);
ok(await ali.locator('.chat-item').count() === 0, 'sohbet Ali\'nin listesinden kalktı');
await ayse.getByPlaceholder('Mesaj').fill('Geri geldim');
await ayse.getByRole('button', { name: 'Gönder', exact: true }).click();
await ali.locator('.chat-item').first().waitFor({ timeout: 8000 });
ok(/Geri geldim/.test(await ali.locator('.chat-preview').first().innerText()), 'yeni mesajla sohbet listeye geri geldi');
await ali.locator('.chat-item').first().click();
await ali.locator('.msg', { hasText: 'Geri geldim' }).waitFor();
await ali.waitForTimeout(500);
ok(await ali.locator('.msg').count() === 1, 'geri gelen sohbette yalnızca yeni mesaj var');

// Profil resmini değiştir
await ali.goBack();
await ali.getByRole('button', { name: 'Profil' }).click();
await ali.locator('.avatar-grid .pick').nth(14).click();
await ali.waitForTimeout(500);
ok((await ali.locator('.profile-head .emoji').innerText()) === '🐧', 'profil resmi pengueniyle değişti');
await shot(ali, '08_profil');
await ali.goBack();
await ayse.goBack();
await ayse.waitForTimeout(800);
await ayse.reload();
await ayse.locator('.chat-item').first().waitFor();
ok((await ayse.locator('.chat-item .emoji').first().innerText()) === '🐧', 'Ayşe listede Ali\'nin yeni resmini görüyor');
await shot(ayse, '09_liste_ayse');

// Çıkış ve tek karakterlik şifreyle tekrar giriş
await ali.getByRole('button', { name: 'Profil' }).click();
await ali.getByRole('button', { name: 'Çıkış yap' }).click();
await ali.getByPlaceholder('Kullanıcı adı').fill('umit_ali');
await ali.locator('input[type=password]').fill('1');
await ali.getByRole('button', { name: 'Giriş yap' }).click();
await ali.getByText('Suhbet Edek', { exact: true }).first().waitFor({ timeout: 8000 });
ok(true, 'çıkıp tek karakterlik şifreyle tekrar girdi');

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
