-- Additive resale namespace. No inferred links or marketplace changes; preserve legacy rows.
begin;
create extension if not exists pgcrypto with schema extensions;
alter table public.inventory alter column item_cost drop not null;
create table public.resale_item_details (
 inventory_id uuid primary key references public.inventory(id), sku text unique, description text,
 brand text, category text, condition text, size text, color text, material text,
 measurements jsonb not null default '{}' check(jsonb_typeof(measurements)='object'),
 weight_grams numeric check(weight_grams>0 and weight_grams<1000000), location text,
 attributes jsonb not null default '{}' check(jsonb_typeof(attributes)='object'),
 workflow text not null default 'draft' check(workflow in ('draft','needs_details','ready','archived')),
 version integer not null default 1, updated_at timestamptz not null default now()
);
create table public.resale_accounts (
 id uuid primary key default gen_random_uuid(), marketplace text not null, account_alias text not null,
 external_account_id text, username text, profile_url text,
 login_method text not null default 'unknown' check(login_method in ('unknown','password','google','apple','email_link','other')),
 connection_status text not null default 'unverified' check(connection_status in ('unverified','manual','connected','expired','blocked')),
 capabilities jsonb not null default '{}' check(jsonb_typeof(capabilities)='object'),
 verified_at timestamptz, created_at timestamptz not null default now(), unique(marketplace,account_alias),
 check(marketplace ~ '^[a-z][a-z0-9_-]+$'), check(account_alias ~ '^[a-z][a-z0-9_-]+$')
);
create unique index resale_account_external on public.resale_accounts(marketplace,external_account_id) where external_account_id is not null;
-- Credentials never enter browser-visible account rows. References only, no secret values.
create table private.resale_account_credentials (
 account_id uuid not null references public.resale_accounts(id), purpose text not null,
 vault_secret_name text not null, environment text not null, consumer text not null,
 verified_at timestamptz, primary key(account_id,purpose,environment),
 check(vault_secret_name like 'resale\_%' escape '\')
);
create table public.resale_snapshots (
 id uuid primary key default gen_random_uuid(), account_id uuid not null references public.resale_accounts(id),
 source text not null check(source in ('manual','official_api','export','browser')), source_ref text not null,
 observed_at timestamptz not null, scope text not null,
 coverage text not null check(coverage in ('unknown','partial','complete')), cursor text,
 record_count integer check(record_count>=0), captured_at timestamptz not null default now(), unique(id,account_id)
);
create table public.resale_listings (
 id uuid primary key default gen_random_uuid(), account_id uuid not null references public.resale_accounts(id),
 external_listing_id text, external_identifiers jsonb not null default '{}' check(jsonb_typeof(external_identifiers)='object'),
 inventory_id uuid references public.inventory(id),
 match_status text not null default 'unmatched' check(match_status in ('unmatched','proposed','confirmed','rejected')),
 match_evidence jsonb not null default '{}' check(jsonb_typeof(match_evidence)='object'),
 matched_by uuid references auth.users(id), matched_at timestamptz,
 title text, listing_url text, desired_fields jsonb not null default '{}' check(jsonb_typeof(desired_fields)='object'),
 asking_price numeric(12,2) check(asking_price>=0 and asking_price<100000000), currency text check(currency ~ '^[A-Z]{3}$'),
 observed_status text not null default 'unknown' check(observed_status in ('unknown','draft','active','reserved','sold','ended','removed')),
 observed_at timestamptz, observation_id uuid,
 unique(account_id,external_listing_id), unique(id,account_id),
 check(match_status<>'confirmed' or (inventory_id is not null and matched_at is not null and match_evidence<>'{}'))
);
create index resale_listings_item on public.resale_listings(inventory_id);
create table public.resale_observations (
 id uuid primary key default gen_random_uuid(), snapshot_id uuid not null, account_id uuid not null,
 listing_id uuid not null, observed_at timestamptz not null,
 status text not null check(status in ('unknown','draft','active','reserved','sold','ended','removed')),
 raw_status text, availability text, external_listing_id text, external_identifiers jsonb not null default '{}',
 evidence jsonb not null default '{}' check(jsonb_typeof(evidence)='object'),
 created_at timestamptz not null default now(),
 foreign key(snapshot_id,account_id) references public.resale_snapshots(id,account_id),
 foreign key(listing_id,account_id) references public.resale_listings(id,account_id), unique(id,listing_id)
);
alter table public.resale_listings add constraint resale_current_observation
 foreign key(observation_id,id) references public.resale_observations(id,listing_id);
create index resale_observations_snapshot on public.resale_observations(snapshot_id);
create index resale_observations_listing_time on public.resale_observations(listing_id,observed_at desc);
create table public.resale_order_lines (
 id uuid primary key default gen_random_uuid(), account_id uuid not null references public.resale_accounts(id),
 external_order_id text not null, external_line_id text not null, listing_id uuid,
 inventory_id uuid references public.inventory(id), sale_id uuid references public.sales(id),
 status text not null default 'unknown' check(status in ('unknown','purchased','completed','cancelled','returned')),
 quantity integer check(quantity>0), currency text check(currency ~ '^[A-Z]{3}$'),
 gross_amount numeric(12,2), fee_amount numeric(12,2), shipping_amount numeric(12,2), net_amount numeric(12,2),
 observed_at timestamptz not null, snapshot_id uuid not null,
 foreign key(snapshot_id,account_id) references public.resale_snapshots(id,account_id),
 foreign key(listing_id,account_id) references public.resale_listings(id,account_id),
 unique(account_id,external_order_id,external_line_id), unique(id,account_id)
);
create table public.resale_order_events (
 id uuid primary key default gen_random_uuid(), account_id uuid not null references public.resale_accounts(id),
 order_line_id uuid, external_event_id text not null, event_type text not null, occurred_at timestamptz not null,
 snapshot_id uuid not null, evidence jsonb not null default '{}' check(jsonb_typeof(evidence)='object'),
 foreign key(order_line_id,account_id) references public.resale_order_lines(id,account_id),
 foreign key(snapshot_id,account_id) references public.resale_snapshots(id,account_id),
 unique(account_id,external_event_id,event_type,occurred_at)
);
create table public.resale_media (
 id uuid primary key default gen_random_uuid(), inventory_id uuid not null references public.inventory(id),
 original_id uuid, kind text not null check(kind in ('original','thumbnail','marketplace')),
 bucket text not null, object_key text not null unique, mime_type text not null,
 byte_size bigint check(byte_size>0), sha256 text check(sha256 ~ '^[a-f0-9]{64}$'),
 width integer check(width>0), height integer check(height>0), position integer not null check(position>=0),
 state text not null default 'pending' check(state in ('pending','ready','failed','quarantined')),
 created_at timestamptz not null default now(), created_by uuid references auth.users(id),
 check((kind='original' and original_id is null) or (kind<>'original' and original_id is not null)),
 check(state<>'ready' or (byte_size is not null and sha256 is not null)),
 check(object_key like 'resale/items/' || inventory_id::text || '/%'),
 unique(id,inventory_id), foreign key(original_id,inventory_id) references public.resale_media(id,inventory_id)
);
create index resale_media_item_position on public.resale_media(inventory_id,position,id);
create table public.resale_review_cases (
 id uuid primary key default gen_random_uuid(), inventory_id uuid references public.inventory(id),
 listing_id uuid references public.resale_listings(id), reason text not null,
 state text not null default 'open' check(state in ('open','resolved','dismissed')),
 evidence jsonb not null default '{}' check(jsonb_typeof(evidence)='object'),
 resolution text, resolved_by uuid references auth.users(id), resolved_at timestamptz,
 created_at timestamptz not null default now(), check(state='open' or (resolution is not null and resolved_at is not null))
);
create table public.resale_actions (
 id uuid primary key default gen_random_uuid(), listing_id uuid not null references public.resale_listings(id),
 sale_id uuid references public.sales(id), target_account_id uuid references public.resale_accounts(id),
 target_external_listing_id text, target_inventory_id uuid references public.inventory(id), action text not null check(action in ('publish','update','delist')),
 state text not null default 'blocked' check(state in ('blocked','queued','running','uncertain','succeeded','failed','cancelled')),
 idempotency_key text not null unique, reason text not null, payload jsonb not null default '{}',
 attempts integer not null default 0 check(attempts>=0), next_attempt_at timestamptz,
 lease_token uuid, lease_expires_at timestamptz, last_error text,
 verification_observation_id uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(verification_observation_id,listing_id) references public.resale_observations(id,listing_id),
 check(action<>'delist' or (target_account_id is not null and target_external_listing_id is not null and target_inventory_id is not null)),
 check(state<>'succeeded' or verification_observation_id is not null),
 check(state<>'running' or (lease_token is not null and lease_expires_at is not null))
);
create index resale_actions_dispatch on public.resale_actions(state,next_attempt_at);
create table public.resale_action_attempts (
 id uuid primary key default gen_random_uuid(), action_id uuid not null references public.resale_actions(id),
 attempt integer not null, started_at timestamptz not null, finished_at timestamptz,
 outcome text check(outcome in ('accepted','verified','rejected','uncertain')), evidence jsonb not null default '{}',
 unique(action_id,attempt)
);
create index resale_action_attempt_parent on public.resale_action_attempts(action_id);
-- All shared resale business data requires resale membership. None of these grants apply to genealogy.
do $$ declare t text; begin
 foreach t in array array['resale_item_details','resale_accounts','resale_snapshots','resale_listings','resale_observations',
 'resale_order_lines','resale_order_events','resale_media','resale_review_cases','resale_actions','resale_action_attempts'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public, anon, authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 execute format('create policy resale_members_read on public.%I for select to authenticated using ((select private.has_access(''resale'')))',t);
 end loop;
end $$;
alter table private.resale_account_credentials enable row level security;
revoke all on private.resale_account_credentials from public,anon,authenticated;
grant all on private.resale_account_credentials to service_role;

-- New item/detail writes are atomic and exact-retry safe. Existing sale RPC remains unchanged.
create table private.resale_item_requests (
 request_id uuid primary key, actor_id uuid not null, payload jsonb not null,
 inventory_id uuid not null references public.inventory(id), created_at timestamptz not null default now()
);
alter table private.resale_item_requests enable row level security;
revoke all on private.resale_item_requests from public,anon,authenticated;
grant all on private.resale_item_requests to service_role;
create function private.resale_save_item(p_request_id uuid,p_payload jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_id uuid; v_req private.resale_item_requests; v_details public.resale_item_details; v_cost numeric;
begin
 if v_actor is null or not private.has_access('resale') then raise exception 'Resale access required' using errcode='42501'; end if;
 if p_request_id is null or p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'Request and item details required' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,1));
 select * into v_req from private.resale_item_requests where request_id=p_request_id;
 if found then
 if v_req.actor_id<>v_actor or v_req.payload<>p_payload then raise exception 'Request reused with changed details' using errcode='22023'; end if;
 return v_req.inventory_id; end if;
 if nullif(btrim(p_payload->>'item_name'),'') is null then raise exception 'Item name required' using errcode='22023'; end if;
 v_cost:=(p_payload->>'item_cost')::numeric;
 if v_cost is not null and (v_cost<0 or v_cost>=100000000 or v_cost<>round(v_cost,2) or v_cost::text in ('NaN','Infinity','-Infinity')) then raise exception 'Invalid cost' using errcode='22023'; end if;
 v_id:=nullif(p_payload->>'id','')::uuid;
 if v_id is null then
 insert into public.inventory(item_name,item_cost,date_added) values(btrim(p_payload->>'item_name'),v_cost,(p_payload->>'date_added')::date) returning id into v_id;
 else
 perform 1 from public.inventory where id=v_id for update;
 if not found then raise exception 'Item not found' using errcode='P0002'; end if;
 select * into v_details from public.resale_item_details where inventory_id=v_id;
 if coalesce(v_details.version,0) is distinct from (p_payload->>'version')::integer then raise exception 'Item changed; reload before editing' using errcode='40001'; end if;
 update public.inventory set item_name=btrim(p_payload->>'item_name'),item_cost=v_cost,
 date_added=case when p_payload?'date_added' then (p_payload->>'date_added')::date else date_added end where id=v_id;
 end if;
 insert into public.resale_item_details(inventory_id) values(v_id) on conflict do nothing;
 -- Partial detail updates preserve unspecified fields and all platform evidence.
 update public.resale_item_details set
 sku=case when p_payload?'sku' then nullif(p_payload->>'sku','') else sku end,
 description=case when p_payload?'description' then p_payload->>'description' else description end,
 brand=case when p_payload?'brand' then p_payload->>'brand' else brand end,
 category=case when p_payload?'category' then p_payload->>'category' else category end,
 condition=case when p_payload?'condition' then p_payload->>'condition' else condition end,
 size=case when p_payload?'size' then p_payload->>'size' else size end,
 color=case when p_payload?'color' then p_payload->>'color' else color end,
 material=case when p_payload?'material' then p_payload->>'material' else material end,
 location=case when p_payload?'location' then p_payload->>'location' else location end,
 weight_grams=case when p_payload?'weight_grams' then (p_payload->>'weight_grams')::numeric else weight_grams end,
 measurements=coalesce(p_payload->'measurements',measurements), attributes=coalesce(p_payload->'attributes',attributes),
 workflow=coalesce(p_payload->>'workflow',workflow), version=coalesce(v_details.version,0)+1,updated_at=now()
 where inventory_id=v_id;
 insert into private.resale_item_requests(request_id,actor_id,payload,inventory_id) values(p_request_id,v_actor,p_payload,v_id);
 return v_id;
end $$;
revoke all on function private.resale_save_item(uuid,jsonb) from public,anon;
grant execute on function private.resale_save_item(uuid,jsonb) to authenticated;
create function public.resale_save_item(p_request_id uuid,p_payload jsonb) returns uuid
language sql security invoker set search_path='' as $$ select private.resale_save_item(p_request_id,p_payload) $$;
revoke all on function public.resale_save_item(uuid,jsonb) from public,anon;
grant execute on function public.resale_save_item(uuid,jsonb) to authenticated;

-- Queue intent in the SAME transaction as existing save_sale. No outbound calls in transactions.
-- Every new job starts blocked until adapter support/account access and current target are verified.
create function private.resale_sale_actions() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.inventory_id is null then return new; end if;
 if lower(coalesce(new.status,''))='void' then
 update public.resale_actions set state=case when state='running' then 'uncertain' else 'cancelled' end,
 reason='Sale voided; inspect marketplace before any further action',updated_at=now()
 where sale_id=new.id and state in ('blocked','queued','running','failed');
 insert into public.resale_review_cases(inventory_id,reason,evidence)
 select new.inventory_id,'Sale voided; verify remaining marketplace listings before relisting',jsonb_build_object('sale_id',new.id)
 where exists(select 1 from public.resale_actions where sale_id=new.id and state in ('uncertain','succeeded'));
 return new;
 end if;
 insert into public.resale_actions(listing_id,sale_id,action,idempotency_key,reason,target_account_id,target_external_listing_id,target_inventory_id)
 select l.id,new.id,'delist','sale:'||new.id::text||':listing:'||l.id::text||':delist',
 'Sale recorded; verify current target and supported execution before delisting',l.account_id,l.external_listing_id,l.inventory_id
 from public.resale_listings l where l.inventory_id=new.inventory_id and l.match_status='confirmed'
 and l.external_listing_id is not null and l.observed_status not in ('sold','ended','removed')
 on conflict(idempotency_key) do nothing;
 return new;
end $$;
revoke all on function private.resale_sale_actions() from public,anon,authenticated;
create trigger resale_sale_actions after insert or update of status on public.sales for each row execute function private.resale_sale_actions();

-- Apply observation evidence atomically; never let an older import overwrite a newer observation.
create function private.resale_apply_observation() returns trigger language plpgsql security definer set search_path='' as $$
declare l public.resale_listings;
begin
 select * into l from public.resale_listings where id=new.listing_id for update;
 if l.observed_at is null or l.observed_at<new.observed_at then
 update public.resale_listings set observed_status=new.status,observed_at=new.observed_at,observation_id=new.id where id=new.listing_id;
 elsif l.observed_at=new.observed_at and l.observed_status<>new.status and l.observation_id is not null then
 insert into public.resale_review_cases(inventory_id,listing_id,reason,evidence)
 values(l.inventory_id,l.id,'Conflicting listing observations at the same time',jsonb_build_object('observation_ids',jsonb_build_array(l.observation_id,new.id)));
 update public.resale_listings set observed_status='unknown',observation_id=null where id=new.listing_id;
 end if;
 return new;
end $$;
revoke all on function private.resale_apply_observation() from public,anon,authenticated;
create trigger resale_apply_observation after insert on public.resale_observations for each row execute function private.resale_apply_observation();
-- Browser reservation establishes immutable upload intent, not proof of stored bytes.
create function private.resale_reserve_media(p_request_id uuid,p_inventory_id uuid,p_mime_type text,p_byte_size bigint)
returns public.resale_media language plpgsql security definer set search_path='' as $$
declare v_media public.resale_media; v_actor uuid:=auth.uid(); v_position integer;
begin
 if v_actor is null or not private.has_access('resale') then raise exception 'Resale access required' using errcode='42501'; end if;
 if p_request_id is null or p_inventory_id is null or p_mime_type is null or p_byte_size is null
 or p_mime_type not in ('image/jpeg','image/png','image/webp','image/gif') or p_byte_size<1 or p_byte_size>20971520 then
 raise exception 'A JPEG, PNG, WebP or GIF up to 20 MiB is required' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,2));
 select * into v_media from public.resale_media where id=p_request_id;
 if found then
 if v_media.inventory_id<>p_inventory_id or v_media.mime_type<>p_mime_type or v_media.byte_size<>p_byte_size or v_media.created_by is distinct from v_actor then
 raise exception 'Upload request reused with changed details' using errcode='22023'; end if;
 return v_media; end if;
 perform 1 from public.inventory where id=p_inventory_id and archived_at is null for update;
 if not found then raise exception 'Item not found or archived' using errcode='P0002'; end if;
 select coalesce(max(position),-1)+1 into v_position from public.resale_media where inventory_id=p_inventory_id;
 insert into public.resale_media(id,inventory_id,kind,bucket,object_key,mime_type,byte_size,position,created_by)
 values(p_request_id,p_inventory_id,'original','paulette-resale-originals-prod',
 'resale/items/'||p_inventory_id::text||'/'||p_request_id::text||'/original',p_mime_type,p_byte_size,v_position,v_actor) returning * into v_media;
 return v_media;
