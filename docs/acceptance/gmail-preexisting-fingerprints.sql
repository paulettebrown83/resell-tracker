-- Run before migration, after migration, and again after rollback-only acceptance.
-- These exact 29 preexisting tables must remain unchanged across the Gmail rollout.
-- The Gmail migration adds tables only; no row data leaves SQL.
begin isolation level repeatable read;
create temporary table operation_fingerprint_results(table_name text,row_count bigint,sha256 text) on commit drop;
do $fp$ declare target text; relation regclass; begin
foreach target in array array['public.inventory','public.sales','public.resell_clothes','public.expenses','public.book_of_snippets','public.sale_history','private.memberships','private.sale_requests','private.resale_item_requests','public.resale_item_details','public.resale_accounts','public.resale_snapshots','public.resale_listings','public.resale_observations','public.resale_source_records','public.resale_review_cases','public.resale_actions','public.resale_action_attempts','public.resale_order_lines','public.resale_order_events','public.resale_media','public.resale_listing_match_history','public.resale_listing_draft_history','private.resale_draft_requests','private.resale_operation_requests','private.resale_operation_adapters','public.resale_operation_proposals','public.resale_operation_verifications','private.resale_import_runs'] loop
relation:=to_regclass(target);
if relation is null then raise exception 'Required fingerprint relation missing: %',target;end if;
execute format('insert into operation_fingerprint_results select %L,count(*),encode(extensions.digest(convert_to(coalesce(string_agg(to_jsonb(r)::text,E''\\n'' order by to_jsonb(r)::text),''''),''UTF8''),''sha256''),''hex'') from %s r',target,relation);
end loop; end $fp$;
select * from operation_fingerprint_results order by table_name;
rollback;

