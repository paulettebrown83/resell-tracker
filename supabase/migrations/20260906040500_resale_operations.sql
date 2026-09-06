begin;
-- One existing outbox. New protocol rows are blocked until a real trusted adapter prepares them.
alter table public.resale_actions drop constraint resale_actions_action_check;
alter table public.resale_actions add constraint resale_actions_action_check check(action in ('publish','update','delist','import','reconcile_sale','reconcile_cancellation','reconcile_shipping'));
alter table public.resale_actions alter column listing_id drop not null;
alter table public.resale_actions add column operation_protocol integer not null default 0 check(operation_protocol in (0,1));
alter table public.resale_actions add column execution_mode text not null default 'unavailable' check(execution_mode in ('api_automatic','file_automatic','supervised_agent_browser','human_required','unavailable'));
alter table public.resale_actions add column adapter_key text;
alter table public.resale_actions add column adapter_version text;
alter table public.resale_actions add column trigger_ref jsonb;
alter table public.resale_actions add column expected_observation_id uuid references public.resale_observations(id);
alter table public.resale_actions add column expected_item_version integer;
alter table public.resale_actions add column desired_sha256 text;
alter table public.resale_actions add column target_identity jsonb not null default '{}';
alter table public.resale_actions add column required_fields jsonb not null default '[]' check(jsonb_typeof(required_fields)='array');
alter table public.resale_actions add column missing_fields jsonb not null default '[]' check(jsonb_typeof(missing_fields)='array');
alter table public.resale_actions add column blockers jsonb not null default '[]' check(jsonb_typeof(blockers)='array');
alter table public.resale_actions add column deep_link text;
alter table public.resale_actions add column next_step jsonb;
alter table public.resale_actions add column checkpoint jsonb not null default '{}';
alter table public.resale_actions add column verification_id uuid;
alter table public.resale_actions add constraint resale_operation_target_required check(
 (action not in ('publish','update','delist') or listing_id is not null)
 and (operation_protocol=0 or target_account_id is not null));

create table private.resale_operation_requests (
 request_id uuid primary key, actor_id uuid not null references auth.users(id),
 operation_id uuid not null references public.resale_actions(id), payload jsonb not null, created_at timestamptz not null default now()
);
alter table private.resale_operation_requests enable row level security;
revoke all on private.resale_operation_requests from public,anon,authenticated,service_role;

-- Runtime authority is not accepted from the browser. Registry contains no credentials.
create table private.resale_operation_adapters (
 account_id uuid not null references public.resale_accounts(id), action text not null,
 adapter_key text not null, adapter_version text not null,
 execution_mode text not null check(execution_mode in ('api_automatic','file_automatic','supervised_agent_browser','human_required','unavailable')),
 ready boolean not null default false, reason text not null,
 required_fields jsonb not null default '[]' check(jsonb_typeof(required_fields)='array'),
 verified_at timestamptz not null default now(), primary key(account_id,action),
 check(action in ('publish','update','delist','import','reconcile_sale','reconcile_cancellation','reconcile_shipping')),
 check(not ready or execution_mode in ('api_automatic','file_automatic','supervised_agent_browser'))
);
alter table private.resale_operation_adapters enable row level security;
revoke all on private.resale_operation_adapters from public,anon,authenticated;
grant select,insert,update,delete on private.resale_operation_adapters to service_role;