end $$;
revoke all on function private.resale_reserve_media(uuid,uuid,text,bigint) from public,anon;
grant execute on function private.resale_reserve_media(uuid,uuid,text,bigint) to authenticated;
create function public.resale_reserve_media(p_request_id uuid,p_inventory_id uuid,p_mime_type text,p_byte_size bigint)
returns public.resale_media language sql security invoker set search_path='' as $$
 select private.resale_reserve_media(p_request_id,p_inventory_id,p_mime_type,p_byte_size) $$;
revoke all on function public.resale_reserve_media(uuid,uuid,text,bigint) from public,anon;
grant execute on function public.resale_reserve_media(uuid,uuid,text,bigint) to authenticated;

-- Only this function reads the scoped signing key. The Worker sees bytes and signs an expiring receipt;
-- authenticated browser callers can never supply a trusted hash without that proof.
create function private.finalize_resale_media(p_receipt text,p_signature text) returns public.resale_media
language plpgsql security definer set search_path='' as $$
declare v_secret text; v_expected bytea; v_payload jsonb; v_media public.resale_media; v_expiry numeric;
begin
 if auth.uid() is null or not private.has_access('resale') then raise exception 'Resale access required' using errcode='42501'; end if;
 if p_receipt is null or octet_length(p_receipt)>4096 or p_signature is null or p_signature !~ '^[a-f0-9]{64}$' then
 raise exception 'Invalid upload receipt' using errcode='22023'; end if;
 select decrypted_secret into strict v_secret from vault.decrypted_secrets where name='resale_media_production_receipt_signing_key';
 if v_secret is null or v_secret !~ '^[a-f0-9]{64}$' then raise exception 'Media verification unavailable' using errcode='55000'; end if;
 v_expected:=extensions.hmac(convert_to(p_receipt,'UTF8'),decode(v_secret,'hex'),'sha256');
 -- Hash both fixed-size signatures again before equality, so comparison timing cannot expose an HMAC prefix.
 if extensions.digest(decode(p_signature,'hex'),'sha256')<>extensions.digest(v_expected,'sha256') then
 raise exception 'Invalid upload receipt' using errcode='22023'; end if;
 v_payload:=p_receipt::jsonb;
 if jsonb_typeof(v_payload)<>'object' or v_payload->>'v' is distinct from '1' then raise exception 'Unsupported upload receipt' using errcode='22023'; end if;
 v_expiry:=(v_payload->>'expires_at')::numeric;
 if v_expiry is null or v_expiry<=extract(epoch from clock_timestamp()) or v_expiry>extract(epoch from clock_timestamp())+900 or v_expiry<>trunc(v_expiry) then
 raise exception 'Upload receipt expired or invalid' using errcode='22023'; end if;
 select * into v_media from public.resale_media where id=(v_payload->>'media_id')::uuid for update;
 if not found or v_media.state not in ('pending','ready') or v_media.kind<>'original'
 or v_media.inventory_id::text is distinct from v_payload->>'inventory_id'
 or v_media.bucket is distinct from v_payload->>'bucket' or v_media.object_key is distinct from v_payload->>'object_key'
 or v_media.mime_type is distinct from v_payload->>'mime_type'
 or v_media.byte_size is distinct from (v_payload->>'byte_size')::bigint
 or (v_payload->>'sha256') is null or (v_payload->>'sha256') !~ '^[a-f0-9]{64}$' then
 raise exception 'Receipt does not match reserved upload' using errcode='22023'; end if;
 if v_media.state='ready' then
 if v_media.sha256 is distinct from v_payload->>'sha256' then raise exception 'Original is already finalized with different bytes' using errcode='22023'; end if;
 return v_media; end if;
 update public.resale_media set sha256=v_payload->>'sha256',state='ready' where id=v_media.id returning * into v_media;
 return v_media;
