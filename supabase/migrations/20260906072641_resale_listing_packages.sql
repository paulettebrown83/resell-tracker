-- Member-owned preparation artifacts only; never marketplace execution or trusted sale proof.
begin;
create table private.resale_package_abandoned_requests(id uuid primary key,owner_id uuid not null references auth.users(id),created_at timestamptz not null default now());
revoke all on private.resale_package_abandoned_requests from public,anon,authenticated,service_role;
create table public.resale_listing_packages (
 id uuid primary key, owner_id uuid not null references auth.users(id),
 listing_id uuid not null references public.resale_listings(id), account_id uuid not null references public.resale_accounts(id),
 inventory_id uuid not null references public.inventory(id), draft_version integer not null check(draft_version>0),
 request_payload jsonb not null, snapshot jsonb not null,
 state text not null default 'pending' check(state in ('pending','processing','ready','failed','discarding','discarded')),
 completed_images integer not null default 0 check(completed_images between 0 and 16),
 derivatives jsonb not null default '[]', outputs jsonb not null default '{}',
 lease_token uuid, lease_until timestamptz, last_error text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 constraint package_lease check((lease_token is null)=(lease_until is null))
);
create index resale_packages_listing on public.resale_listing_packages(listing_id,created_at desc);
create index resale_packages_owner_lease on public.resale_listing_packages(owner_id,lease_until);
alter table public.resale_listing_packages enable row level security;
revoke all on public.resale_listing_packages from public,anon,authenticated,service_role;
grant select on public.resale_listing_packages to authenticated;

create function private.resale_package_current(p_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.resale_listing_packages p
 join public.resale_listings l on l.id=p.listing_id
 join public.resale_accounts a on a.id=p.account_id
 join public.inventory i on i.id=p.inventory_id
 where p.id=p_id and p.state not in ('discarding','discarded') and p.owner_id=auth.uid() and private.has_access('resale')
 and l.account_id=p.account_id and l.inventory_id=p.inventory_id and l.match_status='confirmed'
 and l.external_listing_id is null and l.draft_version=p.draft_version
 and l.desired_fields=p.snapshot->'fields' and l.draft_context->>'inventory_id'=p.inventory_id::text
 and l.draft_context->>'account_id'=p.account_id::text
 and lower(a.marketplace)='poshmark' and a.external_account_id='5bb5431e42aa76fee623d5a6'
 and i.archived_at is null and lower(coalesce(i.status,''))<>'sold'
 and not exists(select 1 from public.resale_item_details d where d.inventory_id=i.id and d.workflow='archived')
 and not exists(select 1 from public.resale_listings sibling where sibling.account_id=p.account_id and sibling.inventory_id=p.inventory_id and sibling.external_listing_id is not null)
 and not exists(select 1 from jsonb_array_elements(p.snapshot->'media') s where not exists(
  select 1 from public.resale_media m where m.id::text=s->>'id' and m.inventory_id=p.inventory_id and m.kind='original' and m.original_id is null and m.state='ready'
  and m.bucket=s->>'bucket' and m.object_key=s->>'object_key' and m.sha256=s->>'sha256' and m.byte_size=(s->>'byte_size')::bigint and m.mime_type=s->>'mime_type')));
$$;
revoke all on function private.resale_package_current(uuid) from public,anon,authenticated,service_role;
grant execute on function private.resale_package_current(uuid) to authenticated;
create policy package_owner_current on public.resale_listing_packages for select to authenticated using(private.resale_package_current(id));

