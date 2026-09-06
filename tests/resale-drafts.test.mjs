import {baseline,migrate} from './helpers.mjs'
import assert from 'node:assert/strict'
import {randomUUID as uuid} from 'node:crypto'
const db=await baseline()
try{
 await migrate(db)
 const owner=uuid(),other=uuid(),stranger=uuid(),genealogy=uuid(),account=uuid(),otherAccount=uuid(),item=uuid(),otherItem=uuid(),photo=uuid(),foreignPhoto=uuid()
 await db.query('insert into auth.users values($1),($2),($3),($4)',[owner,other,stranger,genealogy])
 await db.query("insert into private.memberships(user_id,area) values($1,'resale'),($2,'resale'),($3,'genealogy')",[owner,other,genealogy])
 await db.query("insert into public.resale_accounts(id,marketplace,account_alias) values($1,'ebay','main'),($2,'depop','main')",[account,otherAccount])
 for(const id of[item,otherItem])await db.query("insert into public.inventory(id,item_name,item_cost) values($1,'Synthetic draft item',0)",[id])
 for(const[id,i]of[[photo,item],[foreignPhoto,otherItem]])await db.query("insert into public.resale_media(id,inventory_id,kind,bucket,object_key,mime_type,byte_size,sha256,position,state) values($1::uuid,$2::uuid,'original','test','resale/items/'||$2::text||'/'||$1::text,'image/png',1,repeat('a',64),0,'ready')",[id,i])
 const role=async(r,id='')=>{await db.exec(`reset role;set role ${r}`);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id])}
 const input={account_id:account,inventory_id:item,expected_version:0,channel:'consumer',rules_version:'2026-09-06.1',fields:{title:'Base title',description:'Known facts',price:null,media_ids:[photo]},preferences:{avoid_emojis:true},overrides:{title:'Item-specific title'}}
 const save=async(p=input,id=uuid())=>(await db.query('select * from public.resale_save_listing_draft($1,$2)',[id,p])).rows[0]
 const deny=(fn,code='42501')=>assert.rejects(fn,e=>e.code===code)
 await role('anon');await deny(()=>save())
 for(const id of[stranger,genealogy]){await role('authenticated',id);await deny(()=>save())}
 await role('authenticated',owner)
 for(const p of[{...input,token:'x'},{...input,fields:{secret:'x'}},{...input,fields:{price:-1}},{...input,fields:{media_ids:[foreignPhoto]}},{...input,fields:{media_ids:[photo,photo]}},{...input,preferences:{style:'imaginary'}},{...input,expected_version:null},{...input,fields:{shipping:{packed_weight_grams:-1}}}])await deny(()=>save(p),'22023')
 const request=uuid(),created=await save(input,request)
 assert.equal(created.id,request);assert.equal(created.inventory_id,item);assert.equal(created.match_status,'confirmed');assert.equal(created.external_listing_id,null);assert.equal(created.observed_status,'unknown');assert.equal(created.draft_version,1);assert.equal(created.desired_fields.title,'Item-specific title');assert.equal(created.draft_context.fields.title,'Base title');assert.equal(created.desired_fields.price,null)
 assert.deepEqual(await save(input,request),created)
 await deny(()=>save({...input,overrides:{title:'Changed request'}},request),'22023')
 await role('authenticated',other);await deny(()=>save(input,request),'22023');await role('authenticated',owner)
 await deny(()=>save(input),'23505')
 const edit={...input,listing_id:created.id,expected_version:1,overrides:{title:null}}
 assert.equal((await save(edit)).draft_version,2)
 assert.deepEqual(await save(input,request),created)
 assert.equal((await db.query('select draft_version from public.resale_listings where id=$1',[created.id])).rows[0].draft_version,2)
 await deny(()=>save(edit),'40001');await deny(()=>save({...edit,expected_version:2,account_id:otherAccount}),'22023')
 await deny(()=>db.exec("update public.resale_listings set desired_fields='{}'"));await deny(()=>db.exec('select * from private.resale_draft_requests'));await deny(()=>db.exec('delete from public.resale_listing_draft_history'))
 assert.equal((await db.query('select count(*) from public.resale_listing_draft_history')).rows[0].count,2)
 for(const table of['sales','resale_actions','resale_observations'])assert.equal((await db.query('select count(*) from '+table)).rows[0].count,0)
 assert.equal((await db.query('select status from public.inventory where id=$1',[item])).rows[0].status,'unlisted')
 await role('postgres');const unmatched=uuid();await db.query("insert into public.resale_listings(id,account_id,external_listing_id,title) values($1,$2,'external-sample','Observed title')",[unmatched,account])
 await role('authenticated',owner);await deny(()=>save({...edit,listing_id:unmatched,expected_version:0}),'22023')
 await role('postgres');await db.query("update public.resale_listings set inventory_id=$1,match_status='confirmed',matched_by=$2,matched_at=now(),match_evidence='{\"checked\":true}',observed_status='active',desired_fields='{\"legacy\":\"preserve in history\"}' where id=$3",[item,owner,unmatched])
 await role('authenticated',owner);const prepared=await save({...edit,listing_id:unmatched,expected_version:0});assert.equal(prepared.title,'Observed title');assert.equal(prepared.observed_status,'active');assert.equal(prepared.external_listing_id,'external-sample')
 const history=(await db.query('select prior_draft from public.resale_listing_draft_history where listing_id=$1',[unmatched])).rows[0];assert.equal(history.prior_draft.desired_fields.legacy,'preserve in history')
 await role('postgres');await db.query("update public.inventory set status='sold' where id=$1",[item]);await role('authenticated',owner);await deny(()=>save({...edit,expected_version:2}),'22023')
 await role('postgres');await deny(()=>db.exec('delete from public.resale_listing_draft_history'),'55000')
 await db.query("delete from private.memberships where user_id=$1 and area='resale'",[owner]);await role('authenticated',owner);await deny(()=>save(input,request));assert.equal((await db.query('select * from public.resale_listing_draft_history')).rows.length,0)
 console.log('PASS draft RPC auth/revocation, exact retries, stale edits, item/media ownership, immutable history and no sale/stock/publication writes')
}finally{await db.close()}
