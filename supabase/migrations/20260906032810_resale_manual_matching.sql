-- Explicit operator decisions only. No stock, sale, source or remote-action changes.
begin;
create table public.resale_listing_match_history (
 id uuid primary key, listing_id uuid not null references public.resale_listings(id),
 account_id uuid not null references public.resale_accounts(id),
 inventory_id uuid not null references public.inventory(id), actor_id uuid not null references auth.users(id),
 reason text not null check(length(btrim(reason)) between 1 and 2000),
 prior_match jsonb not null, confirmation jsonb not null,
 created_at timestamptz not null default now()
);
create index resale_listing_match_history_listing on public.resale_listing_match_history(listing_id,created_at,id);
alter table public.resale_listing_match_history enable row level security;
revoke all on public.resale_listing_match_history from public,anon,authenticated,service_role;
grant select on public.resale_listing_match_history to authenticated,service_role;
create policy resale_members_read on public.resale_listing_match_history for select to authenticated
using((select private.has_access('resale')));
create function private.resale_match_history_immutable() returns trigger
language plpgsql security invoker set search_path='' as $$
begin raise exception 'Match history is immutable; record a new decision' using errcode='55000'; end $$;
revoke all on function private.resale_match_history_immutable() from public,anon,authenticated,service_role;
create trigger resale_match_history_immutable before update or delete on public.resale_listing_match_history
for each row execute function private.resale_match_history_immutable();
create table private.resale_match_requests (
 request_id uuid primary key, actor_id uuid not null, payload jsonb not null,
 result jsonb not null, created_at timestamptz not null default now()
);
alter table private.resale_match_requests enable row level security;
revoke all on private.resale_match_requests from public,anon,authenticated,service_role;

create function private.resale_confirm_listing_match(p_request_id uuid,p_payload jsonb)
returns public.resale_listings language plpgsql security definer set search_path='' as $$
declare
 v_actor uuid:=auth.uid(); v_req private.resale_match_requests; v_listing public.resale_listings;
 v_item public.inventory; v_observation public.resale_observations;
 v_listing_id uuid; v_inventory_id uuid; v_expected_observation uuid; v_expected_inventory uuid;
 v_reason text; v_confirmation jsonb; v_prior jsonb;
