begin;
-- Initial deliberately narrow feed: one mailbox, one Vinted account, one parser.
create table public.resale_gmail_feeds (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id),
 mailbox_email text not null unique check(mailbox_email='paulettebrown83@gmail.com'),
 account_id uuid not null references public.resale_accounts(id), account_handle text not null,
 parser_version text not null check(parser_version='vinted-gmail-v1'),
 status text not null default 'pending' check(status in ('pending','active','paused','reconnect_required')),
 generation bigint not null default 1, last_started_at timestamptz, last_success_at timestamptz,
 last_error_code text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.resale_gmail_feeds enable row level security;
revoke all on public.resale_gmail_feeds from public,anon,authenticated,service_role;
grant select on public.resale_gmail_feeds to authenticated,service_role;
create policy resale_gmail_owner_read on public.resale_gmail_feeds for select to authenticated
 using(owner_id=(select auth.uid()) and (select private.has_access('resale')));

create table private.resale_gmail_config (
 singleton boolean primary key default true check(singleton), client_id text not null check(length(client_id) between 10 and 300),
 redirect_uri text not null check(redirect_uri='https://resell-tracker-beta.vercel.app/api/integrations/gmail/callback'),
 publishing_status text not null default 'unknown' check(publishing_status in ('unknown','testing','production')),
 updated_at timestamptz not null default now()
);
create table private.resale_gmail_enrollment_requests (
 request_id uuid primary key, actor_id uuid not null references auth.users(id), feed_id uuid not null references public.resale_gmail_feeds(id), payload jsonb not null
);
create table private.resale_gmail_runtime (
 feed_id uuid primary key references public.resale_gmail_feeds(id), lease_token uuid, lease_expires_at timestamptz, lease_generation bigint,
 not_before timestamptz, cursor jsonb, token_present boolean not null default false, token_client_id text
);
create table private.resale_gmail_oauth_states (
 id uuid primary key default gen_random_uuid(), feed_id uuid not null references public.resale_gmail_feeds(id),
 member_id uuid not null references auth.users(id), feed_generation bigint not null, client_id text not null,
 state_sha256 text not null unique, browser_binding_sha256 text not null, code_verifier text,
 created_at timestamptz not null default now(), expires_at timestamptz not null,
 consumed_at timestamptz, completed_at timestamptz, completion_sha256 text
);
create table private.resale_gmail_tick_receipts (
 nonce uuid primary key, receipt_sha256 text not null, created_at timestamptz not null default now()
);
create table private.resale_gmail_messages (
 feed_id uuid not null references public.resale_gmail_feeds(id), message_id text not null,
 semantic_sha256 text not null, source_record_id uuid not null references public.resale_source_records(id),
 operation_id uuid not null references public.resale_actions(id), legacy_source_reused boolean not null,
 created_at timestamptz not null default now(), primary key(feed_id,message_id)
);
create table private.resale_gmail_ingress_receipts (
 nonce uuid primary key, receipt_sha256 text not null, feed_id uuid not null references public.resale_gmail_feeds(id),
 message_id text not null, created_at timestamptz not null default now()
);
do $$ declare t text; begin
 foreach t in array array['resale_gmail_config','resale_gmail_enrollment_requests','resale_gmail_runtime','resale_gmail_oauth_states','resale_gmail_tick_receipts','resale_gmail_messages','resale_gmail_ingress_receipts'] loop
 execute format('alter table private.%I enable row level security',t);
 execute format('revoke all on private.%I from public,anon,authenticated,service_role',t);
 end loop;
end $$;
-- Coordinator metadata setup only. No browser writes or secret values in configuration.
grant select,insert,update on private.resale_gmail_config to service_role;
-- Changing coordinator configuration invalidates all in-flight work, including existing leases.
create function private.gmail_config_changed() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if row(old.client_id,old.redirect_uri,old.publishing_status) is distinct from row(new.client_id,new.redirect_uri,new.publishing_status) then
 update public.resale_gmail_feeds set status='reconnect_required',generation=generation+1,last_error_code='configuration_mismatch',updated_at=now();
 update private.resale_gmail_runtime set lease_token=null,lease_expires_at=null;
 end if;
 return new;
end $$;
revoke all on function private.gmail_config_changed() from public,anon,authenticated,service_role;
create trigger gmail_config_generation_fence after update on private.resale_gmail_config for each row execute function private.gmail_config_changed();
create index resale_gmail_oauth_expiry on private.resale_gmail_oauth_states(expires_at);
create index resale_gmail_ingress_created on private.resale_gmail_ingress_receipts(created_at);

create function private.gmail_require_owner(p_member uuid,p_feed uuid default null) returns public.resale_gmail_feeds
language plpgsql set search_path='' as $$
declare f public.resale_gmail_feeds;
begin
 perform 1 from private.memberships where user_id=p_member and area='resale' for share;
 if p_member is null or not found then raise exception 'Resale membership required' using errcode='42501'; end if;
 if p_feed is not null then
 select * into f from public.resale_gmail_feeds where id=p_feed for update;
 if not found or f.owner_id<>p_member then raise exception 'Feed ownership required' using errcode='42501'; end if;
 end if;
 return f;
end $$;
revoke all on function private.gmail_require_owner(uuid,uuid) from public,anon,authenticated,service_role;

