begin;
create table public.resale_marketplace_photo_objects(
 sha256 text primary key check(sha256 ~ '^[a-f0-9]{64}$'), bucket text not null check(bucket='paulette-resale-originals-prod'),
 object_key text not null unique,byte_size bigint not null check(byte_size between 1 and 20971520),
 mime_type text not null check(mime_type in ('image/jpeg','image/png','image/webp','image/gif')),created_at timestamptz not null default now(),
 check(object_key='resale/marketplace-copies/sha256/'||sha256)
);
create table public.resale_listing_photo_refs(
 id uuid primary key default gen_random_uuid(),listing_id uuid not null,account_id uuid not null,source_record_id uuid not null,
 external_account_id text not null,external_listing_id text not null,position integer not null check(position between 0 and 15),role text not null check(role in ('cover','gallery')),
 source_url text not null,source_observed_at timestamptz not null,kind text not null default 'marketplace_copy' check(kind='marketplace_copy'),
 state text not null default 'available' check(state in ('available','saving','ready','failed')),object_sha256 text references public.resale_marketplace_photo_objects(sha256),fetched_at timestamptz,last_error text,
 created_at timestamptz not null default now(),foreign key(listing_id,account_id) references public.resale_listings(id,account_id),foreign key(source_record_id,account_id) references public.resale_source_records(id,account_id),unique(source_record_id,position),
 check((state='ready')=(object_sha256 is not null and fetched_at is not null))
);
create table private.resale_listing_photo_jobs(
 id uuid primary key,actor_id uuid not null references auth.users(id),ref_id uuid not null references public.resale_listing_photo_refs(id),
 nonce uuid not null default gen_random_uuid(),lease_token uuid not null default gen_random_uuid(),expires_at timestamptz not null,
 state text not null check(state in ('prepared','leased','ready','failed')),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),receipt_sha256 text
);
create unique index resale_one_photo_capture on private.resale_listing_photo_jobs(ref_id) where state in ('prepared','leased');
alter table public.resale_marketplace_photo_objects enable row level security;alter table public.resale_listing_photo_refs enable row level security;alter table private.resale_listing_photo_jobs enable row level security;
revoke all on public.resale_marketplace_photo_objects,public.resale_listing_photo_refs,private.resale_listing_photo_jobs from public,anon,authenticated,service_role;
grant select on public.resale_marketplace_photo_objects,public.resale_listing_photo_refs to authenticated,service_role;
create policy resale_members_read on public.resale_marketplace_photo_objects for select to authenticated using((select private.has_access('resale')));
create policy resale_members_read on public.resale_listing_photo_refs for select to authenticated using((select private.has_access('resale')));
create trigger resale_marketplace_object_immutable before update or delete on public.resale_marketplace_photo_objects for each row execute function private.resale_source_record_immutable();
create function private.resale_photo_ref_immutable() returns trigger language plpgsql set search_path='' as $$ begin
 if tg_op='DELETE' or (to_jsonb(new)-array['state','object_sha256','fetched_at','last_error']) is distinct from (to_jsonb(old)-array['state','object_sha256','fetched_at','last_error']) or (old.state='ready' and new is distinct from old) then raise exception 'Marketplace photo provenance is immutable' using errcode='55000';end if;return new;end $$;
revoke all on function private.resale_photo_ref_immutable() from public,anon,authenticated,service_role;
create trigger resale_photo_ref_immutable before update or delete on public.resale_listing_photo_refs for each row execute function private.resale_photo_ref_immutable();

create function private.resale_safe_photo_url(p_marketplace text,p_listing text,p_url text) returns boolean language sql immutable set search_path='' as $$
 select coalesce(p_marketplace='poshmark' and p_listing ~ '^[a-f0-9]{24}$' and p_url ~ ('^https://di2ponv0v5otw[.]cloudfront[.]net/posts/[0-9]{4}/[0-9]{2}/[0-9]{2}/'||p_listing||'/l_[a-f0-9]{24}[.](jpg|jpeg|png|webp)$'),false)
