import './styles.css';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { createClient } from './lib/supa.js';
import { h, icon, toast } from './dom.js';
import { prepareImage } from './image.js';
import { enableZoom } from './zoom.js';
import { saveImageToDevice, askNotificationPermission, showNotification, playChime, unlockSound, setupPush } from './native.js';
import {
  normalizeUsername, usernameError, passwordError, serverPassword, usernameToEmail, listTime, lastSeenText,
  withDaySeparators, mergeMessages, friendlyError, hhmm, fitSize, AVATARS, avatarAt, randomAvatar, PASSWORD_MAX,
} from './util.js';

const APP_NAME = 'Suhbet Edek';
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
  conv: null, // açık sohbet
  urls: new Map(), // foto yolu → { url, exp }
  dbChannel: null,
  presence: null,
  rtJoined: false,
  timers: [],
  seenIds: new Set(), // bildirimi yapılmış mesajlar
};

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  renderSetupNeeded();
} else {
  S.db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  unlockSound();
  start();
}

function renderSetupNeeded() {
  app.replaceChildren(
    h('div', { class: 'center-page' },
      h('div', { class: 'logo' }, '💬'),
      h('h1', {}, APP_NAME),
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
    // ağ yok: eldeki oturumla devam
    const md = S.db.user.user_metadata || {};
    S.me = { id: S.db.user.id, username: md.username || '', display_name: md.display_name || '', avatar: +md.avatar || 0 };
    return true;
  }
}

function afterLogin() {
  startRealtime();
  startTimers();
  setupPush({
    onToken: (tok) => {
      S.pushToken = tok;
      S.db.rpc('save_push_token', { tok }).catch(() => {});
    },
    onOpen: (id) => { if (S.me) navigate('chat', { id }); },
  }).then((ok) => {
    S.pushOn = ok;
    if (!ok) askNotificationPermission();
  });
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
  const hadOverlay = closeOverlay();
  // Uygulama içinden kapatılan pencere (kapat düğmesi, menü seçimi): ekranı değiştirme
  if (pendingDismiss) {
    const done = pendingDismiss;
    pendingDismiss = null;
    done();
    return;
  }
  // Telefonun geri tuşu açık pencereyi kapattı: ekran aynı kalır
  if (hadOverlay) return;
  const st = e.state;
  if (!st) return;
  if (!S.db?.user && st.name !== 'auth') {
    history.replaceState({ name: 'auth', params: {} }, '');
    show({ name: 'auth', params: {} });
    return;
  }
  show(st);
});

function closeOverlay() {
  const o = document.querySelector('.overlay');
  if (!o) return false;
  o.remove();
  return true;
}

/** Pencere aç: geçmişe bir adım eklenir, böylece telefonun geri tuşu önce pencereyi kapatır */
function openOverlay(el) {
  document.querySelectorAll('.overlay').forEach((o) => o.remove());
  document.body.append(el);
  history.pushState({ ...S.screen, overlay: true }, '');
}

let pendingDismiss = null;
/** Pencereyi uygulama içinden kapat (kapat düğmesi, boşluğa dokunma). Kapanınca çözülür. */
function dismissOverlay() {
  return new Promise((resolve) => {
    if (history.state?.overlay) {
      pendingDismiss = resolve;
      history.back(); // popstate pencereyi kaldırır
    } else {
      closeOverlay();
      resolve();
    }
  });
}

/** Onay penceresi: true = onaylandı */
function confirmBox(title, text, okLabel) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (v) => {
      if (answered) return;
      answered = true;
      dismissOverlay().then(() => resolve(v));
    };
    const box = h('div', { class: 'overlay sheet-bg center', onclick: (e) => { if (e.target === box) answer(false); } },
      h('div', { class: 'dialog', role: 'alertdialog' },
        h('div', { class: 'dialog-title' }, title),
        h('div', { class: 'dialog-text' }, text),
        h('div', { class: 'dialog-buttons' },
          h('button', { class: 'dialog-btn', onclick: () => answer(false) }, 'Vazgeç'),
          h('button', { class: 'dialog-btn danger', onclick: () => answer(true) }, okLabel),
        ),
      ));
    openOverlay(box);
    // geri tuşuyla kapanırsa "vazgeç"
    const obs = new MutationObserver(() => {
      if (!box.isConnected) {
        obs.disconnect();
        if (!answered) { answered = true; resolve(false); }
      }
    });
    obs.observe(document.body, { childList: true });
  });
}

