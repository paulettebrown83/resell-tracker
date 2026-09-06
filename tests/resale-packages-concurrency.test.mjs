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
  const owner=randomUUID(), account=randomUUID(), item=randomUUID(), photo=randomUUID(), listing=randomUUID(), packageId=randomUUID()
  await admin.query('insert into auth.users values($1)',[owner]);await admin.query("insert into private.memberships(user_id,area) values($1,'resale')",[owner])
  await admin.query("insert into public.resale_accounts(id,marketplace,account_alias,external_account_id) values($1,'poshmark','synthetic','5bb5431e42aa76fee623d5a6')",[account])
  await admin.query("insert into public.inventory(id,item_name,item_cost) values($1,'Synthetic package concurrency',0)",[item])
  await admin.query("insert into public.resale_media(id,inventory_id,kind,bucket,object_key,mime_type,byte_size,sha256,position,state) values($1::uuid,$2::uuid,'original','paulette-resale-originals-prod','resale/items/'||$2::text||'/'||$1::text||'/original','image/png',10,repeat('a',64),0,'ready')",[photo,item])
  for(const client of[a,b]){await client.query('set role authenticated');await client.query("select set_config('request.jwt.claim.sub',$1,false)",[owner])}
  await a.query('select * from public.resale_save_listing_draft($1,$2::jsonb)',[listing,JSON.stringify({account_id:account,inventory_id:item,expected_version:0,channel:'consumer',rules_version:'2026-09-06.1',fields:{title:'Synthetic',size:'L',media_ids:[photo]}})])
  const payload={listing_id:listing,account_id:account,inventory_id:item,expected_version:1,quantity:1,native_fields:{Department:'Women',Category:'Tops'}}
  await a.query('select * from public.resale_request_package($1,$2::jsonb)',[packageId,JSON.stringify(payload)])
  const bPid=(await b.query('select pg_backend_pid() pid')).rows[0].pid
  async function waiting(){for(let n=0;n<100;n++){if((await admin.query('select wait_event_type from pg_stat_activity where pid=$1',[bPid])).rows[0].wait_event_type==='Lock')return;await new Promise(r=>setTimeout(r,20))}assert.fail('Expected real lock wait')}
  await a.query('reset role');await a.query('begin');await a.query('select id from public.resale_listing_packages where id=$1 for update',[packageId])
  let pending=b.query('select * from public.resale_claim_package($1)',[packageId]).then(value=>({value}),error=>({error}))
  await waiting();await a.query('update public.resale_listings set draft_version=2 where id=$1',[listing]);await a.query('commit');let result=await pending;assert.equal(result.error?.code,'42501')
  await admin.query('update public.resale_listings set draft_version=1 where id=$1',[listing]);const lease=(await b.query('select * from public.resale_claim_package($1)',[packageId])).rows[0].lease_token
  await admin.query("insert into storage.objects(bucket_id,name,metadata) values('resale-listing-packages',$1,'{\"size\":20}')",[packageId+'/photo-0.jpg'])
  await a.query('begin');await a.query('select id from public.resale_listing_packages where id=$1 for update',[packageId])
  pending=b.query('select * from public.resale_checkpoint_package($1,$2,$3::jsonb)',[packageId,lease,JSON.stringify({name:packageId+'/photo-0.jpg',media_id:photo,sha256:'b'.repeat(64),byte_size:20,width:10,height:10})]).then(value=>({value}),error=>({error}))
  await waiting();await a.query("update public.resale_media set state='quarantined' where id=$1",[photo]);await a.query('commit');result=await pending;assert.equal(result.error?.code,'42501')
  assert.equal((await admin.query('select completed_images from public.resale_listing_packages where id=$1',[packageId])).rows[0].completed_images,0)
  const absent=randomUUID();await b.query('select public.resale_abandon_package_request($1)',[absent]);await assert.rejects(()=>b.query('select * from public.resale_request_package($1,$2::jsonb)',[absent,JSON.stringify(payload)]),e=>e.code==='22023')
  console.log('PASS native package locked-row draft/media races reject stale claim/checkpoint; canceled request cannot arrive late')
} finally {
  await Promise.allSettled(clients.map(client=>client.end()))
  await postgres.stop()
  await rm(directory,{recursive:true,force:true})
}