-- Hold binding rows through each checkpoint; a changed draft cannot pass an earlier snapshot while waiting.
create function private.resale_lock_package_binding(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare job public.resale_listing_packages;
begin
 select * into job from public.resale_listing_packages where id=p_id for update;
 perform 1 from public.resale_listings where id=job.listing_id for share;
 perform 1 from public.resale_accounts where id=job.account_id for share;
 perform 1 from public.inventory where id=job.inventory_id for share;
 perform 1 from public.resale_media where id in(select (m->>'id')::uuid from jsonb_array_elements(job.snapshot->'media') m) order by id for share;
 if not private.resale_package_current(p_id) then raise exception 'Saved package binding changed; refresh the draft' using errcode='42501';end if;
end $$;
revoke all on function private.resale_lock_package_binding(uuid) from public,anon,authenticated,service_role;

create function private.resale_request_package(p_request_id uuid,p_payload jsonb) returns public.resale_listing_packages
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); job public.resale_listing_packages; l public.resale_listings; a public.resale_accounts; m public.resale_media; media jsonb:='[]'; media_id text; native jsonb; k text;
begin
 perform 1 from private.memberships where user_id=actor and area='resale' for share;
 if actor is null or not found then raise exception 'Resale access required' using errcode='42501';end if;
 if p_request_id is null or p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>8192
 or not(p_payload ?& array['listing_id','account_id','inventory_id','expected_version','quantity','native_fields'])
 or exists(select 1 from jsonb_object_keys(p_payload) key where key<>all(array['listing_id','account_id','inventory_id','expected_version','quantity','native_fields'])) then raise exception 'Invalid package request' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,72));
 if exists(select 1 from private.resale_package_abandoned_requests where id=p_request_id) then raise exception 'This preparation request was replaced. Use the current request.' using errcode='22023';end if;
 select * into job from public.resale_listing_packages where id=p_request_id;
 if found then
  if job.owner_id<>actor or job.request_payload<>p_payload then raise exception 'Package request changed; preserve the original request' using errcode='22023';end if;
  if not private.resale_package_current(job.id) then raise exception 'Saved draft or photos changed; prepare a new package' using errcode='40001';end if;
  return job;
 end if;
 if p_payload->'quantity'<>'1'::jsonb or jsonb_typeof(p_payload->'expected_version')<>'number' or (p_payload->>'expected_version') !~ '^[1-9][0-9]{0,8}$' then raise exception 'One unit and current draft version required' using errcode='22023';end if;
 native:=p_payload->'native_fields';
 if jsonb_typeof(native)<>'object' or exists(select 1 from jsonb_object_keys(native) key where key<>all(array['Department','Category','Sub-category','Brand','Color1','Color2','Orig price '])) then raise exception 'Unsupported native fields' using errcode='22023';end if;
 for k in select jsonb_object_keys(native) loop
  if jsonb_typeof(native->k)<>'string' or length(native->>k)>200 then raise exception 'Invalid native field' using errcode='22023';end if;
 end loop;
 select * into l from public.resale_listings where id=(p_payload->>'listing_id')::uuid for share;
 if not found or l.account_id::text<>p_payload->>'account_id' or l.inventory_id::text is distinct from p_payload->>'inventory_id' or l.external_listing_id is not null or l.match_status<>'confirmed' then raise exception 'Use the exact confirmed local draft, not an existing marketplace listing' using errcode='22023';end if;
 if l.draft_version<>(p_payload->>'expected_version')::integer or l.draft_context->>'inventory_id' is distinct from l.inventory_id::text or l.draft_context->>'account_id' is distinct from l.account_id::text then raise exception 'Saved draft changed; reload' using errcode='40001';end if;
 select * into a from public.resale_accounts where id=l.account_id for share;
 if lower(a.marketplace)<>'poshmark' or a.external_account_id is distinct from '5bb5431e42aa76fee623d5a6' then raise exception 'Verified Poshmark account required' using errcode='22023';end if;
 if jsonb_typeof(l.desired_fields->'media_ids') is distinct from 'array' or jsonb_array_length(l.desired_fields->'media_ids') not between 1 and 16 then raise exception 'Choose one to sixteen saved original photos' using errcode='22023';end if;
 if (select count(distinct value) from jsonb_array_elements_text(l.desired_fields->'media_ids'))<>jsonb_array_length(l.desired_fields->'media_ids') then raise exception 'Duplicate photo identity' using errcode='22023';end if;
 for media_id in select value from jsonb_array_elements_text(l.desired_fields->'media_ids') loop
  select * into m from public.resale_media where id=media_id::uuid for share;
  if not found or m.inventory_id<>l.inventory_id or m.kind<>'original' or m.original_id is not null or m.state<>'ready' or m.bucket<>'paulette-resale-originals-prod'
   or m.object_key<>('resale/items/'||l.inventory_id||'/'||m.id||'/original') or m.sha256 is null or m.sha256 !~ '^[0-9a-f]{64}$' or m.byte_size not between 1 and 20971520 then raise exception 'Photo is not a verified ready original for this item' using errcode='22023';end if;
  media:=media||jsonb_build_array(jsonb_build_object('id',m.id,'inventory_id',m.inventory_id,'bucket',m.bucket,'object_key',m.object_key,'mime_type',m.mime_type,'byte_size',m.byte_size,'sha256',m.sha256));
 end loop;
 insert into public.resale_listing_packages(id,owner_id,listing_id,account_id,inventory_id,draft_version,request_payload,snapshot)
 values(p_request_id,actor,l.id,l.account_id,l.inventory_id,l.draft_version,p_payload,jsonb_build_object('fields',l.desired_fields,'native_fields',native,'media',media,'template_sha256','f6c51f1f8d319122b6b1fea1d96f886e26e28d87811ff36a402b7cbe6b3b35f2','runtime_version','poshmark-package-node-v1','external_account_id',a.external_account_id)) returning * into job;
 if not private.resale_package_current(job.id) then raise exception 'Item is sold, archived, already listed or changed; refresh before preparation' using errcode='40001';end if;
 return job;