create function public.resale_enroll_gmail_feed(p_request_id uuid,p_payload jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); old private.resale_gmail_enrollment_requests; f public.resale_gmail_feeds; a public.resale_accounts;
begin
 perform private.gmail_require_owner(actor);
 if p_request_id is null or p_payload is null or jsonb_typeof(p_payload)<>'object'
 or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('mailbox_email','account_id','parser_version'))
 or p_payload->>'mailbox_email' is distinct from 'paulettebrown83@gmail.com' or p_payload->>'parser_version' is distinct from 'vinted-gmail-v1' then raise exception 'Unsupported enrollment' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,7301));
 select * into old from private.resale_gmail_enrollment_requests where request_id=p_request_id;
 if found then
 if old.actor_id<>actor or old.payload<>p_payload then raise exception 'Enrollment retry changed' using errcode='22023'; end if;
 return old.feed_id; end if;
 select * into a from public.resale_accounts where id=(p_payload->>'account_id')::uuid for share;
 if not found or a.marketplace<>'vinted' or nullif(btrim(a.username),'') is null then raise exception 'Verified Vinted account handle required' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('gmail:paulettebrown83@gmail.com',7302));
 select * into f from public.resale_gmail_feeds where mailbox_email='paulettebrown83@gmail.com' for update;
 if found then
 if f.owner_id<>actor or f.account_id<>a.id or f.parser_version<>p_payload->>'parser_version' then raise exception 'Mailbox enrollment already belongs to another binding' using errcode='22023'; end if;
 else
 insert into public.resale_gmail_feeds(owner_id,mailbox_email,account_id,account_handle,parser_version)
 values(actor,'paulettebrown83@gmail.com',a.id,lower(a.username),'vinted-gmail-v1') returning * into f;
 insert into private.resale_gmail_runtime(feed_id) values(f.id);
 end if;
 insert into private.resale_gmail_enrollment_requests values(p_request_id,actor,f.id,p_payload);
 return f.id;
end $$;
revoke all on function public.resale_enroll_gmail_feed(uuid,jsonb) from public,anon;
grant execute on function public.resale_enroll_gmail_feed(uuid,jsonb) to authenticated;