$$;
revoke all on function private.resale_safe_photo_url(text,text,text) from public,anon,authenticated,service_role;

create function public.resale_register_listing_photos(p_member_id uuid,p_listing_id uuid,p_source_record_id uuid) returns setof public.resale_listing_photo_refs
language plpgsql security definer set search_path='' as $$
declare l public.resale_listings;a public.resale_accounts;s public.resale_source_records;p jsonb;r public.resale_listing_photo_refs;
begin
 perform 1 from private.memberships where user_id=p_member_id and area='resale' for share;if not found then raise exception 'Current resale membership required' using errcode='42501';end if;
 select * into l from public.resale_listings where id=p_listing_id for share;select * into a from public.resale_accounts where id=l.account_id for share;select * into s from public.resale_source_records where id=p_source_record_id;
 if l.id is null or s.id is null or s.account_id is distinct from l.account_id or s.record_status<>'accepted' or s.source_kind not in ('browser','official_api') or s.source_observed_at is null
 or s.external_identifiers->>'listing_id' is distinct from l.external_listing_id or s.external_identifiers->>'account_id' is distinct from a.external_account_id then raise exception 'Exact accepted photo source required' using errcode='22023';end if;
 if jsonb_typeof(s.normalized->'marketplace_photos') is distinct from 'array' or jsonb_array_length(s.normalized->'marketplace_photos') not between 1 and 16 then raise exception 'Bounded source photo positions required' using errcode='22023';end if;
 for p in select value from jsonb_array_elements(s.normalized->'marketplace_photos') loop
 if jsonb_typeof(p)<>'object' or (select count(*) from jsonb_object_keys(p))<>3 or coalesce(p->>'position','') !~ '^([0-9]|1[0-5])$' or p->>'role' is null or p->>'role' not in ('cover','gallery') or not private.resale_safe_photo_url(a.marketplace,l.external_listing_id,p->>'url') then raise exception 'Unverified marketplace photo URL or position' using errcode='22023';end if;
 insert into public.resale_listing_photo_refs(listing_id,account_id,source_record_id,external_account_id,external_listing_id,position,role,source_url,source_observed_at)
 values(l.id,a.id,s.id,a.external_account_id,l.external_listing_id,(p->>'position')::integer,p->>'role',p->>'url',s.source_observed_at) on conflict(source_record_id,position) do nothing;
 select * into r from public.resale_listing_photo_refs where source_record_id=s.id and position=(p->>'position')::integer;
 if r.listing_id<>l.id or r.account_id<>a.id or r.external_account_id<>a.external_account_id or r.external_listing_id<>l.external_listing_id or r.source_url<>p->>'url' or r.role<>p->>'role' or r.source_observed_at<>s.source_observed_at then raise exception 'Photo source retry differs' using errcode='40001';end if;return next r;
 end loop;
