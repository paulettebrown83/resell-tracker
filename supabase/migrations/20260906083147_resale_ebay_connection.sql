begin;
-- Unactivated foundation: configuration is deliberately absent until developer recovery and deletion coverage review.
create table public.resale_ebay_connections (
 account_id uuid primary key references public.resale_accounts(id),owner_id uuid not null references auth.users(id),
 status text not null default 'setup_required' check(status in ('setup_required','connected','paused','reconnect_required','deletion_pending')),
 generation bigint not null default 1,last_verified_at timestamptz,last_read_at timestamptz,last_error text,
 created_at timestamptz not null default now()
);
create table private.resale_ebay_config (
 singleton boolean primary key default true check(singleton), client_id text not null,runame text not null,trading_version text not null check(trading_version~'^\d{3,4}$'),
 callback text not null check(callback='https://resell-tracker-beta.vercel.app/api/integrations/ebay/callback'),
 deletion_endpoint text not null check(deletion_endpoint='https://resell-tracker-beta.vercel.app/api/integrations/ebay/deletion'),
 activation_ready boolean not null default false, deletion_receipts_ready boolean not null default false,
 deletion_coverage_review text,revision bigint not null default 1
);
create table private.resale_ebay_tokens (
 account_id uuid primary key references public.resale_ebay_connections(account_id),seller_eias_sha256 text,secret_id uuid,expires_at timestamptz
);
create table private.resale_ebay_states (
 id uuid primary key default gen_random_uuid(),account_id uuid not null references public.resale_ebay_connections(account_id),owner_id uuid not null,
 generation bigint not null,config_revision bigint not null,state_hash text not null unique,browser_hash text not null,
 expires_at timestamptz not null,consumed_at timestamptz,completed_at timestamptz
);
create table public.resale_ebay_reads (
 id uuid primary key,account_id uuid not null references public.resale_ebay_connections(account_id),owner_id uuid not null references auth.users(id),
 kind text not null check(kind in ('listings','orders')),page integer not null check(page between 1 and 100),window_from timestamptz,window_to timestamptz,
 status text not null check(status in ('pending','complete','failed')), result jsonb,error_code text,created_at timestamptz not null default now(),completed_at timestamptz
);
create table private.resale_ebay_read_leases (
 request_id uuid primary key references public.resale_ebay_reads(id) on delete cascade,lease uuid not null,generation bigint not null,config_revision bigint not null,expires_at timestamptz not null
);
create table private.resale_ebay_read_subjects (request_id uuid not null references public.resale_ebay_reads(id) on delete cascade,eias_sha256 text,handle_sha256 text);
create index ebay_read_subject_eias on private.resale_ebay_read_subjects(eias_sha256);
create index ebay_read_subject_handle on private.resale_ebay_read_subjects(handle_sha256);
create table private.resale_ebay_deletions (
 event_id text primary key, event_at timestamptz not null,subject_eias_sha256 text not null,subject_user_sha256 text not null,subject_handle_sha256 text not null,
 received_at timestamptz not null default now(),connection_purged_at timestamptz,
 historical_status text not null default 'review_pending' check(historical_status in ('review_pending','complete')),
 historical_receipt jsonb
);
do $$ declare t text;begin
 foreach t in array array['resale_ebay_config','resale_ebay_tokens','resale_ebay_states','resale_ebay_read_leases','resale_ebay_read_subjects','resale_ebay_deletions'] loop
 execute format('alter table private.%I enable row level security',t);execute format('revoke all on private.%I from public,anon,authenticated,service_role',t);end loop;
 foreach t in array array['resale_ebay_connections','resale_ebay_reads'] loop
 execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 execute format('grant select on public.%I to authenticated,service_role',t);
 execute format('create policy owner_read on public.%I for select to authenticated using(owner_id=(select auth.uid()) and (select private.has_access(''resale'')))',t);end loop;
