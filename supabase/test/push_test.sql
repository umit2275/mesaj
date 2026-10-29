\set ON_ERROR_STOP 1
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select public.save_push_token('ayse-telefon-token-123456789');
select public.save_push_token('kisa');  -- yok sayılır
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select id as conv from public.conversations limit 1 \gset
insert into public.messages (conversation_id, body) values (:'conv', 'Bildirim denemesi');
-- tablo doğrudan okunamaz
select count(*) as token_gorunen from public.push_tokens;
reset role;
select url, body->>'title' as baslik, body->>'body' as metin, body->'tokens' as tokenler, headers->>'x-push-secret' as gizli from net.calls;
-- Ayşe yazınca Ali'nin tokeni yok: çağrı olmamalı
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
insert into public.messages (conversation_id, body) values (:'conv', 'cevap');
select public.delete_push_token('ayse-telefon-token-123456789');
reset role;
select count(*) as toplam_cagri, (select count(*) from public.push_tokens) as kalan_token from net.calls;
