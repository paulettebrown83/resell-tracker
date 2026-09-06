begin;
alter table public.book_of_snippets add column archived_at timestamptz;
create function public.genealogy_access() returns boolean
language sql stable security invoker set search_path = '' as $$
  select private.has_access('genealogy');
$$;
revoke all on function public.genealogy_access() from public, anon;
grant execute on function public.genealogy_access() to authenticated;
commit;
