-- Dated production structure only; no business rows. Test/restore fixture, never apply over production.
create extension if not exists vector;
create table public."thoughts" (
  "id" uuid default gen_random_uuid() not null,
  "content" text not null,
  "embedding" vector(1536),
  "metadata" jsonb default '{}'::jsonb,
  "created_at" timestamp with time zone default now(),
  "updated_at" timestamp with time zone default now(),
  constraint "thoughts_pkey" PRIMARY KEY (id)
);
alter table public."thoughts" enable row level security;
CREATE INDEX thoughts_embedding_idx ON public.thoughts USING hnsw (embedding vector_cosine_ops);
CREATE INDEX thoughts_metadata_idx ON public.thoughts USING gin (metadata);
CREATE INDEX thoughts_created_at_idx ON public.thoughts USING btree (created_at DESC);
create table public."expenses" (
  "id" uuid default gen_random_uuid() not null,
  "name" text not null,
  "amount" numeric(10,2) not null,
  "date_added" date default CURRENT_DATE,
  "created_at" timestamp with time zone default timezone('utc'::text, now()),
  constraint "expenses_pkey" PRIMARY KEY (id)
);
alter table public."expenses" enable row level security;
create table public."inventory" (
  "id" uuid default gen_random_uuid() not null,
  "item_name" text not null,
  "item_cost" numeric(10,2) not null,
  "platforms" text[] default ARRAY['unlisted'::text],
  "date_added" date,
  "created_at" timestamp with time zone default timezone('utc'::text, now()),
  "status" text default 'unlisted'::text,
  constraint "inventory_pkey" PRIMARY KEY (id),
  constraint "inventory_status_check" CHECK ((status = ANY (ARRAY['listed'::text, 'unlisted'::text, 'sold'::text, 'returned'::text])))
);
alter table public."inventory" enable row level security;
CREATE INDEX idx_inventory_date ON public.inventory USING btree (date_added DESC);
create table public."sales" (
  "id" uuid default gen_random_uuid() not null,
  "item_name" text not null,
  "platform" text not null,
  "sale_date" date not null,
  "sale_price" numeric(10,2) not null,
  "platform_fee" numeric(10,2) not null,
  "item_cost" numeric(10,2) default 0,
  "shipping_cost" numeric(10,2) default 0,
  "profit" numeric(10,2) not null,
  "gross_total" numeric(10,2),
  "actual_received" numeric(10,2),
  "status" text default 'Sold'::text,
  "created_at" timestamp with time zone default timezone('utc'::text, now()),
  constraint "sales_pkey" PRIMARY KEY (id),
  constraint "sales_platform_check" CHECK ((platform = ANY (ARRAY['eBay'::text, 'Mercari'::text, 'Poshmark'::text, 'Depop'::text, 'Vinted'::text])))
);
alter table public."sales" enable row level security;
CREATE INDEX idx_sales_date ON public.sales USING btree (sale_date DESC);
CREATE INDEX idx_sales_platform ON public.sales USING btree (platform);
create sequence public."book_of_snippets_id_seq";
create table public."book_of_snippets" (
  "id" bigint default nextval('book_of_snippets_id_seq'::regclass) not null,
  "page_number" text,
  "name" text,
  "correct_name" text,
  "find_a_grave_url" text,
  "brief_notes" text,
  "created_at" timestamp with time zone default now(),
  "updated_at" timestamp with time zone default now(),
  "last_name" text,
  "maiden_name" text,
  "type" text,
  "date_of_article" text,
  "date_of_death" text,
  "birth_date" text,
  "location" text,
  "grave_location" text,
  "relatives" text,
  "deep_dive_notes" text,
  "verified" boolean default false,
  "tik_tok_done" boolean default false,
  constraint "book_of_snippets_pkey" PRIMARY KEY (id)
);
alter table public."book_of_snippets" enable row level security;
create sequence public."resell_clothes_id_seq";
create table public."resell_clothes" (
  "id" integer default nextval('resell_clothes_id_seq'::regclass) not null,
  "garment_name" text not null,
  "bag_number" text,
  "sold" boolean default false,
  "created_at" timestamp with time zone default now(),
  "purchase_date" date,
  "cost" numeric(10,2),
  constraint "resell_clothes_pkey" PRIMARY KEY (id)
);
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.update_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.match_thoughts(query_embedding vector, match_threshold double precision DEFAULT 0.7, match_count integer DEFAULT 10, filter jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(id uuid, content text, metadata jsonb, similarity double precision, created_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
begin
  return query
  select
    t.id,
    t.content,
    t.metadata,
    1 - (t.embedding <=> query_embedding) as similarity,
    t.created_at
  from thoughts t
  where 1 - (t.embedding <=> query_embedding) > match_threshold
    and (filter = '{}'::jsonb or t.metadata @> filter)
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$function$
;
CREATE TRIGGER thoughts_updated_at BEFORE UPDATE ON public.thoughts FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_book_of_snippets_updated_at BEFORE UPDATE ON public.book_of_snippets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
create view public."sales_summary" as  SELECT count(*) AS total_sales,
    sum(sale_price) AS total_revenue,
    sum(platform_fee) AS total_fees,
    sum(profit) AS total_profit,
    platform,
    date_trunc('month'::text, (sale_date)::timestamp with time zone) AS month
   FROM sales
  GROUP BY platform, (date_trunc('month'::text, (sale_date)::timestamp with time zone));
create policy "Service role full access" on public."thoughts" for ALL to public using ((auth.role() = 'service_role'::text));
create policy "Enable all access for service role" on public."expenses" for ALL to public using (true);
create policy "Enable all access for service role" on public."inventory" for ALL to public using (true);
create policy "Enable all access for service role" on public."sales" for ALL to public using (true);
create policy "Allow all operations" on public."book_of_snippets" for ALL to public using (true) with check (true);
grant INSERT on public."thoughts" to anon;
grant SELECT on public."thoughts" to anon;
grant UPDATE on public."thoughts" to anon;
grant DELETE on public."thoughts" to anon;
grant TRUNCATE on public."thoughts" to anon;
grant REFERENCES on public."thoughts" to anon;
grant TRIGGER on public."thoughts" to anon;
grant INSERT on public."thoughts" to authenticated;
grant SELECT on public."thoughts" to authenticated;
grant UPDATE on public."thoughts" to authenticated;
grant DELETE on public."thoughts" to authenticated;
grant TRUNCATE on public."thoughts" to authenticated;
grant REFERENCES on public."thoughts" to authenticated;
grant TRIGGER on public."thoughts" to authenticated;
grant INSERT on public."thoughts" to service_role;
grant SELECT on public."thoughts" to service_role;
grant UPDATE on public."thoughts" to service_role;
grant DELETE on public."thoughts" to service_role;
grant TRUNCATE on public."thoughts" to service_role;
grant REFERENCES on public."thoughts" to service_role;
grant TRIGGER on public."thoughts" to service_role;
grant INSERT on public."expenses" to anon;
grant SELECT on public."expenses" to anon;
grant UPDATE on public."expenses" to anon;
grant DELETE on public."expenses" to anon;
grant TRUNCATE on public."expenses" to anon;
grant REFERENCES on public."expenses" to anon;
grant TRIGGER on public."expenses" to anon;
grant INSERT on public."expenses" to authenticated;
grant SELECT on public."expenses" to authenticated;
grant UPDATE on public."expenses" to authenticated;
grant DELETE on public."expenses" to authenticated;
grant TRUNCATE on public."expenses" to authenticated;
grant REFERENCES on public."expenses" to authenticated;
grant TRIGGER on public."expenses" to authenticated;
grant INSERT on public."expenses" to service_role;
grant SELECT on public."expenses" to service_role;
grant UPDATE on public."expenses" to service_role;
grant DELETE on public."expenses" to service_role;
grant TRUNCATE on public."expenses" to service_role;
grant REFERENCES on public."expenses" to service_role;
grant TRIGGER on public."expenses" to service_role;
grant INSERT on public."sales_summary" to anon;
grant SELECT on public."sales_summary" to anon;
grant UPDATE on public."sales_summary" to anon;
grant DELETE on public."sales_summary" to anon;
grant TRUNCATE on public."sales_summary" to anon;
grant REFERENCES on public."sales_summary" to anon;
grant TRIGGER on public."sales_summary" to anon;
grant INSERT on public."sales_summary" to authenticated;
grant SELECT on public."sales_summary" to authenticated;
grant UPDATE on public."sales_summary" to authenticated;
grant DELETE on public."sales_summary" to authenticated;
grant TRUNCATE on public."sales_summary" to authenticated;
grant REFERENCES on public."sales_summary" to authenticated;
grant TRIGGER on public."sales_summary" to authenticated;
grant INSERT on public."sales_summary" to service_role;
grant SELECT on public."sales_summary" to service_role;
grant UPDATE on public."sales_summary" to service_role;
grant DELETE on public."sales_summary" to service_role;
grant TRUNCATE on public."sales_summary" to service_role;
grant REFERENCES on public."sales_summary" to service_role;
grant TRIGGER on public."sales_summary" to service_role;
grant INSERT on public."inventory" to anon;
grant SELECT on public."inventory" to anon;
grant UPDATE on public."inventory" to anon;
grant DELETE on public."inventory" to anon;
grant TRUNCATE on public."inventory" to anon;
grant REFERENCES on public."inventory" to anon;
grant TRIGGER on public."inventory" to anon;
grant INSERT on public."inventory" to authenticated;
grant SELECT on public."inventory" to authenticated;
grant UPDATE on public."inventory" to authenticated;
grant DELETE on public."inventory" to authenticated;
grant TRUNCATE on public."inventory" to authenticated;
grant REFERENCES on public."inventory" to authenticated;
grant TRIGGER on public."inventory" to authenticated;
grant INSERT on public."inventory" to service_role;
grant SELECT on public."inventory" to service_role;
grant UPDATE on public."inventory" to service_role;
grant DELETE on public."inventory" to service_role;
grant TRUNCATE on public."inventory" to service_role;
grant REFERENCES on public."inventory" to service_role;
grant TRIGGER on public."inventory" to service_role;
grant INSERT on public."sales" to anon;
grant SELECT on public."sales" to anon;
grant UPDATE on public."sales" to anon;
grant DELETE on public."sales" to anon;
grant TRUNCATE on public."sales" to anon;
grant REFERENCES on public."sales" to anon;
grant TRIGGER on public."sales" to anon;
grant INSERT on public."sales" to authenticated;
grant SELECT on public."sales" to authenticated;
grant UPDATE on public."sales" to authenticated;
grant DELETE on public."sales" to authenticated;
grant TRUNCATE on public."sales" to authenticated;
grant REFERENCES on public."sales" to authenticated;
grant TRIGGER on public."sales" to authenticated;
grant INSERT on public."sales" to service_role;
grant SELECT on public."sales" to service_role;
grant UPDATE on public."sales" to service_role;
grant DELETE on public."sales" to service_role;
grant TRUNCATE on public."sales" to service_role;
grant REFERENCES on public."sales" to service_role;
grant TRIGGER on public."sales" to service_role;
grant INSERT on public."book_of_snippets" to anon;
grant SELECT on public."book_of_snippets" to anon;
grant UPDATE on public."book_of_snippets" to anon;
grant DELETE on public."book_of_snippets" to anon;
grant TRUNCATE on public."book_of_snippets" to anon;
grant REFERENCES on public."book_of_snippets" to anon;
grant TRIGGER on public."book_of_snippets" to anon;
grant INSERT on public."book_of_snippets" to authenticated;
grant SELECT on public."book_of_snippets" to authenticated;
grant UPDATE on public."book_of_snippets" to authenticated;
grant DELETE on public."book_of_snippets" to authenticated;
grant TRUNCATE on public."book_of_snippets" to authenticated;
grant REFERENCES on public."book_of_snippets" to authenticated;
grant TRIGGER on public."book_of_snippets" to authenticated;
grant INSERT on public."book_of_snippets" to service_role;
grant SELECT on public."book_of_snippets" to service_role;
grant UPDATE on public."book_of_snippets" to service_role;
grant DELETE on public."book_of_snippets" to service_role;
grant TRUNCATE on public."book_of_snippets" to service_role;
grant REFERENCES on public."book_of_snippets" to service_role;
grant TRIGGER on public."book_of_snippets" to service_role;
grant INSERT on public."resell_clothes" to anon;
grant SELECT on public."resell_clothes" to anon;
grant UPDATE on public."resell_clothes" to anon;
grant DELETE on public."resell_clothes" to anon;
grant TRUNCATE on public."resell_clothes" to anon;
grant REFERENCES on public."resell_clothes" to anon;
grant TRIGGER on public."resell_clothes" to anon;
grant INSERT on public."resell_clothes" to authenticated;
grant SELECT on public."resell_clothes" to authenticated;
grant UPDATE on public."resell_clothes" to authenticated;
grant DELETE on public."resell_clothes" to authenticated;
grant TRUNCATE on public."resell_clothes" to authenticated;
grant REFERENCES on public."resell_clothes" to authenticated;
grant TRIGGER on public."resell_clothes" to authenticated;
grant INSERT on public."resell_clothes" to service_role;
grant SELECT on public."resell_clothes" to service_role;
grant UPDATE on public."resell_clothes" to service_role;
grant DELETE on public."resell_clothes" to service_role;
grant TRUNCATE on public."resell_clothes" to service_role;
grant REFERENCES on public."resell_clothes" to service_role;
grant TRIGGER on public."resell_clothes" to service_role;