end $$;
revoke all on function public.resale_register_listing_photos(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.resale_register_listing_photos(uuid,uuid,uuid) to service_role;

create function private.resale_photo_mac(p_domain text,p_text text) returns text language plpgsql security definer set search_path='' as $$
declare key text;n integer;
begin
 if p_domain not in ('dispatch','receipt') or p_domain is null or p_text is null or octet_length(p_text)>16384 then raise exception 'Invalid photo signature domain' using errcode='22023';end if;
 select count(*),min(decrypted_secret) into n,key from vault.decrypted_secrets where name='resale_media_production_receipt_signing_key';
 if n<>1 or key is null or key !~ '^[a-f0-9]{64}$' then raise exception 'Photo signing key unavailable' using errcode='55000';end if;
 return encode(extensions.hmac(convert_to('resale:marketplace-copy:'||p_domain||':v1'||E'\n'||p_text,'UTF8'),decode(key,'hex'),'sha256'),'hex');
end $$;
revoke all on function private.resale_photo_mac(text,text) from public,anon,authenticated,service_role;

create function private.resale_photo_job_result(j private.resale_listing_photo_jobs) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('request_id',j.id,'member_id',j.actor_id,'nonce',j.nonce,'lease_token',j.lease_token,'expires_at',extract(epoch from j.expires_at)::bigint,'job_state',j.state,'ref',to_jsonb(r),'object',to_jsonb(o)) from public.resale_listing_photo_refs r left join public.resale_marketplace_photo_objects o on o.sha256=r.object_sha256 where r.id=j.ref_id
$$;
revoke all on function private.resale_photo_job_result(private.resale_listing_photo_jobs) from public,anon,authenticated,service_role;

create function private.resale_prepare_photo_job(p_member_id uuid,p_request_id uuid,p_ref_id uuid,p_claim boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare j private.resale_listing_photo_jobs;r public.resale_listing_photo_refs;l public.resale_listings;a public.resale_accounts;
begin
 perform 1 from private.memberships where user_id=p_member_id and area='resale' for share;if not found then raise exception 'Current resale membership required' using errcode='42501';end if;
 if p_request_id is null or p_ref_id is null or p_claim is null then raise exception 'Exact capture request required' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,87));
 select * into r from public.resale_listing_photo_refs where id=p_ref_id for update;select * into l from public.resale_listings where id=r.listing_id for share;select * into a from public.resale_accounts where id=r.account_id for share;
 if r.id is null or r.account_id is distinct from l.account_id or r.external_listing_id is distinct from l.external_listing_id or r.external_account_id is distinct from a.external_account_id or not private.resale_safe_photo_url(a.marketplace,r.external_listing_id,r.source_url) then raise exception 'Photo target changed or URL unsupported' using errcode='40001';end if;
 select * into j from private.resale_listing_photo_jobs where id=p_request_id for update;
 if found and (j.actor_id<>p_member_id or j.ref_id<>p_ref_id) then raise exception 'Capture request retry changed' using errcode='40001';end if;
 if j.id is not null then
 if j.state in ('prepared','leased') and j.expires_at<=clock_timestamp() then update private.resale_listing_photo_jobs set state='failed',updated_at=now() where id=j.id returning * into j;if r.state<>'ready' then update public.resale_listing_photo_refs set state='failed',last_error='capture_lease_expired' where id=r.id;end if;end if;
 if p_claim and j.state='prepared' then update private.resale_listing_photo_jobs set state='leased',updated_at=now() where id=j.id returning * into j;end if;
 return private.resale_photo_job_result(j);end if;
 update private.resale_listing_photo_jobs set state='failed',updated_at=now() where ref_id=r.id and state in ('prepared','leased') and expires_at<=clock_timestamp();
 if exists(select 1 from private.resale_listing_photo_jobs where ref_id=r.id and state in ('prepared','leased')) then raise exception 'Photo preservation already running' using errcode='55000';end if;
 insert into private.resale_listing_photo_jobs(id,actor_id,ref_id,expires_at,state) values(p_request_id,p_member_id,p_ref_id,clock_timestamp()+interval '10 minutes',case when r.state='ready' then 'ready' when p_claim then 'leased' else 'prepared' end)
 returning * into j;
 if r.state<>'ready' then update public.resale_listing_photo_refs set state='saving',last_error=null where id=r.id;end if;
 return private.resale_photo_job_result(j);
