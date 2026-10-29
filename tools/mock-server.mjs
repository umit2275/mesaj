/**
 * Yerel deneme sunucusu: Supabase'in bu uygulamanın kullandığı küçük bir alt kümesini
 * taklit eder. Veriler gerçek PostgreSQL'de (şema + RLS aynen), sorgular kullanıcının
 * rolüyle çalışır; yani güvenlik kuralları da denenmiş olur.
 *
 *   node tools/mock-server.mjs [port] [psql bağlantı argümanları...]
 *
 * Yalnızca test içindir; uygulama gerçekte supabase.co'ya bağlanır.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const PORT = +(process.argv[2] || 54321);
const PSQL = process.argv.slice(3).length ? process.argv.slice(3) : ['-h', '/tmp', '-p', '5499', '-U', 'postgres', '-d', 't'];

import { appendFileSync } from 'node:fs';
const dlog = (...a) => process.env.DEBUG && appendFileSync(process.env.DEBUG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
const users = new Map(); // email → { id, password, meta }
const tokens = new Map(); // token → user id
const files = new Map(); // path → { type, buf }
const sockets = new Set();

const lit = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error('geçersiz ad ' + s);
  return s;
};

function sql(query, uid, admin = false) {
  const pre = admin ? '' : uid
    ? `set local role authenticated; select set_config('request.jwt.claim.sub', ${lit(uid)}, true);`
    : `set local role anon;`;
  const t0 = Date.now();
  const r = spawnSync('psql', [...PSQL, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', `begin; ${pre} ${query}; commit;`], { encoding: 'utf8' });
  dlog('sql', Date.now() - t0, 'ms', query.slice(0, 60).replace(/\s+/g, ' '));
  if (r.status !== 0) {
    const msg = (r.stderr || '').split('\n').find((l) => l.startsWith('ERROR:')) || r.stderr;
    const e = new Error(msg.replace(/^ERROR:\s*/, '').trim());
    e.pg = true;
    throw e;
  }
  const lines = r.stdout.split('\n').filter((l) => l && l !== 'BEGIN' && l !== 'COMMIT' && l !== 'SET');
  const last = lines.filter((l) => l.startsWith('[') || l.startsWith('{') || l === 't' || l === 'f' || l === 'true' || l === 'false' || l === 'null' || /^-?\d+$/.test(l) || l.startsWith('"'));
  const out = last[last.length - 1];
  if (out === undefined) return null;
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

function session(user) {
  const access = 'tok_' + crypto.randomBytes(12).toString('hex');
  const refresh = 'ref_' + crypto.randomBytes(12).toString('hex');
  tokens.set(access, user.id);
  tokens.set(refresh, user.id);
  return { access_token: access, refresh_token: refresh, token_type: 'bearer', expires_in: 3600, user: { id: user.id, user_metadata: user.meta } };
}

// ---- PostgREST alt kümesi ----
function parseFilters(params) {
  const where = [];
  let order = '', limit = '', select = '*';
  for (const [k, v] of params) {
    if (k === 'select') { select = v; continue; }
    if (k === 'order') {
      const [col, dir] = v.split('.');
      order = ` order by ${ident(col)} ${dir === 'desc' ? 'desc' : 'asc'}`;
      continue;
    }
    if (k === 'limit') { limit = ` limit ${parseInt(v, 10)}`; continue; }
    const col = ident(k);
    const m = v.match(/^(not\.)?(eq|neq|gt|lt|gte|lte|ilike|is|in)\.(.*)$/);
    if (!m) throw new Error('filtre anlaşılamadı ' + v);
    const [, not, op, raw] = m;
    let cond;
    if (op === 'is') cond = `${col} is ${raw === 'null' ? 'null' : raw === 'true' ? 'true' : 'false'}`;
    else if (op === 'in') cond = `${col}::text in (${raw.replace(/^\(|\)$/g, '').split(',').map(lit).join(',')})`;
    else if (op === 'ilike') cond = `${col} ilike ${lit(raw.replace(/\*/g, '%'))}`;
    else cond = `${col} ${{ eq: '=', neq: '<>', gt: '>', lt: '<', gte: '>=', lte: '<=' }[op]} ${lit(raw)}`;
    where.push(not ? `not (${cond})` : cond);
  }
  const cols = select === '*' ? '*' : select.split(',').map(ident).join(',');
  return { where: where.length ? ' where ' + where.join(' and ') : '', order, limit, cols };
}

