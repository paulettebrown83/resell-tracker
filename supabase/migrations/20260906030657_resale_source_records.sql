-- Report evidence can exist without a known order/line identity or event timestamp.
-- Append only; no sale/listing/status mutation or import execution in this migration.
begin;
create table public.resale_source_records (
 id uuid primary key default gen_random_uuid(),
 snapshot_id uuid not null, account_id uuid not null,
 record_key text not null check(length(btrim(record_key)) between 1 and 512),
 row_index integer check(row_index>=1),
 source_kind text not null check(source_kind in ('csv','browser','email','official_api','webhook','manual')),
 source_file_sha256 text check(source_file_sha256 ~ '^[a-f0-9]{64}$'),
 source_row_sha256 text check(source_row_sha256 ~ '^[a-f0-9]{64}$'),
 raw_business jsonb not null check(jsonb_typeof(raw_business)='object'),
 normalized jsonb not null default '{}' check(jsonb_typeof(normalized)='object'),
 external_identifiers jsonb not null default '{}' check(jsonb_typeof(external_identifiers)='object'),
 event_precision text not null default 'unknown' check(event_precision in ('unknown','date','instant')),
 event_date date, event_time timestamptz, event_timezone text,
 source_observed_at timestamptz, captured_at timestamptz not null,
 record_status text not null check(record_status in ('accepted','needs_review','quarantined')),
 review_reason text,
 supersedes_record_id uuid,
 created_at timestamptz not null default now(),
 foreign key(snapshot_id,account_id) references public.resale_snapshots(id,account_id),
 unique(snapshot_id,record_key), unique(id,account_id),
 foreign key(supersedes_record_id,account_id) references public.resale_source_records(id,account_id),
 check(supersedes_record_id is distinct from id),
 check(record_status='accepted' or nullif(btrim(review_reason),'') is not null),
 check(
 (event_precision='unknown' and event_date is null and event_time is null) or
 (event_precision='date' and event_date is not null and event_time is null) or
 (event_precision='instant' and event_time is not null)
 ),
 check(octet_length(raw_business::text)<=262144 and octet_length(normalized::text)<=262144 and octet_length(external_identifiers::text)<=65536)
);
create index resale_source_records_account_status on public.resale_source_records(account_id,record_status);
create index resale_source_records_snapshot_row on public.resale_source_records(snapshot_id,row_index);
create index resale_source_records_event_date on public.resale_source_records(account_id,event_date);
alter table public.resale_source_records enable row level security;
revoke all on public.resale_source_records from public,anon,authenticated,service_role;
grant select on public.resale_source_records to authenticated;
grant select,insert on public.resale_source_records to service_role;
create policy resale_members_read on public.resale_source_records for select to authenticated
using((select private.has_access('resale')));
-- Provenance is immutable even for a trusted importer. Corrections append a new record
-- with supersedes_record_id and their own source key; review state lives in review_cases.
create function private.resale_source_record_immutable() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 raise exception 'Source records are immutable; append corrected evidence and retain the original' using errcode='55000';
end $$;
revoke all on function private.resale_source_record_immutable() from public,anon,authenticated,service_role;
create trigger resale_source_record_immutable before update or delete on public.resale_source_records
for each row execute function private.resale_source_record_immutable();
commit;
