-- pg_net yerine kayıt tutan sahte fonksiyon (yalnızca yerel test)
create schema if not exists extensions;
create schema if not exists net;
create table if not exists net.calls (id serial, url text, body jsonb, headers jsonb);
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000)
returns bigint language sql as $$ insert into net.calls (url, body, headers) values (url, body, headers) returning id::bigint $$;
