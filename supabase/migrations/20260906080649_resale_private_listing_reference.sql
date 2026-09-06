begin;
-- One narrow listing-only scope in the existing outbox. No inventory match, price,
-- stock, sale, delist, credential, or general text-write capability is added.
create unique index resale_one_open_listing_reference on public.resale_actions(listing_id) where payload->>'scope'='poshmark_private_listing_reference' and state not in ('succeeded','cancelled');
create table private.resale_listing_reference_checks (
 id uuid primary key default gen_random_uuid(), action_id uuid not null references public.resale_actions(id),
 attempt_id uuid not null references public.resale_action_attempts(id), phase text not null check(phase in ('before','after','not_applied')),
 lease_sha256 text not null, source_record_id uuid not null references public.resale_source_records(id),
 facts jsonb not null, protected_sha256 text not null, expected_note text not null check(length(expected_note)<=500),
 created_at timestamptz not null default now(), unique(attempt_id,phase)
);
alter table private.resale_listing_reference_checks enable row level security;
revoke all on private.resale_listing_reference_checks from public,anon,authenticated,service_role;
create trigger resale_reference_check_immutable before update or delete on private.resale_listing_reference_checks for each row execute function private.resale_source_record_immutable();

create function public.resale_request_listing_reference(p_request_id uuid,p_payload jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); l public.resale_listings; a public.resale_accounts; prior private.resale_operation_requests; op uuid:=gen_random_uuid(); wanted jsonb;
begin
 perform 1 from private.memberships where user_id=actor and area='resale' for share;
 if not found then raise exception 'Current resale membership required' using errcode='42501'; end if;
 if p_request_id is null or jsonb_typeof(p_payload)<>'object' then raise exception 'Exact request required' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,73));
 select * into prior from private.resale_operation_requests where request_id=p_request_id;
 if found then
 if prior.actor_id<>actor or prior.payload is distinct from p_payload then raise exception 'Request retry changed' using errcode='22023'; end if;
 return prior.operation_id; end if;
 select * into l from public.resale_listings where id=(p_payload->>'listing_id')::uuid for share;
 if not found or l.external_listing_id is null then raise exception 'Existing listing required' using errcode='22023'; end if;
 select * into a from public.resale_accounts where id=l.account_id for share;
 if a.marketplace<>'poshmark' or nullif(a.external_account_id,'') is null or nullif(a.username,'') is null then raise exception 'Verified Poshmark account identity required' using errcode='22023'; end if;
 wanted:=jsonb_build_object('account_id',a.id,'action','update','listing_id',l.id,'inventory_id',l.inventory_id,'expected_observation_id',l.observation_id,'expected_item_version',null,
 'trigger',jsonb_build_object('kind','member_request','id',p_request_id),'requested',jsonb_build_object('scope','poshmark_private_listing_reference','external_listing_id',l.external_listing_id));
 if p_payload is distinct from wanted then raise exception 'Exact listing reference request required; reload the listing' using errcode='40001'; end if;
 insert into public.resale_actions(id,listing_id,action,state,idempotency_key,reason,payload,operation_protocol,execution_mode,adapter_key,adapter_version,trigger_ref,target_account_id,target_external_listing_id,target_inventory_id,expected_observation_id,desired_sha256,target_identity,blockers,deep_link,next_step)
 values(op,l.id,'update','blocked','listing-reference:'||p_request_id,'Add a tracker reference to the seller-private Other Info field',p_payload->'requested',1,'supervised_agent_browser','poshmark_private_reference_v1','1',p_payload->'trigger',a.id,l.external_listing_id,l.inventory_id,l.observation_id,
 encode(extensions.digest(convert_to((p_payload->'requested')::text,'UTF8'),'sha256'),'hex'),
 jsonb_build_object('account_id',a.id,'external_account_id',a.external_account_id,'account_handle',a.username,'listing_id',l.id,'external_listing_id',l.external_listing_id,'inventory_id',l.inventory_id,'match_status',l.match_status),
 '[{"code":"awaiting_agent","message":"A supervised agent must inspect the exact listing, preserve all other fields, and verify the saved private note."}]',
 'https://poshmark.com/edit-listing/'||l.external_listing_id,
 '{"key":"awaiting_agent","label":"Awaiting an agent","explanation":"This is a saved request for supervised browser work. No background marketplace consumer is installed."}');
 insert into private.resale_operation_requests(request_id,actor_id,operation_id,payload) values(p_request_id,actor,op,p_payload);
 return op;