end $$;

create function private.resale_claim_package(p_id uuid) returns public.resale_listing_packages
language plpgsql security definer set search_path='' as $$
declare job public.resale_listing_packages;
begin
 perform 1 from private.memberships where user_id=auth.uid() and area='resale' for share;
 if not found or not private.resale_package_current(p_id) then raise exception 'Package access or current draft binding required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,73));
 perform private.resale_lock_package_binding(p_id);
 select * into job from public.resale_listing_packages where id=p_id for update;
 if job.state='ready' then return job;end if;
 if exists(select 1 from public.resale_listing_packages where owner_id=auth.uid() and lease_until>now()) then raise exception 'A photo step is still running. Check saved progress shortly.' using errcode='55P03';end if;
 update public.resale_listing_packages set lease_token=gen_random_uuid(),lease_until=now()+interval '180 seconds',state='processing',last_error=null,updated_at=now() where id=p_id returning * into job;
 return job;
end $$;

create function private.resale_package_storage_allowed(p_name text,p_write boolean) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare job public.resale_listing_packages; suffix text; n integer;
begin
 if p_name is null or p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' then return false;end if;
 select * into job from public.resale_listing_packages where id=split_part(p_name,'/',1)::uuid;
 if not found or not private.resale_package_current(job.id) then return false;end if;
 suffix:=substring(p_name from 38);
 if suffix in ('listings.csv','photos.zip','manifest.json') then
  if p_write then return job.state='processing' and job.lease_until>now() and job.completed_images=jsonb_array_length(job.snapshot->'media');end if;
  return true;
 end if;
 if suffix !~ '^photo-(0|[1-9]|1[0-5])\.jpg$' then return false;end if;
 n:=substring(suffix from '^photo-([0-9]+)')::integer;
 if n>=jsonb_array_length(job.snapshot->'media') then return false;end if;
 if p_write then return job.state='processing' and job.lease_until>now() and n=job.completed_images;end if;
 return true;
end $$;
revoke all on function private.resale_package_storage_allowed(text,boolean) from public,anon,authenticated,service_role;
grant execute on function private.resale_package_storage_allowed(text,boolean) to authenticated;

-- No public URLs, overwrite, delete, signing URLs or broad listing policies.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('resale-listing-packages','resale-listing-packages',false,67108864,array['image/jpeg','application/zip','text/csv','application/json']) on conflict(id) do nothing;
do $$ begin
 if not exists(select 1 from storage.buckets where id='resale-listing-packages' and public=false and file_size_limit=67108864 and allowed_mime_types=array['image/jpeg','application/zip','text/csv','application/json']) then raise exception 'Existing package bucket configuration requires review';end if;
end $$;
create policy resale_package_insert on storage.objects for insert to authenticated
 with check(bucket_id='resale-listing-packages' and private.resale_package_storage_allowed(name,true));
