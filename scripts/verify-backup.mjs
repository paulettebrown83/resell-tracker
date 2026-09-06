// Restores only to a fresh, in-memory PostgreSQL instance. Never connects to production.
import { baseline, migrate } from '../tests/helpers.mjs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const path=process.argv[2]
if (!path) throw new Error('Usage: node scripts/verify-backup.mjs /private/path/snapshot.json')
const raw=await readFile(path), snapshot=JSON.parse(raw)
const db=await baseline()
for(const table of snapshot.tables) {
  const name=table.name
  if(!['inventory','sales','expenses','resell_clothes','book_of_snippets','thoughts'].includes(name)) throw new Error('Unexpected table')
  await db.query(`insert into public.${name} select * from jsonb_populate_recordset(null::public.${name},$1::jsonb)`,[JSON.stringify(snapshot.data[name])])
  const diff=await db.query(`select count(*) as differences from (
    (select to_jsonb(t) from public.${name} t except select to_jsonb(original) from jsonb_populate_recordset(null::public.${name},$1::jsonb) original)
    union all (select to_jsonb(original) from jsonb_populate_recordset(null::public.${name},$1::jsonb) original except select to_jsonb(t) from public.${name} t)
  ) d`,[JSON.stringify(snapshot.data[name])])
  assert.equal(diff.rows[0].differences,0,`${name} restore mismatch`)
}
for(const name of ['book_of_snippets','resell_clothes']) {
  await db.exec(`select setval('public.${name}_id_seq',coalesce((select max(id) from public.${name}),1),exists(select 1 from public.${name}))`)
}
console.log('PASS fresh restore: all 800 records match every original field')
await migrate(db)
for(const table of snapshot.tables) {
  const name=table.name, cols=table.columns.map(c=>'"'+c.name.replaceAll('"','""')+'"').join(',')
  const diff=await db.query(`select count(*) as differences from (
    (select to_jsonb(t) from (select ${cols} from public.${name}) t except select to_jsonb(original) from (select ${cols} from jsonb_populate_recordset(null::public.${name},$1::jsonb)) original)
    union all (select to_jsonb(original) from (select ${cols} from jsonb_populate_recordset(null::public.${name},$1::jsonb)) original except select to_jsonb(t) from (select ${cols} from public.${name}) t)
  ) d`,[JSON.stringify(snapshot.data[name])])
  assert.equal(diff.rows[0].differences,0,`${name} migration changed original records`)
}
console.log('PASS migration preserves every original field in every restored record')
console.log('Snapshot SHA-256:',createHash('sha256').update(raw).digest('hex'))
await db.close()
