import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import EmbeddedPostgres from 'embedded-postgres'

// A disposable native PostgreSQL 17 server, with genuinely independent connections.
// JWT claims are synthetic. Hosted OAuth/REST are separately verified during cutover.
const portProbe = createServer()
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve))
const port = portProbe.address().port
await new Promise(resolve => portProbe.close(resolve))
const directory = await mkdtemp(join(tmpdir(), 'foundation-pg-test-'))
const postgres = new EmbeddedPostgres({ databaseDir: join(directory, 'db'), port,
  password: randomUUID(), persistent: false, authMethod: 'scram-sha-256',
  postgresFlags: ['-h', '127.0.0.1', '-k', directory], onLog() {}, onError() {} })
const clients = []
async function connect() {
  const client = postgres.getPgClient('postgres', '127.0.0.1')
  await client.connect(); clients.push(client)
  await client.query("set statement_timeout='15s'")
  return client
}
try {
  await postgres.initialise(); await postgres.start()
  const admin = await connect(), a = await connect(), b = await connect()
  await admin.query(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema extensions; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select current_user::text $$;
    grant usage on schema auth,public to anon,authenticated,service_role;
    grant execute on all functions in schema auth to anon,authenticated,service_role;`)
  // Native bundle has no pgvector. Only this unrelated thoughts fixture is adapted;
  // both production migrations and every resale object run unchanged. The PGlite
  // backup/restore suite separately uses the real vector extension and original fixture.
  let fixture = await readFile(new URL('./baseline.sql', import.meta.url), 'utf8')
  fixture = fixture.replace('create extension if not exists vector;', 'create domain vector as real[];')
    .replaceAll('vector(1536)', 'vector')
    .replace(/^CREATE INDEX thoughts_embedding_idx[^\n]+\n/m, '')
  await admin.query(fixture)
  const migrations = new URL('../supabase/migrations/', import.meta.url)
  for (const name of (await readdir(migrations)).filter(n => n.endsWith('.sql')).sort())
    await admin.query(await readFile(new URL(name, migrations), 'utf8'))
  const owner=randomUUID(),account=randomUUID(),listing=randomUUID(),snapshot=randomUUID(),source=randomUUID(),request=randomUUID();
  await admin.query('insert into auth.users values($1)',[owner]);
  await admin.query("insert into private.memberships(user_id,area) values($1,'resale')",[owner]);
  await admin.query("insert into public.resale_accounts(id,marketplace,account_alias,external_account_id) values($1,'mercari','synthetic','seller1')",[account]);
  await admin.query("insert into public.resale_listings(id,account_id,external_listing_id) values($1,$2,'m1')",[listing,account]);
  await admin.query("insert into public.resale_snapshots(id,account_id,source,source_ref,observed_at,scope,coverage) values($1,$2,'browser','synthetic',now(),'one listing','partial')",[snapshot,account]);
  await admin.query(`insert into public.resale_source_records(id,snapshot_id,account_id,record_key,source_kind,raw_business,normalized,external_identifiers,source_observed_at,captured_at,record_status) values($1,$2,$3,'one','browser','{}','{"pricing":{"currency":"USD","asking_minor":2000,"mechanism":"mercari_smart_pricing","enabled":true,"minimum_minor":1700}}','{"listing_id":"m1","account_id":"seller1"}',now(),now(),'accepted')`,[source,snapshot,account]);
  const record=(client)=>client.query('select public.resale_record_pricing_observation($1,$2,$3,$4)',[owner,request,listing,source]);
  const waitForLock=async()=>{for(let i=0;i<60;i++){const r=await admin.query("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'");if(r.rows[0].n)return;await new Promise(r=>setTimeout(r,25));}throw Error('Expected blocked transaction');};
  await a.query('begin');await record(a);const pending=record(b);await waitForLock();await a.query('commit');await pending;
  assert.equal((await admin.query('select count(*)::int n from public.resale_pricing_observations')).rows[0].n,1);
  await a.query('begin');await a.query("delete from private.memberships where user_id=$1 and area='resale'",[owner]);const denied=record(b).then(()=>null,e=>e.code);await waitForLock();await a.query('commit');assert.equal(await denied,'42501');
  console.log('PASS native exact retry serialization and current membership revocation; isolated server cleaned');
} finally {
  await Promise.allSettled(clients.map(client=>client.end()));
  await postgres.stop();
  await rm(directory,{recursive:true,force:true});
}