create policy resale_package_read on storage.objects for select to authenticated
 using(bucket_id='resale-listing-packages' and private.resale_package_storage_allowed(name,false) and storage.allow_only_operation('object.get_authenticated'));

create function private.resale_checkpoint_package(p_id uuid,p_lease uuid,p_artifact jsonb) returns public.resale_listing_packages
language plpgsql security definer set search_path='' as $$
declare job public.resale_listing_packages; expected text; total bigint;
begin
 perform 1 from private.memberships where user_id=auth.uid() and area='resale' for share;
 if not found or not private.resale_package_current(p_id) then raise exception 'Package access or current draft binding required' using errcode='42501';end if;
 perform private.resale_lock_package_binding(p_id);
 select * into job from public.resale_listing_packages where id=p_id for update;
 if p_lease is null or job.lease_token is distinct from p_lease or job.lease_until<=now() then raise exception 'Photo step lease expired; resume saved progress' using errcode='40001';end if;
 expected:=job.id||'/photo-'||job.completed_images||'.jpg';
 if job.completed_images>=jsonb_array_length(job.snapshot->'media') or jsonb_typeof(p_artifact) is distinct from 'object'
 or not(p_artifact ?& array['name','sha256','byte_size','width','height','media_id'])
 or exists(select 1 from jsonb_object_keys(p_artifact) k where k<>all(array['name','sha256','byte_size','width','height','media_id']))
 or p_artifact->>'name' is distinct from expected or p_artifact->>'media_id' is distinct from job.snapshot->'media'->job.completed_images->>'id'
 or coalesce(p_artifact->>'sha256','') !~ '^[0-9a-f]{64}$'
 or jsonb_typeof(p_artifact->'byte_size') is distinct from 'number' or jsonb_typeof(p_artifact->'width') is distinct from 'number' or jsonb_typeof(p_artifact->'height') is distinct from 'number'
 or (p_artifact->>'byte_size') !~ '^[0-9]+$' or (p_artifact->>'width') !~ '^[0-9]+$' or (p_artifact->>'height') !~ '^[0-9]+$'
 or (p_artifact->>'byte_size')::bigint not between 1 and 8388608 or (p_artifact->>'width')::integer not between 1 and 1920 or (p_artifact->>'height')::integer not between 1 and 1920 then raise exception 'Invalid derivative checkpoint' using errcode='22023';end if;
 if not exists(select 1 from storage.objects where bucket_id='resale-listing-packages' and name=expected and (metadata->>'size')::bigint=(p_artifact->>'byte_size')::bigint) then raise exception 'Derivative storage not confirmed' using errcode='22023';end if;
 select coalesce(sum((a->>'byte_size')::bigint),0)+(p_artifact->>'byte_size')::bigint into total from jsonb_array_elements(job.derivatives) a;
 if total>62914560 then raise exception 'Package exceeds the local 60 MiB photo limit; choose fewer photos' using errcode='22023';end if;
 update public.resale_listing_packages set derivatives=derivatives||jsonb_build_array(p_artifact),completed_images=completed_images+1,state='pending',lease_token=null,lease_until=null,last_error=null,updated_at=now() where id=p_id returning * into job;
 return job;
end $$;

