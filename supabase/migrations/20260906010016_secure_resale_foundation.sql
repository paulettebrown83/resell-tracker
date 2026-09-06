-- Coordinated cutover only: follow docs/ROLLOUT.md. No legacy records are deleted or matched by name.
begin;
revoke create on schema public from public, anon, authenticated;
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;
create table private.memberships (
  user_id uuid not null references auth.users(id) on delete cascade,
  area text not null check (area in ('resale','genealogy')),
  created_at timestamptz not null default now(),
  primary key (user_id, area)
);
alter table private.memberships enable row level security;
revoke all on private.memberships from public, anon, authenticated;
grant select on private.memberships to authenticated;
grant all on private.memberships to service_role;
create policy self_membership on private.memberships for select to authenticated
  using (user_id = (select auth.uid()));

create function private.has_access(p_area text) returns boolean
language sql stable security invoker set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from private.memberships where user_id = auth.uid() and area = p_area
  );
$$;
revoke all on function private.has_access(text) from public, anon;
grant execute on function private.has_access(text) to authenticated, service_role;
create function public.resale_access() returns boolean
language sql stable security invoker set search_path = '' as $$
  select private.has_access('resale');
$$;
revoke all on function public.resale_access() from public, anon;
grant execute on function public.resale_access() to authenticated;

-- Replace permissive policies, including access through the summary view.
do $$ declare r record; t text; a text; begin
  for r in select tablename, policyname from pg_policies
    where schemaname='public' and tablename in ('sales','inventory','expenses','resell_clothes','book_of_snippets','thoughts')
  loop execute format('drop policy %I on public.%I',r.policyname,r.tablename); end loop;
  foreach t in array array['sales','inventory','expenses','resell_clothes','book_of_snippets','thoughts'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated',t);
    if t <> 'thoughts' then
      a := case when t='book_of_snippets' then 'genealogy' else 'resale' end;
      execute format('grant select on public.%I to authenticated',t);
      execute format('create policy members on public.%I for all to authenticated using ((select private.has_access(%L))) with check ((select private.has_access(%L)))',t,a,a);
    end if;
  end loop;
end $$;
revoke all on public.sales_summary from public, anon, authenticated;
alter view public.sales_summary set (security_invoker = true);
grant select on public.sales_summary to authenticated;
revoke all on sequence public.book_of_snippets_id_seq, public.resell_clothes_id_seq from public, anon, authenticated;
grant usage on sequence public.book_of_snippets_id_seq, public.resell_clothes_id_seq to authenticated;
-- These two clients require their own login cutover before production migration.
grant insert, update on public.book_of_snippets, public.resell_clothes to authenticated;
alter function public.update_updated_at() set search_path = '';
alter function public.update_updated_at_column() set search_path = '';
alter function public.match_thoughts(vector,double precision,integer,jsonb) set search_path = public, extensions;
revoke all on function public.match_thoughts(vector,double precision,integer,jsonb) from public, anon, authenticated;
grant execute on function public.match_thoughts(vector,double precision,integer,jsonb) to service_role;

alter table public.inventory add column archived_at timestamptz;
alter table public.expenses add column archived_at timestamptz;
alter table public.resell_clothes add column inventory_id uuid references public.inventory(id);
create index resell_clothes_inventory_id_idx on public.resell_clothes(inventory_id);
alter table public.sales
  add column inventory_id uuid references public.inventory(id),
  add column previous_inventory_status text,
  add column source_system text,
  add column source_record_id text,
  add column settlement_status text not null default 'legacy_unverified',
  add column version integer not null default 1,
  add constraint sales_source_pair check ((source_system is null) = (source_record_id is null)),
  add constraint sales_settlement_status check (settlement_status in ('legacy_unverified','actual'));
create unique index sales_source_unique on public.sales(source_system,source_record_id)
  where source_system is not null;
create unique index sales_active_inventory_unique on public.sales(inventory_id)
  where inventory_id is not null and lower(coalesce(status,'')) <> 'void';
grant insert (item_name,item_cost,platforms,date_added) on public.inventory to authenticated;
grant update (item_name,item_cost,platforms,date_added,archived_at) on public.inventory to authenticated;
grant insert (name,amount,date_added) on public.expenses to authenticated;
grant update (name,amount,date_added,archived_at) on public.expenses to authenticated;

create table private.sale_requests (
  request_id uuid primary key,
  actor_id uuid not null,
  payload jsonb not null,
  sale_id uuid not null references public.sales(id),
  created_at timestamptz not null default now()
);
alter table private.sale_requests enable row level security;
revoke all on private.sale_requests from public, anon, authenticated;
create table public.sale_history (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id),
  actor_id uuid not null,
  reason text not null,
  before_record jsonb,
  after_record jsonb not null,
  created_at timestamptz not null default now()
);
create index sale_history_sale_id_idx on public.sale_history(sale_id);
alter table public.sale_history enable row level security;
revoke all on public.sale_history from public, anon, authenticated;
grant select on public.sale_history to authenticated;
grant all on public.sale_history, private.sale_requests to service_role;
create policy members_read_history on public.sale_history for select to authenticated
  using ((select private.has_access('resale')));

