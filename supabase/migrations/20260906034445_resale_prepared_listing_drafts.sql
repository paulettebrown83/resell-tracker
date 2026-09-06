-- Prepared local copy only; no publishing, observation, sale, stock or remote action changes.
begin;
alter table public.resale_listings add column draft_version integer not null default 0 check(draft_version>=0),
 add column draft_updated_at timestamptz, add column draft_context jsonb not null default '{}' check(jsonb_typeof(draft_context)='object');
create table public.resale_listing_draft_history (
 id uuid primary key, listing_id uuid not null references public.resale_listings(id), actor_id uuid not null references auth.users(id),
 prior_draft jsonb not null, saved_draft jsonb not null, created_at timestamptz not null default now()
);
create index resale_draft_history_listing on public.resale_listing_draft_history(listing_id,created_at,id);
alter table public.resale_listing_draft_history enable row level security;
revoke all on public.resale_listing_draft_history from public,anon,authenticated,service_role;
grant select on public.resale_listing_draft_history to authenticated,service_role;
create policy resale_members_read on public.resale_listing_draft_history for select to authenticated using((select private.has_access('resale')));
create function private.resale_draft_history_immutable() returns trigger language plpgsql security invoker set search_path='' as $$
begin raise exception 'Draft history is immutable; save a new version' using errcode='55000'; end $$;
revoke all on function private.resale_draft_history_immutable() from public,anon,authenticated,service_role;
create trigger resale_draft_history_immutable before update or delete on public.resale_listing_draft_history for each row execute function private.resale_draft_history_immutable();
create table private.resale_draft_requests(request_id uuid primary key,actor_id uuid not null,payload jsonb not null,result jsonb not null,created_at timestamptz not null default now());
alter table private.resale_draft_requests enable row level security;
revoke all on private.resale_draft_requests from public,anon,authenticated,service_role;

