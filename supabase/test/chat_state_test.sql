\set ON_ERROR_STOP 1
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select id as conv from public.conversations limit 1 \gset
select count(*) as ali_once from public.my_chats();
-- Ali sohbeti temizler (sohbet içi): listede kalır, mesajsız
select public.clear_chat(:'conv', false) is not null as temizlendi;
select count(*) as ali_listede, max(last_message_id) as son_mesaj, max(unread) as okunmamis from public.my_chats();
-- Ayşe'de her şey duruyor
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select last_message_id is not null as ayse_mesaj_goruyor from public.my_chats();
-- Ali sohbeti siler (liste): listeden kalkar
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select pg_sleep(0.01);
select public.clear_chat(:'conv', true) is not null;
select count(*) as ali_listede_sonra from public.my_chats();
-- Ayşe yeni mesaj atar: Ali'de yalnızca yeni mesajla geri gelir
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select pg_sleep(0.01);
insert into public.messages (conversation_id, body) values (:'conv', 'yeni mesaj');
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select count(*) as geri_geldi, max(last_body) as son, max(unread) as okunmamis from public.my_chats();
-- Başkası benim durumumu göremez; yabancı sohbeti temizleyemez
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
select count(*) as can_gorur from public.chat_state;
select set_config('test.conv', :'conv', false);
do $$ begin
  perform public.clear_chat(current_setting('test.conv')::uuid, true);
  raise exception 'HATA: yabancı sohbeti sildi';
exception when raise_exception then
  if sqlerrm like 'HATA%' then raise; end if;
  raise notice 'tamam: yabancı sohbet silinemiyor';
end $$;
reset role;
select 'SOHBET SİLME DENETİMLERİ GEÇTİ';