end $$;
revoke all on function public.resale_request_listing_reference(uuid,jsonb) from public,anon,service_role;
grant execute on function public.resale_request_listing_reference(uuid,jsonb) to authenticated;

create function private.resale_lock_listing_reference(p_action_id uuid,p_require_target boolean default true) returns public.resale_actions
language plpgsql security definer set search_path='' as $$
declare a public.resale_actions; l public.resale_listings; c public.resale_accounts; actor uuid;
begin
 select q.actor_id into actor from private.resale_operation_requests q where q.operation_id=p_action_id;
 perform 1 from private.memberships where user_id=actor and area='resale' for share;
 if not found then raise exception 'Requesting member no longer has access' using errcode='42501'; end if;
 select * into a from public.resale_actions where id=p_action_id;
 if not found or a.action<>'update' or a.payload->>'scope' is distinct from 'poshmark_private_listing_reference' or a.adapter_key is distinct from 'poshmark_private_reference_v1' then raise exception 'Not a private listing reference request' using errcode='22023'; end if;
 select * into l from public.resale_listings where id=a.listing_id for share;
 select * into c from public.resale_accounts where id=l.account_id for share;
 select * into a from public.resale_actions where id=p_action_id for update;
 if p_require_target and (l.account_id is distinct from a.target_account_id or l.external_listing_id is distinct from a.target_external_listing_id or l.inventory_id is distinct from a.target_inventory_id
 or l.observation_id is distinct from a.expected_observation_id or l.match_status is distinct from a.target_identity->>'match_status'
 or c.marketplace is distinct from 'poshmark' or c.external_account_id is distinct from a.target_identity->>'external_account_id' or c.username is distinct from a.target_identity->>'account_handle'
 or a.desired_sha256 is distinct from encode(extensions.digest(convert_to(a.payload::text,'UTF8'),'sha256'),'hex') ) then raise exception 'Listing reference target changed; fresh review required' using errcode='40001'; end if;
 return a;
end $$;
revoke all on function private.resale_lock_listing_reference(uuid,boolean) from public,anon,authenticated,service_role;

