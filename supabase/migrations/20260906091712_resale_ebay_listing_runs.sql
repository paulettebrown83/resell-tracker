begin;
create table public.resale_ebay_listing_runs (
 id uuid primary key, account_id uuid not null references public.resale_ebay_connections(account_id), owner_id uuid not null references auth.users(id),
 generation bigint not null, config_revision bigint not null, status text not null default 'running' check(status in ('running','complete','needs_review','cancelled','deletion_pending')),
 next_page integer not null default 1 check(next_page between 1 and 101), next_request_id uuid not null unique,
 expected_pages integer,expected_entries integer, records_read integer not null default 0, pages_read integer not null default 0,
 started_at timestamptz not null default clock_timestamp(), finished_at timestamptz,last_error text,
 coverage_note text not null default 'Pages read over an interval; not an atomic shop snapshot. Absence is not ended or sold.'
);
create unique index ebay_one_running_listing_run on public.resale_ebay_listing_runs(account_id) where status='running';
alter table public.resale_ebay_listing_runs enable row level security;
revoke all on public.resale_ebay_listing_runs from public,anon,authenticated,service_role;
grant select on public.resale_ebay_listing_runs to authenticated,service_role;
create policy owner_read on public.resale_ebay_listing_runs for select to authenticated using(owner_id=(select auth.uid()) and (select private.has_access('resale')));
create table private.resale_ebay_listing_pages (
 run_id uuid not null references public.resale_ebay_listing_runs(id), page integer not null, read_id uuid not null unique references public.resale_ebay_reads(id) on delete cascade,
 snapshot_id uuid not null references public.resale_snapshots(id), primary key(run_id,page)
);
create table private.resale_ebay_listing_ingests (
 read_id uuid not null references public.resale_ebay_reads(id) on delete cascade, listing_id uuid not null references public.resale_listings(id),
 source_id uuid not null unique references public.resale_source_records(id) deferrable initially deferred, observation_id uuid not null unique references public.resale_observations(id),
 external_listing_id text not null, primary key(read_id,external_listing_id)
);
create table private.resale_ebay_created_listings (listing_id uuid primary key references public.resale_listings(id) on delete cascade, account_id uuid not null references public.resale_accounts(id));
do $$declare t text;begin foreach t in array array['resale_ebay_listing_pages','resale_ebay_listing_ingests','resale_ebay_created_listings'] loop
 execute format('alter table private.%I enable row level security',t);execute format('revoke all on private.%I from public,anon,authenticated,service_role',t);end loop;end $$;

create function public.resale_ebay_start_listing_run(p_member_id uuid,p_account_id uuid,p_run_id uuid) returns public.resale_ebay_listing_runs
language plpgsql security definer set search_path='' as $$
declare c public.resale_ebay_connections;cfg jsonb;r public.resale_ebay_listing_runs;begin
 c:=private.ebay_owner(p_member_id,p_account_id);cfg:=private.ebay_config_json();
 if c.status<>'connected' or p_run_id is null then raise exception 'Active connection and request required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_run_id::text,9835));
 select * into r from public.resale_ebay_listing_runs where id=p_run_id;
 if found then if r.owner_id<>p_member_id or r.account_id<>p_account_id then raise exception 'Run retry changed' using errcode='22023';end if;return r;end if;
 if exists(select 1 from public.resale_ebay_listing_runs where account_id=p_account_id and status='running') then raise exception 'Resume the existing listing run' using errcode='55000';end if;
 insert into public.resale_ebay_listing_runs(id,account_id,owner_id,generation,config_revision,next_request_id) values(p_run_id,p_account_id,p_member_id,c.generation,(cfg->>'revision')::bigint,gen_random_uuid()) returning * into r;return r;end $$;