create function private.resale_finish_package(p_id uuid,p_lease uuid,p_outputs jsonb,p_error text default null) returns public.resale_listing_packages
language plpgsql security definer set search_path='' as $$
declare job public.resale_listing_packages; key text; a jsonb;
begin
 perform 1 from private.memberships where user_id=auth.uid() and area='resale' for share;
 if not found or not private.resale_package_current(p_id) then raise exception 'Package access or current draft binding required' using errcode='42501';end if;
 perform private.resale_lock_package_binding(p_id);
 select * into job from public.resale_listing_packages where id=p_id for update;
 if p_lease is null or job.lease_token is distinct from p_lease or job.lease_until<=now() then raise exception 'Package step expired; resume saved progress' using errcode='40001';end if;
 if p_error is not null then
  if p_error !~ '^[a-z_]{1,60}$' then raise exception 'Invalid package error code' using errcode='22023';end if;
  update public.resale_listing_packages set state='failed',last_error=p_error,lease_token=null,lease_until=null,updated_at=now() where id=p_id returning * into job;return job;
 end if;
 if job.completed_images<>jsonb_array_length(job.snapshot->'media') or jsonb_typeof(p_outputs) is distinct from 'object' or not(p_outputs ?& array['csv','zip','manifest']) or (select count(*) from jsonb_object_keys(p_outputs))<>3 then raise exception 'Package files are incomplete' using errcode='22023';end if;
 foreach key in array array['csv','zip','manifest'] loop
  a:=p_outputs->key;
  if jsonb_typeof(a) is distinct from 'object' or not(a ?& array['name','sha256','byte_size']) or exists(select 1 from jsonb_object_keys(a) k where k<>all(array['name','sha256','byte_size']))
  or a->>'name' is distinct from (job.id||'/'||(case key when 'csv' then 'listings.csv' when 'zip' then 'photos.zip' else 'manifest.json' end))
  or coalesce(a->>'sha256','') !~ '^[0-9a-f]{64}$' or jsonb_typeof(a->'byte_size') is distinct from 'number' or (a->>'byte_size') !~ '^[0-9]+$' or (a->>'byte_size')::bigint not between 1 and 67108864 then raise exception 'Invalid package output' using errcode='22023';end if;
  if not exists(select 1 from storage.objects where bucket_id='resale-listing-packages' and name=a->>'name' and (metadata->>'size')::bigint=(a->>'byte_size')::bigint) then raise exception 'Package storage not confirmed' using errcode='22023';end if;
 end loop;
 update public.resale_listing_packages set state='ready',outputs=p_outputs,lease_token=null,lease_until=null,last_error=null,updated_at=now() where id=p_id returning * into job;return job;
end $$;


-- Explicit discard is available for stale packages too. No timer silently removes a final deliverable.
create function private.resale_package_discard_allowed(p_name text) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.resale_listing_packages p where p.owner_id=auth.uid() and private.has_access('resale')
 and p.state='discarding' and p.lease_token is null
 and p_name ~ ('^'||p.id::text||'/(photo-(0|[1-9]|1[0-5])\.jpg|listings\.csv|photos\.zip|manifest\.json)$'));
$$;
revoke all on function private.resale_package_discard_allowed(text) from public,anon,authenticated,service_role;
grant execute on function private.resale_package_discard_allowed(text) to authenticated;
create policy resale_package_discard_read on storage.objects for select to authenticated
 using(bucket_id='resale-listing-packages' and private.resale_package_discard_allowed(name) and storage.allow_any_operation(array['object.delete','object.delete_many']));
create policy resale_package_discard_delete on storage.objects for delete to authenticated
 using(bucket_id='resale-listing-packages' and private.resale_package_discard_allowed(name) and storage.allow_any_operation(array['object.delete','object.delete_many']));

create function private.resale_discard_package(p_id uuid,p_complete boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare job public.resale_listing_packages;
begin
 perform 1 from private.memberships where user_id=auth.uid() and area='resale' for share;
 if not found then raise exception 'Resale access required' using errcode='42501';end if;
 select * into job from public.resale_listing_packages where id=p_id and owner_id=auth.uid() for update;
 if not found then raise exception 'Owned package required' using errcode='42501';end if;
 if job.lease_until>now() then raise exception 'A photo step is still running. Try removal after it finishes.' using errcode='55P03';end if;
 if p_complete is null then raise exception 'Explicit discard stage required' using errcode='22023';end if;
 if job.state='discarded' then return jsonb_build_object('id',job.id,'state','discarded');end if;
 if p_complete then
  if job.state<>'discarding' or exists(select 1 from storage.objects where bucket_id='resale-listing-packages' and split_part(name,'/',1)=job.id::text) then raise exception 'Prepared file removal is not complete' using errcode='22023';end if;
  update public.resale_listing_packages set state='discarded',updated_at=now() where id=p_id;
 else
  update public.resale_listing_packages set state='discarding',lease_token=null,lease_until=null,updated_at=now() where id=p_id;
 end if;
 return jsonb_build_object('id',job.id,'state',case when p_complete then 'discarded' else 'discarding' end);
end $$;
create function public.resale_discard_package(p_id uuid,p_complete boolean default false) returns jsonb language sql security invoker set search_path='' as $$select private.resale_discard_package(p_id,p_complete)$$;

create function private.resale_package_summaries(p_listing_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not private.has_access('resale') then raise exception 'Resale access required' using errcode='42501';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'state',p.state,'draft_version',p.draft_version,'completed_images',p.completed_images,'image_count',jsonb_array_length(p.snapshot->'media'),'current',private.resale_package_current(p.id),'updated_at',p.updated_at,'last_error',p.last_error,'lease_until',p.lease_until,'outputs',case when private.resale_package_current(p.id) then p.outputs else '{}'::jsonb end) order by p.created_at desc) from public.resale_listing_packages p where p.owner_id=auth.uid() and p.listing_id=p_listing_id and p.state<>'discarded'),'[]'::jsonb);
end $$;
create function public.resale_package_summaries(p_listing_id uuid) returns jsonb language sql security invoker set search_path='' as $$select private.resale_package_summaries(p_listing_id)$$;