create table public.resale_operation_proposals (
 id uuid primary key, operation_id uuid not null references public.resale_actions(id),
 actor_id uuid not null references auth.users(id), source_record_ids uuid[] not null default '{}',
 note text not null check(length(note)<=2000), created_at timestamptz not null default now()
);
create table public.resale_operation_verifications (
 id uuid primary key default gen_random_uuid(), operation_id uuid not null references public.resale_actions(id),
 attempt_id uuid not null references public.resale_action_attempts(id),
 account_id uuid not null references public.resale_accounts(id),
 method text not null check(method in ('checked_import','checked_sale_evidence','checked_cancellation_evidence','checked_shipping_evidence')),
 source_record_ids uuid[] not null, snapshot_ids uuid[] not null,
 decision text not null check(decision in ('evidence_imported','verified_source_event','needs_review')),
 note text not null check(length(note) between 1 and 2000), checked_at timestamptz not null default now()
);
create index resale_operation_proposals_parent on public.resale_operation_proposals(operation_id,created_at);
create index resale_operation_verifications_parent on public.resale_operation_verifications(operation_id,attempt_id);
alter table public.resale_actions add foreign key(verification_id) references public.resale_operation_verifications(id);
do $$ declare n text; begin
 select conname into n from pg_constraint where conrelid='public.resale_actions'::regclass and contype='c' and pg_get_constraintdef(oid) like '%succeeded%verification_observation_id%';
 if n is null then raise exception 'Expected existing success constraint'; end if;
 execute format('alter table public.resale_actions drop constraint %I',n);
end $$;
alter table public.resale_actions add constraint resale_action_verified_success check(state<>'succeeded' or
 (action in ('publish','update','delist') and verification_observation_id is not null)
 or (action in ('import','reconcile_sale','reconcile_cancellation','reconcile_shipping') and verification_id is not null));

