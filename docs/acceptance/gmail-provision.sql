-- Reviewed coordinator setup only: run after the migration, before enrollment.
-- Confirm Google Audience is actually In production before setting this value.
-- Existing basic Supabase Google sign-in client is deliberately untouched.
begin;
insert into private.resale_gmail_config(singleton,client_id,redirect_uri,publishing_status)
values(true,'745904614006-u4hc3gauh5vtlkg84n17pebeofjuka7b.apps.googleusercontent.com',
'https://resell-tracker-beta.vercel.app/api/integrations/gmail/callback','production')
on conflict(singleton) do update set client_id=excluded.client_id,redirect_uri=excluded.redirect_uri,
publishing_status=excluded.publishing_status,updated_at=now();
-- The config trigger fences every prior OAuth state/lease if authority metadata changes.
-- Each key is generated inside PostgreSQL and remains inside Vault. This is not a key export.
do $$ declare suffix text; n bigint; valid boolean; begin
foreach suffix in array array['tick_signing_key','ingress_signing_key'] loop
select count(*),bool_and(decrypted_secret ~ '^[a-f0-9]{64}$' and decrypted_secret is not null) into n,valid
from vault.decrypted_secrets where name='resale_gmail_paulettebrown83_production_'||suffix;
if n=0 then
perform vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),
'resale_gmail_paulettebrown83_production_'||suffix,
case suffix when 'tick_signing_key' then 'Resale Gmail timer HMAC; Cloudflare timer and narrow Supabase verifier only'
else 'Resale Gmail one-message receipt HMAC; Supabase Edge runtime and narrow ingress verifier only' end);
elsif n<>1 or valid is distinct from true then raise exception 'Existing Gmail signing-key metadata invalid';end if;
end loop;
end $$;
select name,id from vault.secrets where name in (
'resale_gmail_paulettebrown83_production_oauth_client_secret',
'resale_gmail_paulettebrown83_production_tick_signing_key',
'resale_gmail_paulettebrown83_production_ingress_signing_key') order by name;
commit;
-- Refresh token is created only by the member-bound Google OAuth completion RPC.
-- Transfer the tick key to the Cloudflare secret binding through a protected secret
-- provisioning channel; never select or print decrypted values into agent output.