function rowsToSql(table, rows) {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].map(ident);
  return `insert into public.${ident(table)} (${keys.join(',')}) values ${rows
    .map((r) => `(${keys.map((k) => (r[k] === undefined ? 'default' : lit(r[k]))).join(',')})`)
    .join(',')}`;
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function send(res, status, data, headers = {}) {
  const isBuf = Buffer.isBuffer(data);
  res.writeHead(status, { 'Access-Control-Allow-Origin': '*', 'Content-Type': isBuf ? headers['Content-Type'] || 'application/octet-stream' : 'application/json', ...headers });
  res.end(isBuf ? data : data === undefined ? '' : JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' });
    return res.end();
  }
  const url = new URL(req.url, 'http://x');
  const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
  const uid = tokens.get(auth) || null;
  try {
    if (url.pathname === '/__reset') {
      users.clear(); tokens.clear(); files.clear(); presence.clear();
      sql('truncate auth.users cascade; delete from storage.objects', null, true);
      return send(res, 200, { ok: true });
    }
    // ---- kimlik ----
    if (url.pathname === '/auth/v1/signup') {
      const b = JSON.parse(await body(req));
      if (users.has(b.email)) return send(res, 422, { code: 422, msg: 'User already registered' });
      if (!b.password || b.password.length < 6) return send(res, 422, { msg: 'Password should be at least 6 characters.' });
      const u = { id: crypto.randomUUID(), password: b.password, meta: b.data || {} };
      sql(`insert into auth.users (id, raw_user_meta_data) values (${lit(u.id)}, ${lit(JSON.stringify(u.meta))}::jsonb)`, null, true);
      users.set(b.email, u);
      return send(res, 200, session(u));
    }
    if (url.pathname === '/auth/v1/token') {
      const b = JSON.parse(await body(req));
      if (url.searchParams.get('grant_type') === 'password') {
        const u = users.get(b.email);
        if (!u || u.password !== b.password) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
        return send(res, 200, session(u));
      }
      const id = tokens.get(b.refresh_token);
      const u = [...users.values()].find((x) => x.id === id);
      if (!u) return send(res, 400, { error_description: 'Invalid Refresh Token' });
      return send(res, 200, session(u));
    }
    if (url.pathname === '/auth/v1/logout') {
      tokens.delete(auth);
      return send(res, 204);
    }

    // ---- veri ----
    const rest = url.pathname.match(/^\/rest\/v1\/(rpc\/)?([a-z_]+)$/);
    if (rest) {
      const [, isRpc, name] = rest;
      if (isRpc) {
        const args = req.method === 'POST' ? JSON.parse((await body(req)).toString() || '{}') : {};
        const argSql = Object.entries(args).map(([k, v]) => `${ident(k)} => ${lit(v)}`).join(', ');
        const setReturning = name === 'my_chats';
        const q = setReturning
          ? `select coalesce(jsonb_agg(t), '[]'::jsonb) from public.${ident(name)}(${argSql}) t`
          : `select to_jsonb(public.${ident(name)}(${argSql}))`;
        const out = sql(q, uid);
        if (name === 'mark_read' && out > 0) {
          const changed = sql(`select coalesce(jsonb_agg(m), '[]'::jsonb) from public.messages m where conversation_id = ${lit(args.conv)} and read_at > now() - interval '3 seconds' and sender_id <> auth.uid()`, uid);
          for (const m of changed) broadcastChange('UPDATE', m);
        }
        return send(res, 200, out);
      }
      const f = parseFilters(url.searchParams);
      if (req.method === 'GET') {
        return send(res, 200, sql(`select coalesce(jsonb_agg(t), '[]'::jsonb) from (select ${f.cols} from public.${ident(name)}${f.where}${f.order}${f.limit}) t`, uid));
      }
      if (req.method === 'POST') {
        const b = JSON.parse(await body(req));
        const rows = Array.isArray(b) ? b : [b];
        const out = sql(`with ins as (${rowsToSql(name, rows)} returning *) select coalesce(jsonb_agg(ins), '[]'::jsonb) from ins`, uid);
        if (name === 'messages') for (const m of out) broadcastChange('INSERT', m);
        return send(res, 201, out);
      }
      if (req.method === 'PATCH') {
        const b = JSON.parse(await body(req));
        const sets = Object.entries(b).map(([k, v]) => `${ident(k)} = ${lit(v)}`).join(', ');
        return send(res, 200, sql(`with up as (update public.${ident(name)} set ${sets}${f.where} returning *) select coalesce(jsonb_agg(up), '[]'::jsonb) from up`, uid));
      }
    }

    // ---- dosya ----
    const up = url.pathname.match(/^\/storage\/v1\/object\/(photos)\/(.+)$/);
    if (up && req.method === 'POST') {
      const buf = await body(req);
      sql(`insert into storage.objects (bucket_id, name) values ('photos', ${lit(up[2])})`, uid);
      files.set(up[2], { type: req.headers['content-type'], buf });
      return send(res, 200, { Key: `photos/${up[2]}` });
    }
    if (url.pathname === '/storage/v1/object/sign/photos' && req.method === 'POST') {
      const b = JSON.parse(await body(req));
      const visible = sql(`select coalesce(jsonb_agg(name), '[]'::jsonb) from storage.objects where bucket_id = 'photos' and name in (${b.paths.map(lit).join(',')})`, uid);
      return send(res, 200, b.paths.map((p) => (visible.includes(p) ? { path: p, signedURL: `/object/sign/photos/${p}?token=t`, error: null } : { path: p, error: 'Either the object does not exist or you do not have access to it', signedURL: null })));
    }
    const dl = url.pathname.match(/^\/storage\/v1\/object\/sign\/photos\/(.+)$/);
    if (dl && req.method === 'GET') {
      const f = files.get(dl[1]);
      if (!f) return send(res, 404, { error: 'not found' });
      return send(res, 200, f.buf, { 'Content-Type': f.type });
    }
    send(res, 404, { message: 'yok: ' + url.pathname });
  } catch (e) {
    const msg = e.message || String(e);
    const status = /row-level security|permission denied/i.test(msg) ? 403 : /duplicate key/.test(msg) ? 409 : 400;
    send(res, status, { message: msg, code: status });
  }
});