create function private.resale_operation_append_only() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Operation evidence is append-only' using errcode='55000'; end $$;
revoke all on function private.resale_operation_append_only() from public,anon,authenticated,service_role;
do $$ declare t text; begin
 foreach t in array array['resale_operation_proposals','resale_operation_verifications'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 execute format('grant select on public.%I to authenticated,service_role',t);
 execute format('create policy resale_members_read on public.%I for select to authenticated using ((select private.has_access(''resale'')))',t);
 execute format('create trigger operation_evidence_immutable before update or delete on public.%I for each row execute function private.resale_operation_append_only()',t);
 end loop;
end $$;

-- Exact, fixed marketplace origins only; reject credentials, queries, fragments and lookalike hosts.
create function private.resale_safe_deep_link(p_marketplace text,p_url text) returns text
language sql immutable set search_path='' as $$
 select case when p_url ~ ('^https://' || case p_marketplace
 when 'poshmark' then '(www\.)?poshmark\.com' when 'mercari' then '(www\.)?mercari\.com'
 when 'depop' then '(www\.)?depop\.com' when 'vinted' then '(www\.)?vinted\.(com|co\.uk|fr)'
 when 'ebay' then '(www\.)?ebay\.com' else '(?!)' end || '/[A-Za-z0-9_./%~-]*$') then p_url else null end
$$;
revoke all on function private.resale_safe_deep_link(text,text) from public,anon,authenticated;
grant execute on function private.resale_safe_deep_link(text,text) to service_role;

create function private.resale_request_operation(p_request_id uuid,p_payload jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare actor uuid:=auth.uid(); req private.resale_operation_requests; a public.resale_accounts; l public.resale_listings;
 item public.inventory; d public.resale_item_details; adapter private.resale_operation_adapters;
 account_id uuid; listing_id uuid; inventory_id uuid; kind text; op uuid:=gen_random_uuid(); expected uuid; trigger_id uuid;
 need jsonb:='[]'; missing jsonb:='[]'; field text; blocked jsonb;
begin
 perform 1 from private.memberships where user_id=actor and area='resale' for share;
 if actor is null or not found then raise exception 'Resale access required' using errcode='42501'; end if;
 if p_request_id is null or p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'Operation request required' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,7201));
 select * into req from private.resale_operation_requests where request_id=p_request_id;
 if found then
 if req.actor_id<>actor or req.payload<>p_payload then raise exception 'Operation retry changed' using errcode='22023'; end if;
 return req.operation_id; end if;
 if exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('account_id','action','listing_id','inventory_id','expected_observation_id','expected_item_version','trigger','requested'))
 or jsonb_typeof(p_payload->'requested') is distinct from 'object'
 or jsonb_typeof(p_payload->'trigger') is distinct from 'object'
 or octet_length(p_payload::text)>24000 then raise exception 'Invalid operation fields' using errcode='22023'; end if;
 account_id:=(p_payload->>'account_id')::uuid; listing_id:=(p_payload->>'listing_id')::uuid;
 inventory_id:=(p_payload->>'inventory_id')::uuid; kind:=p_payload->>'action'; expected:=(p_payload->>'expected_observation_id')::uuid;
 if kind is null or kind not in ('publish','update','delist','import','reconcile_sale','reconcile_cancellation','reconcile_shipping') then raise exception 'Unknown operation' using errcode='22023'; end if;
 select * into a from public.resale_accounts where id=account_id for share;
 if not found then raise exception 'Account not found' using errcode='22023'; end if;
 if inventory_id is not null then
 select * into item from public.inventory where id=inventory_id for update;
 if not found then raise exception 'Item not found' using errcode='22023'; end if;
 select * into d from public.resale_item_details details where details.inventory_id=item.id for share;
 end if;
 if listing_id is not null then
 select * into l from public.resale_listings where id=listing_id for update;
 if not found or l.account_id<>account_id or l.inventory_id is distinct from inventory_id then raise exception 'Account or item binding mismatch' using errcode='22023'; end if;
 if l.observation_id is distinct from expected then raise exception 'Listing changed; reload' using errcode='40001'; end if;
 end if;
 if kind in ('publish','update','delist') then
 if listing_id is null or inventory_id is null or l.match_status<>'confirmed' then raise exception 'Confirmed exact item and listing required' using errcode='22023'; end if;
 if coalesce(d.version,0) is distinct from (p_payload->>'expected_item_version')::integer then raise exception 'Item changed; reload' using errcode='40001'; end if;
 if kind in ('publish','update') and (lower(coalesce(item.status,''))='sold' or item.archived_at is not null or d.workflow='archived') then raise exception 'Item unavailable for listing changes' using errcode='22023'; end if;
 if kind='delist' and l.external_listing_id is null then raise exception 'Exact external listing ID required' using errcode='22023'; end if;
 end if;
 trigger_id:=(p_payload->'trigger'->>'id')::uuid;
 if trigger_id is null then raise exception 'Trigger identity required' using errcode='22023'; end if;
 case p_payload->'trigger'->>'kind'
 when 'member_request' then if trigger_id<>p_request_id then raise exception 'Member trigger must equal request ID' using errcode='22023'; end if;
 when 'source_record' then if not exists(select 1 from public.resale_source_records s where s.id=trigger_id and s.account_id=account_id) then raise exception 'Source account mismatch' using errcode='22023'; end if;
 when 'order_event' then if not exists(select 1 from public.resale_order_events e where e.id=trigger_id and e.account_id=account_id) then raise exception 'Event account mismatch' using errcode='22023'; end if;
 when 'sale' then if inventory_id is null or not exists(select 1 from public.sales s where s.id=trigger_id and s.inventory_id=inventory_id and lower(coalesce(s.status,''))<>'void') then raise exception 'Sale item mismatch' using errcode='22023'; end if;
 else raise exception 'Unknown trigger' using errcode='22023'; end case;
 select * into adapter from private.resale_operation_adapters r where r.account_id=account_id and r.action=kind;
 need:=coalesce(adapter.required_fields,'[]');
 for field in select jsonb_array_elements_text(need) loop
 if not (p_payload->'requested' ? field) or p_payload->'requested'->field='null'::jsonb or p_payload->'requested'->field='""'::jsonb then missing:=missing||jsonb_build_array(field); end if;
 end loop;
 blocked:=jsonb_build_array(jsonb_build_object('code',case when adapter.execution_mode='human_required' then 'human_step' when adapter.ready then 'trusted_preflight' else 'capability_unavailable' end,'message',coalesce(adapter.reason,'This operation has no enabled executor. Your request is saved.')));
 if jsonb_array_length(missing)>0 then blocked:=blocked||jsonb_build_array(jsonb_build_object('code','missing_data','message','Add the missing required details.')); end if;
 if kind in ('publish','update','delist') then blocked:=blocked||jsonb_build_array(jsonb_build_object('code','quantity_review','message','Confirm exact physical unit and variant scope before execution.')); end if;
 insert into public.resale_actions(id,listing_id,sale_id,target_account_id,target_external_listing_id,target_inventory_id,action,state,idempotency_key,reason,payload,
 operation_protocol,execution_mode,adapter_key,adapter_version,trigger_ref,expected_observation_id,expected_item_version,desired_sha256,target_identity,required_fields,missing_fields,blockers,deep_link,next_step)
 values(op,listing_id,case when p_payload->'trigger'->>'kind'='sale' then trigger_id end,account_id,l.external_listing_id,inventory_id,kind,'blocked','member:'||p_request_id,
 'Requested work; trusted preparation and verification required',p_payload->'requested',1,coalesce(adapter.execution_mode,'unavailable'),adapter.adapter_key,adapter.adapter_version,p_payload->'trigger',expected,(p_payload->>'expected_item_version')::integer,
 encode(extensions.digest(convert_to((p_payload->'requested')::text,'UTF8'),'sha256'),'hex'),
 jsonb_build_object('account_id',account_id,'external_account_id',a.external_account_id,'listing_id',listing_id,'external_listing_id',l.external_listing_id,'external_identifiers',l.external_identifiers,'inventory_id',inventory_id),need,missing,blocked,
 private.resale_safe_deep_link(a.marketplace,l.listing_url),jsonb_build_object('key',case when jsonb_array_length(missing)>0 then 'provide_details' else 'review_capability' end,'label',case when jsonb_array_length(missing)>0 then 'Add details' else 'Review next step' end,'explanation',coalesce(adapter.reason,'A working executor must be connected before this can run.')));
 insert into private.resale_operation_requests(request_id,actor_id,operation_id,payload) values(p_request_id,actor,op,p_payload);
 return op;
