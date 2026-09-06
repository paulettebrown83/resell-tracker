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
  const owner = randomUUID()
  await admin.query('insert into auth.users values ($1)', [owner])
  await admin.query("insert into private.memberships(user_id,area) values ($1,'resale')", [owner])
  for (const client of [a,b]) {
    await client.query('set role authenticated')
    await client.query("select set_config('request.jwt.claim.sub',$1,false)", [owner])
  }
  const payload = { item_name:'Synthetic concurrent sale', platform:'Vinted', sale_date:'2026-09-05', sale_price:25, platform_fee:2, item_cost:3, shipping_cost:4 }
  const save = async (client, input, request = randomUUID()) => (await client.query('select * from public.save_sale($1,$2::jsonb)', [request, JSON.stringify(input)])).rows[0]
  const item = async () => (await a.query("insert into public.inventory(item_name,item_cost) values ('Synthetic concurrent garment',3) returning id")).rows[0].id
  const bPid = (await b.query('select pg_backend_pid() as pid')).rows[0].pid
  async function waitForLock() {
    for (let i=0;i<100;i++) {
      const row=(await admin.query('select wait_event_type from pg_stat_activity where pid=$1',[bPid])).rows[0]
      if (row.wait_event_type === 'Lock') return
      await new Promise(resolve => setTimeout(resolve,20))
    }
    assert.fail('Second real connection never reached a lock wait')
  }
  async function contend(first, second, expectedCode) {
    await a.query('begin')
    const result = await first()
    const pending = second().then(value => ({value}), error => ({error}))
    await waitForLock()
    await a.query('commit')
    const outcome = await pending
    if (expectedCode) assert.equal(outcome.error?.code, expectedCode)
    else { assert.ifError(outcome.error); assert.equal(outcome.value.id, result.id) }
    return result
  }
  const firstItem=await item(), retry=randomUUID(), same={...payload, inventory_id:firstItem}
  const sale=await contend(()=>save(a,same,retry),()=>save(b,same,retry))
  assert.equal((await admin.query('select count(*)::int as n from public.sales')).rows[0].n,1)
  assert.equal((await admin.query('select count(*)::int as n from private.sale_requests')).rows[0].n,1)
  console.log('PASS native PostgreSQL: simultaneous identical request waits then returns one sale and one request')

  const contested=await item(), linked={...payload, inventory_id:contested}
  await contend(()=>save(a,linked),()=>save(b,linked),'22023')
  assert.equal((await admin.query('select count(*)::int as n from public.sales where inventory_id=$1',[contested])).rows[0].n,1)
  console.log('PASS native PostgreSQL: different simultaneous requests for one item cannot double-sell')

  const sourceA=await item(), sourceB=await item()
  const source={...payload, source_system:'synthetic:concurrency',source_record_id:'order-1'}
  await contend(()=>save(a,{...source,inventory_id:sourceA}),()=>save(b,{...source,inventory_id:sourceB}),'23505')
  assert.equal((await admin.query('select status from public.inventory where id=$1',[sourceB])).rows[0].status,'unlisted')
  assert.equal((await admin.query('select count(*)::int as n from public.sales where inventory_id=$1',[sourceB])).rows[0].n,0)
  console.log('PASS native PostgreSQL: duplicate source loser rolls back its item and sale')

  const correction={...payload,id:sale.id,version:1,reason:'Synthetic concurrent correction',shipping_cost:5}
  await contend(()=>save(a,correction),()=>save(b,{...correction,shipping_cost:6}),'40001')
  assert.equal((await admin.query('select version from public.sales where id=$1',[sale.id])).rows[0].version,2)
  assert.equal((await admin.query('select count(*)::int as n from public.sale_history where sale_id=$1',[sale.id])).rows[0].n,2)
  console.log('PASS native PostgreSQL: competing corrections reject the stale version and retain one audit entry per change')
} finally {
  await Promise.allSettled(clients.map(client => client.end()))
  await postgres.stop()
  await rm(directory, {recursive:true,force:true})
}
