import './styles.css';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { createClient } from './lib/supa.js';
import { h, icon, toast } from './dom.js';
import { prepareImage } from './image.js';
import {
  normalizeUsername, usernameError, passwordError, usernameToEmail, listTime, lastSeenText,
  withDaySeparators, mergeMessages, avatarFor, friendlyError, hhmm, fitSize,
} from './util.js';

const app = document.getElementById('app');
const PAGE = 40; // bir seferde yüklenen mesaj sayısı

// ------------------------------------------------------------------
// Durum
// ------------------------------------------------------------------
const S = {
  db: null,
  me: null, // profil
  screen: null, // { name, params }
  chats: [],
  online: new Set(),
  conv: null, // açık sohbet: { id, other, messages, hasMore, loadingOlder }
  urls: new Map(), // foto yolu → { url, exp }
  dbChannel: null,
  presence: null,
  rtJoined: false,
  timers: [],
};

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  renderSetupNeeded();
} else {
  S.db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  start();
}

function renderSetupNeeded() {
  app.replaceChildren(
    h('div', { class: 'center-page' },
      h('div', { class: 'logo' }, '💬'),
      h('h1', {}, 'Mesaj'),
      h('p', { class: 'muted' }, 'Sunucu bilgileri henüz girilmemiş (src/config.js).'),
    ),
  );
}

async function start() {
  app.replaceChildren(h('div', { class: 'center-page' }, h('div', { class: 'spinner' })));
  await S.db.restore();
  if (S.db.user) {
    const ok = await loadMe();
    if (ok) {
      afterLogin();
      return;
    }
  }
  navigate('auth', {}, { replace: true });
}

async function loadMe() {
  try {
    const rows = await S.db.select('profiles', `id=eq.${S.db.user.id}&select=*`);
    S.me = rows[0] || null;
    if (!S.me) {
      await S.db.signOut();
      return false;
    }
    return true;
  } catch (e) {
    if (e.status === 401) {
      await S.db.signOut();
      return false;
    }
    // ağ yok: eldeki oturumla devam (profil bilinmiyor)
    S.me = { id: S.db.user.id, username: S.db.user.user_metadata?.username || '', display_name: S.db.user.user_metadata?.display_name || '' };
    return true;
  }
}

function afterLogin() {
  startRealtime();
  startTimers();
  navigate('chats', {}, { replace: true });
}

// ------------------------------------------------------------------
// Gezinme (Android geri tuşu tarayıcı geçmişini kullanır)
// ------------------------------------------------------------------
function navigate(name, params = {}, { replace = false } = {}) {
  const st = { name, params };
  if (replace) history.replaceState(st, '');
  else history.pushState(st, '');
  show(st);
}

window.addEventListener('popstate', (e) => {
  const st = e.state;
  if (!st) return;
  if (!S.db?.user && st.name !== 'auth') {
    history.replaceState({ name: 'auth', params: {} }, '');
    show({ name: 'auth', params: {} });
    return;
  }
  show(st);
});

function show(st) {
  S.screen = st;
  if (st.name !== 'chat') S.conv = null;
  document.getElementById('viewer')?.remove();
  switch (st.name) {
    case 'auth': return renderAuth();
    case 'chats': return renderChats();
    case 'new': return renderNewChat();
    case 'chat': return renderChat(st.params);
    case 'profile': return renderProfile();
    default: return renderChats();
  }
}