create function public.resale_claim_listing_reference(p_action_id uuid,p_verify_only boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.resale_actions; before_check private.resale_listing_reference_checks; attempt_id uuid;
begin
 if p_verify_only is null then raise exception 'Explicit readback mode required' using errcode='22023'; end if;
 a:=private.resale_lock_listing_reference(p_action_id);
 if a.state='succeeded' then return jsonb_build_object('state',a.state,'action_id',a.id,'verification_id',a.verification_id); end if;
 if a.state='running' and a.lease_expires_at>clock_timestamp() then raise exception 'A supervised attempt is already running' using errcode='55000'; end if;
 if a.state in ('running','uncertain') and not p_verify_only then raise exception 'Uncertain outcome requires readback only' using errcode='55000'; end if;
 if a.state not in ('blocked','queued','failed','running','uncertain') then raise exception 'Request cannot be claimed' using errcode='55000'; end if;
 if a.attempts>0 then
 select r.* into before_check from private.resale_listing_reference_checks r join public.resale_action_attempts t on t.id=r.attempt_id where r.action_id=a.id and r.phase='before' order by t.attempt limit 1;
 if not p_verify_only then raise exception 'Previous attempt requires readback only' using errcode='55000'; end if;
 end if;
 update public.resale_action_attempts set finished_at=clock_timestamp(),outcome='uncertain',evidence=evidence||'{"recovery_reason":"lease_expired"}'::jsonb where action_id=a.id and finished_at is null;
 update public.resale_actions set state='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '10 minutes',blockers='[]',last_error=null,
 next_step='{"key":"supervised_read","label":"Agent checking the listing","explanation":"The agent must verify the exact private note and preserve all other fields."}',updated_at=now()
 where id=a.id returning * into a;
 insert into public.resale_action_attempts(action_id,attempt,started_at,evidence) values(a.id,a.attempts,clock_timestamp(),jsonb_build_object('adapter_key',a.adapter_key,'verify_only',p_verify_only,'lease_expires_at',a.lease_expires_at)) returning id into attempt_id;
 return jsonb_build_object('action_id',a.id,'attempt_id',attempt_id,'state',a.state,'lease_token',a.lease_token,'lease_expires_at',a.lease_expires_at,'target',a.target_identity,'editor_url',a.deep_link,
 'marker','Resale tracker listing: '||a.listing_id,'verify_only',p_verify_only,'prior_expected_note',before_check.expected_note,'prior_protected_sha256',before_check.protected_sha256);
end $$;
revoke all on function public.resale_claim_listing_reference(uuid,boolean) from public,anon,authenticated;
grant execute on function public.resale_claim_listing_reference(uuid,boolean) to service_role;

create function private.resale_validate_reference_facts(a public.resale_actions,p_facts jsonb,p_started_at timestamptz) returns text
language plpgsql security definer set search_path='' as $$
declare k text; fields jsonb:=p_facts->'protected_fields'; t timestamptz;
begin
 if jsonb_typeof(p_facts)<>'object' or octet_length(p_facts::text)>32768
 or p_facts->>'v' is distinct from '1' or p_facts->>'external_listing_id' is distinct from a.target_external_listing_id
 or p_facts->>'account_handle' is distinct from a.target_identity->>'account_handle' or p_facts->>'external_account_id' is distinct from a.target_identity->>'external_account_id'
 or p_facts->>'editor_url' is distinct from a.deep_link or p_facts->'owner_controls_verified' is distinct from 'true'::jsonb
 or jsonb_typeof(p_facts->'other_info') is distinct from 'string' or length(p_facts->>'other_info')>500 or jsonb_typeof(fields) is distinct from 'object' then raise exception 'Exact authenticated editor evidence required' using errcode='22023'; end if;
 if exists(select 1 from jsonb_object_keys(p_facts) x where x not in ('v','observed_at','external_listing_id','account_handle','external_account_id','editor_url','owner_controls_verified','other_info','protected_fields')) then raise exception 'Unexpected reference evidence fields' using errcode='22023'; end if;
 t:=(p_facts->>'observed_at')::timestamptz;
 if t is null or t<p_started_at or t<clock_timestamp()-interval '2 minutes' or t>clock_timestamp()+interval '30 seconds' then raise exception 'Fresh in-attempt editor evidence required' using errcode='22023'; end if;
 if (select count(*) from jsonb_object_keys(fields))<>20 then raise exception 'Complete non-note editor coverage required' using errcode='22023'; end if;
 foreach k in array array['title','description','category','quantity_mode','size','condition','brand','price','smart_sell','discounted_shipping','availability','sku','cost_price','currency'] loop
 if jsonb_typeof(fields->k) is distinct from 'string' then raise exception 'Non-note editor field missing: %',k using errcode='22023'; end if; end loop;
 foreach k in array array['photos','colors','style_tags'] loop
 if jsonb_typeof(fields->k) is distinct from 'array' or jsonb_array_length(fields->k)>16 or exists(select 1 from jsonb_array_elements(fields->k) x where jsonb_typeof(x)<>'string') then raise exception 'Ordered editor evidence missing: %',k using errcode='22023'; end if; end loop;
 foreach k in array array['original_price','quantity_value'] loop
 if jsonb_typeof(fields->k) is distinct from 'object' or jsonb_typeof(fields->k->'present') is distinct from 'boolean'
 or (fields->k->'present'='true'::jsonb and jsonb_typeof(fields->k->'value') is distinct from 'string')
 or (fields->k->'present'='false'::jsonb and fields->k->'value' is distinct from 'null'::jsonb) then raise exception 'Explicit control presence required: %',k using errcode='22023'; end if; end loop;
 if jsonb_typeof(fields->'variant_controls') is distinct from 'array' or jsonb_array_length(fields->'variant_controls')>100 then raise exception 'Variant controls must be captured explicitly' using errcode='22023'; end if;
 if nullif(fields->>'title','') is null or nullif(fields->>'price','') is null or nullif(fields->>'smart_sell','') is null or nullif(fields->>'availability','') is null or jsonb_array_length(fields->'photos')<1 then raise exception 'Price, automation, availability and photo evidence required' using errcode='22023'; end if;
 return encode(extensions.digest(convert_to(fields::text,'UTF8'),'sha256'),'hex');
end $$;
revoke all on function private.resale_validate_reference_facts(public.resale_actions,jsonb,timestamptz) from public,anon,authenticated,service_role;

create function private.resale_save_reference_source(a public.resale_actions,p_facts jsonb,p_phase text,p_attempt_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare snapshot_id uuid:=gen_random_uuid(); source_id uuid:=gen_random_uuid();
begin
 insert into public.resale_snapshots(id,account_id,source,source_ref,observed_at,scope,coverage,record_count)
 values(snapshot_id,a.target_account_id,'browser',a.deep_link,(p_facts->>'observed_at')::timestamptz,'One authenticated seller editor; private reference '||p_phase||' check. Covers inspected controls only; no account, order, or physical-stock coverage.','partial',1);
 insert into public.resale_source_records(id,snapshot_id,account_id,record_key,source_kind,source_row_sha256,raw_business,normalized,external_identifiers,event_precision,source_observed_at,captured_at,record_status)
 values(source_id,snapshot_id,a.target_account_id,p_attempt_id||':'||p_phase,'browser',encode(extensions.digest(convert_to(p_facts::text,'UTF8'),'sha256'),'hex'),p_facts,
 jsonb_build_object('kind','seller_private_listing_reference','phase',p_phase,'action_id',a.id,'attempt_id',p_attempt_id,'physical_quantity_confirmed',false),
 jsonb_build_object('listing_id',a.target_external_listing_id,'account_id',a.target_identity->>'external_account_id'),'unknown',(p_facts->>'observed_at')::timestamptz,clock_timestamp(),'accepted');
 return source_id;
end $$;
revoke all on function private.resale_save_reference_source(public.resale_actions,jsonb,text,uuid) from public,anon,authenticated,service_role;

create function public.resale_preflight_listing_reference(p_action_id uuid,p_lease_token uuid,p_facts jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.resale_actions; t public.resale_action_attempts; prior private.resale_listing_reference_checks; first_check private.resale_listing_reference_checks; h text; marker text; expected text; source_id uuid; verify_only boolean;
begin
 a:=private.resale_lock_listing_reference(p_action_id);
 if a.state<>'running' or p_lease_token is null or a.lease_token is distinct from p_lease_token or a.lease_expires_at<=clock_timestamp() then raise exception 'Current supervised lease required' using errcode='55000'; end if;
 select * into t from public.resale_action_attempts where action_id=a.id and attempt=a.attempts;
 h:=private.resale_validate_reference_facts(a,p_facts,t.started_at);marker:='Resale tracker listing: '||a.listing_id;verify_only:=coalesce((t.evidence->>'verify_only')::boolean,false);
 select * into prior from private.resale_listing_reference_checks where attempt_id=t.id and phase='before';
 if found then
 if prior.facts is distinct from p_facts then raise exception 'Preflight retry changed' using errcode='40001'; end if;
 return jsonb_build_object('expected_note',prior.expected_note,'write_allowed',not verify_only and prior.facts->>'other_info'<>prior.expected_note,'source_record_id',prior.source_record_id,'lease_expires_at',a.lease_expires_at); end if;
 select * into first_check from private.resale_listing_reference_checks where action_id=a.id and phase='before' order by created_at limit 1;
 if first_check.id is not null then
 if h<>first_check.protected_sha256 then raise exception 'Other editor controls changed; keep outcome unresolved' using errcode='40001'; end if;
 expected:=first_check.expected_note;
 if p_facts->>'other_info'<>expected then raise exception 'Expected marker not verified; keep outcome unresolved' using errcode='40001'; end if;
 else
 expected:=p_facts->>'other_info';
 if not(marker=any(string_to_array(expected,E'\n'))) then expected:=expected||case when expected='' then '' else E'\n' end||marker; end if;
 if length(expected)>500 then raise exception 'Existing note has no room for the exact reference; nothing will be replaced' using errcode='22023'; end if;
 if verify_only and expected<>p_facts->>'other_info' then raise exception 'Readback-only attempt cannot modify the note' using errcode='55000'; end if;
 end if;
 source_id:=private.resale_save_reference_source(a,p_facts,'before',t.id);
 insert into private.resale_listing_reference_checks(action_id,attempt_id,phase,lease_sha256,source_record_id,facts,protected_sha256,expected_note)
 values(a.id,t.id,'before',encode(extensions.digest(convert_to(p_lease_token::text,'UTF8'),'sha256'),'hex'),source_id,p_facts,h,expected);
 update public.resale_actions set checkpoint=jsonb_build_object('step_key','private_note_preflight','source_record_ids',jsonb_build_array(source_id)),updated_at=now() where id=a.id;
 return jsonb_build_object('expected_note',expected,'write_allowed',not verify_only and expected<>p_facts->>'other_info','source_record_id',source_id,'lease_expires_at',a.lease_expires_at);
end $$;
revoke all on function public.resale_preflight_listing_reference(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.resale_preflight_listing_reference(uuid,uuid,jsonb) to service_role;

alter table public.resale_operation_verifications drop constraint resale_operation_verifications_method_check;
alter table public.resale_operation_verifications add constraint resale_operation_verifications_method_check check(method in ('checked_import','checked_sale_evidence','checked_cancellation_evidence','checked_shipping_evidence','checked_private_listing_reference'));
alter table public.resale_operation_verifications drop constraint resale_operation_verifications_decision_check;
alter table public.resale_operation_verifications add constraint resale_operation_verifications_decision_check check(decision in ('evidence_imported','verified_source_event','needs_review','verified_listing_reference'));

alter table public.resale_actions drop constraint resale_action_verified_success;
alter table public.resale_actions add constraint resale_action_verified_success check(state<>'succeeded' or
 (action in ('publish','update','delist') and verification_observation_id is not null)
 or (action in ('import','reconcile_sale','reconcile_cancellation','reconcile_shipping') and verification_id is not null)
 or (action='update' and (payload->>'scope') is not distinct from 'poshmark_private_listing_reference' and verification_id is not null));

create function public.resale_finish_listing_reference(p_action_id uuid,p_lease_token uuid,p_facts jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare a public.resale_actions; t public.resale_action_attempts; b private.resale_listing_reference_checks; prior private.resale_listing_reference_checks; h text; source_id uuid; v_verification_id uuid:=gen_random_uuid(); snapshot_ids uuid[];
begin
 a:=private.resale_lock_listing_reference(p_action_id);
 select * into t from public.resale_action_attempts where action_id=a.id and attempt=a.attempts;
 select * into b from private.resale_listing_reference_checks where attempt_id=t.id and phase='before';
 if b.id is null or p_lease_token is null or b.lease_sha256<>encode(extensions.digest(convert_to(p_lease_token::text,'UTF8'),'sha256'),'hex') then raise exception 'Exact prior leased preflight required' using errcode='55000'; end if;
 select * into prior from private.resale_listing_reference_checks where attempt_id=t.id and phase='after';
 if a.state='succeeded' and prior.facts=p_facts then return a.verification_id; end if;
 if a.state<>'running' or a.lease_token is distinct from p_lease_token or a.lease_expires_at<=clock_timestamp() then raise exception 'Current supervised lease required' using errcode='55000'; end if;
 h:=private.resale_validate_reference_facts(a,p_facts,t.started_at);
 if h<>b.protected_sha256 or p_facts->>'other_info'<>b.expected_note or (p_facts->>'observed_at')::timestamptz<(b.facts->>'observed_at')::timestamptz then raise exception 'Exact note and unchanged non-note readback required' using errcode='40001'; end if;
 source_id:=private.resale_save_reference_source(a,p_facts,'after',t.id);
 insert into private.resale_listing_reference_checks(action_id,attempt_id,phase,lease_sha256,source_record_id,facts,protected_sha256,expected_note) values(a.id,t.id,'after',b.lease_sha256,source_id,p_facts,h,b.expected_note);
 select array_agg(s.snapshot_id order by s.id) into snapshot_ids from public.resale_source_records s where s.id in (source_id,b.source_record_id);
 insert into public.resale_operation_verifications(id,operation_id,attempt_id,account_id,method,source_record_ids,snapshot_ids,decision,note)
 values(v_verification_id,a.id,t.id,a.target_account_id,'checked_private_listing_reference',array[b.source_record_id,source_id],snapshot_ids,'verified_listing_reference','Exact private tracker reference read back in the same seller listing; inspected non-note controls unchanged. No physical match, sale, or stock change.');
 update public.resale_action_attempts set finished_at=clock_timestamp(),outcome='verified',evidence=evidence||jsonb_build_object('verification_id',v_verification_id,'source_record_ids',jsonb_build_array(b.source_record_id,source_id)) where id=t.id;
 update public.resale_actions set state='succeeded',verification_id=v_verification_id,lease_token=null,lease_expires_at=null,last_error=null,next_step=null,checkpoint=jsonb_build_object('step_key','private_note_verified','source_record_ids',jsonb_build_array(b.source_record_id,source_id)),updated_at=now() where id=a.id;
 return v_verification_id;
end $$;
revoke all on function public.resale_finish_listing_reference(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.resale_finish_listing_reference(uuid,uuid,jsonb) to service_role;

create function public.resale_pause_listing_reference(p_action_id uuid,p_lease_token uuid,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare a public.resale_actions;
begin
 a:=private.resale_lock_listing_reference(p_action_id,false);
 if a.state='uncertain' and a.lease_token=p_lease_token then return; end if;
 if a.state<>'running' or a.lease_token is distinct from p_lease_token or p_lease_token is null or p_reason is null or p_reason not in ('browser_unavailable','save_outcome_unknown','readback_mismatch','lease_expired') then raise exception 'Exact leased recovery reason required' using errcode='22023'; end if;
 update public.resale_action_attempts set finished_at=clock_timestamp(),outcome='uncertain',evidence=evidence||jsonb_build_object('recovery_reason',p_reason) where action_id=a.id and attempt=a.attempts;
 update public.resale_actions set state='uncertain',last_error=p_reason,next_step='{"key":"private_note_readback","label":"Agent must check the saved note","explanation":"The result is unresolved. Reopen the exact listing and inspect the marker before attempting another write."}',updated_at=now() where id=a.id;
end $$;
revoke all on function public.resale_pause_listing_reference(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.resale_pause_listing_reference(uuid,uuid,text) to service_role;

-- Retire a proved-not-applied request; a new exact request can then be made.
-- This never retries a remote write. Only a stopped prior consumer plus fresh
-- unchanged readback can release the single-open-request constraint.
create function public.resale_retire_unapplied_listing_reference(p_action_id uuid,p_lease_token uuid,p_stopped_attempt_id uuid,p_consumer_stopped boolean,p_facts jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare a public.resale_actions; t public.resale_action_attempts; old_t public.resale_action_attempts; b private.resale_listing_reference_checks; prior private.resale_listing_reference_checks; h text; source_id uuid; marker text;
begin
 if p_consumer_stopped is distinct from true then raise exception 'The previous consumer must be confirmed stopped' using errcode='22023'; end if;
 a:=private.resale_lock_listing_reference(p_action_id);
 if a.state='cancelled' then
 select * into prior from private.resale_listing_reference_checks where action_id=a.id and phase='not_applied';
 select * into t from public.resale_action_attempts where id=prior.attempt_id;
 if prior.id is not null and p_facts=prior.facts and prior.lease_sha256=encode(extensions.digest(convert_to(p_lease_token::text,'UTF8'),'sha256'),'hex') and t.evidence->>'stopped_attempt_id'=p_stopped_attempt_id::text then return prior.source_record_id; end if;
 raise exception 'Retired request retry differs' using errcode='40001';
 end if;
 if a.state<>'running' or p_lease_token is null or a.lease_token is distinct from p_lease_token or a.lease_expires_at<=clock_timestamp() then raise exception 'Current readback lease required' using errcode='55000'; end if;
 select * into t from public.resale_action_attempts where action_id=a.id and attempt=a.attempts;
 select * into b from private.resale_listing_reference_checks where action_id=a.id and phase='before' order by created_at limit 1;
 if b.id is not null then select * into old_t from public.resale_action_attempts where id=b.attempt_id;
 else select * into old_t from public.resale_action_attempts where action_id=a.id and attempt=a.attempts-1; end if;
 if t.evidence->'verify_only' is distinct from 'true'::jsonb or old_t.id is null or old_t.id is distinct from p_stopped_attempt_id then raise exception 'Exact stopped previous attempt required' using errcode='22023'; end if;
 h:=private.resale_validate_reference_facts(a,p_facts,t.started_at);marker:='Resale tracker listing: '||a.listing_id;
 if marker=any(string_to_array(p_facts->>'other_info',E'\n')) then raise exception 'Marker exists; verify completion instead of replacing the request' using errcode='22023'; end if;
 select * into b from private.resale_listing_reference_checks where action_id=a.id and phase='before' order by created_at limit 1;
 if b.id is not null then
 if p_facts->>'other_info' is distinct from b.facts->>'other_info' or h<>b.protected_sha256 then raise exception 'Original note or controls changed; keep unresolved' using errcode='40001'; end if;
 if (old_t.evidence->>'lease_expires_at')::timestamptz is null or (old_t.evidence->>'lease_expires_at')::timestamptz+interval '30 seconds'>clock_timestamp() then raise exception 'Wait for the previous write lease to expire before retiring it' using errcode='55000'; end if;
 end if;
 source_id:=private.resale_save_reference_source(a,p_facts,'not_applied',t.id);
 insert into private.resale_listing_reference_checks(action_id,attempt_id,phase,lease_sha256,source_record_id,facts,protected_sha256,expected_note)
 values(a.id,t.id,'not_applied',encode(extensions.digest(convert_to(p_lease_token::text,'UTF8'),'sha256'),'hex'),source_id,p_facts,h,p_facts->>'other_info');
 update public.resale_action_attempts set finished_at=clock_timestamp(),outcome='rejected',evidence=evidence||jsonb_build_object('result','verified_not_applied','stopped_attempt_id',old_t.id,'source_record_id',source_id) where id=t.id;
 update public.resale_actions set state='cancelled',lease_token=null,lease_expires_at=null,last_error=null,checkpoint=jsonb_build_object('step_key','verified_not_applied','source_record_ids',jsonb_build_array(source_id)),
 next_step='{"key":"new_reference_request","label":"Ready for a new supervised request","explanation":"Fresh readback confirmed the note was not changed. The previous consumer was stopped; this request is retired and preserved."}',updated_at=now() where id=a.id;
 return source_id;
end $$;
revoke all on function public.resale_retire_unapplied_listing_reference(uuid,uuid,uuid,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.resale_retire_unapplied_listing_reference(uuid,uuid,uuid,boolean,jsonb) to service_role;

create function private.resale_guard_reference_scope() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and old.payload->>'scope'='poshmark_private_listing_reference' then
 if new.action is distinct from old.action or new.payload is distinct from old.payload or new.target_identity is distinct from old.target_identity or new.target_account_id is distinct from old.target_account_id or new.target_external_listing_id is distinct from old.target_external_listing_id or new.target_inventory_id is distinct from old.target_inventory_id or new.listing_id is distinct from old.listing_id or new.expected_observation_id is distinct from old.expected_observation_id or new.adapter_key is distinct from old.adapter_key then raise exception 'Private reference scope and target are immutable' using errcode='40001'; end if;
 end if;
 if new.payload->>'scope'='poshmark_private_listing_reference' and new.state='succeeded' and not exists(
 select 1 from public.resale_operation_verifications v join public.resale_action_attempts t on t.id=v.attempt_id
 join private.resale_listing_reference_checks c on c.attempt_id=t.id and c.phase='after'
 where v.id=new.verification_id and v.operation_id=new.id and v.account_id=new.target_account_id and v.method='checked_private_listing_reference' and v.decision='verified_listing_reference'
 and t.action_id=new.id and t.attempt=new.attempts and c.action_id=new.id and c.source_record_id=any(v.source_record_ids)) then raise exception 'Exact private reference proof required' using errcode='55000'; end if;
 if new.payload->>'scope'='poshmark_private_listing_reference' and (new.action<>'update' or new.adapter_key is distinct from 'poshmark_private_reference_v1') then raise exception 'Isolated private reference scope required' using errcode='22023'; end if;
 return new;
end $$;
revoke all on function private.resale_guard_reference_scope() from public,anon,authenticated,service_role;
create trigger resale_guard_reference_scope before insert or update on public.resale_actions for each row execute function private.resale_guard_reference_scope();
commit;