end $$;
revoke all on function private.resale_request_operation(uuid,jsonb) from public,anon;
grant execute on function private.resale_request_operation(uuid,jsonb) to authenticated;
create function public.resale_request_operation(p_request_id uuid,p_payload jsonb) returns uuid language sql security invoker set search_path='' as $$ select private.resale_request_operation(p_request_id,p_payload) $$;
revoke all on function public.resale_request_operation(uuid,jsonb) from public,anon;
grant execute on function public.resale_request_operation(uuid,jsonb) to authenticated;

create function private.resale_submit_operation_evidence(p_request_id uuid,p_operation_id uuid,p_payload jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); a public.resale_actions; prior public.resale_operation_proposals; ids uuid[]; note text;
begin
 perform 1 from private.memberships where user_id=actor and area='resale' for share;
 if actor is null or not found then raise exception 'Resale access required' using errcode='42501'; end if;
 if p_request_id is null or p_payload is null or jsonb_typeof(p_payload)<>'object'
 or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('source_record_ids','note'))
 or jsonb_typeof(p_payload->'source_record_ids') is distinct from 'array' or jsonb_array_length(p_payload->'source_record_ids')>100
 or jsonb_typeof(p_payload->'note') is distinct from 'string' or length(p_payload->>'note')>2000 then raise exception 'Invalid evidence proposal' using errcode='22023'; end if;
 select coalesce(array_agg(x::uuid order by ord),'{}') into ids from jsonb_array_elements_text(p_payload->'source_record_ids') with ordinality v(x,ord);
 note:=p_payload->>'note';
 if cardinality(ids)=0 and length(btrim(note))=0 then raise exception 'Evidence or explanation required' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,7202));
 select * into prior from public.resale_operation_proposals where id=p_request_id;
 if found then
 if prior.operation_id<>p_operation_id or prior.actor_id<>actor or prior.source_record_ids<>ids or prior.note<>note then raise exception 'Evidence retry changed' using errcode='22023'; end if;
 return prior.id; end if;
 select * into a from public.resale_actions where id=p_operation_id for share;
 if not found then raise exception 'Operation not found' using errcode='22023'; end if;
 if exists(select 1 from unnest(ids) i where not exists(select 1 from public.resale_source_records s where s.id=i and s.account_id=a.target_account_id)) then raise exception 'Evidence account mismatch' using errcode='22023'; end if;
 insert into public.resale_operation_proposals(id,operation_id,actor_id,source_record_ids,note) values(p_request_id,p_operation_id,actor,ids,note);
 return p_request_id;