begin
 -- Lock the live membership until commit, including retries. A completed revocation denies access.
 perform 1 from private.memberships where user_id=v_actor and area='resale' for share;
 if v_actor is null or not found then raise exception 'Resale access required' using errcode='42501'; end if;
 if p_request_id is null or p_payload is null or jsonb_typeof(p_payload)<>'object'
 or octet_length(p_payload::text)>8192 then raise exception 'Bounded match request required' using errcode='22023'; end if;
 if not (p_payload ?& array['listingId','inventoryId','expectedObservationId','expectedInventoryId','expectedMatchStatus','reason'])
 or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('listingId','inventoryId','expectedObservationId','expectedInventoryId','expectedMatchStatus','reason'))
 or jsonb_typeof(p_payload->'listingId')<>'string' or jsonb_typeof(p_payload->'inventoryId')<>'string'
 or jsonb_typeof(p_payload->'expectedObservationId') not in ('string','null')
 or jsonb_typeof(p_payload->'expectedInventoryId') not in ('string','null')
 or jsonb_typeof(p_payload->'expectedMatchStatus')<>'string'
 or p_payload->>'expectedMatchStatus' not in ('unmatched','proposed','confirmed','rejected')
 or jsonb_typeof(p_payload->'reason')<>'string'
 then raise exception 'Exact match fields required; refresh the listing' using errcode='22023'; end if;
 v_reason:=btrim(p_payload->>'reason');
 if length(v_reason) not between 1 and 2000 then raise exception 'Explain the physical item match in 1–2000 characters' using errcode='22023'; end if;
 v_listing_id:=(p_payload->>'listingId')::uuid; v_inventory_id:=(p_payload->>'inventoryId')::uuid;
 v_expected_observation:=(p_payload->>'expectedObservationId')::uuid;
 v_expected_inventory:=(p_payload->>'expectedInventoryId')::uuid;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,4));
 select * into v_req from private.resale_match_requests where request_id=p_request_id;
 if found then
 if v_req.actor_id<>v_actor or v_req.payload<>p_payload then raise exception 'Match request reused with changed details or actor' using errcode='22023'; end if;
 return jsonb_populate_record(null::public.resale_listings,v_req.result);
 end if;
 -- Item first matches the existing item/sale locking order. Listing lock serializes observations and decisions.
 select * into v_item from public.inventory where id=v_inventory_id for update;
 if not found then raise exception 'Physical inventory item not found' using errcode='P0002'; end if;
 perform 1 from public.resale_item_details where inventory_id=v_inventory_id for share;
 if v_item.archived_at is not null or exists(select 1 from public.resale_item_details where inventory_id=v_inventory_id and workflow='archived') then
 raise exception 'Archived item cannot be matched; review the inventory item first' using errcode='22023'; end if;
 if lower(coalesce(v_item.status,''))='sold' or exists(select 1 from public.sales where inventory_id=v_inventory_id and lower(coalesce(status,''))<>'void') then
 raise exception 'Item already sold; review the sale before matching. Stock was not changed.' using errcode='22023'; end if;
 select * into v_listing from public.resale_listings where id=v_listing_id for update;
 if not found then raise exception 'Listing not found' using errcode='P0002'; end if;
 if v_listing.observation_id is distinct from v_expected_observation or v_listing.inventory_id is distinct from v_expected_inventory
 or v_listing.match_status is distinct from p_payload->>'expectedMatchStatus' then
 raise exception 'Listing evidence or prior match changed; refresh and review again' using errcode='40001'; end if;
 select * into v_observation from public.resale_observations where id=v_listing.observation_id and listing_id=v_listing.id and account_id=v_listing.account_id;
 v_prior:=jsonb_build_object('inventory_id',v_listing.inventory_id,'match_status',v_listing.match_status,
 'matched_by',v_listing.matched_by,'matched_at',v_listing.matched_at,'match_evidence',v_listing.match_evidence);
 v_confirmation:=jsonb_build_object('method','operator_confirmation','request_id',p_request_id,'reason',v_reason,
 'actor_id',v_actor,'confirmed_at',now(),'account_id',v_listing.account_id,'external_listing_id',v_listing.external_listing_id,
 'inventory_id',v_inventory_id,'observation_id',v_listing.observation_id,'snapshot_id',v_observation.snapshot_id,
 'observed_status',v_listing.observed_status,'observed_at',v_listing.observed_at,
 'observation_external_listing_id',v_observation.external_listing_id);
 insert into public.resale_listing_match_history(id,listing_id,account_id,inventory_id,actor_id,reason,prior_match,confirmation)
 values(p_request_id,v_listing.id,v_listing.account_id,v_inventory_id,v_actor,v_reason,v_prior,v_confirmation);
 update public.resale_listings set inventory_id=v_inventory_id,match_status='confirmed',matched_by=v_actor,matched_at=now(),
 match_evidence=match_evidence||jsonb_build_object('manual_confirmation',v_confirmation)
 where id=v_listing.id returning * into v_listing;
 insert into private.resale_match_requests(request_id,actor_id,payload,result) values(p_request_id,v_actor,p_payload,to_jsonb(v_listing));
 return v_listing;
end $$;
revoke all on function private.resale_confirm_listing_match(uuid,jsonb) from public,anon,service_role;
grant execute on function private.resale_confirm_listing_match(uuid,jsonb) to authenticated;
create function public.resale_confirm_listing_match(p_request_id uuid,p_payload jsonb)
returns public.resale_listings language sql security invoker set search_path='' as $$
select private.resale_confirm_listing_match(p_request_id,p_payload) $$;
revoke all on function public.resale_confirm_listing_match(uuid,jsonb) from public,anon,service_role;
grant execute on function public.resale_confirm_listing_match(uuid,jsonb) to authenticated;
commit;