// ------------------------------------------------------------------
// Giriş / kayıt
// ------------------------------------------------------------------
function renderAuth() {
  let mode = 'login';
  const err = h('div', { class: 'form-error' });
  const user = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: false, placeholder: 'Kullanıcı adı', maxLength: 20 });
  const name = h('input', { type: 'text', autocomplete: 'nickname', placeholder: 'Görünen ad (ör. Ümit)', maxLength: 40 });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Şifre' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Giriş yap');
  const nameRow = h('label', { class: 'field hidden' }, name);
  const tabLogin = h('button', { type: 'button', class: 'tab active' }, 'Giriş');
  const tabSignup = h('button', { type: 'button', class: 'tab' }, 'Kayıt ol');
  const hint = h('p', { class: 'hint hidden' }, 'Kullanıcı adın: küçük harf, rakam ve _ (Türkçe harfler otomatik düzeltilir). Arkadaşların seni bu adla bulur.');

  const setMode = (m) => {
    mode = m;
    tabLogin.classList.toggle('active', m === 'login');
    tabSignup.classList.toggle('active', m === 'signup');
    nameRow.classList.toggle('hidden', m !== 'signup');
    hint.classList.toggle('hidden', m !== 'signup');
    pass.autocomplete = m === 'signup' ? 'new-password' : 'current-password';
    btn.textContent = m === 'signup' ? 'Hesap oluştur' : 'Giriş yap';
    err.textContent = '';
  };
  tabLogin.onclick = () => setMode('login');
  tabSignup.onclick = () => setMode('signup');
  user.addEventListener('blur', () => { user.value = normalizeUsername(user.value); });

  const form = h('form', { class: 'auth-form', novalidate: true },
    h('div', { class: 'tabs' }, tabLogin, tabSignup),
    h('label', { class: 'field' }, user),
    nameRow,
    h('label', { class: 'field' }, pass),
    hint,
    err,
    btn,
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    const u = normalizeUsername(user.value);
    user.value = u;
    const problem = usernameError(u) || passwordError(pass.value);
    if (problem) {
      err.textContent = problem;
      return;
    }
    btn.disabled = true;
    err.textContent = '';
    try {
      if (mode === 'signup') {
        const free = await S.db.rpc('username_available', { uname: u });
        if (free === false) throw new Error('Bu kullanıcı adı alınmış');
        await S.db.signUp(usernameToEmail(u), pass.value, { username: u, display_name: name.value.trim() || u });
      } else {
        await S.db.signIn(usernameToEmail(u), pass.value);
      }
      if (await loadMe()) afterLogin();
      else throw new Error('Profil bulunamadı');
    } catch (ex) {
      err.textContent = friendlyError(ex);
    } finally {
      btn.disabled = false;
    }
  };

  app.replaceChildren(
    h('div', { class: 'auth-page' },
      h('div', { class: 'auth-top' }, h('div', { class: 'logo' }, '💬'), h('h1', {}, 'Mesaj')),
      form,
    ),
  );
}

// ------------------------------------------------------------------
// Sohbet listesi
// ------------------------------------------------------------------
function header(title, { back = false, actions = [], sub = null, onTitle = null } = {}) {
  return h('header', { class: 'topbar' },
    back ? h('button', { class: 'icon-btn', 'aria-label': 'Geri', onclick: () => history.back() }, icon('back')) : null,
    h('div', { class: 'title', onclick: onTitle },
      h('div', { class: 'title-main' }, title),
      sub ? h('div', { class: 'title-sub' }, sub) : null,
    ),
    ...actions,
  );
}

function avatar(name, online = false, size = 'md') {
  const a = avatarFor(name);
  return h('div', { class: `avatar ${size}`, style: { background: a.color } }, a.initial, online ? h('span', { class: 'dot' }) : null);
}

function renderChats() {
  const list = h('div', { class: 'chat-list' });
  const body = h('main', { class: 'scroll' }, list);
  app.replaceChildren(
    h('div', { class: 'page' },
      header('Mesajlar', { actions: [h('button', { class: 'icon-btn', 'aria-label': 'Profil', onclick: () => navigate('profile') }, icon('user'))] }),
      body,
      h('button', { class: 'fab', 'aria-label': 'Yeni sohbet', onclick: () => navigate('new') }, icon('plus')),
    ),
  );
  paintChats();
  refreshChats();
}

function paintChats() {
  const list = app.querySelector('.chat-list');
  if (!list) return;
  if (!S.chats.length) {
    list.replaceChildren(h('div', { class: 'empty' },
      h('p', {}, 'Henüz sohbet yok.'),
      h('p', { class: 'muted' }, 'Sağ alttaki + ile arkadaşını kullanıcı adıyla bul.')));
    return;
  }
  list.replaceChildren(...S.chats.map((c) => {
    const name = c.other_display_name || c.other_username;
    const mine = c.last_sender === S.me.id;
    let preview = c.last_has_image ? [icon('photo', 'ic sm'), ' Fotoğraf'] : [c.last_body || ''];
    if (!c.last_message_id) preview = [h('span', { class: 'muted' }, 'Sohbet başladı')];
    const tick = mine && c.last_message_id ? h('span', { class: `st ticks ${c.last_read_at ? 'read' : ''}` }, icon(c.last_read_at ? 'checks' : 'check', 'ic xs')) : null;
    return h('button', { class: 'chat-item', onclick: () => navigate('chat', { id: c.conversation_id }) },
      avatar(name, S.online.has(c.other_id)),
      h('div', { class: 'chat-mid' },
        h('div', { class: 'chat-row' }, h('span', { class: 'chat-name' }, name), h('span', { class: `chat-time ${c.unread ? 'hl' : ''}` }, listTime(c.last_created_at))),
        h('div', { class: 'chat-row' }, h('span', { class: 'chat-preview' }, tick, ...preview), c.unread ? h('span', { class: 'badge' }, c.unread > 99 ? '99+' : c.unread) : null),
      ),
    );
  }));
}

