begin;
-- Immutable observations, separate from desired prices and physical inventory.
create table public.resale_pricing_observations (
 id uuid primary key, recorded_by uuid not null references auth.users(id),
 listing_id uuid not null, account_id uuid not null, source_record_id uuid not null,
 external_account_id text not null, external_listing_id text not null,
 inventory_id uuid references public.inventory(id), observed_at timestamptz not null,
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 asking_minor bigint not null check(asking_minor between 0 and 1000000000),
 mechanism text not null check(mechanism in ('mercari_smart_pricing','poshmark_smart_sell','unknown')),
 enabled boolean, minimum_minor bigint check(minimum_minor between 0 and 1000000000),
 created_at timestamptz not null default now(),
 foreign key(listing_id,account_id) references public.resale_listings(id,account_id),
 foreign key(source_record_id,account_id) references public.resale_source_records(id,account_id),
 unique(listing_id,source_record_id),
 check(minimum_minor is null or minimum_minor<=asking_minor),
 check(mechanism<>'unknown' or enabled is null)
);
create index resale_pricing_listing_time on public.resale_pricing_observations(listing_id,observed_at desc);
alter table public.resale_pricing_observations enable row level security;
revoke all on public.resale_pricing_observations from public,anon,authenticated,service_role;
grant select on public.resale_pricing_observations to authenticated,service_role;
create policy resale_members_read on public.resale_pricing_observations for select to authenticated using((select private.has_access('resale')));
create trigger resale_pricing_immutable before update or delete on public.resale_pricing_observations for each row execute function private.resale_source_record_immutable();

create function public.resale_record_pricing_observation(p_member_id uuid,p_request_id uuid,p_listing_id uuid,p_source_record_id uuid) returns uuid
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
 if p is null or jsonb_typeof(p)<>'object' or (p->>'currency') !~ '^[A-Z]{3}$'
 or coalesce(p->>'asking_minor','') !~ '^[0-9]{1,10}$'
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

-- A view never resolves equal-time disagreement by arbitrary ID order. It returns no
-- authoritative observation ID for conflicts, changed identity, or relinked stock.
create view public.resale_listing_pricing with (security_invoker=true) as
select l.id as listing_id,l.account_id,l.external_listing_id,l.inventory_id,l.draft_version,
 case when facts.fact_count=1 and facts.bindings_match then facts.observation_id else null end as pricing_observation_id,
 facts.observed_at,
 case when facts.fact_count is null then 'unknown' when not facts.bindings_match then 'target_changed'
 when facts.fact_count>1 then 'conflict' when facts.observed_at<now()-interval '24 hours' then 'stale'
 when facts.enabled is null or facts.mechanism='unknown' then 'unknown' else 'observed' end as pricing_status,
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

-- Existing-price execution remains unavailable until a real adapter validates the
-- captured expectation and verifies the provider's settings again after its write.
-- UI intent and a preserve-platform policy cannot masquerade as verified execution.
create function private.resale_guard_price_operation() returns trigger language plpgsql security definer set search_path='' as $$
declare l public.resale_listings; reason text; p record; e jsonb; issue text;
begin
 if tg_op='UPDATE' and old.action in ('publish','update') and coalesce(old.payload->'prepared_fields','{}'::jsonb) ? 'price'
 and (new.action is distinct from old.action or new.payload is distinct from old.payload) then raise exception 'Captured price request cannot change' using errcode='40001'; end if;
 if new.action not in ('publish','update') or not(coalesce(new.payload->'prepared_fields','{}'::jsonb) ? 'price') then return new; end if;
 select * into l from public.resale_listings where id=new.listing_id;
 if tg_op='UPDATE' and old.target_external_listing_id is not null
 and (new.target_external_listing_id is distinct from old.target_external_listing_id or new.listing_id is distinct from old.listing_id or new.target_account_id is distinct from old.target_account_id or new.target_inventory_id is distinct from old.target_inventory_id or new.target_identity is distinct from old.target_identity) then
 raise exception 'Captured pricing target cannot change' using errcode='40001'; end if;
 if coalesce(new.target_external_listing_id,new.target_identity->>'external_listing_id',l.external_listing_id) is null then return new; end if;
 if new.state in ('running','succeeded') then raise exception 'Existing listing price execution requires an implemented settings-preserving adapter and postflight verification' using errcode='55000'; end if;
 if tg_op='INSERT' then
 select * into p from public.resale_listing_pricing where listing_id=l.id;
 e:=new.payload->'pricing_expectation';
 if p.pricing_status is distinct from 'observed' or p.pricing_observation_id is null then issue:='Pricing facts are missing, stale, conflicting, or tied to an earlier item link.';
 elsif e is null or e->>'pricing_observation_id' is distinct from p.pricing_observation_id::text
 or e->>'draft_version' is distinct from l.draft_version::text
 or e->>'account_id' is distinct from l.account_id::text
 or e->>'listing_id' is distinct from l.id::text
 or e->>'external_listing_id' is distinct from l.external_listing_id
 or e->>'inventory_id' is distinct from l.inventory_id::text
 or e->>'policy' is distinct from 'preserve_platform' or e->>'intent' is distinct from 'set_asking_price'
 then issue:='The request must capture the current exact pricing observation, item link, and draft version.';
 elsif p.enabled is distinct from false then issue:='Marketplace automatic pricing or offers are enabled or unverified; a fixed price update is blocked.';
 end if;
 if issue is not null then new.blockers:=new.blockers||jsonb_build_array(jsonb_build_object('code','pricing_settings_check','message',issue)); end if;
 reason:='The marketplace price and automatic pricing settings must be checked before applying this request. Existing listing price execution is not connected.';
 new.blockers:=new.blockers||jsonb_build_array(jsonb_build_object('code','pricing_execution_unavailable','message',reason));
 end if;
 return new;
end $$;
revoke all on function private.resale_guard_price_operation() from public,anon,authenticated,service_role;
create trigger resale_guard_price_operation before insert or update on public.resale_actions for each row execute function private.resale_guard_price_operation();
commit;