-- Privilege elevation is confined to a private, explicitly authorized operation.
-- Clients have no direct sale INSERT/UPDATE/DELETE grants and cannot bypass this transaction.
create function private.save_sale(p_request_id uuid, p_payload jsonb) returns public.sales
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid(); v_sale public.sales; v_old public.sales;
  v_item public.inventory; v_request private.sale_requests;
  v_id uuid; v_item_id uuid; v_price numeric; v_fee numeric; v_cost numeric;
  v_shipping numeric; v_received numeric; v_gross numeric; v_source text; v_source_id text;
  v_void boolean := coalesce((p_payload->>'void')::boolean,false);
  v_reason text := nullif(btrim(p_payload->>'reason'),'');
begin
  if v_actor is null or not private.has_access('resale') then
    raise exception 'Resale access required' using errcode='42501';
  end if;
  if p_request_id is null or p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Request ID and sale details required' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
  select * into v_request from private.sale_requests where request_id=p_request_id;
  if found then
    if v_request.actor_id <> v_actor or v_request.payload <> p_payload then
      raise exception 'Request ID already used with different details' using errcode='22023';
    end if;
    select * into v_sale from public.sales where id=v_request.sale_id;
    return v_sale;
  end if;
  v_id := nullif(p_payload->>'id','')::uuid;
  if v_id is not null then
    select * into v_old from public.sales where id=v_id for update;
    if not found then raise exception 'Sale not found' using errcode='P0002'; end if;
    if (p_payload->>'version')::integer is distinct from v_old.version then
      raise exception 'Sale changed. Reload before correcting it.' using errcode='40001';
    end if;
    if v_reason is null then raise exception 'Correction reason required' using errcode='22023'; end if;
    if lower(coalesce(v_old.status,''))='void' then
      raise exception 'Voided sale is retained as history; create a new sale' using errcode='22023';
    end if;
    v_item_id := v_old.inventory_id;
  else
    if v_void then raise exception 'Cannot void a new sale' using errcode='22023'; end if;
    v_item_id := nullif(p_payload->>'inventory_id','')::uuid;
  end if;
  if v_item_id is not null then
    select * into v_item from public.inventory where id=v_item_id for update;
    if not found then raise exception 'Inventory item not found' using errcode='P0002'; end if;
    if v_id is null and (lower(coalesce(v_item.status,''))='sold' or v_item.archived_at is not null) then
      raise exception 'Item is already sold or archived' using errcode='22023';
    end if;
  end if;
  if v_void then
    update public.sales set status='Void',version=version+1 where id=v_id returning * into v_sale;
    if v_item_id is not null then
      update public.inventory set status=v_old.previous_inventory_status where id=v_item_id;
    end if;
  else
    v_price := (p_payload->>'sale_price')::numeric;
    v_fee := (p_payload->>'platform_fee')::numeric;
    v_cost := case when v_id is null and v_item_id is not null then v_item.item_cost else (p_payload->>'item_cost')::numeric end;
    v_shipping := (p_payload->>'shipping_cost')::numeric;
    v_received := nullif(p_payload->>'actual_received','')::numeric;
    v_gross := nullif(p_payload->>'gross_total','')::numeric;
    if v_price is null or v_fee is null or v_cost is null or v_shipping is null or
      v_price < 0 or v_fee < 0 or v_cost < 0 or v_shipping < 0 or v_received < 0 or v_gross < 0 or
      v_price::text in ('NaN','Infinity','-Infinity') or v_fee::text in ('NaN','Infinity','-Infinity') or
      v_cost::text in ('NaN','Infinity','-Infinity') or v_shipping::text in ('NaN','Infinity','-Infinity') or
      v_received::text in ('NaN','Infinity','-Infinity') or v_gross::text in ('NaN','Infinity','-Infinity') then
      raise exception 'Enter actual nonnegative price, fees, cost and shipping' using errcode='22023';
    end if;
    if v_price <> round(v_price,2) or v_fee <> round(v_fee,2) or v_cost <> round(v_cost,2) or
      v_shipping <> round(v_shipping,2) or v_received <> round(v_received,2) or v_gross <> round(v_gross,2) then
      raise exception 'Use no more than two decimal places for money' using errcode='22023';
    end if;
    if nullif(btrim(p_payload->>'platform'),'') is null or nullif(p_payload->>'sale_date','') is null or
      (v_item_id is null and nullif(btrim(p_payload->>'item_name'),'') is null) then
      raise exception 'Item, platform and sale date required' using errcode='22023';
    end if;
    v_source := nullif(lower(btrim(p_payload->>'source_system')),'');
    v_source_id := nullif(btrim(p_payload->>'source_record_id'),'');
    if v_id is not null then
      -- Source identity is immutable through corrections; no accidental deduplication escape.
      v_source := v_old.source_system; v_source_id := v_old.source_record_id;
    end if;
    if (v_source is null) <> (v_source_id is null) then
      raise exception 'Source system and source record ID must be supplied together' using errcode='22023';
    end if;
    if v_id is null then
      insert into public.sales(item_name,platform,sale_date,sale_price,platform_fee,item_cost,shipping_cost,profit,
        gross_total,actual_received,status,inventory_id,previous_inventory_status,source_system,source_record_id,settlement_status)
      values(coalesce(v_item.item_name,btrim(p_payload->>'item_name')),btrim(p_payload->>'platform'),(p_payload->>'sale_date')::date,
        round(v_price,2),round(v_fee,2),round(v_cost,2),round(v_shipping,2),
        round(coalesce(v_received,v_price-v_fee)-v_cost-v_shipping,2),v_gross,v_received,'Sold',v_item_id,v_item.status,v_source,v_source_id,'actual')
      returning * into v_sale;
    else
      update public.sales set item_name=btrim(p_payload->>'item_name'),platform=btrim(p_payload->>'platform'),
        sale_date=(p_payload->>'sale_date')::date,sale_price=round(v_price,2),platform_fee=round(v_fee,2),
        item_cost=round(v_cost,2),shipping_cost=round(v_shipping,2),gross_total=v_gross,actual_received=v_received,
        profit=round(coalesce(v_received,v_price-v_fee)-v_cost-v_shipping,2),settlement_status='actual',version=version+1
      where id=v_id returning * into v_sale;
    end if;
    if v_id is null and v_item_id is not null then
      update public.inventory set status='sold' where id=v_item_id;
    end if;
  end if;
  insert into public.sale_history(sale_id,actor_id,reason,before_record,after_record)
    values(v_sale.id,v_actor,coalesce(v_reason,'Sale recorded'),case when v_id is null then null else to_jsonb(v_old) end,to_jsonb(v_sale));
  insert into private.sale_requests(request_id,actor_id,payload,sale_id) values(p_request_id,v_actor,p_payload,v_sale.id);
  return v_sale;
end;
$$;
revoke all on function private.save_sale(uuid,jsonb) from public, anon;
grant execute on function private.save_sale(uuid,jsonb) to authenticated;
create function public.save_sale(p_request_id uuid,p_payload jsonb) returns public.sales
language sql security invoker set search_path = '' as $$ select private.save_sale(p_request_id,p_payload); $$;
revoke all on function public.save_sale(uuid,jsonb) from public, anon;
grant execute on function public.save_sale(uuid,jsonb) to authenticated;

create or replace view public.sales_summary with (security_invoker=true) as
select count(*) as total_sales,sum(sale_price) as total_revenue,sum(platform_fee) as total_fees,
  sum(profit) as total_profit,platform,date_trunc('month',sale_date::timestamptz) as month
from public.sales where lower(coalesce(status,'')) <> 'void'
group by platform,date_trunc('month',sale_date::timestamptz);
commit;