end $$;
revoke all on function private.resale_prepare_photo_job(uuid,uuid,uuid,boolean) from public,anon,authenticated,service_role;
create function public.resale_prepare_listing_photo(p_request_id uuid,p_ref_id uuid) returns jsonb language sql security definer set search_path='' as $$ select private.resale_prepare_photo_job(auth.uid(),p_request_id,p_ref_id,true) $$;
revoke all on function public.resale_prepare_listing_photo(uuid,uuid) from public,anon,service_role;grant execute on function public.resale_prepare_listing_photo(uuid,uuid) to authenticated;
create function public.resale_prepare_listing_photo_admin(p_member_id uuid,p_request_id uuid,p_ref_id uuid) returns uuid language plpgsql security definer set search_path='' as $$ begin perform private.resale_prepare_photo_job(p_member_id,p_request_id,p_ref_id,false);return p_request_id;end $$;
revoke all on function public.resale_prepare_listing_photo_admin(uuid,uuid,uuid) from public,anon,authenticated;grant execute on function public.resale_prepare_listing_photo_admin(uuid,uuid,uuid) to service_role;

create function public.resale_claim_listing_photo_dispatch(p_ticket text,p_signature text) returns jsonb language plpgsql security definer set search_path='' as $$
declare p jsonb;j private.resale_listing_photo_jobs;r public.resale_listing_photo_refs;wanted jsonb;result jsonb;
begin
 if p_signature is null or p_signature !~ '^[a-f0-9]{64}$' or p_signature is distinct from private.resale_photo_mac('dispatch',p_ticket) then raise exception 'Invalid capture dispatch signature' using errcode='42501';end if;p:=p_ticket::jsonb;
 select * into j from private.resale_listing_photo_jobs where id=(p->>'request_id')::uuid;select * into r from public.resale_listing_photo_refs where id=j.ref_id;
 wanted:=jsonb_build_object('v',1,'kind','marketplace_copy_dispatch','request_id',j.id,'member_id',j.actor_id,'ref_id',r.id,'source_record_id',r.source_record_id,'account_id',r.account_id,'listing_id',r.listing_id,'source_url',r.source_url,'nonce',j.nonce,'expires_at',extract(epoch from j.expires_at)::bigint);
 if j.id is null or p is distinct from wanted or j.expires_at<=clock_timestamp() or j.expires_at>clock_timestamp()+interval '11 minutes' or j.state not in ('prepared','leased','ready') then raise exception 'Expired or changed photo dispatch' using errcode='22023';end if;
 result:=private.resale_prepare_photo_job(j.actor_id,j.id,j.ref_id,true);if result->>'nonce' is distinct from p->>'nonce' then raise exception 'Dispatch expired during claim' using errcode='22023';end if;return result;
end $$;
revoke all on function public.resale_claim_listing_photo_dispatch(text,text) from public;grant execute on function public.resale_claim_listing_photo_dispatch(text,text) to anon,authenticated,service_role;