end $$;
create function private.ebay_owner(p_member uuid,p_account uuid) returns public.resale_ebay_connections language plpgsql set search_path='' as $$
declare c public.resale_ebay_connections; a public.resale_accounts;begin
 perform 1 from private.memberships where user_id=p_member and area='resale' for share;
 if p_member is null or not found then raise exception 'Resale membership required' using errcode='42501';end if;
 select * into c from public.resale_ebay_connections where account_id=p_account for update;
 if not found or c.owner_id<>p_member then raise exception 'Connection ownership required' using errcode='42501';end if;
 select * into a from public.resale_accounts where id=p_account for share;
 if not found or a.marketplace is distinct from 'ebay' or lower(a.username) is distinct from 'paulbr-89' then raise exception 'Account binding changed' using errcode='42501';end if;return c;
end $$;
create function private.ebay_config_json() returns jsonb language plpgsql set search_path='' as $$
declare c private.resale_ebay_config;begin select * into c from private.resale_ebay_config where singleton for share;
 if not found or not c.activation_ready or not c.deletion_receipts_ready or nullif(c.deletion_coverage_review,'') is null then raise exception 'eBay setup required' using errcode='55000';end if;
 return to_jsonb(c)||jsonb_build_object('expected_handle','paulbr-89');end $$;
create function private.ebay_client_secret() returns text language plpgsql set search_path='' as $$
declare v text;n integer;begin select count(*),min(decrypted_secret) into n,v from vault.decrypted_secrets where name='resale_ebay_production_oauth_client_secret';
 if n<>1 or nullif(v,'') is null then raise exception 'eBay client credential missing' using errcode='55000';end if;return v;end $$;
create function private.ebay_config_fence() returns trigger language plpgsql security definer set search_path='' as $$ begin
 new.revision:=old.revision+1;
 update public.resale_ebay_connections set generation=generation+1,status=case when status='deletion_pending' then status else 'reconnect_required' end,last_error='configuration_changed';
 delete from private.resale_ebay_states;delete from private.resale_ebay_read_leases;return new;end $$;
create trigger ebay_config_change before update on private.resale_ebay_config for each row execute function private.ebay_config_fence();

create function public.resale_ebay_enroll(p_account_id uuid) returns public.resale_ebay_connections language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();a public.resale_accounts;c public.resale_ebay_connections;begin
 perform 1 from private.memberships where user_id=actor and area='resale' for share;if actor is null or not found then raise exception 'Membership required' using errcode='42501';end if;
 select * into a from public.resale_accounts where id=p_account_id for share;if not found or a.marketplace is distinct from 'ebay' or lower(a.username) is distinct from 'paulbr-89' then raise exception 'Verified eBay account required' using errcode='22023';end if;
 insert into public.resale_ebay_connections(account_id,owner_id) values(p_account_id,actor) on conflict do nothing;
 c:=private.ebay_owner(actor,p_account_id);insert into private.resale_ebay_tokens(account_id) values(p_account_id) on conflict do nothing;return c;end $$;