create function public.resale_ebay_claim_listing_run(p_member_id uuid,p_run_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.resale_ebay_listing_runs;c public.resale_ebay_connections;cfg jsonb;begin
 select * into r from public.resale_ebay_listing_runs where id=p_run_id;if not found then raise exception 'Run not found' using errcode='22023';end if;
 c:=private.ebay_owner(p_member_id,r.account_id);cfg:=private.ebay_config_json();select * into r from public.resale_ebay_listing_runs where id=p_run_id for update;
 if r.owner_id<>p_member_id then raise exception 'Run owner mismatch' using errcode='42501';end if;
 if r.status='running' and (c.status<>'connected' or r.generation<>c.generation or r.config_revision<>(cfg->>'revision')::bigint or r.started_at<clock_timestamp()-interval '1 hour') then
 update public.resale_ebay_listing_runs set status='needs_review',last_error='connection_changed_or_run_expired',finished_at=clock_timestamp() where id=r.id returning * into r;end if;
 return jsonb_build_object('run',to_jsonb(r),'request',case when r.status='running' then jsonb_build_object('account_id',r.account_id,'request_id',r.next_request_id,'kind','listings','page',r.next_page) else null end);end $$;

create function public.resale_ebay_cancel_listing_run(p_run_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare r public.resale_ebay_listing_runs;c public.resale_ebay_connections;begin
 select * into r from public.resale_ebay_listing_runs where id=p_run_id;if not found then raise exception 'Run not found' using errcode='22023';end if;
 c:=private.ebay_owner(auth.uid(),r.account_id);if r.owner_id<>auth.uid() then raise exception 'Run owner mismatch' using errcode='42501';end if;
 update public.resale_ebay_listing_runs set status='cancelled',last_error='cancelled_by_owner',finished_at=clock_timestamp() where id=r.id and status in ('running','needs_review');end $$;

create function public.resale_ebay_checkpoint_listing_run(p_member_id uuid,p_run_id uuid,p_read_id uuid) returns public.resale_ebay_listing_runs
language plpgsql security definer set search_path='' as $$
declare r public.resale_ebay_listing_runs;c public.resale_ebay_connections;cfg jsonb;q public.resale_ebay_reads;v jsonb;item jsonb;l public.resale_listings;
 pages integer;entries integer;n integer;problem text;snap uuid:=gen_random_uuid();src uuid;obs uuid;created boolean;at_time timestamptz;
begin
 perform pg_advisory_xact_lock(98340001);
 select * into r from public.resale_ebay_listing_runs where id=p_run_id;if not found then raise exception 'Run not found' using errcode='22023';end if;
 c:=private.ebay_owner(p_member_id,r.account_id);cfg:=private.ebay_config_json();select * into r from public.resale_ebay_listing_runs where id=p_run_id for update;
 if r.owner_id<>p_member_id or c.status<>'connected' or r.generation<>c.generation or r.config_revision<>(cfg->>'revision')::bigint then raise exception 'Run connection changed' using errcode='42501';end if;
 if exists(select 1 from private.resale_ebay_listing_pages where run_id=r.id and read_id=p_read_id) then return r;end if;
 if r.status<>'running' or r.started_at<clock_timestamp()-interval '1 hour' or p_read_id is distinct from r.next_request_id then raise exception 'Current page request required' using errcode='40001';end if;
 select * into q from public.resale_ebay_reads where id=p_read_id for share;
 if not found or q.account_id<>r.account_id or q.owner_id<>r.owner_id or q.kind<>'listings' or q.page<>r.next_page or q.status<>'complete' or q.completed_at<r.started_at then raise exception 'Saved exact completed listing page required' using errcode='22023';end if;
 v:=q.result;pages:=(v->>'total_pages')::integer;entries:=(v->>'total_entries')::integer;n:=jsonb_array_length(v->'records');at_time:=q.completed_at;
 if pages is null or entries is null or pages<0 or entries<0 or (pages=0 and entries<>0) or (q.page>pages and not(q.page=1 and pages=0 and entries=0)) or n>50 or v->>'coverage' is distinct from 'active_only' or (v->>'page')::integer<>q.page or (v->>'has_more')::boolean is distinct from (q.page<pages) then raise exception 'Invalid saved page shape' using errcode='22023';end if;
 if pages>100 or entries>5000 then problem:='local_page_limit';
 elsif r.expected_pages is not null and (pages<>r.expected_pages or entries<>r.expected_entries) then problem:='provider_totals_changed';
 elsif exists(select 1 from jsonb_array_elements(v->'records') x where x->>'listing_id' is null or x->>'listing_id'!~'^[0-9]{9,15}$' or x->>'observed_status' is distinct from 'active') then raise exception 'Exact active listing identity required' using errcode='22023';
 elsif (select count(distinct x->>'listing_id') from jsonb_array_elements(v->'records') x)<>n or exists(select 1 from jsonb_array_elements(v->'records') x join private.resale_ebay_listing_ingests i on i.external_listing_id=x->>'listing_id' join private.resale_ebay_listing_pages p on p.read_id=i.read_id where p.run_id=r.id) then problem:='duplicate_listing_across_pages';
 elsif (q.page>=pages and r.records_read+n<>entries) or (q.page<pages and n=0) then problem:='provider_count_gap';end if;
 if problem is not null then update public.resale_ebay_listing_runs set status='needs_review',last_error=problem,finished_at=clock_timestamp() where id=r.id returning * into r;return r;end if;
 insert into public.resale_snapshots(id,account_id,source,source_ref,observed_at,scope,coverage,cursor,record_count)
 values(snap,r.account_id,'official_api','ebay:read:'||q.id,at_time,'active listings returned on one page; absence is not sale or ended','partial',jsonb_build_object('run_id',r.id,'page',q.page,'reported_pages',pages,'reported_entries',entries)::text,n);
 for item in select value from jsonb_array_elements(v->'records') loop
 select * into l from public.resale_listings where account_id=r.account_id and external_listing_id=item->>'listing_id' for update;created:=not found;
 if created then insert into public.resale_listings(account_id,external_listing_id,title,listing_url) values(r.account_id,item->>'listing_id',item->>'title','https://www.ebay.com/itm/'||(item->>'listing_id')) on conflict(account_id,external_listing_id) do nothing returning * into l;
 if not found then select * into l from public.resale_listings where account_id=r.account_id and external_listing_id=item->>'listing_id' for update;created:=false;end if;
 if created then insert into private.resale_ebay_created_listings values(l.id,r.account_id);end if;end if;
 src:=gen_random_uuid();obs:=gen_random_uuid();
 insert into public.resale_source_records(id,snapshot_id,account_id,record_key,source_kind,source_file_sha256,source_row_sha256,raw_business,normalized,external_identifiers,event_precision,source_observed_at,captured_at,record_status)
 values(src,snap,r.account_id,'listing:'||(item->>'listing_id'),'official_api',v->>'source_sha256',encode(extensions.digest(convert_to(item::text,'UTF8'),'sha256'),'hex'),item,item,jsonb_build_object('listing_id',item->>'listing_id','api_read_id',q.id),'unknown',at_time,clock_timestamp(),'accepted');
 insert into public.resale_observations(id,snapshot_id,account_id,listing_id,observed_at,status,raw_status,availability,external_listing_id,evidence)
 values(obs,snap,r.account_id,l.id,at_time,'active','GetMyeBaySelling ActiveList','listed',item->>'listing_id',jsonb_build_object('source_record_id',src,'api_read_id',q.id,'run_id',r.id,'physical_stock_verified',false));
 insert into private.resale_ebay_listing_ingests values(q.id,l.id,src,obs,item->>'listing_id');
 end loop;
 insert into private.resale_ebay_listing_pages values(r.id,q.page,q.id,snap);
 update public.resale_ebay_listing_runs set expected_pages=pages,expected_entries=entries,pages_read=pages_read+1,records_read=records_read+n,
 next_page=next_page+1,next_request_id=gen_random_uuid(),status=case when q.page>=pages then 'complete' else 'running' end,
 finished_at=case when q.page>=pages then clock_timestamp() else null end,last_error=null where id=r.id returning * into r;return r;end $$;

-- A narrowly indexed, verified seller deletion is the only exception on this source table.
-- Other tables using the general immutable function retain their existing trigger unchanged.
create function private.resale_ebay_source_immutable() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' and exists(select 1 from private.resale_ebay_listing_ingests i join public.resale_ebay_reads r on r.id=i.read_id join private.resale_ebay_tokens t on t.account_id=r.account_id join private.resale_ebay_deletions d on d.subject_eias_sha256=t.seller_eias_sha256 where i.source_id=old.id and r.account_id=old.account_id) then return old;end if;
 raise exception 'Source records are immutable; append corrected evidence and retain the original' using errcode='55000';end $$;
revoke all on function private.resale_ebay_source_immutable() from public,anon,authenticated,service_role;
drop trigger resale_source_record_immutable on public.resale_source_records;
create trigger resale_source_record_immutable before update or delete on public.resale_source_records for each row execute function private.resale_ebay_source_immutable();

create function private.resale_ebay_purge_listing_page() returns trigger language plpgsql security definer set search_path='' as $$
declare i private.resale_ebay_listing_ingests;l public.resale_listings;o public.resale_observations;snap uuid;retained_at timestamptz;status_count integer;begin
 if not exists(select 1 from private.resale_ebay_listing_pages where read_id=old.id) then return old;end if;
 if not exists(select 1 from private.resale_ebay_tokens t join private.resale_ebay_deletions d on d.subject_eias_sha256=t.seller_eias_sha256 where t.account_id=old.account_id) then raise exception 'Verified exact seller deletion required' using errcode='42501';end if;
 select snapshot_id into snap from private.resale_ebay_listing_pages where read_id=old.id;
 for i in select * from private.resale_ebay_listing_ingests where read_id=old.id order by listing_id loop
 select * into l from public.resale_listings where id=i.listing_id for update;
 if l.observation_id=i.observation_id or (l.observation_id is null and l.observed_at=(select observed_at from public.resale_observations where id=i.observation_id)) then
 select max(observed_at) into retained_at from public.resale_observations where listing_id=l.id and id<>i.observation_id;
 select count(distinct status) into status_count from public.resale_observations where listing_id=l.id and id<>i.observation_id and observed_at=retained_at;
 if status_count>1 then update public.resale_listings set observation_id=null,observed_at=retained_at,observed_status='unknown' where id=l.id;
 else select * into o from public.resale_observations where listing_id=l.id and id<>i.observation_id and observed_at=retained_at order by created_at desc,id desc limit 1;
 update public.resale_listings set observation_id=o.id,observed_at=o.observed_at,observed_status=coalesce(o.status,'unknown') where id=l.id;end if;end if;
 -- The exact mapping must exist while the immutable-source trigger verifies this exception.
 delete from public.resale_source_records where id=i.source_id;
 delete from private.resale_ebay_listing_ingests where read_id=old.id and listing_id=l.id;
 delete from public.resale_observations where id=i.observation_id;
 if exists(select 1 from private.resale_ebay_created_listings where listing_id=l.id) and not exists(select 1 from public.resale_observations where listing_id=l.id) then
 update public.resale_listings set title=null,listing_url=null,external_listing_id=null,external_identifiers='{}',asking_price=null,currency=null,observed_status='unknown',observed_at=null,observation_id=null where id=l.id;
 end if;
 end loop;
 update public.resale_ebay_listing_runs set status='deletion_pending',last_error='seller_deleted',finished_at=clock_timestamp() where id in(select run_id from private.resale_ebay_listing_pages where read_id=old.id);
 delete from private.resale_ebay_listing_pages where read_id=old.id;
 delete from public.resale_snapshots where id=snap;
 return old;end $$;
revoke all on function private.resale_ebay_purge_listing_page() from public,anon,authenticated,service_role;
create trigger resale_ebay_purge_listing_page before delete on public.resale_ebay_reads for each row execute function private.resale_ebay_purge_listing_page();

revoke all on function public.resale_ebay_start_listing_run(uuid,uuid,uuid),public.resale_ebay_claim_listing_run(uuid,uuid),public.resale_ebay_checkpoint_listing_run(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.resale_ebay_start_listing_run(uuid,uuid,uuid),public.resale_ebay_claim_listing_run(uuid,uuid),public.resale_ebay_checkpoint_listing_run(uuid,uuid,uuid) to service_role;
revoke all on function public.resale_ebay_cancel_listing_run(uuid) from public,anon,service_role;
grant execute on function public.resale_ebay_cancel_listing_run(uuid) to authenticated;
commit;