function show(st) {
  if (S.conv) leaveChat();
  S.screen = st;
  document.querySelectorAll('.overlay').forEach((o) => o.remove());
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
// Profil resimleri (uygulamanın 20 hayvanı)
// ------------------------------------------------------------------
function avatar(index, online = false, size = 'md') {
  const a = avatarAt(index);
  return h('div', { class: `avatar ${size}`, style: { background: a.bg }, title: a.name },
    h('span', { class: 'emoji' }, a.e), online ? h('span', { class: 'dot' }) : null);
}

function avatarPicker(selected, onPick) {
  const grid = h('div', { class: 'avatar-grid', role: 'listbox', 'aria-label': 'Profil resmi' });
  const paint = (sel) => {
    grid.replaceChildren(...AVATARS.map((a, i) => h('button', {
      type: 'button', class: `pick ${i === sel ? 'on' : ''}`, style: { background: a.bg }, 'aria-label': a.name,
      'aria-selected': String(i === sel), onclick: () => { paint(i); onPick(i); },
    }, a.e)));
  };
  paint(selected);
  return grid;
}

// ------------------------------------------------------------------
// Giriş / kayıt
// ------------------------------------------------------------------
function renderAuth() {
  let mode = 'login';
  let chosen = randomAvatar();
  const err = h('div', { class: 'form-error' });
  const user = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: false, placeholder: 'Kullanıcı adı', maxLength: 20 });
  const name = h('input', { type: 'text', autocomplete: 'nickname', placeholder: 'Görünen ad (ör. Ümit)', maxLength: 40 });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', placeholder: `Şifre (en fazla ${PASSWORD_MAX} karakter)`, maxLength: PASSWORD_MAX });
  const eye = h('button', { type: 'button', class: 'eye', 'aria-label': 'Şifreyi göster', onclick: () => { pass.type = pass.type === 'password' ? 'text' : 'password'; } }, '👁');
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Giriş yap');
  const signupOnly = h('div', { class: 'signup-only hidden' },
    h('label', { class: 'field' }, name),
    h('div', { class: 'pick-title' }, 'Profil resmini seç'),
    avatarPicker(chosen, (i) => { chosen = i; }),
  );
  const tabLogin = h('button', { type: 'button', class: 'tab active' }, 'Giriş');
  const tabSignup = h('button', { type: 'button', class: 'tab' }, 'Kayıt ol');
  const hint = h('p', { class: 'hint hidden' }, `Kullanıcı adı: harf, rakam ve _ (Türkçe harfler otomatik düzeltilir). Şifre serbest, en fazla ${PASSWORD_MAX} karakter.`);

  const setMode = (m) => {
    mode = m;
    tabLogin.classList.toggle('active', m === 'login');
    tabSignup.classList.toggle('active', m === 'signup');
    signupOnly.classList.toggle('hidden', m !== 'signup');
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
    h('label', { class: 'field pass' }, pass, eye),
    signupOnly,
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
    const email = usernameToEmail(u);
    try {
      if (mode === 'signup') {
        const free = await S.db.rpc('username_available', { uname: u });
        if (free === false) throw new Error('Bu kullanıcı adı alınmış');
        await S.db.signUp(email, serverPassword(pass.value), { username: u, display_name: name.value.trim() || u, avatar: chosen });
      } else {
        try {
          await S.db.signIn(email, serverPassword(pass.value));
        } catch (ex) {
          // İlk sürümde açılmış hesaplar: şifre olduğu gibi kaydedilmişti → girip yeni biçime çevir
          if (pass.value.length < 6 || !/invalid login/i.test(ex.message)) throw ex;
          await S.db.signIn(email, pass.value);
          S.db.updatePassword(serverPassword(pass.value)).catch(() => {});
        }
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
      h('div', { class: 'auth-top' }, h('div', { class: 'logo' }, '💬'), h('h1', {}, APP_NAME)),
      form,
    ),
  );
}

// ------------------------------------------------------------------
// Sohbet listesi
// ------------------------------------------------------------------
function header(title, { back = false, actions = [] } = {}) {
  return h('header', { class: 'topbar' },
    back ? h('button', { class: 'icon-btn', 'aria-label': 'Geri', onclick: () => history.back() }, icon('back')) : null,
    h('div', { class: 'title' }, h('div', { class: 'title-main' }, title)),
    ...actions,
  );
}

function renderChats() {
  const list = h('div', { class: 'chat-list' });
  const me = h('button', { class: 'icon-btn me-btn', 'aria-label': 'Profil', onclick: () => navigate('profile') }, avatar(S.me.avatar, false, 'xs'));
  app.replaceChildren(
    h('div', { class: 'page' },
      header(APP_NAME, { actions: [me] }),
      h('main', { class: 'scroll' }, list),
      h('button', { class: 'fab', 'aria-label': 'Yeni sohbet', onclick: () => navigate('new') }, icon('plus')),
    ),
  );
  paintChats();
  refreshChats();
}