let chatsBusy = false;
async function refreshChats() {
  if (chatsBusy) return;
  chatsBusy = true;
  try {
    S.chats = (await S.db.rpc('my_chats')) || [];
    if (S.screen?.name === 'chats') paintChats();
  } catch (e) {
    if (S.screen?.name === 'chats' && !S.chats.length) toast(friendlyError(e));
  } finally {
    chatsBusy = false;
  }
}

// ------------------------------------------------------------------
// Yeni sohbet: kullanıcı adıyla ara
// ------------------------------------------------------------------
function renderNewChat() {
  const input = h('input', { type: 'search', placeholder: 'Kullanıcı adı ara', autocapitalize: 'none', spellcheck: false, class: 'search-input' });
  const results = h('div', { class: 'chat-list' });
  let t = null, seq = 0;
  const run = async () => {
    const q = normalizeUsername(input.value).replace(/[^a-z0-9_]/g, '');
    const my = ++seq;
    if (q.length < 2) {
      results.replaceChildren(h('div', { class: 'empty muted' }, 'En az 2 harf yaz.'));
      return;
    }
    try {
      const rows = await S.db.select('profiles', `select=id,username,display_name,last_seen&username=ilike.*${encodeURIComponent(q)}*&id=neq.${S.me.id}&order=username&limit=30`);
      if (my !== seq) return;
      if (!rows.length) {
        results.replaceChildren(h('div', { class: 'empty muted' }, 'Kimse bulunamadı.'));
        return;
      }
      results.replaceChildren(...rows.map((p) => h('button', { class: 'chat-item', onclick: () => openWith(p) },
        avatar(p.display_name || p.username, S.online.has(p.id)),
        h('div', { class: 'chat-mid' },
          h('div', { class: 'chat-row' }, h('span', { class: 'chat-name' }, p.display_name || p.username)),
          h('div', { class: 'chat-row' }, h('span', { class: 'chat-preview muted' }, '@' + p.username)),
        ))));
    } catch (e) {
      results.replaceChildren(h('div', { class: 'empty muted' }, friendlyError(e)));
    }
  };
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 250); });
  app.replaceChildren(
    h('div', { class: 'page' },
      header('Yeni sohbet', { back: true }),
      h('div', { class: 'search-bar' }, icon('search'), input),
      h('main', { class: 'scroll' }, results),
    ),
  );
  run();
  setTimeout(() => input.focus(), 50);
}

async function openWith(p) {
  try {
    const id = await S.db.rpc('open_conversation', { other: p.id });
    history.replaceState({ name: 'chats', params: {} }, '');
    navigate('chat', { id, other: p });
  } catch (e) {
    toast(friendlyError(e));
  }
}

