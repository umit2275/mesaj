// Supabase proje bilgileri (Project Settings → API).
// "anon public" anahtarı uygulamaya konmak için yapılmıştır; güvenlik veritabanı
// kurallarıyla (RLS) sağlanır. service_role anahtarını ASLA buraya koymayın.
// (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY yalnızca yerel deneme içindir.)
export const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL || '';
export const SUPABASE_ANON_KEY = import.meta.env?.VITE_SUPABASE_ANON_KEY || '';
