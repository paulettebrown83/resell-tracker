-- Administrator only, AFTER the coordinated migration and successful Auth account verification.
-- Replace placeholders with the approved Auth UUID/email/area. Never create Auth users in SQL.
-- Do not execute this template unchanged.
do $$
declare
  approved_id uuid := 'REPLACE_WITH_APPROVED_AUTH_UUID'::uuid;
  approved_email text := 'REPLACE_WITH_APPROVED_EMAIL';
begin
  if not exists (
    select 1 from auth.users u join auth.identities i on i.user_id=u.id
    where u.id=approved_id and lower(u.email)=lower(approved_email)
      and u.email_confirmed_at is not null and i.provider='google'
      and lower(i.identity_data->>'email')=lower(approved_email)
      and i.identity_data->>'email_verified'='true'
  ) then raise exception 'Approved verified Google identity was not found'; end if;
  insert into private.memberships(user_id,area) values (approved_id,'resale')
  on conflict (user_id,area) do nothing;
end $$;
-- Genealogy requires its own explicit ('uuid', 'genealogy') grant.