// ------------------------------------------------------------------
// Sohbet ekranı
// ------------------------------------------------------------------
async function renderChat({ id, other }) {
  const known = S.chats.find((c) => c.conversation_id === id);
  const o = other || (known && { id: known.other_id, username: known.other_username, display_name: known.other_display_name, last_seen: known.other_last_seen });
  S.conv = { id, other: o || null, messages: [], hasMore: true, loadingOlder: false, sending: 0 };

  const sub = h('span', { class: 'status' }, '');
  const titleName = h('span', {}, o ? o.display_name || o.username : '…');
  const msgs = h('div', { class: 'messages' });
  const scroller = h('main', { class: 'scroll chat-bg' }, h('div', { class: 'older hidden' }, h('div', { class: 'spinner sm' })), msgs);
  const text = h('textarea', { rows: 1, placeholder: 'Mesaj', maxLength: 4000, enterkeyhint: 'send' });
  const file = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  const sendBtn = h('button', { class: 'send-btn', 'aria-label': 'Gönder' }, icon('send'));
  const attachBtn = h('button', { class: 'icon-btn attach', 'aria-label': 'Fotoğraf gönder', onclick: () => file.click() }, icon('attach'));

  const head = h('header', { class: 'topbar chat-top' },
    h('button', { class: 'icon-btn', 'aria-label': 'Geri', onclick: () => history.back() }, icon('back')),
    h('div', { class: 'head-avatar' }, o ? avatar(o.display_name || o.username, false, 'sm') : null),
    h('div', { class: 'title' }, h('div', { class: 'title-main' }, titleName), h('div', { class: 'title-sub' }, sub)),
  );
  app.replaceChildren(
    h('div', { class: 'page chat-page' },
      head,
      scroller,
      h('footer', { class: 'composer' }, attachBtn, h('div', { class: 'input-wrap' }, text), sendBtn, file),
    ),
  );

  const conv = S.conv;
  const paintStatus = () => {
    if (!conv.other) return;
    sub.textContent = lastSeenText(S.online.has(conv.other.id), conv.other.last_seen);
  };
  conv.paintStatus = paintStatus;
  conv.scroller = scroller;
  conv.list = msgs;

  // Karşı tarafı bilmiyorsak (uygulama bu sohbete doğrudan açıldıysa) getir
  if (!conv.other) {
    try {
      const rows = await S.db.select('conversations', `id=eq.${id}&select=user_a,user_b`);
      const otherId = rows[0] && (rows[0].user_a === S.me.id ? rows[0].user_b : rows[0].user_a);
      const ps = otherId ? await S.db.select('profiles', `id=eq.${otherId}&select=id,username,display_name,last_seen`) : [];
      conv.other = ps[0] || null;
      if (conv.other) {
        titleName.textContent = conv.other.display_name || conv.other.username;
        head.querySelector('.head-avatar').replaceChildren(avatar(conv.other.display_name || conv.other.username, false, 'sm'));
      }
    } catch {
      /* başlık boş kalır */
    }
  } else {
    // son görülmeyi tazele
    S.db.select('profiles', `id=eq.${conv.other.id}&select=last_seen`).then((r) => {
      if (r[0] && S.conv === conv) {
        conv.other.last_seen = r[0].last_seen;
        paintStatus();
      }
    }).catch(() => {});
  }
  paintStatus();

  // Yazma kutusu: otomatik yükseklik, gönder
  const autosize = () => {
    text.style.height = 'auto';
    text.style.height = Math.min(text.scrollHeight, 140) + 'px';
  };
  text.addEventListener('input', autosize);
  const doSend = () => {
    const body = text.value.trim();
    if (!body) return;
    text.value = '';
    autosize();
    sendText(conv, body);
    text.focus();
  };
  sendBtn.onclick = doSend;
  file.onchange = () => {
    const f = file.files?.[0];
    file.value = '';
    if (f) sendImage(conv, f);
  };

  scroller.addEventListener('scroll', () => {
    if (scroller.scrollTop < 80) loadOlder(conv);
  });

  await loadLatest(conv, true);
}

function isNearBottom(sc) {
  return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
}

async function loadLatest(conv, first = false) {
  try {
    const rows = await S.db.select('messages', `conversation_id=eq.${conv.id}&select=*&order=id.desc&limit=${PAGE}`);
    if (S.conv !== conv) return;
    if (first) conv.hasMore = rows.length === PAGE;
    applyMessages(conv, rows.reverse(), { stick: first });
    markReadSoon(conv);
  } catch (e) {
    if (first) toast(friendlyError(e));
  }
}

/** Gelen yeni/okundu bilgisi değişen mesajlar (son id'den sonrası + okunma durumu) */
async function pollConversation(conv) {
  const real = conv.messages.filter((m) => !m._tmp);
  const lastId = real.length ? real[real.length - 1].id : 0;
  try {
    const fresh = await S.db.select('messages', `conversation_id=eq.${conv.id}&id=gt.${lastId}&select=*&order=id.asc&limit=100`);
    // kendi okunmamış mesajlarımızın okundu bilgisi
    const unreadMine = real.filter((m) => m.sender_id === S.me.id && !m.read_at).map((m) => m.id);
    let reads = [];
    if (unreadMine.length) reads = await S.db.select('messages', `id=in.(${unreadMine.slice(-100).join(',')})&read_at=not.is.null&select=id,read_at`);
    if (S.conv !== conv) return;
    if (fresh.length || reads.length) applyMessages(conv, [...fresh, ...reads]);
    if (fresh.some((m) => m.sender_id !== S.me.id)) markReadSoon(conv);
  } catch {
    /* sonraki turda */
  }
}

