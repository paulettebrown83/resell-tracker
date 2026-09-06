create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon,authenticated,service_role;
    grant select,insert,update,delete on storage.objects to authenticated;
    create function storage.allow_only_operation(op text) returns boolean language sql stable as $$select coalesce(regexp_replace(current_setting('storage.operation',true),'^storage\.','')=regexp_replace(op,'^storage\.',''),false)$$;
    create function storage.allow_any_operation(ops text[]) returns boolean language sql stable as $$select coalesce(current_setting('storage.operation',true)=any(ops),false)$$;