end $$;
revoke all on function private.resale_submit_operation_evidence(uuid,uuid,jsonb) from public,anon;
grant execute on function private.resale_submit_operation_evidence(uuid,uuid,jsonb) to authenticated;
create function public.resale_submit_operation_evidence(p_request_id uuid,p_operation_id uuid,p_payload jsonb) returns uuid language sql security invoker set search_path='' as $$ select private.resale_submit_operation_evidence(p_request_id,p_operation_id,p_payload) $$;
revoke all on function public.resale_submit_operation_evidence(uuid,uuid,jsonb) from public,anon;
grant execute on function public.resale_submit_operation_evidence(uuid,uuid,jsonb) to authenticated;

-- Narrow trusted evidence dispatcher. No listing executor is introduced here.
create function private.resale_claim_evidence_operation(p_operation_id uuid) returns public.resale_actions
language plpgsql security definer set search_path='' as $$
declare a public.resale_actions; r private.resale_operation_adapters; owner_id uuid; field text;
begin
 select q.actor_id into owner_id from private.resale_operation_requests q where q.operation_id=p_operation_id;
 perform 1 from private.memberships where user_id=owner_id and area='resale' for share;
 if not found then raise exception 'Requesting member no longer has access' using errcode='42501'; end if;
 select * into a from public.resale_actions where id=p_operation_id for update;
 if not found or a.operation_protocol<>1 or a.action not in ('import','reconcile_sale','reconcile_cancellation','reconcile_shipping') then raise exception 'Not an evidence operation' using errcode='22023'; end if;
 if a.state='running' and a.lease_expires_at<clock_timestamp() then
 update public.resale_actions set state='uncertain',last_error='Execution expired; verify the result before retrying',updated_at=now() where id=a.id returning * into a;
 return a; end if;
 if a.state not in ('blocked','queued','failed') or a.verification_id is not null then raise exception 'Operation needs verification or is complete' using errcode='22023'; end if;
 select * into r from private.resale_operation_adapters where account_id=a.target_account_id and action=a.action for share;
 if not found or not r.ready or r.execution_mode not in ('file_automatic','supervised_agent_browser','api_automatic') then raise exception 'A verified working adapter is required' using errcode='22023'; end if;
 for field in select jsonb_array_elements_text(r.required_fields) loop
 if not (a.payload ? field) or a.payload->field='null'::jsonb or a.payload->field='""'::jsonb then raise exception 'Required field missing: %',field using errcode='22023'; end if;
 end loop;
 if a.desired_sha256 is distinct from encode(extensions.digest(convert_to(a.payload::text,'UTF8'),'sha256'),'hex') then raise exception 'Operation request changed' using errcode='22023'; end if;
 update public.resale_actions set state='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '5 minutes',
 execution_mode=r.execution_mode,adapter_key=r.adapter_key,adapter_version=r.adapter_version,required_fields=r.required_fields,missing_fields='[]',blockers='[]',last_error=null,
 next_step=jsonb_build_object('key','running','label','Checking evidence','explanation','The connected adapter is processing this request.'),updated_at=now()
 where id=a.id returning * into a;
 insert into public.resale_action_attempts(action_id,attempt,started_at,evidence) values(a.id,a.attempts,clock_timestamp(),jsonb_build_object('adapter_key',r.adapter_key,'adapter_version',r.adapter_version,'execution_mode',r.execution_mode,'desired_sha256',a.desired_sha256));
 return a;
