/**
 * Küçük Supabase istemcisi (dış bağımlılık yok).
 *  - Kimlik: e-posta/şifre ile kayıt ve giriş, oturum yenileme (GoTrue REST)
 *  - Veri: tablo okuma/ekleme ve RPC (PostgREST)
 *  - Dosya: gizli depoya yükleme, imzalı bağlantı (Storage REST)
 *  - Anlık: Phoenix websocket (postgres_changes + presence)
 */

const SESSION_KEY = 'mesaj.session';

export class SupaError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function createClient(url, anonKey, { fetchImpl = (...a) => fetch(...a), storage = safeStorage(), WebSocketImpl = globalThis.WebSocket } = {}) {
  return new Supa(url.replace(/\/+$/, ''), anonKey, fetchImpl, storage, WebSocketImpl);
}

function safeStorage() {
  try {
    const s = globalThis.localStorage;
    s.setItem('__t', '1');
    s.removeItem('__t');
    return s;
  } catch {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  }
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(body, status) {
  if (body && typeof body === 'object') return body.msg || body.message || body.error_description || body.error || `Hata ${status}`;
  return typeof body === 'string' && body ? body : `Hata ${status}`;
}

class Supa {
  constructor(url, key, fetchImpl, storage, WS) {
    this.url = url;
    this.key = key;
    this.fetch = fetchImpl;
    this.store = storage;
    this.WS = WS;
    this.session = null;
    this.listeners = new Set();
    this._refreshTimer = null;
    this._refreshing = null;
    this.realtime = new Realtime(this);
    try {
      const raw = this.store.getItem(SESSION_KEY);
      if (raw) this.session = JSON.parse(raw);
    } catch {
      this.session = null;
    }
  }

  // ---------------- Kimlik ----------------
  get user() {
    return this.session?.user ?? null;
  }

  onAuth(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _setSession(s) {
    if (s && !s.expires_at && s.expires_in) s.expires_at = Math.floor(Date.now() / 1000) + s.expires_in;
    this.session = s;
    if (s) this.store.setItem(SESSION_KEY, JSON.stringify(s));
    else this.store.removeItem(SESSION_KEY);
    this._scheduleRefresh();
    this.realtime.setToken(s?.access_token ?? null);
    for (const fn of this.listeners) fn(s);
  }

  _scheduleRefresh() {
    clearTimeout(this._refreshTimer);
    if (!this.session?.expires_at) return;
    const ms = (this.session.expires_at - 60) * 1000 - Date.now();
    this._refreshTimer = setTimeout(() => this.refresh().catch(() => {}), Math.max(1000, ms));
  }

  async _auth(path, body) {
    const res = await this.fetch(`${this.url}/auth/v1/${path}`, {
      method: 'POST',
      headers: { apikey: this.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await readBody(res);
    if (!res.ok) throw new SupaError(errorMessage(data, res.status), res.status, data);
    return data;
  }

  async signUp(email, password, meta = {}) {
    const data = await this._auth('signup', { email, password, data: meta });
    // E-posta onayı kapalıysa oturum hemen gelir
    if (data?.access_token) this._setSession(data);
    else if (data && !data.access_token) {
      // Onay açıksa: doğrudan giriş dene (onay kapalı olmalı; değilse anlaşılır hata ver)
      try {
        await this.signIn(email, password);
      } catch (e) {
        throw new SupaError('Hesap oluştu ama e-posta onayı bekliyor. Supabase panelinde "Confirm email" kapatılmalı.', 400, e.body);
      }
    }
    return this.session;
  }

  async signIn(email, password) {
    const data = await this._auth('token?grant_type=password', { email, password });
    this._setSession(data);
    return data;
  }

  async refresh() {
    if (!this.session?.refresh_token) return null;
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      try {
        const data = await this._auth('token?grant_type=refresh_token', { refresh_token: this.session.refresh_token });
        this._setSession(data);
        return data;
      } catch (e) {
        if (e.status >= 400 && e.status < 500) this._setSession(null); // geçersiz oturum
        throw e;
      } finally {
        this._refreshing = null;
      }
    })();
    return this._refreshing;
  }

  /** Uygulama açılışında: süresi dolmuş/dolmak üzere ise yenile */
  async restore() {
    if (!this.session) return null;
    if (!this.session.expires_at || this.session.expires_at * 1000 - Date.now() < 120_000) {
      try {
        await this.refresh();
      } catch (e) {
        if (!(e.status >= 400 && e.status < 500)) {
          // ağ yok: eldeki oturumla devam
          this._scheduleRefresh();
          this.realtime.setToken(this.session?.access_token ?? null);
        }
      }
    } else {
      this._scheduleRefresh();
      this.realtime.setToken(this.session.access_token);
    }
    return this.session;
  }

  async signOut() {
    const token = this.session?.access_token;
    this._setSession(null);
    this.realtime.disconnect();
    if (token) {
      try {
        await this.fetch(`${this.url}/auth/v1/logout`, { method: 'POST', headers: { apikey: this.key, Authorization: `Bearer ${token}` } });
      } catch {
        /* çevrimdışı */
      }
    }
  }

  // ---------------- Veri ----------------
  async _token() {
    if (this.session?.expires_at && this.session.expires_at * 1000 - Date.now() < 30_000) {
      try {
        await this.refresh();
      } catch {
        /* aşağıda 401 ile anlaşılır */
      }
    }
    return this.session?.access_token ?? this.key;
  }

  async request(path, { method = 'GET', body, headers = {}, raw = false, retry = true } = {}) {
    const token = await this._token();
    const h = { apikey: this.key, Authorization: `Bearer ${token}`, ...headers };
    let payload = body;
    if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && typeof body !== 'string') {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await this.fetch(`${this.url}${path}`, { method, headers: h, body: payload });
    if (res.status === 401 && retry && this.session?.refresh_token) {
      await this.refresh().catch(() => {});
      return this.request(path, { method, body, headers, raw, retry: false });
    }
    if (raw) return res;
    const data = await readBody(res);
    if (!res.ok) throw new SupaError(errorMessage(data, res.status), res.status, data);
    return data;
  }

  select(table, query = '') {
    return this.request(`/rest/v1/${table}${query ? `?${query}` : ''}`);
  }

  insert(table, row, { returning = true } = {}) {
    return this.request(`/rest/v1/${table}`, {
      method: 'POST',
      body: row,
      headers: { Prefer: returning ? 'return=representation' : 'return=minimal' },
    });
  }

  update(table, query, patch) {
    return this.request(`/rest/v1/${table}?${query}`, { method: 'PATCH', body: patch, headers: { Prefer: 'return=representation' } });
  }

  rpc(fn, args = {}) {
    return this.request(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args });
  }

  // ---------------- Dosya ----------------
  async upload(bucket, path, blob, contentType) {
    return this.request(`/storage/v1/object/${bucket}/${path}`, {
      method: 'POST',
      body: blob,
      headers: { 'Content-Type': contentType || blob.type || 'application/octet-stream', 'x-upsert': 'false', 'cache-control': '31536000' },
    });
  }

  /** Birden çok dosya için imzalı bağlantı: { yol: url } */
  async signedUrls(bucket, paths, expiresIn = 3600) {
    if (!paths.length) return {};
    const data = await this.request(`/storage/v1/object/sign/${bucket}`, { method: 'POST', body: { expiresIn, paths } });
    const out = {};
    for (const item of data || []) {
      const u = item.signedURL || item.signedUrl;
      if (item.path && u) out[item.path] = u.startsWith('http') ? u : `${this.url}/storage/v1${u}`;
    }
    return out;
  }
}

/**
 * Supabase Realtime (Phoenix kanal protokolü, vsn 1.0.0).
 * Bağlantı koparsa artan aralıkla yeniden bağlanır; kanallar yeniden katılır.
 */
export class Realtime {
  constructor(client) {
    this.c = client;
    this.ws = null;
    this.ref = 0;
    this.channels = new Map(); // topic → Channel
    this.token = null;
    this.heartbeat = null;
    this.retry = 0;
    this.retryTimer = null;
    this.wanted = false;
    this.statusListeners = new Set();
    this.connected = false;
  }

  onStatus(fn) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  _status(v) {
    this.connected = v;
    for (const fn of this.statusListeners) fn(v);
  }

  setToken(t) {
    this.token = t;
    if (!t) return;
    for (const ch of this.channels.values()) {
      if (ch.joined) this.push(ch.topic, 'access_token', { access_token: t });
    }
  }

  nextRef() {
    this.ref += 1;
    return String(this.ref);
  }

  connect() {
    this.wanted = true;
    if (!this.c.WS) return;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    const wsUrl = `${this.c.url.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(this.c.key)}&vsn=1.0.0`;
    let ws;
    try {
      ws = new this.c.WS(wsUrl);
    } catch {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this._status(true);
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.push('phoenix', 'heartbeat', {}), 25_000);
      for (const ch of this.channels.values()) ch._join();
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const ch = this.channels.get(msg.topic);
      if (ch) ch._handle(msg);
    };
    ws.onclose = () => {
      clearInterval(this.heartbeat);
      for (const ch of this.channels.values()) ch.joined = false;
      this._status(false);
      if (this.ws === ws) this.ws = null;
      if (this.wanted) this._scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* */
      }
    };
  }

  _scheduleReconnect() {
    clearTimeout(this.retryTimer);
    const delay = Math.min(30_000, 1000 * 2 ** this.retry);
    this.retry += 1;
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  disconnect() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeat);
    for (const ch of this.channels.values()) ch.joined = false;
    this.channels.clear();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close();
      } catch {
        /* */
      }
    }
    this._status(false);
  }

  push(topic, event, payload, ref = this.nextRef(), joinRef) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    const msg = { topic, event, payload, ref };
    if (joinRef) msg.join_ref = joinRef;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  channel(name, config) {
    const topic = `realtime:${name}`;
    const existing = this.channels.get(topic);
    if (existing) return existing;
    const ch = new Channel(this, topic, config);
    this.channels.set(topic, ch);
    this.connect();
    if (this.ws?.readyState === 1) ch._join();
    return ch;
  }

  removeChannel(ch) {
    if (ch.joined) this.push(ch.topic, 'phx_leave', {}, this.nextRef(), ch.joinRef);
    ch.joined = false;
    this.channels.delete(ch.topic);
  }
}