-- Structural storage limits only, not claims about marketplace publication requirements.
create function private.resale_validate_draft_fields(p_fields jsonb) returns void language plpgsql security invoker set search_path='' as $$
declare k text; v jsonb;
begin
 if p_fields is null or jsonb_typeof(p_fields)<>'object' then raise exception 'Draft fields must be an object' using errcode='22023'; end if;
 if exists(select 1 from jsonb_object_keys(p_fields) key where key<>all(array['title','description','price','currency','category_id','category_label','condition','size','media_ids','attributes','shipping'])) then raise exception 'Unsupported draft field' using errcode='22023'; end if;
 foreach k in array array['title','description','currency','category_id','category_label','condition','size'] loop
 v:=p_fields->k;
 if v is not null and v<>'null'::jsonb and (jsonb_typeof(v)<>'string' or length(p_fields->>k)>10000) then raise exception 'Invalid text draft field' using errcode='22023'; end if;
 end loop;
 if p_fields->'price' is not null and p_fields->'price'<>'null'::jsonb then
 if jsonb_typeof(p_fields->'price')<>'number' or (p_fields->>'price')::numeric<0 or (p_fields->>'price')::numeric>=100000000 or (p_fields->>'price')::numeric<>round((p_fields->>'price')::numeric,2) then raise exception 'Invalid draft price' using errcode='22023'; end if;
 end if;
 if p_fields->>'currency' is not null and p_fields->>'currency' !~ '^[A-Z]{3}$' then raise exception 'Invalid draft currency' using errcode='22023'; end if;
 if p_fields ? 'media_ids' then
 if jsonb_typeof(p_fields->'media_ids')<>'array' or jsonb_array_length(p_fields->'media_ids')>100 then raise exception 'Invalid draft media list' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(p_fields->'media_ids') e where jsonb_typeof(e)<>'string' or (e#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then raise exception 'Invalid media identity' using errcode='22023'; end if;
 if jsonb_array_length(p_fields->'media_ids')<>(select count(distinct e) from jsonb_array_elements_text(p_fields->'media_ids') e) then raise exception 'Duplicate media identity' using errcode='22023'; end if;
 end if;
 if p_fields ? 'attributes' then
 if jsonb_typeof(p_fields->'attributes')<>'object' then raise exception 'Invalid item attributes' using errcode='22023'; end if;
 for k,v in select * from jsonb_each(p_fields->'attributes') loop
 if length(k)>200 or (jsonb_typeof(v)<>'string' and jsonb_typeof(v)<>'array') then raise exception 'Invalid item attribute value' using errcode='22023'; end if;
 if jsonb_typeof(v)='array' and exists(select 1 from jsonb_array_elements(v) e where jsonb_typeof(e)<>'string') then raise exception 'Invalid attribute list' using errcode='22023'; end if;
 end loop;
 end if;
 if p_fields ? 'shipping' then
 if jsonb_typeof(p_fields->'shipping')<>'object' then raise exception 'Invalid draft shipping' using errcode='22023'; end if;
 if exists(select 1 from jsonb_object_keys(p_fields->'shipping') key where key<>all(array['method','packed_weight_grams','notes'])) then raise exception 'Unsupported shipping field' using errcode='22023'; end if;
 foreach k in array array['method','notes'] loop
 v:=p_fields->'shipping'->k;
 if v is not null and (jsonb_typeof(v)<>'string' or length(p_fields->'shipping'->>k)>2000) then raise exception 'Invalid shipping text' using errcode='22023'; end if;
 end loop;
 v:=p_fields->'shipping'->'packed_weight_grams';
 if v is not null and v<>'null'::jsonb and (jsonb_typeof(v)<>'number' or (v#>>'{}')::numeric<=0 or (v#>>'{}')::numeric>=1000000) then raise exception 'Invalid packed weight' using errcode='22023'; end if;
 end if;
end $$;
revoke all on function private.resale_validate_draft_fields(jsonb) from public,anon,authenticated,service_role;

create function private.resale_save_listing_draft(p_request_id uuid,p_payload jsonb) returns public.resale_listings
language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_request private.resale_draft_requests; v_item public.inventory;
 v_listing public.resale_listings; v_listing_id uuid; v_account_id uuid; v_inventory_id uuid; v_fields jsonb;
 v_preferences jsonb; v_overrides jsonb; v_context jsonb; v_prior jsonb; v_media uuid; v_version integer;
begin
 perform 1 from private.memberships where user_id=v_actor and area='resale' for share;
 if v_actor is null or not found then raise exception 'Resale access required' using errcode='42501'; end if;
 if p_request_id is null or p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>32768 then raise exception 'Invalid draft request' using errcode='22023'; end if;
 if exists(select 1 from jsonb_object_keys(p_payload) key where key<>all(array['listing_id','account_id','inventory_id','expected_version','channel','rules_version','fields','preferences','overrides'])) then raise exception 'Unsupported draft request field' using errcode='22023'; end if;
 if not (p_payload ?& array['account_id','inventory_id','expected_version','channel','rules_version','fields']) then raise exception 'Draft identity and context required' using errcode='22023'; end if;
 if jsonb_typeof(p_payload->'expected_version')<>'number' or (p_payload->>'expected_version') !~ '^[0-9]+$' then raise exception 'Expected draft version required' using errcode='22023'; end if;
 v_version:=(p_payload->>'expected_version')::integer;
 if jsonb_typeof(p_payload->'channel')<>'string' or p_payload->>'channel'<>all(array['consumer','bulk','api']) or jsonb_typeof(p_payload->'rules_version')<>'string' or p_payload->>'rules_version' !~ '^[A-Za-z0-9._-]{1,100}$' then raise exception 'Invalid draft guidance context' using errcode='22023'; end if;
 perform private.resale_validate_draft_fields(p_payload->'fields');
 v_overrides:=coalesce(p_payload->'overrides','{}'::jsonb);perform private.resale_validate_draft_fields(v_overrides);
 v_preferences:=coalesce(p_payload->'preferences','{}'::jsonb);
 if jsonb_typeof(v_preferences)<>'object' or exists(select 1 from jsonb_object_keys(v_preferences) key where key<>all(array['style','avoid_emojis','hashtag_target'])) then raise exception 'Invalid writing preferences' using errcode='22023'; end if;
 if v_preferences ? 'style' and (jsonb_typeof(v_preferences->'style')<>'string' or v_preferences->>'style'<>all(array['plain','factual_bullets','style_led'])) then raise exception 'Invalid writing style' using errcode='22023'; end if;
 if v_preferences ? 'avoid_emojis' and jsonb_typeof(v_preferences->'avoid_emojis')<>'boolean' then raise exception 'Invalid emoji preference' using errcode='22023'; end if;
 if v_preferences ? 'hashtag_target' and (jsonb_typeof(v_preferences->'hashtag_target')<>'number' or (v_preferences->>'hashtag_target') !~ '^[0-9]+$' or (v_preferences->>'hashtag_target')::numeric>50) then raise exception 'Invalid hashtag preference' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,5));
 select * into v_request from private.resale_draft_requests where request_id=p_request_id;
 if found then
 if v_request.actor_id<>v_actor or v_request.payload<>p_payload then raise exception 'Request reused with changed draft' using errcode='22023'; end if;
 return jsonb_populate_record(null::public.resale_listings,v_request.result); end if;
 v_account_id:=(p_payload->>'account_id')::uuid;v_inventory_id:=(p_payload->>'inventory_id')::uuid;
 if v_account_id is null or v_inventory_id is null then raise exception 'Draft account and item required' using errcode='22023'; end if;
 if not exists(select 1 from public.resale_accounts where id=v_account_id) then raise exception 'Account not found' using errcode='P0002'; end if;
 select * into v_item from public.inventory where id=v_inventory_id for update;
 if not found then raise exception 'Item not found' using errcode='P0002'; end if;
 if v_item.archived_at is not null or lower(coalesce(v_item.status,''))='sold' or exists(select 1 from public.resale_item_details where inventory_id=v_inventory_id and workflow='archived') then raise exception 'Item is sold or archived' using errcode='22023'; end if;
 v_fields:=(p_payload->'fields')||v_overrides;
 for v_media in select value::uuid from jsonb_array_elements_text(coalesce(v_fields->'media_ids','[]'::jsonb)) loop
 if not exists(select 1 from public.resale_media where id=v_media and inventory_id=v_inventory_id and state='ready') then raise exception 'Photo must be ready and belong to this item' using errcode='22023'; end if;
 end loop;
 v_context:=jsonb_build_object('inventory_id',v_inventory_id,'account_id',v_account_id,'rules_version',p_payload->>'rules_version','channel',p_payload->>'channel','fields',p_payload->'fields','preferences',v_preferences,'overrides',v_overrides);
 v_listing_id:=nullif(p_payload->>'listing_id','')::uuid;
 if v_listing_id is null then
 if v_version<>0 then raise exception 'New draft requires version zero' using errcode='40001'; end if;
 if exists(select 1 from public.resale_listings where account_id=v_account_id and inventory_id=v_inventory_id and external_listing_id is null) then raise exception 'A local draft already exists for this item and account' using errcode='23505'; end if;
 v_prior:='{}'::jsonb;
 insert into public.resale_listings(id,account_id,inventory_id,match_status,matched_by,matched_at,match_evidence,title,desired_fields,draft_version,draft_updated_at,draft_context)
 values(p_request_id,v_account_id,v_inventory_id,'confirmed',v_actor,now(),jsonb_build_object('local_draft_selection',jsonb_build_object('actor_id',v_actor,'inventory_id',v_inventory_id)),v_fields->>'title',v_fields,1,now(),v_context) returning * into v_listing;
 else
 select * into v_listing from public.resale_listings where id=v_listing_id for update;
 if not found then raise exception 'Listing not found' using errcode='P0002'; end if;
 if v_listing.account_id<>v_account_id or v_listing.inventory_id is distinct from v_inventory_id or v_listing.match_status<>'confirmed' then raise exception 'Confirm this listing and physical item link first' using errcode='22023'; end if;
 if v_listing.draft_version<>v_version then raise exception 'Draft changed; reload before saving' using errcode='40001'; end if;
 v_prior:=jsonb_build_object('desired_fields',v_listing.desired_fields,'draft_version',v_listing.draft_version,'draft_context',v_listing.draft_context);
 update public.resale_listings set desired_fields=v_fields,draft_context=v_context,draft_version=draft_version+1,draft_updated_at=now() where id=v_listing_id returning * into v_listing;
 end if;
 insert into public.resale_listing_draft_history(id,listing_id,actor_id,prior_draft,saved_draft) values(p_request_id,v_listing.id,v_actor,v_prior,jsonb_build_object('desired_fields',v_listing.desired_fields,'draft_version',v_listing.draft_version,'draft_context',v_listing.draft_context));
 insert into private.resale_draft_requests(request_id,actor_id,payload,result) values(p_request_id,v_actor,p_payload,to_jsonb(v_listing));
 return v_listing;
end $$;
revoke all on function private.resale_save_listing_draft(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.resale_save_listing_draft(uuid,jsonb) to authenticated;
create function public.resale_save_listing_draft(p_request_id uuid,p_payload jsonb) returns public.resale_listings
language sql security invoker set search_path='' as $$select private.resale_save_listing_draft(p_request_id,p_payload)$$;
revoke all on function public.resale_save_listing_draft(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.resale_save_listing_draft(uuid,jsonb) to authenticated;
commit;
