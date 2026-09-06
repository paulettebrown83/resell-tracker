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
  const owner = randomUUID()
  await admin.query('insert into auth.users values ($1)', [owner])
  await admin.query("insert into private.memberships(user_id,area) values ($1,'resale')", [owner])
  for (const client of [a,b]) {
    await client.query('set role authenticated')
    await client.query("select set_config('request.jwt.claim.sub',$1,false)", [owner])
  }
  const account=randomUUID(),snapshot=randomUUID(),listing=randomUUID(),observation=randomUUID(),item=randomUUID(),other=randomUUID()
  await admin.query("insert into public.resale_accounts(id,marketplace,account_alias) values($1,'vinted','synthetic')",[account])
  await admin.query("insert into public.resale_snapshots(id,account_id,source,source_ref,observed_at,scope,coverage) values($1,$2,'manual','synthetic',now(),'test','partial')",[snapshot,account])
  await admin.query("insert into public.inventory(id,item_name,item_cost) values($1,'Synthetic item',null),($2,'Distinct unit',null)",[item,other])
  await admin.query("insert into public.resale_listings(id,account_id) values($1,$2)",[listing,account])
  await admin.query("insert into public.resale_observations(id,listing_id,account_id,snapshot_id,observed_at,status) values($1,$2,$3,$4,'2026-09-06T00:00:00Z','active')",[observation,listing,account,snapshot])
  const input={listingId:listing,inventoryId:item,expectedObservationId:observation,expectedInventoryId:null,expectedMatchStatus:'unmatched',reason:'Synthetic explicit physical inspection'}
  const match=async(client,payload=input,request=randomUUID())=>(await client.query('select * from public.resale_confirm_listing_match($1,$2::jsonb)',[request,JSON.stringify(payload)])).rows[0]
  const bPid=(await b.query('select pg_backend_pid() as pid')).rows[0].pid
  async function waiting() {
    for(let n=0;n<100;n++) {
      if((await admin.query('select wait_event_type from pg_stat_activity where pid=$1',[bPid])).rows[0].wait_event_type==='Lock') return
      await new Promise(resolve=>setTimeout(resolve,20))
    }
    assert.fail('Second independent connection did not wait on a lock')
  }
  const request=randomUUID()
  await a.query('begin')
  const first=await match(a,input,request)
  let pending=match(b,input,request).then(value=>({value}),error=>({error}))
  await waiting();await a.query('commit')
  let outcome=await pending;assert.ifError(outcome.error);assert.deepEqual(outcome.value,first)
  assert.equal((await admin.query('select count(*)::int as n from public.resale_listing_match_history')).rows[0].n,1)
  console.log('PASS native match identical requests serialize into one immutable decision')
  const relink={...input,inventoryId:other,expectedInventoryId:item,expectedMatchStatus:'confirmed'}
  await a.query('begin');await match(a,relink)
  pending=match(b,relink).then(value=>({value}),error=>({error}))
  await waiting();await a.query('commit');outcome=await pending
  assert.equal(outcome.error?.code,'40001')
  console.log('PASS native competing corrections reject stale prior link after waiting')
  // Hold a changed observation under one transaction; waiting decision must inspect the committed version.
  await a.query('reset role');await a.query('begin')
  const newer=randomUUID()
  await a.query("insert into public.resale_observations(id,listing_id,account_id,snapshot_id,observed_at,status) values($1,$2,$3,$4,'2026-09-06T01:00:00Z','sold')",[newer,listing,account,snapshot])
  pending=match(b,{...input,expectedInventoryId:other,expectedMatchStatus:'confirmed'}).then(value=>({value}),error=>({error}))
  await waiting();await a.query('commit');outcome=await pending
  assert.equal(outcome.error?.code,'40001')
  console.log('PASS native observation arrival cannot be overwritten by a waiting stale decision')
  // Revocation already in progress locks membership. A waiting call must deny after delete commits.
  await a.query('begin');await a.query("delete from private.memberships where user_id=$1 and area='resale'",[owner])
  pending=match(b,{...input,expectedInventoryId:other,expectedMatchStatus:'confirmed',expectedObservationId:newer}).then(value=>({value}),error=>({error}))
  await waiting();await a.query('commit');outcome=await pending
  assert.equal(outcome.error?.code,'42501')
  assert.equal((await admin.query('select count(*)::int as n from public.resale_listing_match_history')).rows[0].n,2)
  assert.equal((await admin.query('select count(*)::int as n from public.sales')).rows[0].n,0)
  assert.equal((await admin.query('select count(*)::int as n from public.resale_actions')).rows[0].n,0)
  console.log('PASS native membership revocation wins before a waiting match; zero sales/actions')
} finally {
  await Promise.allSettled(clients.map(client=>client.end()))
  await postgres.stop()
  await rm(directory,{recursive:true,force:true})
}
