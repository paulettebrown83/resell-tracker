import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import EmbeddedPostgres from 'embedded-postgres'
import {fixture as gmailFixture,hash,rpc} from './gmail-fixture.mjs'

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
  const {owner}=await gmailFixture(admin),account=randomUUID();
  await admin.query("insert into public.resale_accounts(id,marketplace,account_alias,username) values($1,'ebay','synthetic','paulbr-89')",[account]);
  await admin.query("insert into private.resale_ebay_config(client_id,runame,trading_version,callback,deletion_endpoint,activation_ready,deletion_receipts_ready,deletion_coverage_review) values('synthetic','synthetic-runame','1423','https://resell-tracker-beta.vercel.app/api/integrations/ebay/callback','https://resell-tracker-beta.vercel.app/api/integrations/ebay/deletion',true,true,'synthetic-only')");
  await admin.query("insert into vault.secrets(name,secret) values('resale_ebay_production_oauth_client_secret','synthetic')");
  await a.query('set role authenticated');await a.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);await rpc(a,'resale_ebay_enroll',[account]);
  for(const client of [a,b])await client.query('set role service_role');
  await rpc(a,'resale_ebay_oauth_start',[owner,account,hash('state'),hash('browser')]);const cfg=await rpc(a,'resale_ebay_oauth_consume',[hash('state'),hash('browser')]);await rpc(a,'resale_ebay_oauth_complete',[cfg.state_id,'paulbr-89',hash('seller'),'synthetic-token',86400]);
  const from=new Date(Date.now()-86400000).toISOString(),to=new Date(Date.now()-180000).toISOString();
  const result={records:[{order_id:'synthetic-order',status:'Completed',paid_at:null,lines:[]}],page:1,total_pages:1,total_entries:1,has_more:false,coverage:'created_in_fixed_window',source_sha256:hash('xml'),deletion_subjects:[{eias_sha256:hash('buyer')}]};
  const first=randomUUID(),one=await rpc(a,'resale_ebay_claim_read',[owner,account,first,'orders',1,from,to]);
  // Neither a mutable username nor an untyped immutable BuyerUserID may substitute for EIAS.
  for(const subject of [{eias_sha256:null,handle_sha256:hash('old-username')},{eias_sha256:null,user_sha256:hash('immutable-buyer-id')}]){await assert.rejects(()=>rpc(a,'resale_ebay_finish_read',[owner,first,one.lease,{...result,deletion_subjects:[subject]},null]),error=>error.code==='22023');}
  const saved=await rpc(a,'resale_ebay_finish_read',[owner,first,one.lease,result,null]);assert.equal(saved.result.deletion_subjects,undefined);assert.equal((await admin.query('select count(*)::int n from private.resale_ebay_read_subjects')).rows[0].n,1);
  const notice={event_id:'synthetic-buyer-delete',event_at:new Date().toISOString(),subject_eias_sha256:hash('buyer'),subject_user_sha256:hash('buyer-user'),subject_handle_sha256:hash('buyer-handle')};
  await rpc(a,'resale_ebay_deletion_receive',[notice]);assert.equal((await admin.query('select count(*)::int n from public.resale_ebay_reads')).rows[0].n,0);assert.equal((await admin.query('select status from public.resale_ebay_connections')).rows[0].status,'connected');
  const second=randomUUID(),two=await rpc(a,'resale_ebay_claim_read',[owner,account,second,'orders',1,from,to]);
  const nextResult={...result,deletion_subjects:[{eias_sha256:hash('buyer-two')}]};
  const nextNotice={...notice,event_id:'synthetic-buyer-two-delete',subject_eias_sha256:hash('buyer-two')};
  await a.query('begin');await rpc(a,'resale_ebay_deletion_receive',[nextNotice]);
  const bPid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
  const pending=rpc(b,'resale_ebay_finish_read',[owner,second,two.lease,nextResult,null]).then(value=>({value}),error=>({error}));
  let waited=false;for(let n=0;n<100;n++){if((await admin.query('select wait_event_type from pg_stat_activity where pid=$1',[bPid])).rows[0].wait_event_type==='Lock'){waited=true;break}await new Promise(resolve=>setTimeout(resolve,20))}assert(waited);
  await a.query('commit');const rejected=await pending;assert.equal(rejected.error?.code,'42501');assert.equal((await admin.query('select result from public.resale_ebay_reads where id=$1',[second])).rows[0].result,null);
  console.log('PASS native eBay private buyer binding, exact buyer purge, seller preservation and concurrent deletion blocks stale read finalization');
} finally {
  await Promise.allSettled(clients.map(client=>client.end()))
  await postgres.stop()
  await rm(directory,{recursive:true,force:true})
}