async function loadOlder(conv) {
  if (!conv.hasMore || conv.loadingOlder) return;
  const real = conv.messages.filter((m) => !m._tmp);
  if (!real.length) return;
  conv.loadingOlder = true;
  const spin = conv.scroller.querySelector('.older');
  spin.classList.remove('hidden');
  try {
    const rows = await S.db.select('messages', `conversation_id=eq.${conv.id}&id=lt.${real[0].id}&select=*&order=id.desc&limit=${PAGE}`);
    if (S.conv !== conv) return;
    conv.hasMore = rows.length === PAGE;
    const before = conv.scroller.scrollHeight - conv.scroller.scrollTop;
    applyMessages(conv, rows.reverse(), { keep: false });
    conv.scroller.scrollTop = conv.scroller.scrollHeight - before;
  } catch {
    /* tekrar denenir */
  } finally {
    conv.loadingOlder = false;
    spin.classList.add('hidden');
  }
}

function applyMessages(conv, rows, { stick = false } = {}) {
  const wasBottom = stick || isNearBottom(conv.scroller);
  // gerçek satır geldiyse aynı geçici mesajı kaldır
  for (const r of rows) {
    if (r.sender_id === S.me.id) {
      const i = conv.messages.findIndex((m) => m._tmp && m._client === r._client);
      if (i >= 0) conv.messages.splice(i, 1);
    }
  }
  conv.messages = mergeMessages(conv.messages, rows);
  paintMessages(conv);
  if (wasBottom) conv.scroller.scrollTop = conv.scroller.scrollHeight;
}

function paintMessages(conv) {
  const rows = withDaySeparators(conv.messages);
  const nodes = [];
  if (!conv.messages.length) nodes.push(h('div', { class: 'day-sep' }, h('span', {}, 'Bir mesaj yazarak sohbete başla')));
  for (const r of rows) {
    if (r.type === 'day') {
      nodes.push(h('div', { class: 'day-sep' }, h('span', {}, r.label)));
      continue;
    }
    nodes.push(bubble(conv, r.m));
  }
  conv.list.replaceChildren(...nodes);
  ensureImageUrls(conv);
}

function bubble(conv, m) {
  const mine = m.sender_id === S.me.id;
  let status = null;
  if (mine) {
    if (m._failed) status = h('span', { class: 'st failed', title: 'Gönderilemedi' }, icon('error', 'ic xs'));
    else if (m._tmp) status = h('span', { class: 'st' }, icon('clock', 'ic xs'));
    else status = h('span', { class: `st ticks ${m.read_at ? 'read' : ''}`, title: m.read_at ? 'Okundu' : 'Gönderildi' }, icon(m.read_at ? 'checks' : 'check', 'ic xs'));
  }
  const meta = h('span', { class: 'meta' }, hhmm(new Date(m.created_at)), status);
  const parts = [];
  if (m.image_path || m._localUrl) {
    const { w, h: hh } = fitSize(m.image_w || 4, m.image_h || 3, 260);
    const img = h('img', { class: 'photo', alt: 'Fotoğraf', width: w, height: hh, 'data-path': m.image_path || '', style: { aspectRatio: `${m.image_w || 4} / ${m.image_h || 3}` } });
    const known = m._localUrl || cachedUrl(m.image_path);
    if (known) img.src = known;
    img.onclick = () => img.src && openViewer(img.src);
    parts.push(h('div', { class: 'photo-wrap' }, img));
  }
  if (m.body) parts.push(h('div', { class: 'text' }, m.body));
  const el = h('div', { class: `msg ${mine ? 'out' : 'in'} ${m.image_path && !m.body ? 'only-photo' : ''}` },
    h('div', { class: 'bubble' }, ...parts, meta));
  if (m._failed) {
    el.classList.add('failed');
    el.onclick = () => retry(conv, m);
  }
  return el;
}

// ---- Fotoğraf bağlantıları (gizli depo → imzalı, 1 saat) ----
function cachedUrl(path) {
  if (!path) return null;
  const c = S.urls.get(path);
  return c && c.exp > Date.now() ? c.url : null;
}

