-- Güncelleme 2: hayvan profil resimleri, benden sil / herkesten sil
-- Supabase → SQL Editor → New query → tamamını yapıştır → Run. Tekrar çalıştırmak güvenlidir.

-- Profil resmi: uygulamanın 20 hayvan resminden biri (0-19)
alter table public.profiles add column if not exists avatar smallint not null default 0;
alter table public.profiles drop constraint if exists profiles_avatar_check;
alter table public.profiles add constraint profiles_avatar_check check (avatar between 0 and 19);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  uname text := lower(coalesce(new.raw_user_meta_data ->> 'username', ''));
  av smallint := 0;
begin
  if uname !~ '^[a-z0-9_]{3,20}$' then
    uname := 'u_' || substr(replace(new.id::text, '-', ''), 1, 12);
  end if;
  if coalesce(new.raw_user_meta_data ->> 'avatar', '') ~ '^[0-9]{1,2}$' then
    av := least(19, (new.raw_user_meta_data ->> 'avatar')::int);
  end if;
  insert into public.profiles (id, username, display_name, avatar)
  values (new.id, uname, left(coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), uname), 40), av)
  on conflict (id) do nothing;
  return new;
end $$;

-- Mesaj silme: herkesten silinen mesaj "silindi" olarak kalır, benden silinen yalnızca bende gizlenir
alter table public.messages add column if not exists deleted boolean not null default false;
alter table public.messages add column if not exists hidden_by uuid[] not null default '{}';
alter table public.messages drop constraint if exists messages_check;
alter table public.messages drop constraint if exists messages_content_check;
alter table public.messages add constraint messages_content_check
  check (deleted or coalesce(nullif(btrim(body), ''), image_path) is not null);

drop policy if exists "kendi adına mesaj gönder" on public.messages;
create policy "kendi adına mesaj gönder" on public.messages
  for insert to authenticated
  with check (
    sender_id = auth.uid()
    and read_at is null
    and not deleted
    and hidden_by = '{}'
    and public.is_participant(conversation_id)
    and (image_path is null or image_path like conversation_id::text || '/%')
  );

-- Döndürür: herkesten silinen fotoğrafın dosya yolu (uygulama dosyayı da siler)
create or replace function public.delete_message(msg bigint, for_everyone boolean)
returns text language plpgsql security definer set search_path = public as $$
declare
  m public.messages;
begin
  select * into m from public.messages where id = msg;
  if m.id is null or not public.is_participant(m.conversation_id) then raise exception 'izin yok'; end if;
  if for_everyone then
    if m.sender_id <> auth.uid() then raise exception 'yalnızca gönderen herkesten silebilir'; end if;
    update public.messages
       set deleted = true, body = null, image_path = null, image_w = null, image_h = null
     where id = msg;
    return m.image_path;
  end if;
  update public.messages set hidden_by = array_append(hidden_by, auth.uid())
   where id = msg and not (auth.uid() = any (hidden_by));
  return null;
end $$;
grant execute on function public.delete_message(bigint, boolean) to authenticated;

-- Okunmamış sayısı silinen/gizlenen mesajları saymasın
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

drop function if exists public.my_chats();
create function public.my_chats()
returns table (
  conversation_id uuid,
  other_id uuid,
  other_username text,
  other_display_name text,
  other_avatar smallint,
  other_last_seen timestamptz,
  last_message_id bigint,
  last_body text,
  last_has_image boolean,
  last_deleted boolean,
  last_sender uuid,
  last_created_at timestamptz,
  last_read_at timestamptz,
  unread int
) language sql stable security invoker set search_path = public as $$
  select c.id,
         p.id, p.username, p.display_name, p.avatar, p.last_seen,
         m.id, m.body, m.image_path is not null, coalesce(m.deleted, false), m.sender_id,
         coalesce(m.created_at, c.created_at), m.read_at,
         (select count(*)::int from public.messages u
           where u.conversation_id = c.id and u.sender_id <> auth.uid() and u.read_at is null
             and not u.deleted and not (auth.uid() = any (u.hidden_by)))
    from public.conversations c
    join public.profiles p on p.id = case when c.user_a = auth.uid() then c.user_b else c.user_a end
    left join lateral (
      select * from public.messages mm
       where mm.conversation_id = c.id and not (auth.uid() = any (mm.hidden_by))
       order by mm.id desc limit 1
    ) m on true
   where auth.uid() in (c.user_a, c.user_b)
   order by coalesce(m.created_at, c.created_at) desc;
$$;
grant execute on function public.my_chats() to authenticated;

-- Gönderen, herkesten sildiği fotoğrafın dosyasını depodan silebilir
drop policy if exists "kendi fotoğrafını sil" on storage.objects;
create policy "kendi fotoğrafını sil" on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos' and owner_id = auth.uid()::text);
