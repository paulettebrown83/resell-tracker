import assert from 'node:assert/strict'
import { fixture,uid,receipt,rpc,enroll,oauth,complete,claim,ingest } from './gmail-fixture.mjs'
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
  let baselineSql = await readFile(new URL('./baseline.sql', import.meta.url), 'utf8')
  baselineSql = baselineSql.replace('create extension if not exists vector;', 'create domain vector as real[];')
    .replaceAll('vector(1536)', 'vector')
    .replace(/^CREATE INDEX thoughts_embedding_idx[^\n]+\n/m, '')
  await admin.query(baselineSql)
  await admin.query(await readFile(new URL('./storage-fixture.sql', import.meta.url), 'utf8'))
  const migrations = new URL('../supabase/migrations/', import.meta.url)
  for (const name of (await readdir(migrations)).filter(n => n.endsWith('.sql')).sort())
    await admin.query(await readFile(new URL(name, migrations), 'utf8'))
  const {owner,account}=await fixture(admin)
  for(const client of [a,b]){await client.query('set role authenticated');await client.query("select set_config('request.jwt.claim.sub',$1,false)",[owner])}
  const bPid=(await b.query('select pg_backend_pid() pid')).rows[0].pid
  async function waiting(){for(let n=0;n<100;n++){if((await admin.query('select wait_event_type from pg_stat_activity where pid=$1',[bPid])).rows[0].wait_event_type==='Lock')return;await new Promise(r=>setTimeout(r,20))}assert.fail('Expected independent connection lock wait')}
  const requestId=uid();await a.query('begin');const feed=await enroll(a,account,requestId)
  let pending=enroll(b,account,requestId).then(value=>({value}),error=>({error}));await waiting();await a.query('commit');let result=await pending
  assert.ifError(result.error);assert.equal(result.value,feed)
  for(const client of [a,b])await client.query('reset role;set role service_role')
  await admin.query("update private.resale_gmail_config set publishing_status='production'")
  const state=await oauth(a,owner,feed,{consume:false});await a.query('begin');await rpc(a,'resale_gmail_oauth_consume',[state.state,state.binding])
  pending=rpc(b,'resale_gmail_oauth_consume',[state.state,state.binding]).then(value=>({value}),error=>({error}));await waiting();await a.query('commit');result=await pending
  assert.equal(result.error?.code,'22023')
  await complete(a,state)
  console.log('PASS native concurrent enrollment dedupes and OAuth state consumes once')
  await a.query('begin');const first=await claim(a)
  pending=claim(b).then(value=>({value}),error=>({error}));await waiting();await a.query('commit');result=await pending;assert.ifError(result.error);assert.equal(result.value.result,null)
  const lease=first.result.lease_token,cursor={window_start_ms:Date.now()-86400000,window_end_ms:Date.now()-60000,page_token:null,window_complete:false,pending_message_ids:['abc123','def456'],next_page_token:'next'}
  await rpc(a,'resale_gmail_checkpoint_run',[feed,lease,cursor])
  const value=receipt(feed,lease,account,{message_id:'abc123'});await a.query('begin');const imported=await ingest(a,value)
  pending=ingest(b,{...value,nonce:uid()}).then(value=>({value}),error=>({error}));await waiting();await a.query('commit');result=await pending
  assert.ifError(result.error);assert.equal(result.value.source_record_id,imported.source_record_id);assert.equal(result.value.duplicate,true)
  assert.equal((await admin.query('select count(*)::int n from public.resale_actions')).rows[0].n,1)
  assert.equal((await admin.query('select count(*)::int n from public.resale_source_records')).rows[0].n,1)
  console.log('PASS native competing ticks issue one lease; simultaneous message deliveries append one source and task')
  await a.query('reset role;begin');await a.query("delete from private.memberships where user_id=$1 and area='resale'",[owner])
  pending=ingest(b,receipt(feed,lease,account,{message_id:'def456'})).then(value=>({value}),error=>({error}));await waiting();await a.query('commit');result=await pending
  assert.equal(result.error?.code,'42501');assert.equal((await admin.query('select count(*)::int n from public.resale_source_records')).rows[0].n,1)
  assert.equal((await admin.query('select count(*)::int n from public.sales')).rows[0].n,0)
  console.log('PASS native committed membership revocation blocks waiting ingress; no canonical sales')
} catch(e){console.error({message:e.message,code:e.code,where:e.where,stack:e.code?undefined:e.stack});process.exitCode=1} finally {
  await Promise.allSettled(clients.map(client=>client.end()))
  await postgres.stop()
  await rm(directory,{recursive:true,force:true})
}
