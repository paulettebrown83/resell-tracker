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
  const account=randomUUID()
  await admin.query("insert into public.resale_accounts(id,marketplace,account_alias) values($1,'mercari','synthetic')",[account])
  const request=async(client,id,payload)=>(await client.query('select public.resale_request_operation($1,$2::jsonb) id',[id,JSON.stringify(payload)])).rows[0].id
  const bPid=(await b.query('select pg_backend_pid() pid')).rows[0].pid
  async function waiting() {
    for(let n=0;n<100;n++) {
      if((await admin.query('select wait_event_type from pg_stat_activity where pid=$1',[bPid])).rows[0].wait_event_type==='Lock') return
      await new Promise(resolve=>setTimeout(resolve,20))
    }
    assert.fail('Second independent connection did not wait on a lock')
  }
  const id=randomUUID(),input={account_id:account,action:'import',trigger:{kind:'member_request',id},requested:{}}
  await a.query('begin');const operation=await request(a,id,input)
  let pending=request(b,id,input).then(value=>({value}),error=>({error}))
  await waiting();await a.query('commit');let result=await pending
  assert.ifError(result.error);assert.equal(result.value,operation)
  assert.equal((await admin.query('select count(*)::int n from public.resale_actions')).rows[0].n,1)
  console.log('PASS native identical operation requests serialize to one durable action')
  await admin.query("insert into private.resale_operation_adapters(account_id,action,adapter_key,adapter_version,execution_mode,ready,reason) values($1,'import','synthetic','1','file_automatic',true,'Local test')",[account])
  await a.query('reset role');await b.query('reset role')
  await a.query('set role service_role');await b.query('set role service_role')
  await a.query('begin')
  const claim=(await a.query('select * from private.resale_claim_evidence_operation($1)',[operation])).rows[0]
  pending=b.query('select * from private.resale_claim_evidence_operation($1)',[operation]).then(value=>({value}),error=>({error}))
  await waiting();await a.query('commit');result=await pending
  assert.equal(result.error?.code,'22023');assert.equal(claim.attempts,1)
  assert.equal((await admin.query('select count(*)::int n from public.resale_action_attempts')).rows[0].n,1)
  console.log('PASS native competing dispatchers issue exactly one lease and attempt')
  await a.query('reset role');await a.query('begin')
  await a.query("delete from private.memberships where user_id=$1 and area='resale'",[owner])
  await b.query('reset role');await b.query('set role authenticated')
  const next=randomUUID()
  pending=request(b,next,{...input,trigger:{kind:'member_request',id:next}}).then(value=>({value}),error=>({error}))
  await waiting();await a.query('commit');result=await pending
  assert.equal(result.error?.code,'42501')
  assert.equal((await admin.query('select count(*)::int n from public.resale_actions')).rows[0].n,1)
  assert.equal((await admin.query('select count(*)::int n from public.sales')).rows[0].n,0)
  console.log('PASS native membership revocation wins before waiting request; zero sales')
} finally {
  await Promise.allSettled(clients.map(client=>client.end()))
  await postgres.stop()
  await rm(directory,{recursive:true,force:true})
}