create function public.resale_ebay_pause(p_account_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare c public.resale_ebay_connections;begin c:=private.ebay_owner(auth.uid(),p_account_id);
 update public.resale_ebay_connections set status=case when status='deletion_pending' then status else 'paused' end,generation=generation+1,last_error='paused_by_owner' where account_id=p_account_id;
 delete from private.resale_ebay_states where account_id=p_account_id;delete from private.resale_ebay_read_leases where request_id in(select id from public.resale_ebay_reads where account_id=p_account_id);end $$;
create function public.resale_ebay_oauth_start(p_member_id uuid,p_account_id uuid,p_state_hash text,p_browser_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.resale_ebay_connections;cfg jsonb;begin c:=private.ebay_owner(p_member_id,p_account_id);cfg:=private.ebay_config_json();
 if c.status='deletion_pending' then raise exception 'Deletion pending' using errcode='42501';end if;
 if p_state_hash is null or p_state_hash!~'^[a-f0-9]{64}$' or p_browser_hash is null or p_browser_hash!~'^[a-f0-9]{64}$' then raise exception 'Invalid OAuth binding' using errcode='22023';end if;
 delete from private.resale_ebay_states where account_id=p_account_id;
 insert into private.resale_ebay_states(account_id,owner_id,generation,config_revision,state_hash,browser_hash,expires_at) values(p_account_id,p_member_id,c.generation,(cfg->>'revision')::bigint,p_state_hash,p_browser_hash,clock_timestamp()+interval '10 minutes');return cfg;end $$;
create function public.resale_ebay_oauth_consume(p_state_hash text,p_browser_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.resale_ebay_states;c public.resale_ebay_connections;cfg jsonb;t private.resale_ebay_tokens;begin
 select * into s from private.resale_ebay_states where state_hash=p_state_hash;if not found then raise exception 'OAuth state expired' using errcode='22023';end if;
 c:=private.ebay_owner(s.owner_id,s.account_id);cfg:=private.ebay_config_json();
 select * into s from private.resale_ebay_states where state_hash=p_state_hash for update;
 if not found or s.browser_hash is distinct from p_browser_hash or s.expires_at<clock_timestamp() or s.consumed_at is not null or s.generation<>c.generation or s.config_revision<>(cfg->>'revision')::bigint or c.status='deletion_pending' then raise exception 'OAuth state expired' using errcode='22023';end if;
 update private.resale_ebay_states set consumed_at=clock_timestamp() where id=s.id;select * into t from private.resale_ebay_tokens where account_id=c.account_id;
 return cfg||jsonb_build_object('state_id',s.id,'client_secret',private.ebay_client_secret(),'seller_eias_sha256',t.seller_eias_sha256);end $$;
create function public.resale_ebay_oauth_complete(p_state_id uuid,p_handle text,p_eias_hash text,p_refresh_token text,p_refresh_seconds integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.resale_ebay_states;c public.resale_ebay_connections;cfg jsonb;t private.resale_ebay_tokens;sid uuid;begin
 select * into s from private.resale_ebay_states where id=p_state_id;if not found then raise exception 'OAuth state expired' using errcode='22023';end if;
 perform pg_advisory_xact_lock(98340001);c:=private.ebay_owner(s.owner_id,s.account_id);cfg:=private.ebay_config_json();select * into s from private.resale_ebay_states where id=p_state_id for update;
 if not found or s.expires_at<clock_timestamp() or s.consumed_at is null or s.completed_at is not null or s.generation<>c.generation or s.config_revision<>(cfg->>'revision')::bigint or c.status='deletion_pending' then raise exception 'OAuth state expired' using errcode='22023';end if;
 if lower(p_handle) is distinct from 'paulbr-89' or p_eias_hash is null or p_eias_hash!~'^[a-f0-9]{64}$' or p_refresh_token is null or length(p_refresh_token) not between 1 and 8192 or p_refresh_seconds is null or p_refresh_seconds not between 60 and 63072000 then raise exception 'Invalid seller/token binding' using errcode='22023';end if;
 select * into t from private.resale_ebay_tokens where account_id=c.account_id for update;
 if (t.seller_eias_sha256 is not null and t.seller_eias_sha256<>p_eias_hash) or exists(select 1 from private.resale_ebay_deletions where subject_eias_sha256=p_eias_hash) then raise exception 'Seller identity changed or deleted' using errcode='42501';end if;
 if t.secret_id is null then select vault.create_secret(p_refresh_token,'resale_ebay_production_account_'||c.account_id::text||'_refresh_token','eBay read connection; owner-bound Edge consumer') into sid;
 else perform vault.update_secret(t.secret_id,p_refresh_token);sid:=t.secret_id;end if;
 update private.resale_ebay_tokens set seller_eias_sha256=p_eias_hash,secret_id=sid,expires_at=clock_timestamp()+make_interval(secs=>p_refresh_seconds) where account_id=c.account_id;
 update private.resale_ebay_states set completed_at=clock_timestamp() where id=s.id;
 update public.resale_ebay_connections set status='connected',last_verified_at=clock_timestamp(),last_error=null,generation=generation+1 where account_id=c.account_id;
 return jsonb_build_object('status','connected','account_id',c.account_id);end $$;

create function public.resale_ebay_claim_read(p_member_id uuid,p_account_id uuid,p_request_id uuid,p_kind text,p_page integer,p_from timestamptz,p_to timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.resale_ebay_connections;cfg jsonb;r public.resale_ebay_reads;l private.resale_ebay_read_leases;t private.resale_ebay_tokens;v text;begin
 c:=private.ebay_owner(p_member_id,p_account_id);cfg:=private.ebay_config_json();
 if c.status<>'connected' then raise exception 'Connection not active' using errcode='42501';end if;
 if p_request_id is null or p_kind is null or p_kind not in ('listings','orders') or p_page is null or p_page not between 1 and 100 or (p_kind='listings' and (p_from is not null or p_to is not null)) or (p_kind='orders' and (p_from is null or p_to is null or p_from>=p_to or p_from<clock_timestamp()-interval '89 days' or p_to>clock_timestamp()-interval '2 minutes' or p_to-p_from>interval '30 days')) then raise exception 'Invalid read window' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,9832));
 select * into r from public.resale_ebay_reads where id=p_request_id for update;
 if found then
 if r.owner_id<>p_member_id or r.account_id<>p_account_id or r.kind<>p_kind or r.page<>p_page or r.window_from is distinct from p_from or r.window_to is distinct from p_to then raise exception 'Changed retry' using errcode='22023';end if;
 if r.status='complete' then return jsonb_build_object('cached',true,'result',jsonb_build_object('request_id',r.id,'status','complete','result',r.result));end if;
 else insert into public.resale_ebay_reads(id,account_id,owner_id,kind,page,window_from,window_to,status) values(p_request_id,p_account_id,p_member_id,p_kind,p_page,p_from,p_to,'pending');end if;
 select * into l from private.resale_ebay_read_leases where request_id=p_request_id for update;
 if found and l.expires_at>clock_timestamp() then raise exception 'Read already running' using errcode='55000';end if;
 if exists(select 1 from private.resale_ebay_read_leases leases join public.resale_ebay_reads reads on reads.id=leases.request_id where reads.account_id=c.account_id and leases.expires_at>clock_timestamp()) then raise exception 'Account read already running' using errcode='55000';end if;
 select * into t from private.resale_ebay_tokens where account_id=c.account_id;
 if t.secret_id is null or t.expires_at<clock_timestamp() then raise exception 'Reconnect required' using errcode='55000';end if;
 select decrypted_secret into v from vault.decrypted_secrets where id=t.secret_id and name='resale_ebay_production_account_'||c.account_id::text||'_refresh_token';if nullif(v,'') is null then raise exception 'Reconnect required' using errcode='55000';end if;
 insert into private.resale_ebay_read_leases values(p_request_id,gen_random_uuid(),c.generation,(cfg->>'revision')::bigint,clock_timestamp()+interval '90 seconds') on conflict(request_id) do update set lease=excluded.lease,generation=excluded.generation,config_revision=excluded.config_revision,expires_at=excluded.expires_at returning * into l;
 update public.resale_ebay_reads set status='pending',error_code=null where id=p_request_id;
 return cfg||jsonb_build_object('lease',l.lease,'refresh_token',v,'client_secret',private.ebay_client_secret(),'seller_eias_sha256',t.seller_eias_sha256,'window_from',p_from,'window_to',p_to);end $$;
create function public.resale_ebay_finish_read(p_member_id uuid,p_request_id uuid,p_lease uuid,p_result jsonb,p_error text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.resale_ebay_reads;c public.resale_ebay_connections;l private.resale_ebay_read_leases;cfg jsonb;begin
 perform pg_advisory_xact_lock(98340001);select * into r from public.resale_ebay_reads where id=p_request_id;if not found then raise exception 'Read not found' using errcode='22023';end if;
 c:=private.ebay_owner(p_member_id,r.account_id);cfg:=private.ebay_config_json();select * into r from public.resale_ebay_reads where id=p_request_id for update;select * into l from private.resale_ebay_read_leases where request_id=p_request_id for update;
 if not found or r.owner_id<>p_member_id or l.lease is distinct from p_lease or l.expires_at<clock_timestamp() or l.generation<>c.generation or l.config_revision<>(cfg->>'revision')::bigint or c.status<>'connected' then raise exception 'Read lease expired' using errcode='42501';end if;
 if (p_result is null)=(p_error is null) or (p_error is not null and p_error!~'^[a-z_]{1,64}$') or (p_result is not null and (jsonb_typeof(p_result)<>'object' or octet_length(p_result::text)>524288 or jsonb_typeof(p_result->'records') is distinct from 'array' or jsonb_array_length(p_result->'records')>50 or p_result->>'source_sha256' is null or p_result->>'source_sha256'!~'^[a-f0-9]{64}$' or (p_result->>'page')::integer<>r.page)) then raise exception 'Invalid read result' using errcode='22023';end if;
 if p_result is not null and r.kind='orders' then
 if jsonb_typeof(p_result->'deletion_subjects') is distinct from 'array' or jsonb_array_length(p_result->'deletion_subjects')<>jsonb_array_length(p_result->'records') or exists(select 1 from jsonb_array_elements(p_result->'deletion_subjects') x where (x->>'eias_sha256' is null and x->>'handle_sha256' is null) or (x->>'eias_sha256' is not null and x->>'eias_sha256'!~'^[a-f0-9]{64}$') or (x->>'handle_sha256' is not null and x->>'handle_sha256'!~'^[a-f0-9]{64}$')) then raise exception 'Buyer deletion binding required' using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(p_result->'deletion_subjects') x join private.resale_ebay_deletions d on d.subject_eias_sha256=x->>'eias_sha256' or d.subject_handle_sha256=x->>'handle_sha256') then raise exception 'Subject deletion pending' using errcode='42501';end if;
 insert into private.resale_ebay_read_subjects(request_id,eias_sha256,handle_sha256) select r.id,x->>'eias_sha256',x->>'handle_sha256' from jsonb_array_elements(p_result->'deletion_subjects') x;end if;
 update public.resale_ebay_reads set status=case when p_error is null then 'complete' else 'failed' end,result=p_result-'deletion_subjects',error_code=p_error,completed_at=clock_timestamp() where id=r.id;
 delete from private.resale_ebay_read_leases where request_id=r.id;
 update public.resale_ebay_connections set last_read_at=case when p_error is null then clock_timestamp() else last_read_at end,last_error=p_error,status=case when p_error in ('wrong_seller','access_denied','reconnect_required') then 'reconnect_required' else status end where account_id=c.account_id;
 return jsonb_build_object('request_id',r.id,'status',case when p_error is null then 'complete' else 'failed' end,'result',p_result-'deletion_subjects');end $$;

create function public.resale_ebay_deletion_config() returns jsonb language plpgsql security definer set search_path='' as $$
declare c private.resale_ebay_config;v text;begin select * into c from private.resale_ebay_config where singleton for share;
 if not found or not c.deletion_receipts_ready then raise exception 'Deletion endpoint setup required' using errcode='55000';end if;
 select decrypted_secret into v from vault.decrypted_secrets where name='resale_ebay_production_deletion_verification_token';
 if v is null or v!~'^[A-Za-z0-9_-]{32,80}$' then raise exception 'Deletion verification token missing' using errcode='55000';end if;
 return jsonb_build_object('client_id',c.client_id,'client_secret',private.ebay_client_secret(),'deletion_endpoint',c.deletion_endpoint,'verification_token',v);end $$;
create function public.resale_ebay_deletion_receive(p_notice jsonb) returns void language plpgsql security definer set search_path='' as $$
declare old private.resale_ebay_deletions; a uuid;t private.resale_ebay_tokens;begin
 if p_notice is null or jsonb_typeof(p_notice)<>'object' or exists(select 1 from jsonb_object_keys(p_notice) k where k not in ('event_id','event_at','subject_eias_sha256','subject_user_sha256','subject_handle_sha256')) or coalesce(length(p_notice->>'event_id'),0) not between 1 and 160 or p_notice->>'event_at' is null or p_notice->>'subject_eias_sha256' is null or p_notice->>'subject_eias_sha256'!~'^[a-f0-9]{64}$' or p_notice->>'subject_user_sha256' is null or p_notice->>'subject_user_sha256'!~'^[a-f0-9]{64}$' or p_notice->>'subject_handle_sha256' is null or p_notice->>'subject_handle_sha256'!~'^[a-f0-9]{64}$' then raise exception 'Invalid deletion receipt' using errcode='22023';end if;
 perform pg_advisory_xact_lock(98340001);perform pg_advisory_xact_lock(hashtextextended(p_notice->>'event_id',9833));select * into old from private.resale_ebay_deletions where event_id=p_notice->>'event_id';
 if found then if old.event_at<>(p_notice->>'event_at')::timestamptz or old.subject_eias_sha256<>p_notice->>'subject_eias_sha256' or old.subject_user_sha256<>p_notice->>'subject_user_sha256' or old.subject_handle_sha256<>p_notice->>'subject_handle_sha256' then raise exception 'Deletion event changed' using errcode='22023';end if;return;end if;
 insert into private.resale_ebay_deletions(event_id,event_at,subject_eias_sha256,subject_user_sha256,subject_handle_sha256) values(p_notice->>'event_id',(p_notice->>'event_at')::timestamptz,p_notice->>'subject_eias_sha256',p_notice->>'subject_user_sha256',p_notice->>'subject_handle_sha256');
 delete from public.resale_ebay_reads where id in(select request_id from private.resale_ebay_read_subjects where eias_sha256=p_notice->>'subject_eias_sha256' or handle_sha256=p_notice->>'subject_handle_sha256');
 -- This consumer immediately purges only this API integration's own read records/tokens.
 -- Historical exports/source records require the separately documented reviewed erasure workflow.
 for a in select account_id from private.resale_ebay_tokens where seller_eias_sha256=p_notice->>'subject_eias_sha256' order by account_id loop
 perform 1 from public.resale_ebay_connections where account_id=a for update;
 select * into t from private.resale_ebay_tokens where account_id=a for update;
 update public.resale_ebay_connections set status='deletion_pending',generation=generation+1,last_error='historical_deletion_review_pending' where account_id=a;
 delete from private.resale_ebay_states where account_id=a;delete from public.resale_ebay_reads where account_id=a;
 delete from vault.secrets where id=t.secret_id and name='resale_ebay_production_account_'||a::text||'_refresh_token';
 update private.resale_ebay_tokens set secret_id=null,expires_at=null where account_id=a;
 end loop;
 update private.resale_ebay_deletions set connection_purged_at=clock_timestamp() where event_id=p_notice->>'event_id';end $$;
create function public.resale_ebay_setup_status() returns boolean language plpgsql security definer set search_path='' as $$ begin
 if not private.has_access('resale') then raise exception 'Membership required' using errcode='42501';end if;
 return exists(select 1 from private.resale_ebay_config where singleton and activation_ready and deletion_receipts_ready and nullif(deletion_coverage_review,'') is not null);
end $$;
-- Prevent SQL-only callers from reaching secrets. Edge alone verifies bearer/provider signature.
do $$ declare r record;begin
 for r in select p.oid::regprocedure signature,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='private' and p.proname like 'ebay_%') or (n.nspname='public' and p.proname like 'resale_ebay_%') loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',r.signature);
 if r.nspname='public' then execute format('grant execute on function %s to %I',r.signature,case when r.proname in ('resale_ebay_enroll','resale_ebay_pause','resale_ebay_setup_status') then 'authenticated' else 'service_role' end);end if;end loop;
end $$;
commit;