async function ensureImageUrls(conv) {
  const need = [...new Set(conv.messages.map((m) => m.image_path).filter((p) => p && !cachedUrl(p)))];
  if (!need.length) return;
  try {
    const map = await S.db.signedUrls('photos', need, 3600);
    for (const [p, u] of Object.entries(map)) S.urls.set(p, { url: u, exp: Date.now() + 3300_000 });
    if (S.conv !== conv) return;
    for (const img of conv.list.querySelectorAll('img.photo[data-path]')) {
      const u = cachedUrl(img.dataset.path);
      if (u && !img.src) img.src = u;
    }
  } catch {
    /* sonra tekrar */
  }
}

function openViewer(src) {
  const v = h('div', { id: 'viewer', onclick: () => v.remove() },
    h('button', { class: 'icon-btn close', 'aria-label': 'Kapat' }, icon('close')),
    h('img', { src, alt: 'Fotoğraf' }));
  document.body.append(v);
}

// ---- Gönderme ----
let tmpSeq = 0;
function addTemp(conv, fields) {
  const client = `c${Date.now()}_${++tmpSeq}`;
  const m = { id: `tmp-${client}`, _tmp: true, _client: client, sender_id: S.me.id, conversation_id: conv.id, created_at: new Date().toISOString(), read_at: null, ...fields };
  conv.messages = mergeMessages(conv.messages, [m]);
  paintMessages(conv);
  conv.scroller.scrollTop = conv.scroller.scrollHeight;
  return m;
}

async function sendText(conv, body, existing = null) {
  const m = existing || addTemp(conv, { body });
  m._failed = false;
  try {
    const rows = await S.db.insert('messages', { conversation_id: conv.id, body });
    const row = { ...rows[0], _client: m._client };
    if (S.conv === conv) applyMessages(conv, [row]);
    refreshChatsSoon();
  } catch (e) {
    m._failed = true;
    if (S.conv === conv) paintMessages(conv);
    toast(friendlyError(e));
  }
}

async function sendImage(conv, file) {
  let prepared;
  try {
    prepared = await prepareImage(file);
  } catch (e) {
    toast(friendlyError(e));
    return;
  }
  const localUrl = URL.createObjectURL(prepared.blob);
  const m = addTemp(conv, { _localUrl: localUrl, image_w: prepared.w, image_h: prepared.h, _blob: prepared.blob });
  await uploadAndSend(conv, m);
}

async function uploadAndSend(conv, m) {
  m._failed = false;
  try {
    if (!m._uploadedPath) {
      const name = `${conv.id}/${crypto.randomUUID ? crypto.randomUUID() : Date.now() + '_' + Math.random().toString(36).slice(2)}.jpg`;
      await S.db.upload('photos', name, m._blob, 'image/jpeg');
      m._uploadedPath = name;
      S.urls.set(name, { url: m._localUrl, exp: Date.now() + 3300_000 });
    }
    const rows = await S.db.insert('messages', { conversation_id: conv.id, image_path: m._uploadedPath, image_w: m.image_w, image_h: m.image_h });
    const row = { ...rows[0], _client: m._client };
    if (S.conv === conv) applyMessages(conv, [row]);
    refreshChatsSoon();
  } catch (e) {
    m._failed = true;
    if (S.conv === conv) paintMessages(conv);
    toast(friendlyError(e));
  }
}

function retry(conv, m) {
  if (!m._failed) return;
  if (m._blob) uploadAndSend(conv, m);
  else sendText(conv, m.body, m);
  paintMessages(conv);
}

// ---- Okundu ----
let readTimer = null;
function markReadSoon(conv) {
  clearTimeout(readTimer);
  readTimer = setTimeout(async () => {
    if (S.conv !== conv || document.hidden) return;
    const unread = conv.messages.some((m) => m.sender_id !== S.me.id && !m.read_at && !m._tmp);
    if (!unread) return;
    try {
      await S.db.rpc('mark_read', { conv: conv.id });
      const now = new Date().toISOString();
      conv.messages = conv.messages.map((m) => (m.sender_id !== S.me.id && !m.read_at ? { ...m, read_at: now } : m));
      const c = S.chats.find((x) => x.conversation_id === conv.id);
      if (c) c.unread = 0;
    } catch {
      /* sonra */
    }
  }, 400);
}

