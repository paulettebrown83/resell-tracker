-- Administrator only, AFTER the coordinated migration and successful Auth account verification.
-- Replace placeholders with the approved Auth UUID and area. Never use auth.users inserts or store passwords here.
-- Do not execute this template unchanged.
insert into private.memberships(user_id, area)
values ('REPLACE_WITH_APPROVED_AUTH_UUID'::uuid, 'resale')
on conflict (user_id, area) do nothing;
-- Genealogy requires its own explicit ('uuid', 'genealogy') grant.