end $$;
revoke all on function private.finalize_resale_media(text,text) from public,anon;
grant execute on function private.finalize_resale_media(text,text) to authenticated;
create function public.finalize_resale_media(p_receipt text,p_signature text) returns public.resale_media
language sql security invoker set search_path='' as $$ select private.finalize_resale_media(p_receipt,p_signature) $$;
revoke all on function public.finalize_resale_media(text,text) from public,anon;
grant execute on function public.finalize_resale_media(text,text) to authenticated;
-- Trusted adapter plumbing only. No scheduler or unsupported marketplace adapter is enabled here.
-- Releasing intent requires a fresh observed purchasable target, exact confirmed item, active sale,
-- and explicit supported capability. An uncertain call must get a NEW read before any retry.
create function private.resale_release_delist(p_action_id uuid,p_observation_id uuid) returns public.resale_actions
language plpgsql security invoker set search_path='' as $$
declare a public.resale_actions; l public.resale_listings; o public.resale_observations; c public.resale_accounts;
begin
 select * into a from public.resale_actions where id=p_action_id for update;
 if not found or a.action<>'delist' or a.state not in ('blocked','failed','uncertain') then raise exception 'Action cannot be released' using errcode='22023'; end if;
 select * into l from public.resale_listings where id=a.listing_id;
 select * into c from public.resale_accounts where id=l.account_id;
 select * into o from public.resale_observations where id=p_observation_id and listing_id=l.id;
 if not found or o.id is distinct from l.observation_id
 or l.account_id is distinct from a.target_account_id or l.external_listing_id is distinct from a.target_external_listing_id
 or l.inventory_id is distinct from a.target_inventory_id or o.external_listing_id is distinct from a.target_external_listing_id or o.observed_at<clock_timestamp()-interval '15 minutes'
 or o.observed_at>clock_timestamp() or o.status not in ('active','reserved') or l.match_status<>'confirmed'
 or c.connection_status<>'connected' or c.capabilities->>'delist' is distinct from 'supported'
 or not exists(select 1 from public.sales s where s.id=a.sale_id and s.inventory_id=l.inventory_id and lower(coalesce(s.status,''))<>'void') then
 raise exception 'Fresh target, confirmed sale and supported account required' using errcode='22023'; end if;
 if a.attempts>0 and exists(select 1 from public.resale_action_attempts x where x.action_id=a.id and x.started_at>=o.observed_at) then
 raise exception 'Verify marketplace after previous attempt before retry' using errcode='22023'; end if;
 update public.resale_actions set state='queued',next_attempt_at=now(),last_error=null,updated_at=now()
 where id=a.id returning * into a;
 return a;