create function public.resale_finish_listing_photo(p_receipt text,p_signature text) returns public.resale_listing_photo_refs language plpgsql security definer set search_path='' as $$
declare p jsonb;j private.resale_listing_photo_jobs;r public.resale_listing_photo_refs;l public.resale_listings;a public.resale_accounts;o public.resale_marketplace_photo_objects;fetched timestamptz;expiry bigint;
begin
 if p_signature is null or p_signature !~ '^[a-f0-9]{64}$' or p_signature is distinct from private.resale_photo_mac('receipt',p_receipt) then raise exception 'Invalid photo receipt signature' using errcode='42501';end if;p:=p_receipt::jsonb;
 select * into j from private.resale_listing_photo_jobs where id=(p->>'request_id')::uuid;
 perform 1 from private.memberships where user_id=j.actor_id and area='resale' for share;if not found then raise exception 'Current resale membership required' using errcode='42501';end if;
 select * into r from public.resale_listing_photo_refs where id=j.ref_id for update;select * into l from public.resale_listings where id=r.listing_id for share;select * into a from public.resale_accounts where id=r.account_id for share;select * into j from private.resale_listing_photo_jobs where id=j.id for update;
 if p->>'v' is distinct from '1' or p->>'kind' is null or p->>'kind' not in ('marketplace_copy','marketplace_copy_error') or p->>'member_id' is distinct from j.actor_id::text or p->>'ref_id' is distinct from r.id::text or p->>'source_record_id' is distinct from r.source_record_id::text or p->>'account_id' is distinct from r.account_id::text or p->>'listing_id' is distinct from r.listing_id::text
 or p->>'source_url' is distinct from r.source_url or p->>'external_listing_id' is distinct from r.external_listing_id or p->>'external_account_id' is distinct from r.external_account_id or p->>'nonce' is distinct from j.nonce::text or p->>'lease_token' is distinct from j.lease_token::text
 or r.account_id is distinct from l.account_id or r.external_listing_id is distinct from l.external_listing_id or r.external_account_id is distinct from a.external_account_id or not private.resale_safe_photo_url(a.marketplace,r.external_listing_id,r.source_url) then raise exception 'Exact photo receipt target required' using errcode='40001';end if;
 if j.state='ready' and j.receipt_sha256=encode(extensions.digest(convert_to(p_receipt,'UTF8'),'sha256'),'hex') then return r;end if;
 expiry:=(p->>'expires_at')::bigint;
 if expiry is null or expiry<=extract(epoch from clock_timestamp()) or expiry>extract(epoch from clock_timestamp())+900 or j.state<>'leased' or j.expires_at<=clock_timestamp() then raise exception 'Expired photo receipt or lease' using errcode='22023';end if;
 if p->>'kind'='marketplace_copy_error' then
 if p->>'error' is null or p->>'error' not in ('source_unavailable','source_rejected','oversized','unsupported_image','storage_unconfirmed','runtime_error') or r.state='ready' then raise exception 'Invalid bounded capture failure' using errcode='22023';end if;
 -- Same-lease retries may overlap: a failed reader cannot invalidate a valid in-flight capture.
 update private.resale_listing_photo_jobs set updated_at=now() where id=j.id;
 update public.resale_listing_photo_refs set state='saving',last_error=p->>'error' where id=r.id returning * into r;return r;
 end if;
 fetched:=(p->>'fetched_at')::timestamptz;
 if fetched is null or fetched<j.created_at or fetched>clock_timestamp()+interval '30 seconds' or p->>'bucket' is distinct from 'paulette-resale-originals-prod' or coalesce(p->>'sha256','') !~ '^[a-f0-9]{64}$' or p->>'object_key' is distinct from 'resale/marketplace-copies/sha256/'||(p->>'sha256') or coalesce(p->>'byte_size','') !~ '^[0-9]{1,8}$' or (p->>'byte_size')::bigint not between 1 and 20971520 or p->>'mime_type' is null or p->>'mime_type' not in ('image/jpeg','image/png','image/webp','image/gif') then raise exception 'Invalid immutable photo object receipt' using errcode='22023';end if;
 insert into public.resale_marketplace_photo_objects(sha256,bucket,object_key,byte_size,mime_type) values(p->>'sha256',p->>'bucket',p->>'object_key',(p->>'byte_size')::bigint,p->>'mime_type') on conflict(sha256) do nothing;
 select * into o from public.resale_marketplace_photo_objects where sha256=p->>'sha256';
 if o.bucket<>p->>'bucket' or o.object_key<>p->>'object_key' or o.byte_size<>(p->>'byte_size')::bigint or o.mime_type<>p->>'mime_type' then raise exception 'Existing photo bytes conflict' using errcode='40001';end if;
 if r.state='ready' and r.object_sha256<>o.sha256 then raise exception 'Captured source bytes already fixed' using errcode='40001';end if;
 update public.resale_listing_photo_refs set state='ready',object_sha256=o.sha256,fetched_at=fetched,last_error=null where id=r.id returning * into r;
 update private.resale_listing_photo_jobs set state='ready',updated_at=now(),receipt_sha256=encode(extensions.digest(convert_to(p_receipt,'UTF8'),'sha256'),'hex') where id=j.id;return r;
end $$;
revoke all on function public.resale_finish_listing_photo(text,text) from public;grant execute on function public.resale_finish_listing_photo(text,text) to anon,authenticated,service_role;
commit;
