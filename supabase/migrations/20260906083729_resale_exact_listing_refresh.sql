begin;
create unique index resale_one_open_listing_refresh on public.resale_actions(listing_id) where payload->>'scope'='exact_listing_refresh' and state not in ('succeeded','cancelled');
create function public.resale_request_listing_refresh(p_request_id uuid,p_payload jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); l public.resale_listings; a public.resale_accounts; prior private.resale_operation_requests; op uuid:=gen_random_uuid(); wanted jsonb;
begin
 perform 1 from private.memberships where user_id=actor and area='resale' for share;
 if not found then raise exception 'Current resale membership required' using errcode='42501'; end if;
 if p_request_id is null or jsonb_typeof(p_payload)<>'object' then raise exception 'Exact request required' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,79));
 select * into prior from private.resale_operation_requests where request_id=p_request_id;
 if found then
 if prior.actor_id<>actor or prior.payload is distinct from p_payload then raise exception 'Request retry changed' using errcode='22023'; end if;
 return prior.operation_id; end if;
 select * into l from public.resale_listings where id=(p_payload->>'listing_id')::uuid for share;
 if not found or l.external_listing_id is null then raise exception 'Existing listing required' using errcode='22023'; end if;
 select * into a from public.resale_accounts where id=l.account_id for share;
 if a.marketplace not in ('poshmark','mercari') or nullif(a.external_account_id,'') is null or nullif(a.username,'') is null then raise exception 'Verified supported seller account identity required' using errcode='22023'; end if;
 if (a.marketplace='poshmark' and l.external_listing_id !~ '^[0-9a-f]{24}$') or (a.marketplace='mercari' and l.external_listing_id !~ '^m[0-9]{11}$') then raise exception 'Supported exact listing ID required' using errcode='22023'; end if;
 wanted:=jsonb_build_object('account_id',a.id,'action','import','listing_id',l.id,'inventory_id',l.inventory_id,'expected_observation_id',l.observation_id,'expected_item_version',null,
 'trigger',jsonb_build_object('kind','member_request','id',p_request_id),'requested',jsonb_build_object('scope','exact_listing_refresh','external_listing_id',l.external_listing_id));
 if p_payload is distinct from wanted then raise exception 'Exact listing reference request required; reload the listing' using errcode='40001'; end if;
 insert into public.resale_actions(id,listing_id,action,state,idempotency_key,reason,payload,operation_protocol,execution_mode,adapter_key,adapter_version,trigger_ref,target_account_id,target_external_listing_id,target_inventory_id,expected_observation_id,desired_sha256,target_identity,blockers,deep_link,next_step)
 values(op,l.id,'import','blocked','listing-refresh:'||p_request_id,'Refresh the exact marketplace listing and its observed price settings',p_payload->'requested',1,'supervised_agent_browser','exact_listing_refresh_v1','1',p_payload->'trigger',a.id,l.external_listing_id,l.inventory_id,l.observation_id,
 encode(extensions.digest(convert_to((p_payload->'requested')::text,'UTF8'),'sha256'),'hex'),
 jsonb_build_object('marketplace',a.marketplace,'account_id',a.id,'external_account_id',a.external_account_id,'account_handle',a.username,'listing_id',l.id,'external_listing_id',l.external_listing_id,'inventory_id',l.inventory_id,'match_status',l.match_status),
 '[{"code":"awaiting_agent","message":"A supervised agent must read the exact seller listing without changing it."}]',
 case a.marketplace when 'poshmark' then 'https://poshmark.com/edit-listing/'||l.external_listing_id else 'https://www.mercari.com/sell/edit/'||l.external_listing_id||'/' end,
 '{"key":"awaiting_agent","label":"Awaiting an agent","explanation":"This is a saved request for supervised browser work. No background marketplace consumer is installed."}');
 insert into private.resale_operation_requests(request_id,actor_id,operation_id,payload) values(p_request_id,actor,op,p_payload);
 return op;
end $$;
revoke all on function public.resale_request_listing_refresh(uuid,jsonb) from public,anon,service_role;
grant execute on function public.resale_request_listing_refresh(uuid,jsonb) to authenticated;