function previewOf(c) {
  if (!c.last_message_id) return [h('span', { class: 'muted' }, c.cleared_at ? 'Mesaj yok' : 'Sohbet başladı')];
  if (c.last_deleted) return [h('span', { class: 'muted deleted' }, c.last_sender === S.me.id ? '🚫 Bu mesajı sildin' : '🚫 Bu mesaj silindi')];
  if (c.last_has_image) return [icon('photo', 'ic sm'), ' Fotoğraf'];
  return [c.last_body || ''];
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
    const mine = c.last_sender === S.me.id && c.last_message_id && !c.last_deleted;
    const tick = mine ? h('span', { class: `st ticks ${c.last_read_at ? 'read' : ''}` }, icon(c.last_read_at ? 'checks' : 'check', 'ic xs')) : null;
    const item = h('button', { class: 'chat-item', onclick: () => navigate('chat', { id: c.conversation_id }) },
      avatar(c.other_avatar, S.online.has(c.other_id)),
      h('div', { class: 'chat-mid' },
        h('div', { class: 'chat-row' }, h('span', { class: 'chat-name' }, name), h('span', { class: `chat-time ${c.unread ? 'hl' : ''}` }, listTime(c.last_created_at))),
        h('div', { class: 'chat-row' }, h('span', { class: 'chat-preview' }, tick, ...previewOf(c)), c.unread ? h('span', { class: 'badge' }, c.unread > 99 ? '99+' : c.unread) : null),
      ),
    );
    longPress(item, () => chatListActions(c, item));
    return item;
  }));
}

function chatListActions(c, item) {
  const name = c.other_display_name || c.other_username;
  item.classList.add('selected');
  sheet([{ label: '🗑️  Sohbeti sil', danger: true, run: () => deleteChat(c, name) }]);
  const obs = new MutationObserver(() => {
    if (!document.querySelector('.sheet-bg')) { item.classList.remove('selected'); obs.disconnect(); }
  });
  obs.observe(document.body, { childList: true });
}

async function deleteChat(c, name) {
  const ok = await confirmBox(`${name} ile sohbet silinsin mi?`, 'Sohbet ve mesajlar senden silinir, listeden kalkar. Karşı taraftan silinmez. Yeni mesaj gelirse sohbet geri gelir.', 'Sil');
  if (!ok) return;
  try {
    await S.db.rpc('clear_chat', { conv: c.conversation_id, remove: true });
    S.chats = S.chats.filter((x) => x.conversation_id !== c.conversation_id);
    paintChats();
    toast('Sohbet silindi');
  } catch (e) {
    toast(friendlyError(e));
  }
}