// ---- Realtime (Phoenix) ----
function wsSend(sock, obj) {
  if (sock.destroyed) return;
  const data = Buffer.from(JSON.stringify(obj));
  let head;
  if (data.length < 126) head = Buffer.from([0x81, data.length]);
  else if (data.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81; head[1] = 126; head.writeUInt16BE(data.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(data.length), 2);
  }
  sock.write(Buffer.concat([head, data]));
}

function broadcastChange(type, record) {
  for (const s of sockets) {
    const ch = s.st.channels.get('realtime:db');
    if (!ch || !s.st.uid) continue;
    // görünürlük: RLS ile kontrol
    const ok = sql(`select to_jsonb(public.is_participant(${lit(record.conversation_id)}))`, s.st.uid);
    if (ok === true || ok === 't') {
      wsSend(s, { topic: 'realtime:db', event: 'postgres_changes', ref: null, payload: { ids: [1], data: { type, table: 'messages', schema: 'public', record, old_record: type === 'UPDATE' ? { id: record.id } : undefined, commit_timestamp: new Date().toISOString() } } });
    }
  }
}

const presence = new Map(); // key → metas[]
function presenceBroadcast(joins, leaves) {
  dlog('diff', Object.keys(joins), Object.keys(leaves), 'soket', sockets.size);
  for (const s of sockets) if (s.st.channels.has('realtime:online')) wsSend(s, { topic: 'realtime:online', event: 'presence_diff', ref: null, payload: { joins, leaves } });
}

