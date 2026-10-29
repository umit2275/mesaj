-- Güvenlik denetimi: üç kullanıcı (ali, ayse, can). Hata olursa betik durur.
\set ON_ERROR_STOP 1
insert into auth.users values
  ('11111111-1111-1111-1111-111111111111', '{"username":"Ali","display_name":"Ali Veli"}'),
  ('22222222-2222-2222-2222-222222222222', '{"username":"ayse"}'),
  ('33333333-3333-3333-3333-333333333333', '{"username":"x!"}');
select id, username, display_name from public.profiles order by username;

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select public.open_conversation('22222222-2222-2222-2222-222222222222') as conv \gset
select public.open_conversation('22222222-2222-2222-2222-222222222222') = :'conv' as ayni_sohbet;
insert into public.messages (conversation_id, body) values (:'conv', 'Merhaba Ayşe');
insert into storage.objects (bucket_id, name) values ('photos', :'conv' || '/a.jpg');
insert into public.messages (conversation_id, image_path, image_w, image_h) values (:'conv', :'conv' || '/a.jpg', 800, 600);

-- Başkası adına mesaj: reddedilmeli
do $$ begin
  insert into public.messages (conversation_id, sender_id, body)
  select id, '22222222-2222-2222-2222-222222222222', 'sahte' from public.conversations limit 1;
  raise exception 'HATA: başkası adına mesaj gitti';
exception when insufficient_privilege then raise notice 'tamam: başkası adına mesaj reddedildi';
end $$;
-- Mesajı düzenleme: etkisiz olmalı
update public.messages set body = 'değişti';
select count(*) = 0 as duzenleme_yok from public.messages where body = 'değişti';

-- Ayşe: görür, okur
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select other_username, last_has_image, unread from public.my_chats();
select public.mark_read(:'conv') as okundu_sayisi;
select unread from public.my_chats();
select count(*) as ayse_gorur from public.messages;
select count(*) as ayse_foto from storage.objects;

-- Can (u_... adlı): hiçbir şey görmez, katılamaz
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
select count(*) as can_mesaj from public.messages;
select count(*) as can_sohbet from public.conversations;
select count(*) as can_liste from public.my_chats();
select count(*) as can_foto from storage.objects;
do $$ begin
  insert into public.messages (conversation_id, body) select id, 'sızma' from public.conversations limit 1;
  if found then raise exception 'HATA: yabancı sohbet görünür'; end if;
  raise notice 'tamam: yabancı sohbeti göremiyor';
end $$;
select set_config('test.conv', :'conv', false);
do $$ begin
  perform public.mark_read(current_setting('test.conv')::uuid);
  raise exception 'HATA: yabancı sohbeti okundu yaptı';
exception when raise_exception then
  if sqlerrm like 'HATA%' then raise; end if;
  raise notice 'tamam: yabancı sohbeti okundu yapamıyor';
end $$;
do $q$ begin
  insert into storage.objects (bucket_id, name) values ('photos', current_setting('test.conv') || '/x.jpg');
  raise exception 'HATA: yabancı sohbete foto yüklendi';
exception when insufficient_privilege then raise notice 'tamam: yabancı sohbete foto reddedildi';
end $q$;
select public.username_available('ali') as ali_bos, public.username_available('yeni_ad') as yeni_bos;
reset role;
select 'TÜM DENETİMLER GEÇTİ' as sonuc;
