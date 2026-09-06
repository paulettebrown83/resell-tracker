import { baseline, migrate } from './helpers.mjs'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHmac } from 'node:crypto'
const db=await baseline()
try {
 await migrate(db)
 const owner=randomUUID(), stranger=randomUUID(), genealogy=randomUUID(), key=randomBytes(32).toString('hex')
 await db.query('insert into auth.users values ($1),($2),($3)',[owner,stranger,genealogy])
 await db.query("insert into private.memberships(user_id,area) values ($1,'resale'),($2,'genealogy')",[owner,genealogy])
 // Real pgcrypto, with a synthetic Vault relation. No live secrets or production are contacted.
 await db.exec('create schema vault; create table vault.decrypted_secrets(name text unique,decrypted_secret text); revoke all on schema vault from public;')
 await db.query('insert into vault.decrypted_secrets values ($1,$2)',['resale_media_production_receipt_signing_key',key])
 const role=async(name,id='')=>{await db.exec(`reset role; set role ${name}`);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id])}
 const deny=(fn,code='42501')=>assert.rejects(fn,e=>e.code===code)
 const save=(payload,request=randomUUID())=>db.query('select public.resale_save_item($1,$2::jsonb) as id',[request,JSON.stringify(payload)])
 const tables=['resale_item_details','resale_accounts','resale_listings','resale_snapshots','resale_observations','resale_order_lines','resale_order_events','resale_media','resale_review_cases','resale_actions','resale_action_attempts']
 await role('anon')
 for(const table of tables) await deny(()=>db.query(`select * from public.${table}`))
 await deny(()=>save({item_name:'No',item_cost:null}))
 for(const id of [stranger,genealogy]) {
 await role('authenticated',id)
 for(const table of tables) assert.equal((await db.query(`select * from public.${table}`)).rows.length,0)
 await deny(()=>save({item_name:'No',item_cost:null}))
 }
 await role('authenticated',owner)
 const input={item_name:'Unpriced coat',item_cost:null,brand:'Example',measurements:{chest:{value:50,unit:'cm'}}}, request=randomUUID()
 const item=(await save(input,request)).rows[0].id
 assert.equal((await save(input,request)).rows[0].id,item)
 await deny(()=>save({...input,item_cost:0},request),'22023')
 assert.equal((await db.query('select item_cost from public.inventory where id=$1',[item])).rows[0].item_cost,null)
 const details=()=>db.query('select * from public.resale_item_details where inventory_id=$1',[item])
 assert.equal((await details()).rows[0].version,1)
 await save({id:item,version:1,item_name:'Renamed coat',item_cost:3,location:'Bag A'})
 assert.equal((await details()).rows[0].brand,'Example')
 assert.deepEqual((await details()).rows[0].measurements,{chest:{value:50,unit:'cm'}})
 await deny(()=>save({id:item,version:1,item_name:'Stale',item_cost:3}),'40001')
 for(const value of [-1,1.001,'NaN','Infinity']) await deny(()=>save({item_name:'Bad',item_cost:value}),'22023')
 for(const table of tables) await deny(()=>db.query(`delete from public.${table}`))
 await deny(()=>db.query('select * from private.resale_account_credentials'))
 await deny(()=>db.query('select private.resale_claim_delist()'))
 console.log('PASS item unknown cost, atomic retry/version checks, partial detail retention, resale/genealogy/anon boundaries')

 const reserve=(id=randomUUID(),type='image/jpeg',size=123)=>db.query('select * from public.resale_reserve_media($1,$2,$3,$4)',[id,item,type,size])
 const media=(await reserve()).rows[0]
 assert.equal(media.bucket,'paulette-resale-originals-prod')
 assert.equal((await reserve(media.id)).rows[0].id,media.id)
 await deny(()=>reserve(media.id,'image/png'),'22023')
 await deny(()=>reserve(randomUUID(),'image/svg+xml'),'22023')
 await deny(()=>reserve(randomUUID(),'image/jpeg',20971521),'22023')
 await deny(()=>db.query("update public.resale_media set state='ready',sha256=$1",['a'.repeat(64)]))
 const signed=(overrides={})=>{
 const payload=JSON.stringify({v:1,media_id:media.id,inventory_id:item,bucket:media.bucket,object_key:media.object_key,mime_type:'image/jpeg',byte_size:123,sha256:'a'.repeat(64),expires_at:Math.floor(Date.now()/1000)+300,...overrides})
 return [payload,createHmac('sha256',Buffer.from(key,'hex')).update(payload).digest('hex')]
 }
 const finalize=(args)=>db.query('select * from public.finalize_resale_media($1,$2)',args)
 await deny(()=>finalize([signed()[0],'b'.repeat(64)]),'22023')
 for(const delta of [{bucket:'other'},{inventory_id:randomUUID()},{object_key:'resale/items/other/original'},{byte_size:124},{expires_at:Math.floor(Date.now()/1000)-1},{expires_at:Math.floor(Date.now()/1000)+1000}]) await deny(()=>finalize(signed(delta)),'22023')
 const receipt=signed()
 assert.equal((await finalize(receipt)).rows[0].state,'ready')
 assert.equal((await finalize(receipt)).rows[0].sha256,'a'.repeat(64))
 await deny(()=>finalize(signed({sha256:'b'.repeat(64)})),'22023')
 await role('authenticated',stranger);await deny(()=>finalize(receipt))
 await role('authenticated',owner);await deny(()=>db.query('select * from vault.decrypted_secrets'))
 await role('postgres');await db.exec('update vault.decrypted_secrets set decrypted_secret=null')
 await role('authenticated',owner);await deny(()=>finalize(receipt),'55000')
 await role('postgres');await db.query('update vault.decrypted_secrets set decrypted_secret=$1',[key])
 await role('authenticated',owner)
 console.log('PASS real HMAC verification, immutable reserve, MIME/size/expiry checks, idempotent finalize, no secret access')

 await role('postgres')
 const account=randomUUID(), accountB=randomUUID(), listing=randomUUID(), snapshot=randomUUID()
 await db.query("insert into public.resale_accounts(id,marketplace,account_alias,capabilities,connection_status) values ($1,'poshmark','main','{\"delist\":\"supported\"}','connected'),($2,'poshmark','other','{}','manual')",[account,accountB])
 await db.query("insert into public.resale_snapshots(id,account_id,source,source_ref,observed_at,scope,coverage,record_count) values($1,$2,'manual','synthetic',now(),'closet firstpage','partial',48)",[snapshot,account])
 await db.query("insert into public.resale_listings(id,account_id,external_listing_id,inventory_id,match_status,matched_at,match_evidence) values($1,$2,'listing-1',$3,'confirmed',now(),'{\"review\":\"exact SKU and photo\"}')",[listing,account,item])
 // Same external listing ID is allowed in another account. IDs are account scoped.
 await db.query("insert into public.resale_listings(account_id,external_listing_id) values($1,'listing-1')",[accountB])
 const observe=async(status,time=null,extra={})=>{
 // WASM clock resolution is milliseconds; make successive observations strictly ordered.
 if(time===null) await new Promise(resolve=>setTimeout(resolve,3))
 const id=randomUUID()
 await db.query("insert into public.resale_observations(id,snapshot_id,account_id,listing_id,observed_at,status,availability,raw_status,evidence,external_listing_id) values($1,$2,$3,$4,coalesce($5::timestamptz,clock_timestamp()),$6,$7,$8,$9,'listing-1')",[id,snapshot,account,listing,time,status,extra.availability||null,extra.raw_status||null,JSON.stringify(extra)])
 return id
 }
 const active=await observe('active',new Date().toISOString(),{availability:'For Sale',raw_status:'Inactive'})
 await observe('removed','2020-01-01T00:00:00Z')
 assert.equal((await db.query('select observed_status from public.resale_listings where id=$1',[listing])).rows[0].observed_status,'active')
 await deny(()=>db.query("insert into public.resale_observations(snapshot_id,account_id,listing_id,observed_at,status) values($1,$2,$3,now(),'sold')",[snapshot,accountB,listing]),'23503')
 await role('authenticated',owner)
 const sale=(await db.query('select * from public.save_sale($1,$2)',[randomUUID(),JSON.stringify({inventory_id:item,platform:'Poshmark',sale_date:'2026-09-06',sale_price:30,platform_fee:5,item_cost:3,shipping_cost:0})])).rows[0]
 const action=(await db.query('select * from public.resale_actions where sale_id=$1',[sale.id])).rows[0]
 assert.equal(action.state,'blocked')
 // Late sale failure must also roll back generated delist intent.
 await role('postgres')
 await db.exec(`create function private.test_outbox_failure() returns trigger language plpgsql as $body$ begin raise exception 'late failure'; end $body$; create trigger outbox_failure before insert on private.sale_requests for each row execute function private.test_outbox_failure();`)
 await role('authenticated',owner)
 const historyBefore=(await db.query('select count(*) from public.sale_history')).rows[0].count
 await deny(()=>db.query('select public.save_sale($1,$2)',[randomUUID(),JSON.stringify({id:sale.id,version:1,void:true,reason:'Simulated cancellation'})]),'P0001')
 assert.equal((await db.query('select state from public.resale_actions where id=$1',[action.id])).rows[0].state,'blocked')
 assert.equal((await db.query('select count(*) from public.sale_history')).rows[0].count,historyBefore)
 await role('postgres');await db.exec('drop trigger outbox_failure on private.sale_requests')
 await role('service_role')
 await db.query('select private.resale_release_delist($1,$2)',[action.id,active])
 const claimed=(await db.query('select * from private.resale_claim_delist()')).rows[0]
 assert.equal(claimed.state,'running');assert.equal(claimed.attempts,1)
 assert.equal((await db.query('select (private.resale_claim_delist()).id')).rows[0].id,null)
 await db.query("select private.resale_finish_delist($1,$2,'accepted',null,'{\"http_status\":202}')",[action.id,claimed.lease_token])
 assert.equal((await db.query('select state from public.resale_actions where id=$1',[action.id])).rows[0].state,'uncertain')
 await deny(()=>db.query('select private.resale_release_delist($1,$2)',[action.id,active]),'22023')
 const fresh=await observe('active')
 await db.query('select private.resale_release_delist($1,$2)',[action.id,fresh])
 const retry=(await db.query('select * from private.resale_claim_delist()')).rows[0]
 await deny(()=>db.query("select private.resale_finish_delist($1,$2,'verified',$3,'{}')",[action.id,retry.lease_token,fresh]),'22023')
 const staleEnded=await observe('ended')
 await observe('active')
 await deny(()=>db.query("select private.resale_finish_delist($1,$2,'verified',$3,'{}')",[action.id,retry.lease_token,staleEnded]),'22023')
 const ended=await observe('ended')
 await db.query("select private.resale_finish_delist($1,$2,'verified',$3,'{}')",[action.id,retry.lease_token,ended])
 assert.equal((await db.query('select state from public.resale_actions where id=$1',[action.id])).rows[0].state,'succeeded')
 await role('authenticated',owner)
 await db.query('select public.save_sale($1,$2)',[randomUUID(),JSON.stringify({id:sale.id,version:1,void:true,reason:'Buyer cancelled'})])
 assert.equal((await db.query('select count(*) from public.resale_actions')).rows[0].count,1)
 assert.equal((await db.query("select count(*) from public.resale_review_cases where state='open'")).rows[0].count,1)
 console.log('PASS account-scoped evidence, partial snapshots, stale-observation guard, atomic sale outbox, 202 uncertain, verified retry, void review without republishing')
 await role('postgres')
 const equalTime=new Date().toISOString()
 await observe('ended',equalTime);await observe('active',equalTime)
 const conflict=(await db.query('select observed_status,observation_id from public.resale_listings where id=$1',[listing])).rows[0]
 assert.equal(conflict.observed_status,'unknown');assert.equal(conflict.observation_id,null)
 assert.equal((await db.query("select count(*) from public.resale_review_cases where reason='Conflicting listing observations at the same time'")).rows[0].count,1)
 console.log('PASS conflicting equally timed evidence becomes unknown with an explicit review case')
 await db.query("delete from private.memberships where user_id=$1 and area='resale'",[owner])
 await role('authenticated',owner)
 assert.equal((await db.query('select * from public.resale_media')).rows.length,0)
 await deny(()=>finalize(receipt));await deny(()=>reserve())
 console.log('PASS membership revocation immediately blocks data and media finalization')
} finally {await db.close()}
