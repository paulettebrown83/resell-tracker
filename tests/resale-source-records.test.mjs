import { baseline, migrate } from './helpers.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
const db=await baseline()
try {
 await migrate(db)
 const owner=randomUUID(), stranger=randomUUID(), genealogy=randomUUID(), account=randomUUID(), otherAccount=randomUUID(), snapshot=randomUUID()
 await db.query('insert into auth.users values($1),($2),($3)',[owner,stranger,genealogy])
 await db.query("insert into private.memberships(user_id,area) values($1,'resale'),($2,'genealogy')",[owner,genealogy])
 await db.query("insert into public.resale_accounts(id,marketplace,account_alias) values($1,'mercari','main'),($2,'mercari','other')",[account,otherAccount])
 await db.query("insert into public.resale_snapshots(id,account_id,source,source_ref,observed_at,scope,coverage) values($1,$2,'export','synthetic.csv','2026-09-06T03:00:00Z','provided report','complete')",[snapshot,account])
 const role=async(name,id='')=>{await db.exec(`reset role;set role ${name}`);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id])}
 const deny=(fn,code='42501')=>assert.rejects(fn,e=>e.code===code)
 const base={id:randomUUID(),snapshot_id:snapshot,account_id:account,record_key:'file-hash:row:2',row_index:2,source_kind:'csv',source_file_sha256:'a'.repeat(64),source_row_sha256:'b'.repeat(64),raw_business:{status:'Completed',completed_date:'03/18/2025',item_id:'m123'},normalized:{status:'completed',order_id:null,line_id:null,fees_cents:{selling:100,processing:35}},external_identifiers:{item_id:'m123'},event_precision:'date',event_date:'2025-03-18',event_time:null,event_timezone:null,source_observed_at:'2026-09-06T03:00:00Z',captured_at:'2026-09-06T03:05:00Z',record_status:'accepted'}
 const insert=(row)=>db.query('insert into public.resale_source_records select (jsonb_populate_record(null::public.resale_source_records,$1::jsonb)).*',[JSON.stringify({normalized:{},external_identifiers:{},event_precision:'unknown',created_at:'2026-09-06T03:05:00Z',...row})])
 await role('service_role');await insert(base)
 const row=(await db.query('select * from public.resale_source_records')).rows[0]
 assert.equal(row.event_time,null);assert.equal(row.event_timezone,null)
 assert.equal(row.normalized.order_id,null);assert.equal(row.normalized.line_id,null)
 assert.equal(row.external_identifiers.item_id,'m123')
 assert.equal(row.normalized.fees_cents.processing,35)
 await deny(()=>insert({...base,id:randomUUID(),normalized:{status:'cancelled'}}),'23505')
 await deny(()=>insert({...base,id:randomUUID(),record_key:'different-account',account_id:otherAccount}),'23503')
 await deny(()=>insert({...base,id:randomUUID(),record_key:'invented-midnight',event_time:'2025-03-18T00:00:00Z'}),'23514')
 await deny(()=>insert({...base,id:randomUUID(),record_key:'fake-instant',event_precision:'instant',event_time:null}),'23514')
 await deny(()=>insert({...base,id:randomUUID(),record_key:'quarantine-no-reason',record_status:'quarantined'}),'23514')
 await insert({...base,id:randomUUID(),record_key:'file-hash:row:20',row_index:20,record_status:'quarantined',review_reason:'Incorrect column count; do not guess missing values',raw_business:{raw_values:['broken','row']},normalized:{},external_identifiers:{},event_precision:'unknown',event_date:null,event_time:null})
 assert.equal((await db.query('select count(*) from public.resale_order_lines')).rows[0].count,0)
 assert.equal((await db.query('select count(*) from public.resale_order_events')).rows[0].count,0)
 assert.equal((await db.query('select count(*) from public.sales')).rows[0].count,0)
 assert.equal((await db.query('select count(*) from public.resale_listings')).rows[0].count,0)
 await deny(()=>db.query("update public.resale_source_records set raw_business='{}'"))
 await deny(()=>db.query('delete from public.resale_source_records'))
 await role('postgres');await deny(()=>db.query("update public.resale_source_records set raw_business='{}'"),'55000')
 await deny(()=>db.query('delete from public.resale_source_records'),'55000')
 await role('service_role')
 await insert({...base,id:randomUUID(),record_key:'corrected-evidence:row:2',supersedes_record_id:base.id,normalized:{...base.normalized,clarification:'Correction retained as new evidence'}})
 console.log('PASS append-only dedupe, account binding, explicit unknown IDs/date precision, quarantine and correction evidence without canonical mutations')
 await role('anon');await deny(()=>db.query('select * from public.resale_source_records'));await deny(()=>insert({...base,id:randomUUID(),record_key:'blocked'}))
 for(const id of [stranger,genealogy]) {
 await role('authenticated',id)
 assert.equal((await db.query('select * from public.resale_source_records')).rows.length,0)
 await deny(()=>insert({...base,id:randomUUID(),record_key:'blocked'}))
 }
 await role('authenticated',owner)
 assert.equal((await db.query('select * from public.resale_source_records')).rows.length,3)
 await deny(()=>insert({...base,id:randomUUID(),record_key:'blocked'}))
 await deny(()=>db.query('delete from public.resale_source_records'))
 await role('postgres');await db.query("delete from private.memberships where user_id=$1 and area='resale'",[owner])
 await role('authenticated',owner);assert.equal((await db.query('select * from public.resale_source_records')).rows.length,0)
 console.log('PASS source-record signed-out denial, unrelated/genealogy isolation, approved read-only access and immediate revocation')
} finally {await db.close()}
