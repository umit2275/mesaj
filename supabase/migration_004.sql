-- Güncelleme 4: sohbet silme (yalnızca kendinden)
--  - Sohbeti temizle (sohbet içi ⋮): o ana kadarki mesajlar senden silinir, sohbet listede kalır
--  - Sohbeti sil (listede basılı tut): sohbet listeden kalkar; yeni mesaj gelirse yalnızca yenilerle geri gelir
-- Tekrar çalıştırmak güvenlidir.

create table if not exists public.chat_state (
  user_id uuid not null references public.profiles (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  cleared_at timestamptz,
  hidden boolean not null default false,
  primary key (user_id, conversation_id)
);
alter table public.chat_state enable row level security;

drop policy if exists "kendi sohbet durumun" on public.chat_state;
create policy "kendi sohbet durumun" on public.chat_state
  for select to authenticated using (user_id = auth.uid());

create or replace function public.clear_chat(conv uuid, remove boolean)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare t timestamptz := now();
begin
  if not public.is_participant(conv) then raise exception 'izin yok'; end if;
  insert into public.chat_state (user_id, conversation_id, cleared_at, hidden)
  values (auth.uid(), conv, t, remove)
  on conflict (user_id, conversation_id) do update set cleared_at = t, hidden = remove;
  return t;
end $$;
grant execute on function public.clear_chat(uuid, boolean) to authenticated;

-- Silinmiş bir sohbeti kişiyi arayıp yeniden açınca listeye geri gelsin
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
  update public.chat_state set hidden = false where user_id = me and conversation_id = cid;
  return cid;
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
  unread int,
  cleared_at timestamptz
) language sql stable security invoker set search_path = public as $$
  select c.id,
         p.id, p.username, p.display_name, p.avatar, p.last_seen,
         m.id, m.body, m.image_path is not null, coalesce(m.deleted, false), m.sender_id,
         coalesce(m.created_at, s.cleared_at, c.created_at), m.read_at,
         (select count(*)::int from public.messages u
           where u.conversation_id = c.id and u.sender_id <> auth.uid() and u.read_at is null
             and not u.deleted and not (auth.uid() = any (u.hidden_by))
             and u.created_at > coalesce(s.cleared_at, '-infinity')),
         s.cleared_at
    from public.conversations c
    join public.profiles p on p.id = case when c.user_a = auth.uid() then c.user_b else c.user_a end
    left join public.chat_state s on s.user_id = auth.uid() and s.conversation_id = c.id
    left join lateral (
      select * from public.messages mm
       where mm.conversation_id = c.id and not (auth.uid() = any (mm.hidden_by))
         and (not mm.deleted or mm.sender_id = auth.uid())
         and mm.created_at > coalesce(s.cleared_at, '-infinity')
       order by mm.id desc limit 1
    ) m on true
   where auth.uid() in (c.user_a, c.user_b)
     and not (coalesce(s.hidden, false) and m.id is null)
   order by coalesce(m.created_at, s.cleared_at, c.created_at) desc;
$$;
grant execute on function public.my_chats() to authenticated;

notify pgrst, 'reload schema';