end $$;
revoke all on function private.resale_release_delist(uuid,uuid) from public,anon,authenticated;
grant execute on function private.resale_release_delist(uuid,uuid) to service_role;

create function private.resale_claim_delist() returns public.resale_actions
language plpgsql security invoker set search_path='' as $$
declare a public.resale_actions;
begin
 -- Expired leases are uncertain, never blindly placed back on the runnable queue.
 update public.resale_actions set state='uncertain',last_error='Lease expired; verify remote result before retry',updated_at=now()
 where state='running' and lease_expires_at<clock_timestamp();
 select x.* into a from public.resale_actions x join public.resale_listings l on l.id=x.listing_id
 join public.resale_accounts c on c.id=l.account_id
 join public.sales s on s.id=x.sale_id and s.inventory_id=l.inventory_id
 where x.state='queued' and x.action='delist' and coalesce(x.next_attempt_at,now())<=now()
 and l.account_id=x.target_account_id and l.external_listing_id=x.target_external_listing_id and l.inventory_id=x.target_inventory_id
 and exists(select 1 from public.resale_observations o where o.id=l.observation_id and o.external_listing_id=x.target_external_listing_id)
 and l.match_status='confirmed' and l.observed_status in ('active','reserved')
 and l.observed_at>=clock_timestamp()-interval '15 minutes' and l.observed_at<=clock_timestamp()
 and c.connection_status='connected' and c.capabilities->>'delist'='supported' and lower(coalesce(s.status,''))<>'void'
 order by x.created_at,x.id for update of x skip locked limit 1;
 if not found then return null; end if;
 update public.resale_actions set state='running',attempts=attempts+1,lease_token=gen_random_uuid(),
 lease_expires_at=clock_timestamp()+interval '5 minutes',updated_at=now() where id=a.id returning * into a;
 insert into public.resale_action_attempts(action_id,attempt,started_at) values(a.id,a.attempts,clock_timestamp());
 return a;
