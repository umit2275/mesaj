// Supabase Edge Function: "push"
// Veritabanı yeni mesajda bunu çağırır; bu da Firebase (FCM) üzerinden alıcının
// telefonuna bildirim gönderir. Uygulama kapalı ya da uykudayken de çalışır.
//
// Gerekli gizli değerler (Edge Functions → Secrets):
//   FCM_SERVICE_ACCOUNT : Firebase hizmet hesabı JSON'unun tamamı
//   PUSH_SECRET         : veritabanı tetikleyicisiyle aynı gizli kelime
// "Enforce JWT verification" KAPALI olmalı (çağrıyı PUSH_SECRET korur).

type Payload = { tokens: string[]; title: string; body: string; conversation_id: string };

let cached = { token: '', exp: 0 };

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function serviceAccount() {
  const raw = Deno.env.get('FCM_SERVICE_ACCOUNT') ?? '';
  if (!raw) throw new Error('FCM_SERVICE_ACCOUNT eksik');
  return JSON.parse(raw);
}

/** Google OAuth erişim anahtarı (hizmet hesabıyla imzalı JWT → 1 saatlik anahtar) */
async function accessToken(sa: { client_email: string; private_key: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached.token && cached.exp > now + 60) return cached.token;
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` }),
  });
  const j = await res.json();
  if (!res.ok || !j.access_token) throw new Error('Google yetkisi alınamadı: ' + JSON.stringify(j));
  cached = { token: j.access_token, exp: now + (j.expires_in ?? 3600) };
  return cached.token;
}

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get('PUSH_SECRET') ?? '';
  if (!secret || req.headers.get('x-push-secret') !== secret) return new Response('yetkisiz', { status: 401 });
  try {
    const p = (await req.json()) as Payload;
    if (!p.tokens?.length) return Response.json({ sent: 0 });
    const sa = serviceAccount();
    const at = await accessToken(sa);
    const results = await Promise.all(
      p.tokens.map(async (token) => {
        const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              token,
              notification: { title: p.title, body: p.body },
              data: { conversation_id: String(p.conversation_id ?? '') },
              android: {
                priority: 'HIGH',
                notification: { channel_id: 'mesajlar_v2', sound: 'chime', icon: 'ic_stat_suhbet', color: '#008069', tag: String(p.conversation_id ?? '') },
              },
            },
          }),
        });
        return { ok: r.ok, status: r.status, error: r.ok ? null : await r.text() };
      }),
    );
    return Response.json({ sent: results.filter((r) => r.ok).length, errors: results.filter((r) => !r.ok) });
  } catch (e) {
    return Response.json({ error: String((e as Error).message ?? e) }, { status: 500 });
  }
});
