-- Güncelleme 2 denetimi: avatar, benden sil, herkesten sil (rls_test.sql'den sonra çalışır)
\set ON_ERROR_STOP 1
insert into auth.users values ('44444444-4444-4444-4444-444444444444', '{"username":"deniz","avatar":"7"}');
select username, avatar from public.profiles where username = 'deniz';

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select id as conv from public.conversations limit 1 \gset
insert into public.messages (conversation_id, body) values (:'conv', 'silinecek') returning id as m1 \gset
insert into public.messages (conversation_id, body) values (:'conv', 'benden silinecek') returning id as m2 \gset
select set_config('test.m1', :'m1', false);

-- Ayşe okur, sonra Ali herkesten siler (okunmuş olsa bile)
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select public.mark_read(:'conv');
-- Ayşe, Ali'nin mesajını herkesten silemez
do $$ begin
  perform public.delete_message(current_setting('test.m1')::bigint, true);
  raise exception 'HATA: başkasının mesajını herkesten sildi';
exception when raise_exception then
  if sqlerrm like 'HATA%' then raise; end if;
  raise notice 'tamam: başkasının mesajı herkesten silinemiyor';
end $$;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select public.delete_message(:'m1', true) is null as yol_yok;
select deleted, body is null as govde_bos from public.messages where id = :'m1';

-- Ali "benden sil": yalnızca Ali'den gizlenir
select public.delete_message(:'m2', false);
select count(*) as ali_listesinde from public.messages where id = :'m2' and not (auth.uid() = any (hidden_by));
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select count(*) as ayse_listesinde from public.messages where id = :'m2' and not (auth.uid() = any (hidden_by));
select last_body, last_deleted, other_avatar from public.my_chats();

-- Silinmiş/gizli olarak mesaj eklenemez
do $$ begin
  insert into public.messages (conversation_id, body, deleted) select id, 'x', true from public.conversations limit 1;
  raise exception 'HATA: silinmiş mesaj eklendi';
exception when insufficient_privilege then raise notice 'tamam: silinmiş olarak eklenemiyor';
end $$;

-- Fotoğrafı yalnızca yükleyen silebilir
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
insert into storage.objects (bucket_id, name) values ('photos', :'conv' || '/sil.jpg');
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
delete from storage.objects where name = :'conv' || '/sil.jpg';
select count(*) = 1 as ayse_silemedi from storage.objects where name = :'conv' || '/sil.jpg';
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
delete from storage.objects where name = :'conv' || '/sil.jpg';
select count(*) = 0 as ali_sildi from storage.objects where name = :'conv' || '/sil.jpg';
reset role;
select 'GÜNCELLEME 2 DENETİMLERİ GEÇTİ' as sonuc;
