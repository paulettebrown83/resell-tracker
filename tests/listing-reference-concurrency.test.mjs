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
  await admin.query(await readFile(new URL('./storage-fixture.sql', import.meta.url), 'utf8'))
  const migrations = new URL('../supabase/migrations/', import.meta.url)
  for (const name of (await readdir(migrations)).filter(n => n.endsWith('.sql')).sort())
    await admin.query(await readFile(new URL(name, migrations), 'utf8'))
  const owner=randomUUID(),account=randomUUID(),listing=randomUUID(),request=randomUUID();
  await admin.query('insert into auth.users values($1)',[owner]);
  await admin.query("insert into private.memberships(user_id,area) values($1,'resale')",[owner]);
  await admin.query("insert into public.resale_accounts(id,marketplace,account_alias,external_account_id,username) values($1,'poshmark','synthetic','seller1','synthetic_seller')",[account]);
  await admin.query("insert into public.resale_listings(id,account_id,external_listing_id) values($1,$2,'p1')",[listing,account]);
  const payload={account_id:account,action:'update',listing_id:listing,inventory_id:null,expected_observation_id:null,expected_item_version:null,trigger:{kind:'member_request',id:request},requested:{scope:'poshmark_private_listing_reference',external_listing_id:'p1'}};
  for(const c of [a,b])await c.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
  const create=c=>c.query('select public.resale_request_listing_reference($1,$2) id',[request,payload]);
  const waitForLock=async()=>{for(let i=0;i<60;i++){const r=await admin.query("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'");if(r.rows[0].n)return;await new Promise(r=>setTimeout(r,25));}throw Error('Expected blocked transaction');};
  await a.query('begin');const op=(await create(a)).rows[0].id;const retry=create(b);await waitForLock();await a.query('commit');assert.equal((await retry).rows[0].id,op);
  await a.query('begin');await a.query('select public.resale_claim_listing_reference($1,false)',[op]);const second=b.query('select public.resale_claim_listing_reference($1,false)',[op]).then(()=>null,e=>e.code);await waitForLock();await a.query('commit');assert.equal(await second,'55000');
  await a.query('begin');await a.query("delete from private.memberships where user_id=$1 and area='resale'",[owner]);const denied=create(b).then(()=>null,e=>e.code);await waitForLock();await a.query('commit');assert.equal(await denied,'42501');
  console.log('PASS native exact request serialization, exclusive claim and current membership revocation; isolated server cleaned');
} finally {
  await Promise.allSettled(clients.map(client=>client.end()));
  await postgres.stop();
  await rm(directory,{recursive:true,force:true});
}
