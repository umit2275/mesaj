-- Güncelleme 3: Firebase bildirimleri (uygulama kapalıyken de)
-- __PUSH_SECRET__ yerine Edge Function'daki PUSH_SECRET ile aynı gizli kelime yazılır.
-- Tekrar çalıştırmak güvenlidir.

create extension if not exists pg_net with schema extensions;

-- Telefonların bildirim adresleri (Firebase token)
create table if not exists public.push_tokens (
  token text primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  updated_at timestamptz not null default now()
);
create index if not exists push_tokens_user on public.push_tokens (user_id);
alter table public.push_tokens enable row level security;
-- Doğrudan erişim yok; yalnızca aşağıdaki fonksiyonlarla

create or replace function public.save_push_token(tok text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or tok is null or length(tok) < 20 or length(tok) > 4096 then return; end if;
  insert into public.push_tokens (token, user_id, updated_at) values (tok, auth.uid(), now())
  on conflict (token) do update set user_id = auth.uid(), updated_at = now();
end $$;
grant execute on function public.save_push_token(text) to authenticated;

create or replace function public.delete_push_token(tok text)
returns void language sql security definer set search_path = public as $$
  delete from public.push_tokens where token = tok and user_id = auth.uid();
$$;
grant execute on function public.delete_push_token(text) to authenticated;

-- Yeni mesajda alıcının telefonlarına bildirim (Edge Function "push" üzerinden)
create or replace function public.push_on_message()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare
  c public.conversations;
  recipient uuid;
  toks text[];
  who text;
  preview text;
begin
  select * into c from public.conversations where id = new.conversation_id;
  recipient := case when c.user_a = new.sender_id then c.user_b else c.user_a end;
  select array_agg(token) into toks from public.push_tokens
   where user_id = recipient and updated_at > now() - interval '60 days';
  if toks is null then return new; end if;
  select coalesce(nullif(display_name, ''), username) into who from public.profiles where id = new.sender_id;
  preview := case when new.image_path is not null then '📷 Fotoğraf' else left(coalesce(new.body, ''), 140) end;
  perform net.http_post(
    url := 'https://ydjzzsnqrbzeccrpbkpn.supabase.co/functions/v1/push',
    body := jsonb_build_object('tokens', to_jsonb(toks), 'title', coalesce(who, 'Suhbet Edek'), 'body', preview,
                               'conversation_id', new.conversation_id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', '__PUSH_SECRET__')
  );
  return new;
exception when others then
  return new; -- bildirim gönderilemese bile mesaj kaydedilir
end $$;

drop trigger if exists messages_push on public.messages;
create trigger messages_push after insert on public.messages
  for each row execute function public.push_on_message();

notify pgrst, 'reload schema';