end $$;
revoke all on function private.resale_claim_evidence_operation(uuid) from public,anon,authenticated;
grant execute on function private.resale_claim_evidence_operation(uuid) to service_role;

create function private.resale_checkpoint_evidence_operation(p_operation_id uuid,p_lease_token uuid,p_step_key text,p_source_record_ids uuid[],p_snapshot_ids uuid[]) returns void
language plpgsql security definer set search_path='' as $$
declare a public.resale_actions; owner_id uuid;
begin
 select q.actor_id into owner_id from private.resale_operation_requests q where q.operation_id=p_operation_id;
 perform 1 from private.memberships where user_id=owner_id and area='resale' for share;
 if not found then raise exception 'Requesting member no longer has access' using errcode='42501'; end if;
 select * into a from public.resale_actions where id=p_operation_id for update;
 if not found or a.action not in ('import','reconcile_sale','reconcile_cancellation','reconcile_shipping') or a.state<>'running'
 or p_lease_token is null or a.lease_token is distinct from p_lease_token or a.lease_expires_at<=clock_timestamp()
 or p_step_key is null or p_step_key !~ '^[a-z][a-z0-9_]{0,63}$' or p_source_record_ids is null or p_snapshot_ids is null
 or cardinality(p_source_record_ids)>500 or cardinality(p_snapshot_ids)>100 then raise exception 'Invalid checkpoint or lease' using errcode='22023'; end if;
 if exists(select 1 from unnest(p_source_record_ids) i where not exists(select 1 from public.resale_source_records s where s.id=i and s.account_id=a.target_account_id))
 or exists(select 1 from unnest(p_snapshot_ids) i where not exists(select 1 from public.resale_snapshots s where s.id=i and s.account_id=a.target_account_id)) then raise exception 'Checkpoint account mismatch' using errcode='22023'; end if;
 update public.resale_actions set checkpoint=jsonb_build_object('step_key',p_step_key,'source_record_ids',p_source_record_ids,'snapshot_ids',p_snapshot_ids),updated_at=now() where id=a.id;
end $$;
revoke all on function private.resale_checkpoint_evidence_operation(uuid,uuid,text,uuid[],uuid[]) from public,anon,authenticated;
grant execute on function private.resale_checkpoint_evidence_operation(uuid,uuid,text,uuid[],uuid[]) to service_role;