create function private.resale_lock_listing_refresh(p_action_id uuid,p_require_target boolean default true) returns public.resale_actions
language plpgsql security definer set search_path='' as $$
declare a public.resale_actions; l public.resale_listings; c public.resale_accounts; actor uuid;
begin
 select q.actor_id into actor from private.resale_operation_requests q where q.operation_id=p_action_id;
 perform 1 from private.memberships where user_id=actor and area='resale' for share;
 if not found then raise exception 'Requesting member no longer has access' using errcode='42501'; end if;
 select * into a from public.resale_actions where id=p_action_id;
 if not found or a.action<>'import' or a.payload->>'scope' is distinct from 'exact_listing_refresh' or a.adapter_key is distinct from 'exact_listing_refresh_v1' then raise exception 'Not an exact listing refresh request' using errcode='22023'; end if;
 select * into l from public.resale_listings where id=a.listing_id for share;
 select * into c from public.resale_accounts where id=l.account_id for share;
 select * into a from public.resale_actions where id=p_action_id for update;
 if p_require_target and (l.account_id is distinct from a.target_account_id or l.external_listing_id is distinct from a.target_external_listing_id or l.inventory_id is distinct from a.target_inventory_id
 or (a.state<>'succeeded' and l.observation_id is distinct from a.expected_observation_id) or l.match_status is distinct from a.target_identity->>'match_status'
 or c.marketplace is distinct from a.target_identity->>'marketplace' or c.external_account_id is distinct from a.target_identity->>'external_account_id' or c.username is distinct from a.target_identity->>'account_handle'
 or a.desired_sha256 is distinct from encode(extensions.digest(convert_to(a.payload::text,'UTF8'),'sha256'),'hex') ) then raise exception 'Listing refresh target changed; fresh review required' using errcode='40001'; end if;
 return a;
end $$;
revoke all on function private.resale_lock_listing_refresh(uuid,boolean) from public,anon,authenticated,service_role;

