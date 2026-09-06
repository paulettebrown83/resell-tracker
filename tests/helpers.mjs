import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { vector } from '@electric-sql/pglite-pgvector'
import { readFile, readdir } from 'node:fs/promises'
export async function baseline() {
  const db = new PGlite({ extensions: { vector, pgcrypto } })
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema extensions;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select current_user::text $$;
    grant usage on schema auth,public to anon,authenticated,service_role;
    grant execute on all functions in schema auth to anon,authenticated,service_role;`)
  await db.exec(await readFile(new URL('./storage-fixture.sql',import.meta.url),'utf8'))
  await db.exec(await readFile(new URL('./baseline.sql',import.meta.url),'utf8'))
  return db
}
export async function migrate(db) {
  const dir=new URL('../supabase/migrations/',import.meta.url)
  for(const name of (await readdir(dir)).filter(n=>n.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(name,dir),'utf8'))
}