function handleWs(sock, msg) {
  const st = sock.st;
  if (msg.event !== 'heartbeat') dlog('ws<', st.uid?.slice(0, 4), msg.topic, msg.event, JSON.stringify(msg.payload).slice(0, 80));
  const { topic, event, payload, ref } = msg;
  if (topic === 'phoenix' && event === 'heartbeat') return wsSend(sock, { topic, event: 'phx_reply', ref, payload: { status: 'ok', response: {} } });
  if (event === 'phx_join') {
    st.uid = tokens.get(payload.access_token) || st.uid;
    st.channels.set(topic, { key: payload.config?.presence?.key, joinRef: ref });
    wsSend(sock, { topic, event: 'phx_reply', ref, join_ref: ref, payload: { status: 'ok', response: { postgres_changes: (payload.config?.postgres_changes || []).map((c, i) => ({ ...c, id: i + 1 })) } } });
    if (topic === 'realtime:online') {
      const state = {};
      for (const [k, metas] of presence) state[k] = { metas };
      wsSend(sock, { topic, event: 'presence_state', ref: null, payload: state });
    }
    return;
  }
  if (event === 'access_token') {
    st.uid = tokens.get(payload.access_token) || st.uid;
    return;
  }
  if (event === 'presence' && topic === 'realtime:online') {
    const ch = st.channels.get(topic);
    if (payload.event === 'track') {
      const meta = { ...payload.payload, phx_ref: crypto.randomBytes(4).toString('hex') };
      st.meta = meta;
      presence.set(ch.key, [...(presence.get(ch.key) || []), meta]);
      presenceBroadcast({ [ch.key]: { metas: [meta] } }, {});
    } else if (payload.event === 'untrack') leavePresence(sock);
    return;
  }
  if (event === 'phx_leave') {
    st.channels.delete(topic);
  }
}

function leavePresence(sock) {
  const st = sock.st;
  const ch = st.channels.get('realtime:online');
  if (!ch || !st.meta) return;
  const rest = (presence.get(ch.key) || []).filter((m) => m.phx_ref !== st.meta.phx_ref);
  if (rest.length) presence.set(ch.key, rest);
  else presence.delete(ch.key);
  presenceBroadcast({}, { [ch.key]: { metas: [st.meta] } });
  st.meta = null;
}

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.st = { channels: new Map(), uid: null, meta: null };
  sockets.add(sock);
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    dlog('veri', chunk.length, 'birikmiş', buf.length);
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = buf[1] & 0x80;
      const total = off + (masked ? 4 : 0) + len;
      if (buf.length < total) break;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      const data = Buffer.from(buf.subarray(off + (masked ? 4 : 0), total));
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(total);
      if (op === 8) { sock.end(); return; }
      if (op === 1) {
        try { handleWs(sock, JSON.parse(data.toString())); } catch (e) { console.error('ws', e.message); }
      }
    }
  });
  if (process.env.DEBUG) { const iv = setInterval(() => { if (sock.destroyed) return clearInterval(iv); dlog('soket durumu', sock.st.uid?.slice(0,4), 'akış', sock.readableFlowing, 'duraklı', sock.isPaused(), 'okunan', sock.bytesRead); }, 3000); }
  const bye = () => { leavePresence(sock); sockets.delete(sock); };
  sock.on('close', bye);
  sock.on('error', bye);
});

server.listen(PORT, () => console.log(`deneme sunucusu :${PORT}`));
