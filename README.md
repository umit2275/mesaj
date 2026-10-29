# Suhbet Edek

Android için birebir mesajlaşma uygulaması: kullanıcı adıyla kayıt/giriş, anlık mesaj,
fotoğraf gönderme, okundu (mavi çift tik), çevrimiçi / son görülme.

Sunucu olarak **Supabase** (ücretsiz plan) kullanılır. APK, `main` dalına her gönderimde
GitHub Actions ile derlenir ve **Releases** sayfasına konur.

## Supabase kurulumu (bir kez)

1. supabase.com → New project (bölge: Central EU – Frankfurt).
2. **SQL Editor → New query** → `supabase/schema.sql` dosyasının tamamını yapıştır → **Run**. (Eski kurulumu güncellerken yalnızca `supabase/migration_002.sql`.)
3. **Authentication → Sign In / Providers → Email** → **Confirm email** kapalı olsun
   (uygulama e-posta değil kullanıcı adı kullanır).
4. **Project Settings → API**: *Project URL* ve *anon public* anahtarını `src/config.js` içine yaz.
   (`service_role` anahtarı asla uygulamaya konmaz.)

## Geliştirme

```bash
npm install
npm run dev        # tarayıcıda dene
npm test           # birim testleri
```

Yerel uçtan uca deneme (gerçek Supabase gerekmez): PostgreSQL'e `supabase/test/shim.sql` ve
`supabase/schema.sql` yüklenir, `node tools/mock-server.mjs` çalıştırılır, uygulama
`VITE_SUPABASE_URL=http://localhost:54321 VITE_SUPABASE_ANON_KEY=anon` ile derlenir ve
`node tools/e2e.mjs` iki telefonu taklit ederek konuşturur. Güvenlik kuralları:
`supabase/test/rls_test.sql`.

## Güvenlik

- Herkes yalnızca dahil olduğu sohbetleri ve mesajları görebilir (RLS).
- Mesaj başkası adına gönderilemez, gönderilen mesaj değiştirilemez.
- Fotoğraflar gizli depoda; yalnızca sohbetin iki tarafı 1 saatlik imzalı bağlantıyla açabilir.