class Channel {
  constructor(rt, topic, config) {
    this.rt = rt;
    this.topic = topic;
    this.config = config; // { postgres_changes:[...], presence:{key} }
    this.joined = false;
    this.joinRef = null;
    this.changeHandlers = [];
    this.presenceHandlers = new Set();
    this.joinHandlers = new Set();
    this.presence = {}; // key → metas[]
    this.trackPayload = null;
  }

  onChange(fn) {
    this.changeHandlers.push(fn);
    return this;
  }

  onPresence(fn) {
    this.presenceHandlers.add(fn);
    return this;
  }

  onJoin(fn) {
    this.joinHandlers.add(fn);
    return this;
  }

  track(payload) {
    this.trackPayload = payload;
    if (this.joined) this.rt.push(this.topic, 'presence', { type: 'presence', event: 'track', payload }, this.rt.nextRef(), this.joinRef);
  }

  untrack() {
    this.trackPayload = null;
    if (this.joined) this.rt.push(this.topic, 'presence', { type: 'presence', event: 'untrack' }, this.rt.nextRef(), this.joinRef);
  }

  _join() {
    this.joinRef = this.rt.nextRef();
    const cfg = {
      broadcast: { self: false, ack: false },
      presence: { key: this.config.presence?.key ?? '' },
      postgres_changes: this.config.postgres_changes ?? [],
      private: false,
    };
    const payload = { config: cfg };
    if (this.rt.token) payload.access_token = this.rt.token;
    this.presence = {};
    this.rt.push(this.topic, 'phx_join', payload, this.joinRef, this.joinRef);
  }