// ------------------------------------------------------------------
// Profil
// ------------------------------------------------------------------
function renderProfile() {
  const name = h('input', { type: 'text', value: S.me.display_name || '', maxLength: 40, placeholder: 'Görünen ad' });
  const save = h('button', { class: 'btn primary' }, 'Kaydet');
  save.onclick = async () => {
    const v = name.value.trim();
    save.disabled = true;
    try {
      const rows = await S.db.update('profiles', `id=eq.${S.me.id}`, { display_name: v });
      if (rows[0]) S.me = rows[0];
      toast('Kaydedildi');
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      save.disabled = false;
    }
  };
  const out = h('button', { class: 'btn danger' }, 'Çıkış yap');
  out.onclick = async () => {
    stopAll();
    await S.db.signOut();
    S.me = null;
    S.chats = [];
    S.urls.clear();
    navigate('auth', {}, { replace: true });
  };
  app.replaceChildren(
    h('div', { class: 'page' },
      header('Profil', { back: true }),
      h('main', { class: 'scroll pad' },
        h('div', { class: 'profile-head' }, avatar(S.me.display_name || S.me.username, false, 'lg'), h('div', { class: 'muted' }, '@' + S.me.username)),
        h('label', { class: 'field labeled' }, h('span', {}, 'Görünen ad'), name),
        save,
        h('p', { class: 'muted small' }, 'Arkadaşların seni kullanıcı adınla (@' + S.me.username + ') arayıp bulabilir.'),
        out,
      ),
    ),
  );
}

// ------------------------------------------------------------------
// Anlık güncellemeler + yedek yoklama
// ------------------------------------------------------------------
function startRealtime() {
  const rt = S.db.realtime;
  S.dbChannel = rt.channel('db', {
    postgres_changes: [
      { event: 'INSERT', schema: 'public', table: 'messages' },
      { event: 'UPDATE', schema: 'public', table: 'messages' },
    ],
  });
  S.dbChannel.onJoin((ok) => {
    S.rtJoined = ok;
    if (ok) refreshCurrent(); // kopukken kaçanlar
  });
  S.dbChannel.onChange((ch) => {
    const m = ch.record;
    if (!m || ch.table !== 'messages') return;
    const conv = S.conv;
    if (conv && m.conversation_id === conv.id) {
      applyMessages(conv, [m]);
      if (ch.type === 'INSERT' && m.sender_id !== S.me.id) markReadSoon(conv);
    }
    if (ch.type === 'INSERT') refreshChatsSoon();
    else if (S.screen?.name === 'chats') refreshChatsSoon();
  });
  S.presence = rt.channel('online', { presence: { key: S.me.id } });
  S.presence.onPresence((set) => {
    S.online = set;
    if (S.screen?.name === 'chats') paintChats();
    S.conv?.paintStatus?.();
  });
  S.presence.track({ online_at: new Date().toISOString() });
  rt.onStatus((up) => {
    if (!up) S.rtJoined = false;
  });
}

let chatsSoon = null;
function refreshChatsSoon() {
  clearTimeout(chatsSoon);
  chatsSoon = setTimeout(refreshChats, 300);
}

function refreshCurrent() {
  if (S.screen?.name === 'chats') refreshChats();
  if (S.conv) pollConversation(S.conv);
}

function startTimers() {
  stopTimers();
  S.db.rpc('touch_last_seen').catch(() => {});
  // Anlık bağlantı yoksa 4 sn'de bir yokla; varsa 30 sn'de bir emniyet turu
  let tick = 0;
  S.timers.push(setInterval(() => {
    if (document.hidden || !S.db.user) return;
    tick++;
    const healthy = S.rtJoined && S.db.realtime.connected;
    if (!healthy || tick % 8 === 0) refreshCurrent();
    if (tick % 15 === 0) S.db.rpc('touch_last_seen').catch(() => {});
  }, 4000));
}

function stopTimers() {
  for (const t of S.timers) clearInterval(t);
  S.timers = [];
}

function stopAll() {
  stopTimers();
  S.db.realtime.disconnect();
  S.dbChannel = null;
  S.presence = null;
  S.rtJoined = false;
  S.online = new Set();
}

document.addEventListener('visibilitychange', () => {
  if (!S.db?.user || !S.me) return;
  S.db.rpc('touch_last_seen').catch(() => {});
  if (document.hidden) S.presence?.untrack();
  else S.presence?.track({ online_at: new Date().toISOString() });
  if (!document.hidden) {
    S.db.realtime.connect();
    refreshCurrent();
    if (S.conv) markReadSoon(S.conv);
  }
});