create function public.resale_claim_listing_refresh(p_action_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.resale_actions; attempt_id uuid;
begin
 a:=private.resale_lock_listing_refresh(p_action_id);
 if a.state='succeeded' then return jsonb_build_object('state',a.state,'action_id',a.id,'verification_id',a.verification_id); end if;
 if a.state='running' and a.lease_expires_at>clock_timestamp() then raise exception 'An exact refresh is running' using errcode='55000'; end if;
 if a.state not in ('blocked','queued','failed','uncertain','running') then raise exception 'Request cannot be claimed' using errcode='55000'; end if;
 update public.resale_action_attempts set finished_at=clock_timestamp(),outcome='uncertain',evidence=evidence||'{"reason":"read_lease_expired"}' where action_id=a.id and finished_at is null;
 update public.resale_actions set state='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '10 minutes',blockers='[]',last_error=null,
 next_step='{"key":"reading_listing","label":"Agent reading the listing","explanation":"This is a read-only seller-editor check; no marketplace changes are authorized."}',updated_at=now() where id=a.id returning * into a;
 insert into public.resale_action_attempts(action_id,attempt,started_at,evidence) values(a.id,a.attempts,clock_timestamp(),jsonb_build_object('adapter_key',a.adapter_key,'read_only',true)) returning id into attempt_id;
 return jsonb_build_object('action_id',a.id,'attempt_id',attempt_id,'lease_token',a.lease_token,'lease_expires_at',a.lease_expires_at,'target',a.target_identity,'editor_url',a.deep_link,'read_only',true);
end $$;
revoke all on function public.resale_claim_listing_refresh(uuid) from public,anon,authenticated;
grant execute on function public.resale_claim_listing_refresh(uuid) to service_role;

-- A successful read with absent price fields records unknowns, not older amounts as current.
alter table public.resale_pricing_observations alter column asking_minor drop not null;
alter table public.resale_pricing_observations alter column currency drop not null;

alter table public.resale_operation_verifications drop constraint resale_operation_verifications_method_check;
alter table public.resale_operation_verifications add constraint resale_operation_verifications_method_check check(method in ('checked_import','checked_sale_evidence','checked_cancellation_evidence','checked_shipping_evidence','checked_private_listing_reference','checked_exact_listing_refresh'));

create function public.resale_finish_listing_refresh(p_action_id uuid,p_lease_token uuid,p_facts jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare a public.resale_actions; t public.resale_action_attempts; v public.resale_operation_verifications; actor uuid; at_time timestamptz; k text; pricing jsonb; status_value text:='unknown'; snapshot_id uuid:=gen_random_uuid(); source_id uuid:=gen_random_uuid(); observation_id uuid:=gen_random_uuid(); pricing_id uuid:=gen_random_uuid(); proof_id uuid:=gen_random_uuid(); receipt_hash text;
begin
 a:=private.resale_lock_listing_refresh(p_action_id);
 select * into t from public.resale_action_attempts where action_id=a.id and attempt=a.attempts;
 receipt_hash:=encode(extensions.digest(convert_to(p_facts::text,'UTF8'),'sha256'),'hex');
 if a.state='succeeded' then
 if t.evidence->>'receipt_sha256' is distinct from receipt_hash or t.evidence->>'lease_sha256' is distinct from encode(extensions.digest(convert_to(p_lease_token::text,'UTF8'),'sha256'),'hex') then raise exception 'Refresh retry changed' using errcode='40001'; end if;
 return a.verification_id; end if;
 if a.state<>'running' or p_lease_token is null or a.lease_token is distinct from p_lease_token or a.lease_expires_at<=clock_timestamp() or t.id is null then raise exception 'Current refresh lease required' using errcode='55000'; end if;
 if jsonb_typeof(p_facts) is distinct from 'object' or octet_length(p_facts::text)>65536
 or p_facts->>'v' is distinct from '1' or p_facts->>'external_listing_id' is distinct from a.target_external_listing_id
 or p_facts->>'external_account_id' is distinct from a.target_identity->>'external_account_id' or p_facts->>'account_handle' is distinct from a.target_identity->>'account_handle'
 or p_facts->>'editor_url' is distinct from a.deep_link or p_facts->'owner_controls_verified' is distinct from 'true'::jsonb
 or jsonb_typeof(p_facts->'listing_fields') is distinct from 'object' then raise exception 'Exact owner editor evidence required' using errcode='22023'; end if;
 if exists(select 1 from jsonb_object_keys(p_facts) x where x not in ('v','observed_at','external_listing_id','external_account_id','account_handle','editor_url','owner_controls_verified','raw_availability','activity','listing_fields','pricing')) then raise exception 'Unexpected refresh fields' using errcode='22023'; end if;
 at_time:=(p_facts->>'observed_at')::timestamptz;
 if at_time is null or at_time<t.started_at or at_time<clock_timestamp()-interval '2 minutes' or at_time>clock_timestamp()+interval '30 seconds' then raise exception 'Fresh in-attempt evidence required' using errcode='22023'; end if;
 foreach k in array array['raw_availability','activity'] loop
 if not(p_facts ? k) or jsonb_typeof(p_facts->k) not in ('string','null') or length(p_facts->>k)>200 then raise exception 'Explicit availability/activity value or unknown required' using errcode='22023'; end if; end loop;
 if exists(select 1 from jsonb_object_keys(p_facts->'listing_fields') x where x not in ('title','description','photos','category','brand','size','condition','quantity_control','colors','measurements')) then raise exception 'Unexpected business fields; no private notes or buyer data' using errcode='22023'; end if;
 foreach k in array array['title','description','category','brand','size','condition','quantity_control'] loop
 if not(p_facts->'listing_fields' ? k) or jsonb_typeof(p_facts->'listing_fields'->k) not in ('string','null') then raise exception 'Explicit listing field or unknown required: %',k using errcode='22023'; end if; end loop;
 foreach k in array array['photos','colors','measurements'] loop
 if jsonb_typeof(p_facts->'listing_fields'->k) is distinct from 'array' or jsonb_array_length(p_facts->'listing_fields'->k)>16 or exists(select 1 from jsonb_array_elements(p_facts->'listing_fields'->k) x where jsonb_typeof(x)<>'string') then raise exception 'Ordered bounded source fields required: %',k using errcode='22023'; end if; end loop;
 pricing:=p_facts->'pricing';
 if jsonb_typeof(pricing) is distinct from 'object' or (select count(*) from jsonb_object_keys(pricing))<>5 then raise exception 'Complete pricing value/unknown coverage required' using errcode='22023'; end if;
 foreach k in array array['asking_minor','minimum_minor'] loop
 if not(pricing ? k) or (pricing->k<>'null'::jsonb and (coalesce(pricing->>k,'') !~ '^[0-9]{1,10}$' or (pricing->>k)::numeric>1000000000)) then raise exception 'Invalid minor-unit pricing field' using errcode='22023'; end if; end loop;
 if not(pricing ? 'currency') or (pricing->'currency'<>'null'::jsonb and pricing->>'currency' is distinct from 'USD')
 or not(pricing ? 'enabled') or jsonb_typeof(pricing->'enabled') not in ('boolean','null')
 or pricing->>'mechanism' is null or pricing->>'mechanism' not in ('unknown','poshmark_smart_sell','mercari_smart_pricing')
 or (pricing->>'mechanism'='poshmark_smart_sell' and a.target_identity->>'marketplace'<>'poshmark')
 or (pricing->>'mechanism'='mercari_smart_pricing' and a.target_identity->>'marketplace'<>'mercari') then raise exception 'Pricing mechanism/account mismatch' using errcode='22023'; end if;
 if a.target_identity->>'marketplace'='poshmark' then status_value:=case p_facts->>'raw_availability' when 'For Sale' then 'active' when 'Not For Sale' then 'ended' else 'unknown' end;
 elsif p_facts->>'raw_availability'='Deactivate control visible' then status_value:='active'; end if;
 insert into public.resale_snapshots(id,account_id,source,source_ref,observed_at,scope,coverage,record_count)
 values(snapshot_id,a.target_account_id,'browser',a.deep_link,at_time,'One authenticated exact seller editor. Inspected fields only; no account completeness, order, sale or physical-stock coverage.','partial',1);
 insert into public.resale_source_records(id,snapshot_id,account_id,record_key,source_kind,source_row_sha256,raw_business,normalized,external_identifiers,event_precision,source_observed_at,captured_at,record_status)
 values(source_id,snapshot_id,a.target_account_id,t.id::text,'browser',receipt_hash,p_facts,jsonb_build_object('kind','exact_listing_refresh','action_id',a.id,'attempt_id',t.id,'status',status_value,'pricing',pricing,'physical_quantity_confirmed',false),jsonb_build_object('listing_id',a.target_external_listing_id,'account_id',a.target_identity->>'external_account_id'),'unknown',at_time,clock_timestamp(),'accepted');
 insert into public.resale_observations(id,snapshot_id,account_id,listing_id,observed_at,status,raw_status,availability,external_listing_id,external_identifiers,evidence)
 values(observation_id,snapshot_id,a.target_account_id,a.listing_id,at_time,status_value,p_facts->>'raw_availability',p_facts->>'raw_availability',a.target_external_listing_id,jsonb_build_object('listing_id',a.target_external_listing_id,'account_id',a.target_identity->>'external_account_id'),jsonb_build_object('source_record_id',source_id,'action_id',a.id,'activity',p_facts->'activity','physical_quantity_confirmed',false));
 select actor_id into actor from private.resale_operation_requests where operation_id=a.id;
 insert into public.resale_pricing_observations(id,recorded_by,listing_id,account_id,source_record_id,external_account_id,external_listing_id,inventory_id,observed_at,currency,asking_minor,mechanism,enabled,minimum_minor)
 values(pricing_id,actor,a.listing_id,a.target_account_id,source_id,a.target_identity->>'external_account_id',a.target_external_listing_id,a.target_inventory_id,at_time,pricing->>'currency',(pricing->>'asking_minor')::bigint,pricing->>'mechanism',(pricing->>'enabled')::boolean,(pricing->>'minimum_minor')::bigint);
 insert into public.resale_operation_verifications(id,operation_id,attempt_id,account_id,method,source_record_ids,snapshot_ids,decision,note)
 values(proof_id,a.id,t.id,a.target_account_id,'checked_exact_listing_refresh',array[source_id],array[snapshot_id],'evidence_imported','Exact authenticated seller-editor read. Availability and price observations only; no physical item, order or remote change.');
 update public.resale_action_attempts set finished_at=clock_timestamp(),outcome='verified',evidence=evidence||jsonb_build_object('receipt_sha256',receipt_hash,'lease_sha256',encode(extensions.digest(convert_to(p_lease_token::text,'UTF8'),'sha256'),'hex'),'source_record_id',source_id,'observation_id',observation_id,'pricing_observation_id',pricing_id) where id=t.id;
 update public.resale_actions set state='succeeded',verification_id=proof_id,verification_observation_id=observation_id,lease_token=null,lease_expires_at=null,checkpoint=jsonb_build_object('step_key','listing_refreshed','source_record_ids',jsonb_build_array(source_id),'snapshot_ids',jsonb_build_array(snapshot_id)),next_step='{"key":"listing_refreshed","label":"Listing check saved","explanation":"The exact seller listing was read. Marketplace fields and physical inventory were not changed."}',updated_at=now() where id=a.id;
 return proof_id;
end $$;
revoke all on function public.resale_finish_listing_refresh(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.resale_finish_listing_refresh(uuid,uuid,jsonb) to service_role;

create function public.resale_fail_listing_refresh(p_action_id uuid,p_lease_token uuid,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare a public.resale_actions;
begin
 a:=private.resale_lock_listing_refresh(p_action_id,false);
 if p_reason is null or p_reason not in ('browser_unavailable','account_unverified','listing_unavailable','unsupported_editor','read_failed','target_changed') then raise exception 'Bounded refresh reason required' using errcode='22023'; end if;
 if a.state in ('failed','cancelled') and a.lease_token=p_lease_token and a.last_error=p_reason then return; end if;
 if a.state<>'running' or p_lease_token is null or a.lease_token is distinct from p_lease_token then raise exception 'Exact refresh lease required' using errcode='55000'; end if;
 update public.resale_action_attempts set finished_at=clock_timestamp(),outcome='rejected',evidence=evidence||jsonb_build_object('reason',p_reason) where action_id=a.id and attempt=a.attempts;
 update public.resale_actions set state=case when p_reason='target_changed' then 'cancelled' else 'failed' end,last_error=p_reason,lease_expires_at=null,next_step='{"key":"retry_read","label":"Agent must retry the read","explanation":"Existing evidence is retained. No absence, sale or physical-stock conclusion was made."}',updated_at=now() where id=a.id;
end $$;
revoke all on function public.resale_fail_listing_refresh(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.resale_fail_listing_refresh(uuid,uuid,text) to service_role;

create function private.resale_guard_refresh_scope() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and old.payload->>'scope'='exact_listing_refresh' then
 if new.action is distinct from old.action or new.payload is distinct from old.payload or new.target_identity is distinct from old.target_identity or new.target_account_id is distinct from old.target_account_id or new.target_external_listing_id is distinct from old.target_external_listing_id or new.target_inventory_id is distinct from old.target_inventory_id or new.listing_id is distinct from old.listing_id or new.expected_observation_id is distinct from old.expected_observation_id or new.adapter_key is distinct from old.adapter_key then raise exception 'Read-only refresh scope and target are immutable' using errcode='40001'; end if;
 end if;
 if new.payload->>'scope'='exact_listing_refresh' then
 if new.action<>'import' or new.adapter_key is distinct from 'exact_listing_refresh_v1' then raise exception 'Not an exact read-only refresh' using errcode='22023'; end if;
 if new.state='succeeded' and not exists(select 1 from public.resale_operation_verifications v join public.resale_action_attempts t on t.id=v.attempt_id join public.resale_source_records s on s.id=any(v.source_record_ids) join public.resale_observations o on o.id=new.verification_observation_id
 where v.id=new.verification_id and v.operation_id=new.id and v.account_id=new.target_account_id and v.method='checked_exact_listing_refresh' and t.action_id=new.id and t.attempt=new.attempts and s.normalized->>'action_id'=new.id::text and s.source_row_sha256=t.evidence->>'receipt_sha256' and o.evidence->>'source_record_id'=s.id::text and o.listing_id=new.listing_id and o.external_listing_id=new.target_external_listing_id) then raise exception 'Exact refresh proof required' using errcode='23514'; end if;
 end if;
 return new;
end $$;
revoke all on function private.resale_guard_refresh_scope() from public,anon,authenticated,service_role;
create trigger resale_guard_refresh_scope before insert or update on public.resale_actions for each row execute function private.resale_guard_refresh_scope();

create or replace view public.resale_listing_pricing with (security_invoker=true) as
select l.id as listing_id,l.account_id,l.external_listing_id,l.inventory_id,l.draft_version,
 case when facts.fact_count=1 and facts.bindings_match then facts.observation_id else null end as pricing_observation_id,
 facts.observed_at,
 case when facts.fact_count is null then 'unknown' when not facts.bindings_match then 'target_changed'
 when facts.fact_count>1 then 'conflict' when facts.observed_at<now()-interval '24 hours' then 'stale'
 when facts.currency is null or facts.asking_minor is null or facts.enabled is null or facts.mechanism='unknown' then 'unknown' else 'observed' end as pricing_status,
 case when facts.fact_count=1 then facts.currency end currency,
 case when facts.fact_count=1 then facts.asking_minor end asking_minor,
 case when facts.fact_count=1 then facts.mechanism end mechanism,
 case when facts.fact_count=1 then facts.enabled end enabled,
 case when facts.fact_count=1 then facts.minimum_minor end minimum_minor
from public.resale_listings l join public.resale_accounts a on a.id=l.account_id
left join lateral (
 select count(distinct jsonb_build_array(p.currency,p.asking_minor,p.mechanism,p.enabled,p.minimum_minor)) fact_count,
 coalesce(bool_and(p.external_listing_id=l.external_listing_id and p.external_account_id=a.external_account_id and p.inventory_id is not distinct from l.inventory_id),false) bindings_match,
 min(p.id::text)::uuid observation_id,max(p.observed_at) observed_at,min(p.currency) currency,min(p.asking_minor) asking_minor,
 min(p.mechanism) mechanism,(array_agg(p.enabled))[1] enabled,min(p.minimum_minor) minimum_minor
 from public.resale_pricing_observations p where p.listing_id=l.id and p.observed_at=(select max(q.observed_at) from public.resale_pricing_observations q where q.listing_id=l.id)
 having count(*)>0
) facts on true;
revoke all on public.resale_listing_pricing from public,anon;
grant select on public.resale_listing_pricing to authenticated,service_role;


create or replace function public.resale_record_pricing_observation(p_member_id uuid,p_request_id uuid,p_listing_id uuid,p_source_record_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare l public.resale_listings; a public.resale_accounts; s public.resale_source_records; prior public.resale_pricing_observations; p jsonb; mechanism text;
begin
 perform 1 from private.memberships where user_id=p_member_id and area='resale' for share;
 if not found then raise exception 'Current resale membership required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,31));
 select * into l from public.resale_listings where id=p_listing_id for share;
 if not found or l.external_listing_id is null then raise exception 'Exact existing listing required' using errcode='22023'; end if;
 select * into a from public.resale_accounts where id=l.account_id for share;
 select * into s from public.resale_source_records where id=p_source_record_id;
 if not found or s.account_id<>l.account_id or s.record_status<>'accepted' or s.source_kind not in ('browser','official_api','csv')
 or s.source_observed_at is null or s.source_observed_at>clock_timestamp()+interval '5 minutes'
 or (s.external_identifiers->>'listing_id') is distinct from l.external_listing_id
 or (s.external_identifiers->>'account_id') is distinct from a.external_account_id
 or a.external_account_id is null then raise exception 'Exact accepted source and account binding required' using errcode='22023'; end if;
 p:=s.normalized->'pricing'; mechanism:=p->>'mechanism';
 if p is null or jsonb_typeof(p)<>'object' or not(p ? 'currency') or (p->'currency'<>'null'::jsonb and coalesce(p->>'currency','') !~ '^[A-Z]{3}$')
 or not(p ? 'asking_minor') or (p->'asking_minor'<>'null'::jsonb and coalesce(p->>'asking_minor','') !~ '^[0-9]{1,10}$')
 or jsonb_typeof(p->'enabled') not in ('boolean','null') or not(p ? 'enabled')
 or not(p ? 'minimum_minor') or (p->'minimum_minor'<>'null'::jsonb and coalesce(p->>'minimum_minor','') !~ '^[0-9]{1,10}$')
 or mechanism is null or mechanism not in ('mercari_smart_pricing','poshmark_smart_sell','unknown')
 or (mechanism='mercari_smart_pricing' and a.marketplace<>'mercari')
 or (mechanism='poshmark_smart_sell' and a.marketplace<>'poshmark') then raise exception 'Unsupported pricing facts' using errcode='22023'; end if;
 select * into prior from public.resale_pricing_observations where id=p_request_id;
 if found then
 if prior.recorded_by is distinct from p_member_id or prior.listing_id<>l.id or prior.source_record_id<>s.id
 or prior.inventory_id is distinct from l.inventory_id or prior.external_listing_id<>l.external_listing_id or prior.external_account_id<>a.external_account_id then raise exception 'Pricing retry binding changed' using errcode='40001'; end if;
 return prior.id;
 end if;
 insert into public.resale_pricing_observations(id,recorded_by,listing_id,account_id,source_record_id,external_account_id,external_listing_id,inventory_id,observed_at,currency,asking_minor,mechanism,enabled,minimum_minor)
 values(p_request_id,p_member_id,l.id,l.account_id,s.id,a.external_account_id,l.external_listing_id,l.inventory_id,s.source_observed_at,p->>'currency',(p->>'asking_minor')::bigint,mechanism,(p->>'enabled')::boolean,(p->>'minimum_minor')::bigint);
 return p_request_id;
end $$;
revoke all on function public.resale_record_pricing_observation(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.resale_record_pricing_observation(uuid,uuid,uuid,uuid) to service_role;


commit;
