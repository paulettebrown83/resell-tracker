import assert from 'node:assert/strict'
import {readFile}from'node:fs/promises'
import {baseline,migrate}from'./helpers.mjs'
import {fixture}from'./gmail-fixture.mjs'
const db=await baseline()
try{
 await migrate(db);await fixture(db)
 // Hosted-only import receipt table is outside repository migrations. Synthetic shape
 // suffices here: the acceptance script only fingerprints it and never changes it.
 await db.exec('create table if not exists private.resale_import_runs(id uuid primary key,payload jsonb)')
 await db.query("insert into auth.users values('13262711-f77a-45e5-9d98-9649be243a22')")
 await db.query("insert into private.memberships(user_id,area) values('13262711-f77a-45e5-9d98-9649be243a22','resale')")
 const sql=async n=>readFile(new URL('../docs/acceptance/'+n,import.meta.url),'utf8')
 await db.exec(await sql('gmail-provision.sql'))
 const keysBefore=(await db.query('select id,name,secret from vault.secrets order by name')).rows
 await db.exec(await sql('gmail-provision.sql'))
 assert.deepEqual((await db.query('select id,name,secret from vault.secrets order by name')).rows,keysBefore)
 const fingerprintSql=await sql('gmail-preexisting-fingerprints.sql')
 const fingerprint=async()=>{const commands=await db.exec(fingerprintSql);return commands.find(x=>x.rows.length===29).rows}
 const before=await fingerprint();assert.equal(before.length,29)
 const results=await db.exec(await sql('gmail-hosted-rollback.sql'))
 assert.equal(results.find(x=>x.rows.length===5).rows.length,5)
 assert.deepEqual(await fingerprint(),before)
 assert.deepEqual((await db.query('select id,name,secret from vault.secrets order by name')).rows,keysBefore)
 assert.equal((await db.query('select count(*) n from public.resale_gmail_feeds')).rows[0].n,0)
 console.log('PASS hosted acceptance script rolls back all synthetic rows and Vault token; exact29 fingerprints and existing keys unchanged')
}catch(e){console.error({message:e.message,code:e.code,where:e.where,stack:e.code?undefined:e.stack});process.exitCode=1}finally{await db.close()}