end $$;
revoke all on function private.resale_claim_delist() from public,anon,authenticated;
grant execute on function private.resale_claim_delist() to service_role;

create function private.resale_finish_delist(p_action_id uuid,p_lease_token uuid,p_outcome text,p_observation_id uuid,p_evidence jsonb)
returns public.resale_actions language plpgsql security invoker set search_path='' as $$
declare a public.resale_actions; o public.resale_observations; v_started timestamptz;
begin
 select * into a from public.resale_actions where id=p_action_id for update;
 if not found or a.action<>'delist' or a.lease_token is distinct from p_lease_token or p_lease_token is null
 or a.state not in ('running','uncertain') or p_outcome is null or p_outcome not in ('accepted','verified','rejected','uncertain')
 or p_evidence is null or jsonb_typeof(p_evidence)<>'object' then raise exception 'Invalid action result' using errcode='22023'; end if;
 select started_at into v_started from public.resale_action_attempts where action_id=a.id and attempt=a.attempts;
 if p_outcome='verified' then
 select * into o from public.resale_observations where id=p_observation_id and listing_id=a.listing_id;
 if not found or o.external_listing_id is distinct from a.target_external_listing_id
 or not exists(select 1 from public.resale_listings l where l.id=a.listing_id and l.observation_id=o.id
 and l.account_id=a.target_account_id and l.external_listing_id=a.target_external_listing_id and l.inventory_id=a.target_inventory_id and l.match_status='confirmed')
 or o.observed_at<v_started or o.observed_at>clock_timestamp() or o.status not in ('ended','removed','sold') then
 raise exception 'Verified non-purchasable observation required' using errcode='22023'; end if;
 end if;
 update public.resale_action_attempts set finished_at=clock_timestamp(),outcome=p_outcome,evidence=p_evidence
 where action_id=a.id and attempt=a.attempts;
 update public.resale_actions set state=case p_outcome when 'verified' then 'succeeded' when 'rejected' then 'failed' else 'uncertain' end,
 verification_observation_id=case when p_outcome='verified' then p_observation_id else null end,
 last_error=case p_outcome when 'accepted' then 'Remote accepted request; completion not verified' when 'uncertain' then 'Remote result unknown; verify before retry' when 'rejected' then 'Remote request rejected' else null end,
 lease_expires_at=null,updated_at=now() where id=a.id returning * into a;
 return a;
end $$;
revoke all on function private.resale_finish_delist(uuid,uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function private.resale_finish_delist(uuid,uuid,text,uuid,jsonb) to service_role;
commit;