  _handle(msg) {
    const { event, payload } = msg;
    if (event === 'phx_reply' && msg.ref === this.joinRef) {
      if (payload?.status === 'ok') {
        this.joined = true;
        if (this.trackPayload) this.track(this.trackPayload);
        for (const fn of this.joinHandlers) fn(true);
      } else {
        for (const fn of this.joinHandlers) fn(false, payload);
      }
      return;
    }
    if (event === 'postgres_changes') {
      const d = payload?.data;
      if (!d) return;
      const change = { type: d.type || d.eventType, table: d.table, record: d.record || d.new, old: d.old_record || d.old };
      for (const fn of this.changeHandlers) fn(change);
      return;
    }
    if (event === 'presence_state') {
      this.presence = {};
      for (const [k, v] of Object.entries(payload || {})) this.presence[k] = v.metas || [];
      this._emitPresence();
      return;
    }
    if (event === 'presence_diff') {
      for (const [k, v] of Object.entries(payload?.joins || {})) {
        this.presence[k] = [...(this.presence[k] || []), ...(v.metas || [])];
      }
      for (const [k, v] of Object.entries(payload?.leaves || {})) {
        const leaving = new Set((v.metas || []).map((m) => m.phx_ref));
        const rest = (this.presence[k] || []).filter((m) => !leaving.has(m.phx_ref));
        if (rest.length) this.presence[k] = rest;
        else delete this.presence[k];
      }
      this._emitPresence();
      return;
    }
    if (event === 'phx_error' || event === 'phx_close') {
      this.joined = false;
    }
  }

  _emitPresence() {
    const online = new Set(Object.keys(this.presence));
    for (const fn of this.presenceHandlers) fn(online);
  }
}