create function private.resale_finish_evidence_operation(p_operation_id uuid,p_lease_token uuid,p_outcome text,p_source_record_ids uuid[],p_snapshot_ids uuid[],p_decision text,p_note text) returns public.resale_actions
language plpgsql security definer set search_path='' as $$
declare a public.resale_actions; attempt_id uuid; proof public.resale_operation_verifications; verification uuid; owner_id uuid;
begin
 select q.actor_id into owner_id from private.resale_operation_requests q where q.operation_id=p_operation_id;
 perform 1 from private.memberships where user_id=owner_id and area='resale' for share;
 if not found then raise exception 'Requesting member no longer has access' using errcode='42501'; end if;
 select * into a from public.resale_actions where id=p_operation_id for update;
 if not found or a.action not in ('import','reconcile_sale','reconcile_cancellation','reconcile_shipping')
 or p_lease_token is null or a.lease_token is distinct from p_lease_token
 or p_outcome is null or p_outcome not in ('accepted','verified','rejected','uncertain')
 or p_source_record_ids is null or p_snapshot_ids is null or cardinality(p_source_record_ids)>500 or cardinality(p_snapshot_ids)>100
 or p_note is null or length(p_note) not between 1 and 2000 then raise exception 'Invalid evidence result' using errcode='22023'; end if;
 if a.verification_id is not null then
 select * into proof from public.resale_operation_verifications where id=a.verification_id;
 if p_outcome<>'verified' or proof.source_record_ids<>p_source_record_ids or proof.snapshot_ids<>p_snapshot_ids or proof.decision is distinct from p_decision or proof.note<>p_note then raise exception 'Completed result changed' using errcode='22023'; end if;
 return a; end if;
 if a.state not in ('running','uncertain') then raise exception 'No matching active attempt' using errcode='22023'; end if;
 select id into attempt_id from public.resale_action_attempts where action_id=a.id and attempt=a.attempts;
 if attempt_id is null then raise exception 'Attempt missing' using errcode='22023'; end if;
 if p_outcome='verified' then
 if cardinality(p_snapshot_ids)=0 or p_decision is null or p_decision not in ('evidence_imported','verified_source_event','needs_review')
 or (a.action='import' and p_decision<>'evidence_imported') or (a.action<>'import' and p_decision='evidence_imported') then raise exception 'Operation-specific decision required' using errcode='22023'; end if;
 if exists(select 1 from unnest(p_snapshot_ids) i where not exists(select 1 from public.resale_snapshots s where s.id=i and s.account_id=a.target_account_id))
 or exists(select 1 from unnest(p_source_record_ids) i where not exists(select 1 from public.resale_source_records s where s.id=i and s.account_id=a.target_account_id and s.snapshot_id=any(p_snapshot_ids))) then raise exception 'Proof account or snapshot mismatch' using errcode='22023'; end if;
 if cardinality(p_source_record_ids)=0 and (a.action<>'import' or exists(select 1 from public.resale_snapshots s where s.id=any(p_snapshot_ids) and s.record_count is distinct from 0)) then raise exception 'No source proof supplied' using errcode='22023'; end if;
 if p_decision='verified_source_event' and exists(select 1 from public.resale_source_records s where s.id=any(p_source_record_ids) and
 (s.record_status<>'accepted' or coalesce(s.external_identifiers->>'order_id','')='' or coalesce(s.external_identifiers->>'line_id','')='')) then raise exception 'Exact order and line identity required; unresolved evidence needs review' using errcode='22023'; end if;
 insert into public.resale_operation_verifications(operation_id,attempt_id,account_id,method,source_record_ids,snapshot_ids,decision,note)
 values(a.id,attempt_id,a.target_account_id,case a.action when 'import' then 'checked_import' when 'reconcile_sale' then 'checked_sale_evidence' when 'reconcile_cancellation' then 'checked_cancellation_evidence' else 'checked_shipping_evidence' end,p_source_record_ids,p_snapshot_ids,p_decision,p_note) returning id into verification;
 if p_decision='needs_review' then insert into public.resale_review_cases(inventory_id,listing_id,reason,evidence)
 values(a.target_inventory_id,a.listing_id,'Imported evidence needs an explicit reconciliation decision',jsonb_build_object('operation_id',a.id,'verification_id',verification,'source_record_ids',p_source_record_ids)); end if;
 end if;
 update public.resale_action_attempts set finished_at=clock_timestamp(),outcome=p_outcome,evidence=evidence||jsonb_build_object('source_record_ids',p_source_record_ids,'snapshot_ids',p_snapshot_ids,'decision',p_decision,'note',p_note) where id=attempt_id;
 update public.resale_actions set state=case when p_outcome='verified' and p_decision='needs_review' then 'blocked' when p_outcome='verified' then 'succeeded' when p_outcome='rejected' then 'failed' else 'uncertain' end,
 verification_id=verification,lease_expires_at=null,last_error=case p_outcome when 'verified' then null else p_note end,
 blockers=case when p_outcome='verified' and p_decision='needs_review' then jsonb_build_array(jsonb_build_object('code','identity_review','message',p_note)) else '[]'::jsonb end,
 next_step=case when p_outcome='verified' and p_decision='needs_review' then jsonb_build_object('key','review_evidence','label','Review missing details','explanation',p_note) when p_outcome='verified' then null else jsonb_build_object('key','verify_result','label','Check the result','explanation',p_note) end,updated_at=now()
 where id=a.id returning * into a;
 return a;