let chatsBusy = false;
async function refreshChats() {
  if (chatsBusy) return;
  chatsBusy = true;
  try {
    S.chats = (await S.db.rpc('my_chats')) || [];
    S.chatsLoaded = true;
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
      const rows = await S.db.select('profiles', `select=id,username,display_name,avatar,last_seen&username=ilike.*${encodeURIComponent(q)}*&id=neq.${S.me.id}&order=username&limit=30`);
      if (my !== seq) return;
      if (!rows.length) {
        results.replaceChildren(h('div', { class: 'empty muted' }, 'Kimse bulunamadı.'));
        return;
      }
      results.replaceChildren(...rows.map((p) => h('button', { class: 'chat-item', onclick: () => openWith(p) },
        avatar(p.avatar, S.online.has(p.id)),
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
const hiddenFilter = () => `hidden_by=not.cs.%7B${S.me.id}%7D`;
/** "Sohbeti sil" sonrası: o andan önceki mesajlar gösterilmez */
const clearedFilter = (conv) => (conv.clearedAt ? `&created_at=gt.${encodeURIComponent(conv.clearedAt)}` : '');

async function renderChat({ id, other }) {
  const known = S.chats.find((c) => c.conversation_id === id);
  const o = other || (known && { id: known.other_id, username: known.other_username, display_name: known.other_display_name, avatar: known.other_avatar, last_seen: known.other_last_seen });
  const conv = { id, other: o || null, messages: [], hasMore: true, loadingOlder: false, typingUntil: 0, clearedAt: known?.cleared_at || null };
  S.conv = conv;

  const sub = h('span', { class: 'status' }, '');
  const titleName = h('span', {}, o ? o.display_name || o.username : '…');
  const headAvatar = h('div', { class: 'head-avatar' }, o ? avatar(o.avatar, false, 'sm') : null);
  const msgs = h('div', { class: 'messages' });
  const scroller = h('main', { class: 'scroll chat-bg' }, h('div', { class: 'older hidden' }, h('div', { class: 'spinner sm' })), msgs);
  const text = h('textarea', { rows: 1, placeholder: 'Mesaj', maxLength: 4000, enterkeyhint: 'send' });
  const file = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  const sendBtn = h('button', { class: 'send-btn', 'aria-label': 'Gönder' }, icon('send'));
  const attachBtn = h('button', { class: 'icon-btn attach', 'aria-label': 'Fotoğraf gönder', onclick: () => file.click() }, icon('attach'));

  app.replaceChildren(
    h('div', { class: 'page chat-page' },
      h('header', { class: 'topbar chat-top' },
        h('button', { class: 'icon-btn', 'aria-label': 'Geri', onclick: () => history.back() }, icon('back')),
        headAvatar,
        h('div', { class: 'title' }, h('div', { class: 'title-main' }, titleName), h('div', { class: 'title-sub' }, sub)),
        h('button', { class: 'icon-btn', 'aria-label': 'Sohbet menüsü', onclick: () => chatMenu(conv) }, icon('more')),
      ),
      scroller,
      h('footer', { class: 'composer' }, attachBtn, h('div', { class: 'input-wrap' }, text), sendBtn, file),
    ),
  );

  conv.paintStatus = () => {
    if (!conv.other) return;
    const typing = conv.typingUntil > Date.now();
    sub.textContent = typing ? 'yazıyor…' : lastSeenText(S.online.has(conv.other.id), conv.other.last_seen);
    sub.classList.toggle('typing', typing);
  };
  conv.scroller = scroller;
  conv.list = msgs;

  // "Yazıyor" kanalı (kaydedilmeyen anlık yayın)
  conv.typingCh = S.db.realtime.channel(`typing:${id}`, {});
  conv.typingCh.onBroadcast('typing', (p) => {
    if (S.conv !== conv || p.u === S.me.id) return;
    conv.typingUntil = p.stop ? 0 : Date.now() + 4000;
    conv.paintStatus();
    clearTimeout(conv.typingTimer);
    conv.typingTimer = setTimeout(() => conv.paintStatus(), 4100);
  });
  let lastTyping = 0;
  const sendTyping = (stop = false) => {
    const now = Date.now();
    if (!stop && now - lastTyping < 2500) return;
    lastTyping = stop ? 0 : now;
    conv.typingCh.send('typing', { u: S.me.id, stop });
  };

  // Karşı tarafı bilmiyorsak getir
  if (!conv.other) {
    try {
      const rows = await S.db.select('conversations', `id=eq.${id}&select=user_a,user_b`);
      const otherId = rows[0] && (rows[0].user_a === S.me.id ? rows[0].user_b : rows[0].user_a);
      const ps = otherId ? await S.db.select('profiles', `id=eq.${otherId}&select=id,username,display_name,avatar,last_seen`) : [];
      conv.other = ps[0] || null;
      if (conv.other && S.conv === conv) {
        titleName.textContent = conv.other.display_name || conv.other.username;
        headAvatar.replaceChildren(avatar(conv.other.avatar, false, 'sm'));
      }
    } catch {
      /* başlık boş kalır */
    }
  } else {
    S.db.select('profiles', `id=eq.${conv.other.id}&select=last_seen,avatar,display_name`).then((r) => {
      if (r[0] && S.conv === conv) {
        Object.assign(conv.other, r[0]);
        headAvatar.replaceChildren(avatar(conv.other.avatar, false, 'sm'));
        conv.paintStatus();
      }
    }).catch(() => {});
  }
  conv.paintStatus();

  const autosize = () => {
    text.style.height = 'auto';
    text.style.height = Math.min(text.scrollHeight, 140) + 'px';
  };
  text.addEventListener('input', () => {
    autosize();
    if (text.value.trim()) sendTyping();
  });
  sendBtn.onclick = () => {
    const body = text.value.trim();
    if (!body) return;
    text.value = '';
    autosize();
    sendTyping(true);
    sendText(conv, body);
    text.focus();
  };
  file.onchange = () => {
    const f = file.files?.[0];
    file.value = '';
    if (f) sendImage(conv, f);
  };
  scroller.addEventListener('scroll', () => {
    if (scroller.scrollTop < 80) loadOlder(conv);
  });

  goOnline();
  if (!known) {
    try {
      const st = await S.db.select('chat_state', `conversation_id=eq.${id}&select=cleared_at`);
      conv.clearedAt = st[0]?.cleared_at || null;
    } catch {
      /* yoksa hepsi görünür */
    }
  }
  await loadLatest(conv, true);
}

/** Sohbet ekranındayken: çevrimiçi görün, son görülmeyi güncelle */
function goOnline() {
  if (document.hidden || !S.conv) return;
  S.presence?.track({ online_at: new Date().toISOString() });
  S.db.rpc('touch_last_seen').catch(() => {});
}

/** Sohbetten çıkınca / uygulama arka plana geçince: çevrimdışı, son görülme = şimdi */
function goOffline() {
  S.presence?.untrack();
  S.db?.rpc('touch_last_seen').catch(() => {});
}

function chatMenu(conv) {
  sheet([{ label: '🗑️  Sohbeti sil', danger: true, run: () => clearChat(conv) }]);
}

async function clearChat(conv) {
  const ok = await confirmBox('Sohbet silinsin mi?', 'Bu sohbetteki tüm mesajlar senden silinir. Sohbet listede kalır, karşı taraftan silinmez.', 'Sil');
  if (!ok || S.conv !== conv) return;
  try {
    const t = await S.db.rpc('clear_chat', { conv: conv.id, remove: false });
    conv.clearedAt = t || new Date().toISOString();
    conv.messages = conv.messages.filter((m) => m._tmp);
    conv.hasMore = false;
    paintMessages(conv);
    const c = S.chats.find((x) => x.conversation_id === conv.id);
    if (c) Object.assign(c, { cleared_at: conv.clearedAt, last_message_id: null, unread: 0 });
    refreshChatsSoon();
    toast('Sohbet silindi');
  } catch (e) {
    toast(friendlyError(e));
  }
}

function leaveChat() {
  const conv = S.conv;
  S.conv = null;
  if (conv) goOffline();
  if (conv?.typingCh) S.db.realtime.removeChannel(conv.typingCh);
  clearTimeout(conv?.typingTimer);
}

function isNearBottom(sc) {
  return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
}

async function loadLatest(conv, first = false) {
  try {
    const rows = await S.db.select('messages', `conversation_id=eq.${conv.id}&${hiddenFilter()}${clearedFilter(conv)}&select=*&order=id.desc&limit=${PAGE}`);
    if (S.conv !== conv) return;
    if (first) conv.hasMore = rows.length === PAGE;
    for (const r of rows) S.seenIds.add(r.id);
    applyMessages(conv, rows.reverse(), { stick: first });
    markReadSoon(conv);
  } catch (e) {
    if (first) toast(friendlyError(e));
  }
}

/** Yedek yoklama: yeni mesajlar + görünen mesajların okundu/silindi durumu */
async function pollConversation(conv) {
  const real = conv.messages.filter((m) => !m._tmp);
  const lastId = real.length ? real[real.length - 1].id : 0;
  try {
    const fresh = await S.db.select('messages', `conversation_id=eq.${conv.id}&id=gt.${lastId}&${hiddenFilter()}${clearedFilter(conv)}&select=*&order=id.asc&limit=100`);
    let state = [];
    if (real.length) state = await S.db.select('messages', `conversation_id=eq.${conv.id}&id=gte.${real[0].id}&id=lte.${lastId}&select=id,read_at,deleted,body,image_path,image_w,image_h,hidden_by&limit=300`);
    if (S.conv !== conv) return;
    const changed = state.filter((s) => {
      const m = conv.messages.find((x) => x.id === s.id);
      return m && (m.read_at !== s.read_at || m.deleted !== s.deleted || (s.hidden_by || []).includes(S.me.id));
    });
    if (fresh.length || changed.length) applyMessages(conv, [...fresh, ...changed]);
    const incoming = fresh.filter((m) => m.sender_id !== S.me.id);
    if (incoming.length) {
      markReadSoon(conv);
      for (const m of incoming) notifyIncoming(m);
    }
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
    const rows = await S.db.select('messages', `conversation_id=eq.${conv.id}&id=lt.${real[0].id}&${hiddenFilter()}${clearedFilter(conv)}&select=*&order=id.desc&limit=${PAGE}`);
    if (S.conv !== conv) return;
    conv.hasMore = rows.length === PAGE;
    for (const r of rows) S.seenIds.add(r.id);
    const before = conv.scroller.scrollHeight - conv.scroller.scrollTop;
    applyMessages(conv, rows.reverse());
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
  for (const r of rows) {
    if (r.sender_id === S.me.id) {
      const i = conv.messages.findIndex((m) => m._tmp && m._client === r._client);
      if (i >= 0) conv.messages.splice(i, 1);
    }
  }
  if (conv.clearedAt) {
    const cut = Date.parse(conv.clearedAt);
    rows = rows.filter((r) => !r.created_at || Date.parse(r.created_at) > cut || r._client);
  }
  // Benden silinenler kaybolur; karşı tarafın herkesten sildiği mesaj bende iz bırakmaz
  // (kendi sildiğim mesajın yerinde "Bu mesajı sildin" kalır)
  const hiddenNow = new Set(rows.filter((r) => (r.deleted && r.sender_id !== S.me.id) || (r.hidden_by || []).includes(S.me.id)).map((r) => r.id));
  conv.messages = mergeMessages(conv.messages, rows.filter((r) => !hiddenNow.has(r.id))).filter((m) => !hiddenNow.has(m.id));
  paintMessages(conv);
  if (wasBottom) conv.scroller.scrollTop = conv.scroller.scrollHeight;
}

function paintMessages(conv) {
  const rows = withDaySeparators(conv.messages);
  const nodes = [];
  if (!conv.messages.length) nodes.push(h('div', { class: 'day-sep' }, h('span', {}, 'Bir mesaj yazarak sohbete başla')));
  // "Görüldü": karşı tarafın okuduğu son mesajımın altında
  const mineReal = conv.messages.filter((m) => m.sender_id === S.me.id && !m._tmp && !m.deleted);
  const lastMine = mineReal[mineReal.length - 1];
  const lastAll = conv.messages[conv.messages.length - 1];
  for (const r of rows) {
    if (r.type === 'day') {
      nodes.push(h('div', { class: 'day-sep' }, h('span', {}, r.label)));
      continue;
    }
    nodes.push(bubble(conv, r.m));
    if (lastMine && r.m === lastMine && lastMine.read_at && lastAll === lastMine) {
      nodes.push(h('div', { class: 'seen' }, `Görüldü ${hhmm(new Date(lastMine.read_at))}`));
    }
  }
  conv.list.replaceChildren(...nodes);
  ensureImageUrls(conv);
}

function bubble(conv, m) {
  const mine = m.sender_id === S.me.id;
  let status = null;
  if (mine && !m.deleted) {
    if (m._failed) status = h('span', { class: 'st failed', title: 'Gönderilemedi' }, icon('error', 'ic xs'));
    else if (m._tmp) status = h('span', { class: 'st' }, icon('clock', 'ic xs'));
    else status = h('span', { class: `st ticks ${m.read_at ? 'read' : ''}`, title: m.read_at ? 'Görüldü' : 'Gönderildi' }, icon(m.read_at ? 'checks' : 'check', 'ic xs'));
  }
  const meta = h('span', { class: 'meta' }, hhmm(new Date(m.created_at)), status);
  const parts = [];
  if (m.deleted) {
    parts.push(h('div', { class: 'text deleted' }, mine ? '🚫 Bu mesajı sildin' : '🚫 Bu mesaj silindi'));
  } else {
    if (m.image_path || m._localUrl) {
      const { w, h: hh } = fitSize(m.image_w || 4, m.image_h || 3, 260);
      const img = h('img', { class: 'photo', alt: 'Fotoğraf', width: w, height: hh, 'data-path': m.image_path || '', style: { aspectRatio: `${m.image_w || 4} / ${m.image_h || 3}` } });
      const known = m._localUrl || cachedUrl(m.image_path);
      if (known) img.src = known;
      img.onclick = () => img.src && openViewer(img.src, m);
      parts.push(h('div', { class: 'photo-wrap' }, img));
    }
    if (m.body) parts.push(h('div', { class: 'text' }, m.body));
  }
  const el = h('div', { class: `msg ${mine ? 'out' : 'in'} ${m.image_path && !m.body && !m.deleted ? 'only-photo' : ''}` },
    h('div', { class: 'bubble' }, ...parts, meta));
  if (m._failed) {
    el.classList.add('failed');
    el.onclick = () => retry(conv, m);
  } else if (!m._tmp) {
    longPress(el.firstChild, () => openActions(conv, m, el));
  }
  return el;
}

/** Uzun basma (≈0,45 sn) ya da sağ tık */
function longPress(el, fn) {
  let t = null, sx = 0, sy = 0, fired = false;
  const cancel = () => { clearTimeout(t); t = null; };
  el.addEventListener('pointerdown', (e) => {
    sx = e.clientX; sy = e.clientY;
    fired = false;
    cancel();
    t = setTimeout(() => { t = null; fired = true; navigator.vibrate?.(15); fn(); }, 450);
  });
  // uzun basmadan sonra parmak kalkınca oluşan tıklama, sohbeti/fotoğrafı açmasın
  el.addEventListener('click', (e) => {
    if (fired) { e.preventDefault(); e.stopPropagation(); fired = false; }
  }, true);
  el.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel(); });
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!fired) { cancel(); fired = true; fn(); } });
}

// ---- İşlem menüsü: indir, kopyala, benden sil, herkesten sil ----
function sheet(items) {
  const box = h('div', { class: 'overlay sheet-bg', onclick: (e) => { if (e.target === box) dismissOverlay(); } },
    h('div', { class: 'sheet', role: 'menu' },
      ...items.map((it) => h('button', { class: `sheet-item ${it.danger ? 'danger' : ''}`, role: 'menuitem', onclick: () => { dismissOverlay().then(it.run); } }, it.label)),
      h('button', { class: 'sheet-item cancel', onclick: () => dismissOverlay() }, 'Vazgeç'),
    ));
  openOverlay(box);
}

function openActions(conv, m, el) {
  const mine = m.sender_id === S.me.id;
  const items = [];
  if (!m.deleted && m.image_path) items.push({ label: '⬇️  Cihaza indir', run: () => downloadPhoto(m) });
  if (!m.deleted && m.body) items.push({ label: '📋  Kopyala', run: () => copyText(m.body) });
  items.push({ label: '🗑️  Benden sil', run: () => deleteMessage(conv, m, false) });
  if (mine && !m.deleted) items.push({ label: '🗑️  Herkesten sil', danger: true, run: () => deleteMessage(conv, m, true) });
  el.classList.add('selected');
  sheet(items);
  const obs = new MutationObserver(() => {
    if (!document.querySelector('.sheet-bg')) {
      el.classList.remove('selected');
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true });
}

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    toast('Kopyalandı');
  } catch {
    toast('Kopyalanamadı');
  }
}

