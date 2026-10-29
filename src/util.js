/** Saf yardımcılar (test edilir, tarayıcıya bağlı değil). */

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
export const EMAIL_DOMAIN = 'mesaj-app.com';

const TR_MAP = { ç: 'c', ğ: 'g', ı: 'i', İ: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'c', Ğ: 'g', Ö: 'o', Ş: 's', Ü: 'u' };

/** Kullanıcı adını sadeleştir: küçük harf, Türkçe harfler → Latin, boşluk → _ */
export function normalizeUsername(s) {
  return String(s ?? '')
    .trim()
    .replace(/[çğıİöşüÇĞÖŞÜ]/g, (c) => TR_MAP[c])
    .toLowerCase()
    .replace(/\s+/g, '_');
}

export function usernameError(u) {
  if (!u) return 'Kullanıcı adı gerekli';
  if (u.length < 3) return 'Kullanıcı adı en az 3 harf olmalı';
  if (u.length > 20) return 'Kullanıcı adı en fazla 20 harf olabilir';
  if (!USERNAME_RE.test(u)) return 'Yalnızca harf, rakam ve _ kullanılabilir';
  return null;
}

export function passwordError(p) {
  if (!p || p.length < 6) return 'Şifre en az 6 karakter olmalı';
  return null;
}

/** Kullanıcı adı ile giriş: Supabase e-posta istediği için içeride sabit bir alan adı kullanılır */
export const usernameToEmail = (u) => `${u}@${EMAIL_DOMAIN}`;

const pad = (n) => String(n).padStart(2, '0');
export const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const DAYS = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

/** Gün farkı (bugün 0, dün 1) */
export function dayDiff(date, now = new Date()) {
  return Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
}

/** Sohbet listesi zamanı: bugün → saat, dün → "Dün", hafta içi → gün adı, sonra tarih */
export function listTime(iso, now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = dayDiff(d, now);
  if (diff <= 0) return hhmm(d);
  if (diff === 1) return 'Dün';
  if (diff < 7) return DAYS[d.getDay()];
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** Sohbet içi gün ayracı */
export function dayLabel(iso, now = new Date()) {
  const d = new Date(iso);
  const diff = dayDiff(d, now);
  if (diff <= 0) return 'Bugün';
  if (diff === 1) return 'Dün';
  if (diff < 7) return DAYS[d.getDay()];
  const y = d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${y}`;
}

/** "çevrimiçi" ya da "son görülme ..." */
export function lastSeenText(online, iso, now = new Date()) {
  if (online) return 'çevrimiçi';
  if (!iso) return '';
  const d = new Date(iso);
  const diff = dayDiff(d, now);
  if (diff <= 0) return `son görülme bugün ${hhmm(d)}`;
  if (diff === 1) return `son görülme dün ${hhmm(d)}`;
  return `son görülme ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** Resmi en uzun kenarı max olacak şekilde küçült (büyütme yok) */
export function fitSize(w, h, max) {
  if (!w || !h) return { w: 0, h: 0 };
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.round(w * s), h: Math.round(h * s) };
}

/** Mesaj dizisine gün ayraçları ekle: [{type:'day',label}|{type:'msg',m}] */
export function withDaySeparators(messages, now = new Date()) {
  const out = [];
  let last = null;
  for (const m of messages) {
    const key = startOfDay(new Date(m.created_at));
    if (key !== last) {
      out.push({ type: 'day', label: dayLabel(m.created_at, now), key });
      last = key;
    }
    out.push({ type: 'msg', m });
  }
  return out;
}

/** Mesajları id'ye göre birleştir (aynı id → yeni olan), sırala */
export function mergeMessages(list, incoming) {
  const byId = new Map(list.map((m) => [String(m.id), m]));
  for (const m of incoming) {
    const old = byId.get(String(m.id));
    byId.set(String(m.id), old ? { ...old, ...m } : m);
  }
  return [...byId.values()].sort((a, b) => {
    const ta = Date.parse(a.created_at), tb = Date.parse(b.created_at);
    if (ta !== tb) return ta - tb;
    return String(a.id).localeCompare(String(b.id), 'en', { numeric: true });
  });
}

/** Baş harf ve isimden sabit renk */
export function avatarFor(name) {
  const s = String(name || '?').trim();
  const initial = (s[0] || '?').toLocaleUpperCase('tr');
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const colors = ['#e57373', '#f06292', '#ba68c8', '#7986cb', '#4fc3f7', '#4db6ac', '#81c784', '#ffb74d', '#a1887f', '#90a4ae'];
  return { initial, color: colors[h % colors.length] };
}

/** Sunucu hatasını kullanıcıya anlaşılır yaz */
export function friendlyError(e) {
  const msg = String(e?.message || e || '');
  const low = msg.toLowerCase();
  if (low.includes('invalid login credentials')) return 'Kullanıcı adı ya da şifre yanlış';
  if (low.includes('user already registered') || low.includes('already been registered')) return 'Bu kullanıcı adı alınmış';
  if (low.includes('duplicate key') && low.includes('username')) return 'Bu kullanıcı adı alınmış';
  if (low.includes('failed to fetch') || low.includes('network')) return 'İnternet bağlantısı yok gibi görünüyor';
  if (low.includes('password should be')) return 'Şifre en az 6 karakter olmalı';
  if (low.includes('email not confirmed')) return 'Hesap onay bekliyor (Supabase\'de e-posta onayı kapatılmalı)';
  return msg || 'Bir hata oluştu';
}