create function public.resale_pause_gmail_feed(p_feed_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare f public.resale_gmail_feeds;
begin
 f:=private.gmail_require_owner(auth.uid(),p_feed_id);
 update public.resale_gmail_feeds set status='paused',generation=generation+1,last_error_code='paused_by_owner',updated_at=now() where id=f.id;
 update private.resale_gmail_runtime set lease_token=null,lease_expires_at=null where feed_id=f.id;
end $$;
revoke all on function public.resale_pause_gmail_feed(uuid) from public,anon;
grant execute on function public.resale_pause_gmail_feed(uuid) to authenticated;

-- Four fixed-purpose helpers are owner-only, not generic Vault readers.
create function private.gmail_client_secret() returns text language plpgsql set search_path='' as $$
declare value text; n bigint; begin
 select count(*),min(decrypted_secret) into n,value from vault.decrypted_secrets where name='resale_gmail_paulettebrown83_production_oauth_client_secret';
 if n<>1 or nullif(value,'') is null then raise exception 'Gmail OAuth client secret unavailable' using errcode='55000'; end if; return value;
end $$;
create function private.gmail_refresh_token() returns text language plpgsql set search_path='' as $$
declare value text; n bigint; begin
 select count(*),min(decrypted_secret) into n,value from vault.decrypted_secrets where name='resale_gmail_paulettebrown83_production_oauth_refresh_token';
 if n<>1 or nullif(value,'') is null then raise exception 'Gmail refresh token unavailable' using errcode='55000'; end if; return value;
end $$;
create function private.gmail_ingress_key() returns text language plpgsql set search_path='' as $$
declare value text; n bigint; begin
 select count(*),min(decrypted_secret) into n,value from vault.decrypted_secrets where name='resale_gmail_paulettebrown83_production_ingress_signing_key';
 if n<>1 or value is null or value !~ '^[a-f0-9]{64}$' then raise exception 'Gmail ingress key unavailable' using errcode='55000'; end if; return value;
end $$;
create function private.gmail_check_signature(p_purpose text,p_text text,p_signature text) returns void
language plpgsql set search_path='' as $$
declare value text; n bigint; expected bytea;
begin
 if p_text is null or octet_length(p_text)>32768 or p_signature is null or p_signature !~ '^[a-f0-9]{64}$' then raise exception 'Invalid signed envelope' using errcode='22023'; end if;
 if p_purpose='tick' then
 select count(*),min(decrypted_secret) into n,value from vault.decrypted_secrets where name='resale_gmail_paulettebrown83_production_tick_signing_key';
 if n<>1 or value is null or value !~ '^[a-f0-9]{64}$' then raise exception 'Gmail tick key unavailable' using errcode='55000'; end if;
 elsif p_purpose='ingest' then value:=private.gmail_ingress_key();
 else raise exception 'Unsupported signature purpose' using errcode='22023'; end if;
 expected:=extensions.hmac(convert_to('gmail_'||p_purpose||E'_v1\n'||p_text,'UTF8'),decode(value,'hex'),'sha256');
 if extensions.digest(expected,'sha256')<>extensions.digest(decode(p_signature,'hex'),'sha256') then raise exception 'Invalid signature' using errcode='42501'; end if;
end $$;
revoke all on function private.gmail_client_secret(),private.gmail_refresh_token(),private.gmail_ingress_key(),private.gmail_check_signature(text,text,text) from public,anon,authenticated,service_role;

create function public.resale_gmail_oauth_start(p_member_id uuid,p_feed_id uuid,p_state_sha256 text,p_browser_binding_sha256 text,p_code_verifier text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare f public.resale_gmail_feeds; c private.resale_gmail_config; s private.resale_gmail_oauth_states;
begin
 f:=private.gmail_require_owner(p_member_id,p_feed_id);
 if p_state_sha256 is null or p_state_sha256 !~ '^[a-f0-9]{64}$' or p_browser_binding_sha256 is null or p_browser_binding_sha256 !~ '^[a-f0-9]{64}$'
 or p_code_verifier is null or p_code_verifier !~ '^[A-Za-z0-9._~-]{43,128}$' then raise exception 'Invalid OAuth state material' using errcode='22023'; end if;
 select * into c from private.resale_gmail_config where singleton for share;
 if not found then raise exception 'Gmail OAuth configuration required' using errcode='55000'; end if;
 delete from private.resale_gmail_oauth_states where expires_at<now()-interval '1 day';
 insert into private.resale_gmail_oauth_states(feed_id,member_id,feed_generation,client_id,state_sha256,browser_binding_sha256,code_verifier,expires_at)
 values(f.id,p_member_id,f.generation,c.client_id,p_state_sha256,p_browser_binding_sha256,p_code_verifier,clock_timestamp()+interval '10 minutes') returning * into s;
 return jsonb_build_object('state_id',s.id,'client_id',c.client_id,'redirect_uri',c.redirect_uri,'expected_mailbox',f.mailbox_email,'expires_at',s.expires_at);
end $$;

create function public.resale_gmail_oauth_consume(p_state_sha256 text,p_browser_binding_sha256 text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s private.resale_gmail_oauth_states; f public.resale_gmail_feeds; c private.resale_gmail_config;
begin
 select * into s from private.resale_gmail_oauth_states where state_sha256=p_state_sha256;
 if not found then raise exception 'OAuth state invalid or expired' using errcode='22023'; end if;
 f:=private.gmail_require_owner(s.member_id,s.feed_id);
 select * into s from private.resale_gmail_oauth_states where id=s.id for update;
 if s.consumed_at is not null or s.expires_at<=clock_timestamp() or s.browser_binding_sha256 is distinct from p_browser_binding_sha256 or s.feed_generation<>f.generation then raise exception 'OAuth state invalid or expired' using errcode='22023'; end if;
 select * into c from private.resale_gmail_config where singleton for share;
 if c.client_id is distinct from s.client_id then raise exception 'OAuth configuration changed' using errcode='22023'; end if;
 update private.resale_gmail_oauth_states set consumed_at=clock_timestamp(),code_verifier=null where id=s.id;
 return jsonb_build_object('state_id',s.id,'member_id',s.member_id,'feed_id',s.feed_id,'client_id',s.client_id,'redirect_uri',c.redirect_uri,'code_verifier',s.code_verifier,'client_secret',private.gmail_client_secret(),'expected_mailbox',f.mailbox_email);
end $$;

create function public.resale_gmail_oauth_complete(p_state_id uuid,p_mailbox text,p_scopes text[],p_refresh_token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s private.resale_gmail_oauth_states; f public.resale_gmail_feeds; c private.resale_gmail_config; token_id uuid; n bigint; completion text;
begin
 select * into s from private.resale_gmail_oauth_states where id=p_state_id;
 if not found then raise exception 'OAuth state missing' using errcode='22023'; end if;
 f:=private.gmail_require_owner(s.member_id,s.feed_id);
 select * into s from private.resale_gmail_oauth_states where id=p_state_id for update;
 if p_mailbox is distinct from f.mailbox_email or p_scopes is distinct from array['https://www.googleapis.com/auth/gmail.readonly']::text[]
 or s.consumed_at is null or s.expires_at<=clock_timestamp() then raise exception 'OAuth mailbox, scope or state invalid' using errcode='22023'; end if;
 completion:=encode(extensions.digest(convert_to(jsonb_build_object('mailbox',p_mailbox,'scopes',p_scopes,'token',p_refresh_token)::text,'UTF8'),'sha256'),'hex');
 if s.completed_at is not null then
 if s.completion_sha256<>completion then raise exception 'OAuth completion retry changed' using errcode='22023'; end if;
 return jsonb_build_object('feed_id',f.id,'status',f.status); end if;
 if s.feed_generation<>f.generation then raise exception 'Feed changed during OAuth' using errcode='22023'; end if;
 select * into c from private.resale_gmail_config where singleton for share;
 if c.client_id is distinct from s.client_id then raise exception 'OAuth client changed' using errcode='22023'; end if;
 if p_refresh_token is not null then
 if length(p_refresh_token) not between 10 and 4096 then raise exception 'Refresh token invalid' using errcode='22023'; end if;
 select count(*),(array_agg(id))[1] into n,token_id from vault.secrets where name='resale_gmail_paulettebrown83_production_oauth_refresh_token';
 if n>1 then raise exception 'Duplicate Gmail refresh token names' using errcode='55000'; end if;
 if n=0 then perform vault.create_secret(p_refresh_token,'resale_gmail_paulettebrown83_production_oauth_refresh_token','Resale Gmail feed; consumed only by private Edge polling runtime');
 else perform vault.update_secret(token_id,p_refresh_token); end if;
 else
 if not exists(select 1 from private.resale_gmail_runtime r where r.feed_id=f.id and r.token_present and r.token_client_id=c.client_id) then raise exception 'Existing token belongs to another OAuth client or is missing' using errcode='22023'; end if;
 perform private.gmail_refresh_token(); end if;
 update public.resale_gmail_feeds set status=case when c.publishing_status='production' then 'active' else 'paused' end,
 generation=generation+1,last_error_code=case when c.publishing_status='production' then null else 'consent_not_production' end,updated_at=now() where id=f.id returning * into f;
 update private.resale_gmail_runtime set token_present=true,token_client_id=c.client_id,lease_token=null,lease_expires_at=null,not_before=null where feed_id=f.id;
 update private.resale_gmail_oauth_states set completed_at=clock_timestamp(),completion_sha256=completion where id=s.id;
 return jsonb_build_object('feed_id',f.id,'status',f.status);
end $$;

create function private.gmail_validate_cursor(p_cursor jsonb) returns void language plpgsql set search_path='' as $$
begin
 if p_cursor is null then return; end if;
 if jsonb_typeof(p_cursor)<>'object' or exists(select 1 from jsonb_object_keys(p_cursor) k where k not in ('window_start_ms','window_end_ms','page_token','window_complete','pending_message_ids','next_page_token'))
 or jsonb_typeof(p_cursor->'window_start_ms') is distinct from 'number' or jsonb_typeof(p_cursor->'window_end_ms') is distinct from 'number'
 or jsonb_typeof(p_cursor->'window_complete') is distinct from 'boolean' or not p_cursor?'page_token'
 or (p_cursor->'page_token'<>'null'::jsonb and (jsonb_typeof(p_cursor->'page_token')<>'string' or length(p_cursor->>'page_token')>4096))
 or (p_cursor->>'window_start_ms')::numeric<0 or (p_cursor->>'window_start_ms')::numeric>=(p_cursor->>'window_end_ms')::numeric
 or (p_cursor->>'window_end_ms')::numeric>extract(epoch from clock_timestamp())*1000+30000
 or ((p_cursor->>'window_complete')::boolean and (p_cursor->'page_token'<>'null'::jsonb or (p_cursor?'next_page_token' and p_cursor->'next_page_token'<>'null'::jsonb))) then raise exception 'Invalid bounded Gmail cursor' using errcode='22023'; end if;
 if p_cursor?'next_page_token' and p_cursor->'next_page_token'<>'null'::jsonb and (jsonb_typeof(p_cursor->'next_page_token')<>'string' or length(p_cursor->>'next_page_token')>2048) then raise exception 'Invalid next-page token' using errcode='22023'; end if;
 if p_cursor?'pending_message_ids' and p_cursor->'pending_message_ids'<>'null'::jsonb then
 if jsonb_typeof(p_cursor->'pending_message_ids')<>'array' or jsonb_array_length(p_cursor->'pending_message_ids')>25 then raise exception 'Invalid pending message page' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(p_cursor->'pending_message_ids') x where jsonb_typeof(x)<>'string' or x#>>'{}' !~ '^[a-f0-9]{1,128}$') then raise exception 'Invalid pending message identity' using errcode='22023'; end if;
 if (p_cursor->>'window_complete')::boolean and jsonb_array_length(p_cursor->'pending_message_ids')>0 then raise exception 'Pending messages cannot complete scope' using errcode='22023'; end if;
 end if;
end $$;
revoke all on function private.gmail_validate_cursor(jsonb) from public,anon,authenticated,service_role;

create function public.resale_gmail_verify_tick_and_claim(p_tick text,p_signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare payload jsonb; nonce_id uuid; hash text; prior text; f public.resale_gmail_feeds; r private.resale_gmail_runtime; c private.resale_gmail_config;
begin
 perform private.gmail_check_signature('tick',p_tick,p_signature); payload:=p_tick::jsonb;
 if jsonb_typeof(payload)<>'object' or exists(select 1 from jsonb_object_keys(payload) k where k not in ('v','nonce','expires_at'))
 or jsonb_typeof(payload->'v') is distinct from 'number' or payload->>'v' is distinct from '1' or jsonb_typeof(payload->'expires_at') is distinct from 'number'
 or (payload->>'expires_at')::numeric<extract(epoch from clock_timestamp()) or (payload->>'expires_at')::numeric>extract(epoch from clock_timestamp())+600 then raise exception 'Invalid tick expiry' using errcode='22023'; end if;
 nonce_id:=(payload->>'nonce')::uuid; if nonce_id is null then raise exception 'Tick nonce required' using errcode='22023'; end if;
 hash:=encode(extensions.digest(convert_to(p_tick,'UTF8'),'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(nonce_id::text,7303));
 select receipt_sha256 into prior from private.resale_gmail_tick_receipts where nonce=nonce_id;
 if found then if prior<>hash then raise exception 'Tick nonce reused with changed payload' using errcode='22023'; end if; return null; end if;
 insert into private.resale_gmail_tick_receipts(nonce,receipt_sha256) values(nonce_id,hash);
 select * into f from public.resale_gmail_feeds where status='active' limit 1;
 if not found then return null; end if;
 f:=private.gmail_require_owner(f.owner_id,f.id);
 select * into r from private.resale_gmail_runtime where feed_id=f.id for update;
 if f.status<>'active' or not r.token_present or r.not_before>clock_timestamp() or (r.lease_token is not null and r.lease_expires_at>clock_timestamp()) then return null; end if;
 if not exists(select 1 from public.resale_accounts a where a.id=f.account_id and a.marketplace='vinted' and lower(a.username)=f.account_handle) then
 update public.resale_gmail_feeds set status='paused',last_error_code='account_binding_changed',generation=generation+1,updated_at=now() where id=f.id;
 return null; end if;
 select * into c from private.resale_gmail_config where singleton for share;
 if not found or c.publishing_status<>'production' then raise exception 'Production OAuth configuration required' using errcode='55000'; end if;
 if r.token_client_id is distinct from c.client_id then
 update public.resale_gmail_feeds set status='reconnect_required',last_error_code='configuration_mismatch',generation=generation+1,updated_at=now() where id=f.id;
 return null; end if;
 update private.resale_gmail_runtime set lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '5 minutes',lease_generation=f.generation,not_before=clock_timestamp()+interval '30 seconds'
 where feed_id=f.id returning * into r;
 update public.resale_gmail_feeds set last_started_at=clock_timestamp(),updated_at=now() where id=f.id;
 return jsonb_build_object('feed_id',f.id,'member_id',f.owner_id,'account_id',f.account_id,'account_handle',f.account_handle,'mailbox_email',f.mailbox_email,'parser_version',f.parser_version,
 'lease_token',r.lease_token,'lease_expires_at',r.lease_expires_at,'cursor',r.cursor,'client_id',c.client_id,'client_secret',private.gmail_client_secret(),'refresh_token',private.gmail_refresh_token(),'ingress_signing_key',private.gmail_ingress_key());
end $$;

create function private.gmail_require_lease(p_feed uuid,p_lease uuid) returns public.resale_gmail_feeds language plpgsql set search_path='' as $$
declare f public.resale_gmail_feeds; r private.resale_gmail_runtime;
begin
 select * into f from public.resale_gmail_feeds where id=p_feed;
 if not found then raise exception 'Feed missing' using errcode='22023'; end if;
 f:=private.gmail_require_owner(f.owner_id,f.id);
 select * into r from private.resale_gmail_runtime where feed_id=f.id for update;
 if f.status<>'active' or p_lease is null or r.lease_token is distinct from p_lease or r.lease_expires_at is null or r.lease_expires_at<=clock_timestamp() or r.lease_generation is distinct from f.generation then raise exception 'Feed lease expired or revoked' using errcode='22023'; end if;
 return f;
end $$;
revoke all on function private.gmail_require_lease(uuid,uuid) from public,anon,authenticated,service_role;

-- A retry may restart pagination inside its fixed window, but cannot skip unfinished scope.
create function private.gmail_validate_cursor_transition(p_feed uuid,p_next jsonb) returns void language plpgsql set search_path='' as $$
declare old jsonb;
begin
 if p_next is null then return; end if;
 select cursor into old from private.resale_gmail_runtime where feed_id=p_feed;
 if old is null then return; end if;
 if not (old->>'window_complete')::boolean then
 if old->'window_start_ms'<>p_next->'window_start_ms' or old->'window_end_ms'<>p_next->'window_end_ms' then raise exception 'Unfinished Gmail window must be retained' using errcode='22023'; end if;
 elsif (p_next->>'window_start_ms')::numeric>(old->>'window_end_ms')::numeric or (p_next->>'window_end_ms')::numeric<(old->>'window_end_ms')::numeric then
 raise exception 'Gmail watermark cannot skip or move backward' using errcode='22023';
 end if;
end $$;
revoke all on function private.gmail_validate_cursor_transition(uuid,jsonb) from public,anon,authenticated,service_role;

create function public.resale_gmail_checkpoint_run(p_feed_id uuid,p_lease_token uuid,p_cursor jsonb) returns void language plpgsql security definer set search_path='' as $$
begin
 perform private.gmail_require_lease(p_feed_id,p_lease_token); perform private.gmail_validate_cursor(p_cursor); perform private.gmail_validate_cursor_transition(p_feed_id,p_cursor);
 if p_cursor is null or (p_cursor->>'window_complete')::boolean then raise exception 'Checkpoint must retain incomplete scope' using errcode='22023'; end if;
 update private.resale_gmail_runtime set cursor=p_cursor where feed_id=p_feed_id;
end $$;
create function public.resale_gmail_finish_run(p_feed_id uuid,p_lease_token uuid,p_outcome text,p_cursor jsonb,p_error_code text) returns void language plpgsql security definer set search_path='' as $$
declare f public.resale_gmail_feeds;
begin
 f:=private.gmail_require_lease(p_feed_id,p_lease_token); perform private.gmail_validate_cursor(p_cursor); perform private.gmail_validate_cursor_transition(p_feed_id,p_cursor);
 if p_outcome is null or p_outcome not in ('complete','partial','retry','reconnect_required','paused')
 or (p_error_code is not null and p_error_code !~ '^[a-z][a-z0-9_]{0,63}$') then raise exception 'Invalid run outcome' using errcode='22023'; end if;
 if p_outcome='complete' and (p_cursor is null or not (p_cursor->>'window_complete')::boolean or p_cursor->'page_token'<>'null'::jsonb) then raise exception 'Complete coverage required' using errcode='22023'; end if;
 if p_outcome<>'complete' and p_cursor is not null and (p_cursor->>'window_complete')::boolean then raise exception 'Incomplete run cannot complete watermark' using errcode='22023'; end if;
 update private.resale_gmail_runtime set cursor=coalesce(p_cursor,cursor),lease_token=null,lease_expires_at=null,
 not_before=case when p_outcome='retry' then clock_timestamp()+interval '5 minutes' else not_before end where feed_id=f.id;
 update public.resale_gmail_feeds set last_success_at=case when p_outcome='complete' then clock_timestamp() else last_success_at end,
 status=case when p_outcome in ('reconnect_required','paused') then p_outcome else status end,
 generation=generation+case when p_outcome in ('reconnect_required','paused') then 1 else 0 end,last_error_code=p_error_code,updated_at=now() where id=f.id;
end $$;

create function private.gmail_validate_normalized(p jsonb,p_kind text,p_handle text) returns void language plpgsql set search_path='' as $$
declare entry jsonb; value text;
begin
 if p is null or jsonb_typeof(p)<>'object' or exists(select 1 from jsonb_object_keys(p) k where k not in
 ('subject','account_handle','product_titles','money_mentions','conversation_ids','transaction_id','order_id','listing_id','parser_status','quarantine_reason','authentication_pass'))
 or not p?&array['subject','account_handle','product_titles','money_mentions','conversation_ids','transaction_id','order_id','listing_id','parser_status','quarantine_reason','authentication_pass']
 or jsonb_typeof(p->'subject') is distinct from 'string' or length(p->>'subject')>500
 or jsonb_typeof(p->'product_titles') is distinct from 'array' or jsonb_array_length(p->'product_titles')>20
 or jsonb_typeof(p->'money_mentions') is distinct from 'array' or jsonb_array_length(p->'money_mentions')>20
 or jsonb_typeof(p->'conversation_ids') is distinct from 'array' or jsonb_array_length(p->'conversation_ids')>20
 or p->'order_id'<>'null'::jsonb or p->'listing_id'<>'null'::jsonb
 or jsonb_typeof(p->'parser_status') is distinct from 'string' or p->>'parser_status' not in ('recognized','quarantined') or jsonb_typeof(p->'authentication_pass') is distinct from 'boolean'
 or octet_length(p::text)>20000 then raise exception 'Invalid normalized Gmail fields' using errcode='22023'; end if;
 if p->'account_handle'<>'null'::jsonb and (jsonb_typeof(p->'account_handle')<>'string' or lower(p->>'account_handle')<>p_handle) then raise exception 'Message account handle mismatch' using errcode='22023'; end if;
 if p->'transaction_id'<>'null'::jsonb and (jsonb_typeof(p->'transaction_id')<>'string' or p->>'transaction_id' !~ '^[0-9]{1,64}$') then raise exception 'Invalid transaction evidence identifier' using errcode='22023'; end if;
 if p->>'parser_status'='recognized' and (not (p->>'authentication_pass')::boolean or p->'account_handle'='null'::jsonb or p_kind='unknown' or p->'quarantine_reason'<>'null'::jsonb) then raise exception 'Recognized notification requires authenticated matching account evidence' using errcode='22023'; end if;
 if p->>'parser_status'='quarantined' and (jsonb_typeof(p->'quarantine_reason') is distinct from 'string' or p->>'quarantine_reason' !~ '^[a-z][a-z0-9_]{0,63}$') then raise exception 'Quarantine reason required' using errcode='22023'; end if;
 for entry in select * from jsonb_array_elements(p->'product_titles') loop
 if jsonb_typeof(entry)<>'string' or length(entry#>>'{}') not between 1 and 500 then raise exception 'Invalid product title' using errcode='22023'; end if;
 end loop;
 for entry in select * from jsonb_array_elements(p->'conversation_ids') loop
 if jsonb_typeof(entry)<>'string' or entry#>>'{}' !~ '^[A-Za-z0-9_-]{1,128}$' then raise exception 'Invalid conversation identity' using errcode='22023'; end if;
 end loop;
 for entry in select * from jsonb_array_elements(p->'money_mentions') loop
 if jsonb_typeof(entry)<>'object' or exists(select 1 from jsonb_object_keys(entry) k where k not in ('raw','amount_minor','currency_symbol','currency_code','meaning'))
 or not entry?&array['raw','amount_minor','currency_symbol','currency_code','meaning']
 or jsonb_typeof(entry->'raw') is distinct from 'string' or length(entry->>'raw') not between 1 and 64
 or entry->'currency_code'<>'null'::jsonb or entry->>'meaning' is distinct from 'unallocated'
 or (entry->'currency_symbol'<>'null'::jsonb and (jsonb_typeof(entry->'currency_symbol')<>'string' or length(entry->>'currency_symbol')>8))
 then raise exception 'Invalid unallocated amount evidence' using errcode='22023'; end if;
 if entry->'amount_minor'<>'null'::jsonb then
 if jsonb_typeof(entry->'amount_minor')<>'number' then raise exception 'Amount must be integer minor units' using errcode='22023'; end if;
 value:=entry->>'amount_minor';
 if value::numeric<0 or value::numeric>1000000000 or value::numeric<>trunc(value::numeric) then raise exception 'Invalid amount minor units' using errcode='22023'; end if;
 end if;
 end loop;
end $$;
revoke all on function private.gmail_validate_normalized(jsonb,text,text) from public,anon,authenticated,service_role;

create function public.resale_ingest_gmail_message(p_receipt text,p_signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare p jsonb; f public.resale_gmail_feeds; normalized jsonb; old private.resale_gmail_messages;
 nonce_id uuid; receipt_hash text; previous_hash text; semantic text; mid text; kind text; source_id uuid; snapshot_id uuid; operation_id uuid; operation_request uuid;
 received timestamptz; captured timestamptz; cursor_value jsonb; legacy boolean:=false; legacy_count bigint; payload jsonb; action_kind text; review_id uuid;
begin
 perform private.gmail_check_signature('ingest',p_receipt,p_signature); p:=p_receipt::jsonb;
 if jsonb_typeof(p)<>'object' or exists(select 1 from jsonb_object_keys(p) k where k not in
 ('v','nonce','feed_id','lease_token','parser_version','account_id','message_id','thread_id','received_at','captured_at','kind','source_sha256','expires_at','normalized'))
 or not p?&array['v','nonce','feed_id','lease_token','parser_version','account_id','message_id','thread_id','received_at','captured_at','kind','source_sha256','expires_at','normalized']
 or jsonb_typeof(p->'v') is distinct from 'number' or p->>'v' is distinct from '1' or p->>'parser_version' is distinct from 'vinted-gmail-v1'
 or jsonb_typeof(p->'expires_at') is distinct from 'number' or (p->>'expires_at')::numeric<extract(epoch from clock_timestamp()) or (p->>'expires_at')::numeric>extract(epoch from clock_timestamp())+600
 or jsonb_typeof(p->'received_at') is distinct from 'number' or jsonb_typeof(p->'captured_at') is distinct from 'number'
 or jsonb_typeof(p->'message_id') is distinct from 'string' or p->>'message_id' !~ '^[A-Za-z0-9_-]{1,128}$'
 or jsonb_typeof(p->'thread_id') is distinct from 'string' or p->>'thread_id' !~ '^[A-Za-z0-9_-]{1,128}$'
 or jsonb_typeof(p->'source_sha256') is distinct from 'string' or p->>'source_sha256' !~ '^[a-f0-9]{64}$'
 or jsonb_typeof(p->'kind') is distinct from 'string' or p->>'kind' not in ('sale_notification','shipping_notification','cancellation_notification','unknown') then raise exception 'Invalid Gmail receipt' using errcode='22023'; end if;
 if (p->>'received_at')::numeric<0 or (p->>'received_at')::numeric<>trunc((p->>'received_at')::numeric)
 or (p->>'captured_at')::numeric<>trunc((p->>'captured_at')::numeric)
 or (p->>'received_at')::numeric>(p->>'captured_at')::numeric
 or (p->>'captured_at')::numeric<extract(epoch from clock_timestamp())*1000-600000
 or (p->>'captured_at')::numeric>extract(epoch from clock_timestamp())*1000+30000 then raise exception 'Invalid receipt timestamps' using errcode='22023'; end if;
 nonce_id:=(p->>'nonce')::uuid;
 if nonce_id is null then raise exception 'Ingress nonce required' using errcode='22023'; end if;
 f:=private.gmail_require_lease((p->>'feed_id')::uuid,(p->>'lease_token')::uuid);
 if (p->>'account_id')::uuid is distinct from f.account_id or p->>'parser_version'<>f.parser_version
 or not exists(select 1 from public.resale_accounts a where a.id=f.account_id and a.marketplace='vinted' and lower(a.username)=f.account_handle) then raise exception 'Feed account or parser binding mismatch' using errcode='22023'; end if;
 select cursor into cursor_value from private.resale_gmail_runtime where feed_id=f.id;
 if cursor_value is null or (cursor_value->>'window_complete')::boolean
 or (p->>'received_at')::numeric<(cursor_value->>'window_start_ms')::numeric or (p->>'received_at')::numeric>(cursor_value->>'window_end_ms')::numeric then raise exception 'Message outside checkpointed Gmail window' using errcode='22023'; end if;
 normalized:=p->'normalized'; kind:=p->>'kind'; perform private.gmail_validate_normalized(normalized,kind,f.account_handle);
 receipt_hash:=encode(extensions.digest(convert_to(p_receipt,'UTF8'),'sha256'),'hex');
 semantic:=encode(extensions.digest(convert_to((p-array['nonce','lease_token','captured_at','expires_at'])::text,'UTF8'),'sha256'),'hex');
 mid:=p->>'message_id';
 perform pg_advisory_xact_lock(hashtextextended(nonce_id::text,7304));
 select receipt_sha256 into previous_hash from private.resale_gmail_ingress_receipts where nonce=nonce_id;
 if found and previous_hash<>receipt_hash then raise exception 'Ingress nonce reused with changed receipt' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(f.id::text||':'||mid,7305));
 select * into old from private.resale_gmail_messages where feed_id=f.id and message_id=mid;
 if found then
 if old.semantic_sha256<>semantic then raise exception 'Existing message evidence differs; append a reviewed correction, never overwrite' using errcode='22023'; end if;
 insert into private.resale_gmail_ingress_receipts(nonce,receipt_sha256,feed_id,message_id) values(nonce_id,receipt_hash,f.id,mid) on conflict(nonce) do nothing;
 return jsonb_build_object('source_record_id',old.source_record_id,'operation_id',old.operation_id,'duplicate',true,'legacy_source_reused',old.legacy_source_reused);
 end if;
 received:=to_timestamp((p->>'received_at')::numeric/1000); captured:=to_timestamp((p->>'captured_at')::numeric/1000);
 select count(*),(array_agg(s.id order by s.id))[1] into legacy_count,source_id from public.resale_source_records s
 where s.account_id=f.account_id and s.source_kind='email' and s.external_identifiers->>'gmail_message_id'=mid;
 if legacy_count>1 then raise exception 'Legacy message identity is ambiguous; reconcile existing sources first' using errcode='22023'; end if;
 if legacy_count=1 then legacy:=true; select s.snapshot_id into snapshot_id from public.resale_source_records s where s.id=source_id;
 else
 snapshot_id:=gen_random_uuid(); source_id:=gen_random_uuid();
 insert into public.resale_snapshots(id,account_id,source,source_ref,observed_at,scope,coverage,record_count,captured_at)
 values(snapshot_id,f.account_id,'official_api','gmail:message:'||mid,captured,'One Gmail API message parsed by vinted-gmail-v1. Complete for this message only; received time is not a marketplace transaction instant.','complete',1,captured);
 insert into public.resale_source_records(id,snapshot_id,account_id,record_key,source_kind,source_row_sha256,raw_business,normalized,external_identifiers,event_precision,event_time,source_observed_at,captured_at,record_status,review_reason)
 values(source_id,snapshot_id,f.account_id,'gmail:'||f.mailbox_email||':'||mid,'email',p->>'source_sha256',
 jsonb_build_object('gmail_message_id',mid,'gmail_thread_id',p->>'thread_id','received_at',received,'kind',kind,'source_projection_sha256',p->>'source_sha256','authentication_pass',normalized->'authentication_pass'),
 normalized||jsonb_build_object('parser_version',f.parser_version,'notification_kind',kind,'event_time_semantics','Gmail receipt time only; marketplace transaction time unknown'),
 jsonb_build_object('gmail_message_id',mid,'gmail_thread_id',p->>'thread_id','transaction_id',normalized->'transaction_id','order_id',null,'listing_id',null),
 'unknown',null,received,captured,case when normalized->>'parser_status'='quarantined' then 'quarantined' else 'accepted' end,
 case when normalized->>'parser_status'='quarantined' then 'Parser quarantine: '||(normalized->>'quarantine_reason') else null end);
 end if;
 operation_id:=gen_random_uuid(); operation_request:=gen_random_uuid();
 action_kind:=case kind when 'sale_notification' then 'reconcile_sale' when 'shipping_notification' then 'reconcile_shipping' when 'cancellation_notification' then 'reconcile_cancellation' else 'import' end;
 payload:=jsonb_build_object('source_record_ids',jsonb_build_array(source_id),'snapshot_ids',jsonb_build_array(snapshot_id),'note','Gmail notification evidence only; verify exact marketplace transaction and physical unit before any sale or stock change.');
 insert into public.resale_actions(id,target_account_id,action,state,idempotency_key,reason,payload,operation_protocol,execution_mode,adapter_key,adapter_version,trigger_ref,desired_sha256,target_identity,blockers,next_step)
 values(operation_id,f.account_id,action_kind,'blocked','gmail:'||f.id::text||':'||mid,'Notification evidence needs an explicit reconciliation decision',payload,1,'human_required','vinted-gmail','v1',
 jsonb_build_object('kind','source_record','id',source_id),encode(extensions.digest(convert_to(payload::text,'UTF8'),'sha256'),'hex'),jsonb_build_object('account_id',f.account_id,'feed_id',f.id,'gmail_message_id',mid),
 jsonb_build_array(jsonb_build_object('code',case when normalized->>'parser_status'='quarantined' then 'source_conflict' else 'identity_review' end,'message','A notification is not a verified order or physical-item match.')),
 jsonb_build_object('key','review_evidence','label','Review shop notification','explanation','Check the shop transaction and item identity. No sale, shipment, stock update or delisting has been performed.'));
 insert into private.resale_operation_requests(request_id,actor_id,operation_id,payload)
 values(operation_request,f.owner_id,operation_id,jsonb_build_object('origin','enrolled_gmail_feed','feed_id',f.id,'gmail_message_id',mid,'requested',payload));
 if legacy or normalized->>'parser_status'='quarantined' then
 review_id:=gen_random_uuid();
 insert into public.resale_review_cases(id,reason,evidence) values(review_id,
 case when legacy then 'New deterministic Gmail parser facts need comparison with retained historical evidence' else 'Gmail message could not be safely classified; source quarantined' end,
 jsonb_build_object('source_record_id',source_id,'operation_id',operation_id,'feed_id',f.id,'gmail_message_id',mid,'parser_version',f.parser_version,'new_parser_facts',normalized,'source_projection_sha256',p->>'source_sha256','legacy_source_reused',legacy,'canonical_effect','none'));
 end if;
 insert into private.resale_gmail_messages(feed_id,message_id,semantic_sha256,source_record_id,operation_id,legacy_source_reused) values(f.id,mid,semantic,source_id,operation_id,legacy);
 insert into private.resale_gmail_ingress_receipts(nonce,receipt_sha256,feed_id,message_id) values(nonce_id,receipt_hash,f.id,mid);
 return jsonb_build_object('source_record_id',source_id,'operation_id',operation_id,'duplicate',false,'legacy_source_reused',legacy);
end $$;

-- Credential-bearing and ingestion capabilities are service-only, never PUBLIC or member RPCs.
revoke all on function public.resale_gmail_oauth_start(uuid,uuid,text,text,text),public.resale_gmail_oauth_consume(text,text),public.resale_gmail_oauth_complete(uuid,text,text[],text),
 public.resale_gmail_verify_tick_and_claim(text,text),public.resale_gmail_checkpoint_run(uuid,uuid,jsonb),public.resale_gmail_finish_run(uuid,uuid,text,jsonb,text),public.resale_ingest_gmail_message(text,text) from public,anon,authenticated;
grant execute on function public.resale_gmail_oauth_start(uuid,uuid,text,text,text),public.resale_gmail_oauth_consume(text,text),public.resale_gmail_oauth_complete(uuid,text,text[],text),
 public.resale_gmail_verify_tick_and_claim(text,text),public.resale_gmail_checkpoint_run(uuid,uuid,jsonb),public.resale_gmail_finish_run(uuid,uuid,text,jsonb,text),public.resale_ingest_gmail_message(text,text) to service_role;
commit;