async function deleteMessage(conv, m, forEveryone) {
  try {
    const path = await S.db.rpc('delete_message', { msg: m.id, for_everyone: forEveryone });
    if (forEveryone) {
      if (path) S.db.remove('photos', [path]).catch(() => {});
      if (S.conv === conv) applyMessages(conv, [{ ...m, deleted: true, body: null, image_path: null, image_w: null, image_h: null }]);
    } else if (S.conv === conv) {
      conv.messages = conv.messages.filter((x) => x.id !== m.id);
      paintMessages(conv);
    }
    refreshChatsSoon();
  } catch (e) {
    toast(friendlyError(e));
  }
}

async function downloadPhoto(m) {
  try {
    let url = m._localUrl || cachedUrl(m.image_path);
    if (!url && m.image_path) {
      const map = await S.db.signedUrls('photos', [m.image_path], 3600);
      url = map[m.image_path];
    }
    if (!url) throw new Error('Fotoğraf bulunamadı');
    const blob = await (await fetch(url)).blob();
    const where = await saveImageToDevice(blob, `suhbet_${m.id}_${Date.now()}.jpg`);
    toast(where === 'gallery' ? 'Galeriye kaydedildi (Resimler › Suhbet Edek)' : 'İndirildi');
  } catch (e) {
    toast('İndirilemedi: ' + friendlyError(e));
  }
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

function openViewer(src, m) {
  const img = h('img', { src, alt: 'Fotoğraf' });
  const v = h('div', { class: 'overlay viewer', onclick: (e) => { if (e.target === v && !(+img.dataset.scale > 1)) dismissOverlay(); } },
    h('div', { class: 'viewer-bar' },
      h('button', { class: 'icon-btn', 'aria-label': 'Kapat', onclick: (e) => { e.stopPropagation(); dismissOverlay(); } }, icon('close')),
      m.image_path ? h('button', { class: 'viewer-dl', onclick: () => downloadPhoto(m) }, '⬇️ Cihaza indir') : null,
    ),
    img);
  openOverlay(v);
  enableZoom(img, v);
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
    S.seenIds.add(rows[0].id);
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
    S.seenIds.add(rows[0].id);
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
// Bildirim: zil sesi (uygulama açıkken) ya da sistem bildirimi (arka planda)
// ------------------------------------------------------------------
async function notifyIncoming(m) {
  if (!m || m.sender_id === S.me?.id || S.seenIds.has(m.id) || m.deleted) return;
  S.seenIds.add(m.id);
  let c = S.chats.find((x) => x.conversation_id === m.conversation_id);
  if (!c) {
    await refreshChats();
    c = S.chats.find((x) => x.conversation_id === m.conversation_id);
  }
  const who = c ? c.other_display_name || c.other_username : 'Yeni mesaj';
  const text = m.image_path ? '📷 Fotoğraf' : m.body || '';
  if (document.hidden) {
    // Firebase açıksa bildirimi sunucu gönderir (çift bildirim olmasın)
    if (!S.pushOn) showNotification(who, text, m.conversation_id);
    return;
  }
  playChime();
  const inThisChat = S.conv?.id === m.conversation_id;
  if (!inThisChat) banner(c?.other_avatar ?? 0, who, text, () => navigate('chat', { id: m.conversation_id }));
}

function banner(av, title, text, onTap) {
  document.querySelector('.banner')?.remove();
  const b = h('button', { class: 'banner', onclick: () => { b.remove(); onTap(); } },
    avatar(av, false, 'sm'),
    h('div', { class: 'banner-txt' }, h('b', {}, title), h('span', {}, text)));
  document.body.append(b);
  setTimeout(() => b.classList.add('show'), 10);
  setTimeout(() => { b.classList.remove('show'); setTimeout(() => b.remove(), 300); }, 4000);
}

// ------------------------------------------------------------------
// Profil
// ------------------------------------------------------------------
function renderProfile() {
  const name = h('input', { type: 'text', value: S.me.display_name || '', maxLength: 40, placeholder: 'Görünen ad' });
  const head = h('div', { class: 'profile-head' });
  const paintHead = () => head.replaceChildren(avatar(S.me.avatar, false, 'lg'), h('div', { class: 'muted' }, '@' + S.me.username));
  paintHead();
  const save = h('button', { class: 'btn primary' }, 'Kaydet');
  save.onclick = async () => {
    save.disabled = true;
    try {
      const rows = await S.db.update('profiles', `id=eq.${S.me.id}`, { display_name: name.value.trim() });
      if (rows[0]) S.me = rows[0];
      toast('Kaydedildi');
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      save.disabled = false;
    }
  };
  const picker = avatarPicker(S.me.avatar, async (i) => {
    const old = S.me.avatar;
    S.me.avatar = i;
    paintHead();
    try {
      const rows = await S.db.update('profiles', `id=eq.${S.me.id}`, { avatar: i });
      if (rows[0]) S.me = rows[0];
    } catch (e) {
      S.me.avatar = old;
      paintHead();
      toast(friendlyError(e));
    }
  });
  const out = h('button', { class: 'btn danger' }, 'Çıkış yap');
  out.onclick = async () => {
    if (S.pushToken) await S.db.rpc('delete_push_token', { tok: S.pushToken }).catch(() => {});
    S.pushToken = null;
    stopAll();
    await S.db.signOut();
    S.me = null;
    S.chats = [];
    S.chatsLoaded = false;
    S.urls.clear();
    navigate('auth', {}, { replace: true });
  };
  app.replaceChildren(
    h('div', { class: 'page' },
      header('Profil', { back: true }),
      h('main', { class: 'scroll pad' },
        head,
        h('div', { class: 'pick-title' }, 'Profil resmi'),
        picker,
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
    if (ok) refreshCurrent();
  });
  S.dbChannel.onChange((ch) => {
    const m = ch.record;
    if (!m || ch.table !== 'messages') return;
    const conv = S.conv;
    const hiddenForMe = (m.hidden_by || []).includes(S.me.id);
    if (conv && m.conversation_id === conv.id) {
      applyMessages(conv, [m]);
      if (ch.type === 'INSERT' && m.sender_id !== S.me.id) markReadSoon(conv);
    }
    if (ch.type === 'INSERT' && !hiddenForMe) notifyIncoming(m);
    refreshChatsSoon();
  });
  S.presence = rt.channel('online', { presence: { key: S.me.id } });
  S.presence.onPresence((set) => {
    S.online = set;
    if (S.screen?.name === 'chats') paintChats();
    S.conv?.paintStatus?.();
  });
  // Çevrimiçi yalnızca bir sohbetin içindeyken görünür (bkz. goOnline)
  rt.onStatus((up) => {
    if (!up) S.rtJoined = false;
  });
}

let chatsSoon = null;
function refreshChatsSoon() {
  clearTimeout(chatsSoon);
  chatsSoon = setTimeout(refreshChats, 300);
}

/** Yoklama: liste için okunmamış artışında zil */
async function pollChats() {
  const before = new Map(S.chats.map((c) => [c.conversation_id, c.last_message_id]));
  const loadedBefore = S.chatsLoaded;
  await refreshChats();
  if (!loadedBefore) return;
  for (const c of S.chats) {
    const prev = before.get(c.conversation_id);
    if (c.last_message_id && c.last_message_id !== prev && c.last_sender !== S.me.id) {
      notifyIncoming({ id: c.last_message_id, conversation_id: c.conversation_id, sender_id: c.last_sender, body: c.last_body, image_path: c.last_has_image ? 'x' : null, deleted: c.last_deleted });
    }
  }
}

function refreshCurrent() {
  if (S.conv) pollConversation(S.conv);
  else pollChats();
}

function startTimers() {
  stopTimers();
  let tick = 0;
  S.timers.push(setInterval(() => {
    if (!S.db.user) return;
    tick++;
    const healthy = S.rtJoined && S.db.realtime.connected;
    if (!healthy || tick % 8 === 0) refreshCurrent();
    if (S.conv && !document.hidden && tick % 15 === 0) S.db.rpc('touch_last_seen').catch(() => {});
  }, 4000));
}

function stopTimers() {
  for (const t of S.timers) clearInterval(t);
  S.timers = [];
}

function stopAll() {
  stopTimers();
  leaveChat();
  S.db.realtime.disconnect();
  S.dbChannel = null;
  S.presence = null;
  S.rtJoined = false;
  S.online = new Set();
}

document.addEventListener('visibilitychange', () => {
  if (!S.db?.user || !S.me) return;
  if (document.hidden) {
    if (S.conv) goOffline();
  } else {
    goOnline();
  }
  if (!document.hidden) {
    S.db.realtime.connect();
    refreshCurrent();
    if (S.conv) markReadSoon(S.conv);
  }
});