end $$;
revoke all on function private.resale_finish_evidence_operation(uuid,uuid,text,uuid[],uuid[],text,text) from public,anon,authenticated;
grant execute on function private.resale_finish_evidence_operation(uuid,uuid,text,uuid[],uuid[],text,text) to service_role;

create view public.resale_operation_view with(security_invoker=true) as
 select a.id,coalesce(a.target_account_id,l.account_id) account_id,c.marketplace,a.action,a.state,
 a.execution_mode,a.adapter_key,a.adapter_version,a.listing_id,a.target_inventory_id inventory_id,a.trigger_ref trigger,
 a.required_fields,a.missing_fields,a.blockers,a.deep_link,a.next_step,a.checkpoint,a.attempts,a.next_attempt_at,a.last_error,
 (select t.outcome from public.resale_action_attempts t where t.action_id=a.id order by t.attempt desc limit 1) latest_outcome,
 a.verification_id,a.verification_observation_id,
 (select count(*) from public.resale_operation_proposals p where p.operation_id=a.id) proposal_count,a.created_at,a.updated_at
 from public.resale_actions a left join public.resale_listings l on l.id=a.listing_id
 join public.resale_accounts c on c.id=coalesce(a.target_account_id,l.account_id);
revoke all on public.resale_operation_view from public,anon;
grant select on public.resale_operation_view to authenticated,service_role;

-- Existing delist executor retains its original guarded protocol; it cannot claim new packets.
create or replace function private.resale_release_delist(p_action_id uuid,p_observation_id uuid) returns public.resale_actions
language plpgsql security invoker set search_path='' as $$
declare a public.resale_actions; l public.resale_listings; o public.resale_observations; c public.resale_accounts;
begin
 select * into a from public.resale_actions where id=p_action_id for update;
 if not found or a.operation_protocol<>0 or a.action<>'delist' or a.state not in ('blocked','failed','uncertain') then raise exception 'Action cannot be released' using errcode='22023'; end if;
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

create or replace function private.resale_claim_delist() returns public.resale_actions
language plpgsql security invoker set search_path='' as $$
declare a public.resale_actions;
begin
 -- Expired leases are uncertain, never blindly placed back on the runnable queue.
 update public.resale_actions set state='uncertain',last_error='Lease expired; verify remote result before retry',updated_at=now()
 where action='delist' and operation_protocol=0 and state='running' and lease_expires_at<clock_timestamp();
 select x.* into a from public.resale_actions x join public.resale_listings l on l.id=x.listing_id
 join public.resale_accounts c on c.id=l.account_id
 join public.sales s on s.id=x.sale_id and s.inventory_id=l.inventory_id
 where x.operation_protocol=0 and x.state='queued' and x.action='delist' and coalesce(x.next_attempt_at,now())<=now()
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


create or replace function private.resale_finish_delist(p_action_id uuid,p_lease_token uuid,p_outcome text,p_observation_id uuid,p_evidence jsonb)
returns public.resale_actions language plpgsql security invoker set search_path='' as $$
declare a public.resale_actions; o public.resale_observations; v_started timestamptz;
begin
 select * into a from public.resale_actions where id=p_action_id for update;
 if not found or a.operation_protocol<>0 or a.action<>'delist' or a.lease_token is distinct from p_lease_token or p_lease_token is null
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

-- Sale voiding changes delist work, never historical evidence tasks.
create or replace function private.resale_sale_actions() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.inventory_id is null then return new; end if;
 if lower(coalesce(new.status,''))='void' then
 update public.resale_actions set state=case when state='running' then 'uncertain' else 'cancelled' end,
 reason='Sale voided; inspect marketplace before any further action',updated_at=now()
 where sale_id=new.id and action='delist' and state in ('blocked','queued','running','failed');
 insert into public.resale_review_cases(inventory_id,reason,evidence)
 select new.inventory_id,'Sale voided; verify remaining marketplace listings before relisting',jsonb_build_object('sale_id',new.id)
 where exists(select 1 from public.resale_actions where sale_id=new.id and action='delist' and state in ('uncertain','succeeded'));
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
commit;
