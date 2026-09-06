import {baseline,migrate} from './helpers.mjs'
import assert from 'node:assert/strict'
import {randomUUID as uuid} from 'node:crypto'
const db=await baseline()
try{
 await migrate(db)
 const owner=uuid(),other=uuid(),outsider=uuid(),account=uuid(),item=uuid(),photo=uuid(),listing=uuid(),request=uuid()
 await db.query('insert into auth.users values($1),($2),($3)',[owner,other,outsider])
 await db.query("insert into private.memberships(user_id,area) values($1,'resale'),($2,'resale')",[owner,other])
 await db.query("insert into public.resale_accounts(id,marketplace,account_alias,external_account_id) values($1,'poshmark','main','5bb5431e42aa76fee623d5a6')",[account])
 await db.query("insert into public.inventory(id,item_name,item_cost) values($1,'Synthetic package item',0)",[item])
 await db.query("insert into public.resale_media(id,inventory_id,kind,bucket,object_key,mime_type,byte_size,sha256,position,state) values($1::uuid,$2::uuid,'original','paulette-resale-originals-prod','resale/items/'||$2::text||'/'||$1::text||'/original','image/png',10,repeat('a',64),0,'ready')",[photo,item])
 const role=async(r,id='')=>{await db.exec(`reset role;set role ${r}`);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id])}
 const deny=(fn,code)=>assert.rejects(fn,e=>!code||e.code===code)
 const rpc=async(name,args)=> (await db.query(`select * from public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})`,args)).rows[0]
 await role('authenticated',owner)
 await rpc('resale_save_listing_draft',[listing,{account_id:account,inventory_id:item,expected_version:0,channel:'consumer',rules_version:'2026-09-06.1',fields:{title:'Synthetic',description:'No sale',size:'L',price:22,currency:'USD',media_ids:[photo]},preferences:{},overrides:{}}])
 const payload={listing_id:listing,account_id:account,inventory_id:item,expected_version:1,quantity:1,native_fields:{Department:'Women',Category:'Tops'}}
 const start=(p=payload,id=request)=>rpc('resale_request_package',[id,p])
 await role('anon');await deny(()=>start(),'42501');await role('authenticated',outsider);await deny(()=>start(),'42501')
 await role('authenticated',owner)
 for(const bad of[{...payload,quantity:null},{...payload,native_fields:{SKU:'bad'}},{...payload,expected_version:2}])await deny(()=>start(bad,uuid()))
 const job=await start();assert.equal(job.snapshot.media[0].id,photo);assert.deepEqual(await start(),job)
 await deny(()=>start({...payload,native_fields:{Department:'Men',Category:'Tops'}}),'22023')
 await role('authenticated',other);await deny(()=>start(),'22023');assert.equal((await db.query('select * from public.resale_listing_packages')).rows.length,0)
 await role('authenticated',owner);let claim=await rpc('resale_claim_package',[request]);await deny(()=>rpc('resale_claim_package',[request]),'55P03');await deny(()=>rpc('resale_discard_package',[request,false]),'55P03')
 const name=`${request}/photo-0.jpg`,artifact={name,sha256:'b'.repeat(64),byte_size:20,width:10,height:10,media_id:photo}
 const storageOp=op=>db.query("select set_config('storage.operation',$1,false)",[op])
 await storageOp('object.upload');await db.query("insert into storage.objects(bucket_id,name,metadata) values('resale-listing-packages',$1,'{\"size\":20}')",[name])
 await deny(()=>db.query("insert into storage.objects(bucket_id,name,metadata) values('resale-listing-packages',$1,'{}')",[`${request}/../escape.jpg`]),'42501')
 await deny(()=>db.query("insert into storage.objects(bucket_id,name,metadata) values('resale-listing-packages',$1,'{}')",[`${request}/photo-1.jpg`]),'42501')
 await storageOp('object.get_authenticated');assert.equal((await db.query('select * from storage.objects')).rows.length,1)
 for(const op of ['object.list','object.sign','s3.object.get']){await storageOp(op);assert.equal((await db.query('select * from storage.objects')).rows.length,0)}
 await storageOp('object.upload_update');assert.equal((await db.query("update storage.objects set metadata='{}' returning *")).rows.length,0)
 await deny(()=>rpc('resale_checkpoint_package',[request,uuid(),artifact]),'40001')
 await deny(()=>rpc('resale_checkpoint_package',[request,claim.lease_token,{...artifact,media_id:uuid()}]),'22023')
 const checkpoint=await rpc('resale_checkpoint_package',[request,claim.lease_token,artifact]);assert.equal(checkpoint.completed_images,1);assert.equal(checkpoint.state,'pending')
 await deny(()=>rpc('resale_checkpoint_package',[request,claim.lease_token,artifact]),'40001')
 claim=await rpc('resale_claim_package',[request]);const outputs={}
 for(const[k,suffix]of[['csv','listings.csv'],['zip','photos.zip'],['manifest','manifest.json']]){outputs[k]={name:`${request}/${suffix}`,byte_size:30,sha256:'c'.repeat(64)};await db.query("insert into storage.objects(bucket_id,name,metadata) values('resale-listing-packages',$1,'{\"size\":30}')",[outputs[k].name])}
 const ready=await rpc('resale_finish_package',[request,claim.lease_token,outputs,null]);assert.equal(ready.state,'ready')
 await storageOp('object.get_authenticated');assert.equal((await db.query('select * from storage.objects')).rows.length,4)
 await role('postgres');await db.query("update public.resale_media set state='quarantined' where id=$1",[photo]);await role('authenticated',owner)
 assert.equal((await db.query('select * from storage.objects')).rows.length,0);assert.equal((await db.query('select * from public.resale_listing_packages')).rows.length,0)
 const stale=(await db.query('select public.resale_package_summaries($1) summaries',[listing])).rows[0].summaries;assert.equal(stale[0].current,false);assert.deepEqual(stale[0].outputs,{})
 await rpc('resale_discard_package',[request,false]);await storageOp('object.get_authenticated');assert.equal((await db.query('select * from storage.objects')).rows.length,0)
 await storageOp('object.delete_many');assert.equal((await db.query('delete from storage.objects returning *')).rows.length,4)
 await rpc('resale_discard_package',[request,true]);assert.deepEqual((await db.query('select public.resale_package_summaries($1) summaries',[listing])).rows[0].summaries,[])
 await role('postgres');await db.query("delete from private.memberships where user_id=$1 and area='resale'",[owner]);await role('authenticated',owner);await deny(()=>rpc('resale_package_summaries',[listing]),'42501');await deny(()=>rpc('resale_discard_package',[request,false]),'42501')
 await role('postgres');for(const table of['sales','resale_actions','resale_observations'])assert.equal((await db.query('select count(*) from '+table)).rows[0].count,0)
 assert.equal((await db.query('select count(*) from public.resale_media')).rows[0].count,1)
 console.log('PASS package member/owner/exact retries/leases/current media/Storage operation restrictions/stale discard and no canonical effects')
}catch(e){console.error(e.message,e.code,e.where);process.exitCode=1}finally{await db.close()}