-- A definite missing receipt is distinct from transport failure and permits abandoned client-request recovery.
create function private.resale_package_receipt(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare job public.resale_listing_packages;
begin
 if not private.has_access('resale') then raise exception 'Resale access required' using errcode='42501';end if;
 select * into job from public.resale_listing_packages where id=p_id;
 if not found then return jsonb_build_object('id',p_id,'accepted',false);end if;
 if job.owner_id<>auth.uid() then raise exception 'Owned request required' using errcode='42501';end if;
 return jsonb_build_object('id',p_id,'accepted',true,'current',private.resale_package_current(p_id),'state',job.state);
end $$;
create function public.resale_package_receipt(p_id uuid) returns jsonb language sql security invoker set search_path='' as $$select private.resale_package_receipt(p_id)$$;


create function private.resale_abandon_package_request(p_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare job public.resale_listing_packages; prior_owner uuid;
begin
 perform 1 from private.memberships where user_id=auth.uid() and area='resale' for share;
 if not found or p_id is null then raise exception 'Resale access and exact request required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,72));
 select * into job from public.resale_listing_packages where id=p_id;
 if found and (job.owner_id<>auth.uid() or job.state<>'discarded') then raise exception 'This request was accepted. Use or remove its saved package instead.' using errcode='40001';end if;
 select owner_id into prior_owner from private.resale_package_abandoned_requests where id=p_id;
 if found and prior_owner<>auth.uid() then raise exception 'Owned request required' using errcode='42501';end if;
 insert into private.resale_package_abandoned_requests(id,owner_id) values(p_id,auth.uid()) on conflict do nothing;
 return jsonb_build_object('id',p_id,'abandoned',true);
end $$;
create function public.resale_abandon_package_request(p_id uuid) returns jsonb language sql security invoker set search_path='' as $$select private.resale_abandon_package_request(p_id)$$;

-- Public invoker wrappers preserve narrowly scoped private checks and grants.
create function public.resale_request_package(p_request_id uuid,p_payload jsonb) returns public.resale_listing_packages language sql security invoker set search_path='' as $$select private.resale_request_package(p_request_id,p_payload)$$;
create function public.resale_claim_package(p_id uuid) returns public.resale_listing_packages language sql security invoker set search_path='' as $$select private.resale_claim_package(p_id)$$;
create function public.resale_checkpoint_package(p_id uuid,p_lease uuid,p_artifact jsonb) returns public.resale_listing_packages language sql security invoker set search_path='' as $$select private.resale_checkpoint_package(p_id,p_lease,p_artifact)$$;
create function public.resale_finish_package(p_id uuid,p_lease uuid,p_outputs jsonb,p_error text default null) returns public.resale_listing_packages language sql security invoker set search_path='' as $$select private.resale_finish_package(p_id,p_lease,p_outputs,p_error)$$;
do $$declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('private','public') and p.proname in ('resale_request_package','resale_claim_package','resale_checkpoint_package','resale_finish_package','resale_discard_package','resale_package_summaries','resale_package_receipt','resale_abandon_package_request') loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;
commit;
