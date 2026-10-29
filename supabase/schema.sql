-- Mesaj uygulaması veritabanı şeması
-- Supabase panelinde: SQL Editor → New query → bu dosyanın tamamını yapıştır → Run
-- Tekrar çalıştırmak güvenlidir.

create extension if not exists pgcrypto;

-- ============================================================
-- Profiller (her kullanıcı için bir satır, kayıtta otomatik oluşur)
-- ============================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null default '' check (char_length(display_name) <= 40),
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiller herkese açık" on public.profiles;
create policy "profiller herkese açık" on public.profiles
  for select to authenticated using (true);

drop policy if exists "kendi profilini düzenle" on public.profiles;
create policy "kendi profilini düzenle" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  uname text := lower(coalesce(new.raw_user_meta_data ->> 'username', ''));
begin
  if uname !~ '^[a-z0-9_]{3,20}$' then
    uname := 'u_' || substr(replace(new.id::text, '-', ''), 1, 12);
  end if;
  insert into public.profiles (id, username, display_name)
  values (new.id, uname, left(coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), uname), 40))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- Kayıttan önce kullanıcı adı boş mu? (giriş yapmamış kişi de sorabilir)
create or replace function public.username_available(uname text)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.profiles where username = lower(uname));
$$;
grant execute on function public.username_available(text) to anon, authenticated;

-- ============================================================
-- Sohbetler (iki kişi arasında tek bir sohbet)
-- ============================================================
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_a uuid not null references public.profiles (id) on delete cascade,
  user_b uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  check (user_a < user_b),
  unique (user_a, user_b)
);
create index if not exists conversations_user_b on public.conversations (user_b);

alter table public.conversations enable row level security;

drop policy if exists "kendi sohbetlerini gör" on public.conversations;
create policy "kendi sohbetlerini gör" on public.conversations
  for select to authenticated using (auth.uid() in (user_a, user_b));

create or replace function public.is_participant(conv uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.conversations c
    where c.id = conv and auth.uid() in (c.user_a, c.user_b)
  );
$$;

-- Biriyle sohbet aç (varsa olanı döndürür)
create or replace function public.open_conversation(other uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  a uuid; b uuid; cid uuid;
begin
  if me is null then raise exception 'giriş gerekli'; end if;
  if other is null or other = me then raise exception 'geçersiz kişi'; end if;
  if not exists (select 1 from public.profiles where id = other) then raise exception 'kişi bulunamadı'; end if;
  a := least(me, other); b := greatest(me, other);
  insert into public.conversations (user_a, user_b) values (a, b) on conflict (user_a, user_b) do nothing;
  select id into cid from public.conversations where user_a = a and user_b = b;
  return cid;
end $$;
grant execute on function public.open_conversation(uuid) to authenticated;

-- ============================================================
-- Mesajlar
-- ============================================================
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body text check (body is null or char_length(body) <= 4000),
  image_path text check (image_path is null or char_length(image_path) <= 300),
  image_w int,
  image_h int,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  check (coalesce(nullif(btrim(body), ''), image_path) is not null)
);
create index if not exists messages_conv_id on public.messages (conversation_id, id desc);
create index if not exists messages_unread on public.messages (conversation_id) where read_at is null;

alter table public.messages enable row level security;

drop policy if exists "sohbetin mesajlarını gör" on public.messages;
create policy "sohbetin mesajlarını gör" on public.messages
  for select to authenticated using (public.is_participant(conversation_id));

drop policy if exists "kendi adına mesaj gönder" on public.messages;
create policy "kendi adına mesaj gönder" on public.messages
  for insert to authenticated
  with check (
    sender_id = auth.uid()
    and read_at is null
    and public.is_participant(conversation_id)
    and (image_path is null or image_path like conversation_id::text || '/%')
  );
-- Güncelleme / silme yok: okundu bilgisi yalnızca mark_read ile değişir.

create or replace function public.touch_conversation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set last_message_at = new.created_at where id = new.conversation_id;
  return new;
end $$;
drop trigger if exists messages_touch on public.messages;
create trigger messages_touch after insert on public.messages
  for each row execute function public.touch_conversation();

-- Sohbeti okundu yap (karşı tarafın okunmamış mesajları)
create or replace function public.mark_read(conv uuid)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_participant(conv) then raise exception 'izin yok'; end if;
  update public.messages set read_at = now()
   where conversation_id = conv and sender_id <> auth.uid() and read_at is null;
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function public.mark_read(uuid) to authenticated;

-- Son görülme
create or replace function public.touch_last_seen()
returns void language sql security definer set search_path = public as $$
  update public.profiles set last_seen = now() where id = auth.uid();
$$;
grant execute on function public.touch_last_seen() to authenticated;

-- Sohbet listesi: karşı taraf, son mesaj, okunmamış sayısı
create or replace function public.my_chats()
returns table (
  conversation_id uuid,
  other_id uuid,
  other_username text,
  other_display_name text,
  other_last_seen timestamptz,
  last_message_id bigint,
  last_body text,
  last_has_image boolean,
  last_sender uuid,
  last_created_at timestamptz,
  last_read_at timestamptz,
  unread int
) language sql stable security invoker set search_path = public as $$
  select c.id,
         p.id, p.username, p.display_name, p.last_seen,
         m.id, m.body, m.image_path is not null, m.sender_id, coalesce(m.created_at, c.created_at), m.read_at,
         (select count(*)::int from public.messages u
           where u.conversation_id = c.id and u.sender_id <> auth.uid() and u.read_at is null)
    from public.conversations c
    join public.profiles p on p.id = case when c.user_a = auth.uid() then c.user_b else c.user_a end
    left join lateral (
      select * from public.messages mm where mm.conversation_id = c.id order by mm.id desc limit 1
    ) m on true
   where auth.uid() in (c.user_a, c.user_b)
   order by coalesce(m.created_at, c.created_at) desc;
$$;
grant execute on function public.my_chats() to authenticated;

-- ============================================================
-- Anlık güncellemeler (yeni mesaj, okundu bilgisi)
-- ============================================================
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages') then
    execute 'alter publication supabase_realtime add table public.messages';
  end if;
end $$;

-- ============================================================
-- Fotoğraflar (gizli depo: yalnızca sohbetin iki tarafı görebilir)
-- Dosya yolu: <sohbet_id>/<rastgele>.jpg
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.photo_conversation(object_name text)
returns uuid language plpgsql immutable as $$
begin
  return split_part(object_name, '/', 1)::uuid;
exception when others then
  return null;
end $$;

drop policy if exists "sohbet fotoğrafı yükle" on storage.objects;
create policy "sohbet fotoğrafı yükle" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos' and public.is_participant(public.photo_conversation(name)));

drop policy if exists "sohbet fotoğrafını gör" on storage.objects;
create policy "sohbet fotoğrafını gör" on storage.objects
  for select to authenticated
  using (bucket_id = 'photos' and public.is_participant(public.photo_conversation(name)));
