import {baseline,migrate} from './helpers.mjs';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
const db=await baseline();try{
 await migrate(db);const owner=randomUUID(),other=randomUUID(),account=randomUUID(),listing=randomUUID();
 await db.query('insert into auth.users values($1),($2)',[owner,other]);await db.query("insert into private.memberships(user_id,area) values($1,'resale'),($2,'resale')",[owner,other]);
 await db.query("insert into public.resale_accounts(id,marketplace,account_alias,external_account_id,username) values($1,'mercari','synthetic','seller1','synthetic_seller')",[account]);
 await db.query("insert into public.resale_listings(id,account_id,external_listing_id,desired_fields) values($1,$2,'m12345678901','{\"description\":\"preserve desired\"}')",[listing,account]);
 const role=async(r,u='')=>{await db.exec(`reset role;set role ${r}`);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[u]);};const deny=(f,code)=>assert.rejects(f,e=>!code||e.code===code);
 const payload=(id,observation=null)=>({account_id:account,action:'import',listing_id:listing,inventory_id:null,expected_observation_id:observation,expected_item_version:null,trigger:{kind:'member_request',id},requested:{scope:'exact_listing_refresh',external_listing_id:'m12345678901'}});
 const id=randomUUID(),p=payload(id),request=(i=id,f=p)=>db.query('select public.resale_request_listing_refresh($1,$2) id',[i,f]);
 await role('authenticated',owner);const op=(await request()).rows[0].id;assert.equal((await request()).rows[0].id,op);await deny(()=>request(id,{...p,requested:{...p.requested,price:20}}),'22023');
 await role('authenticated',other);await deny(()=>request(),'22023');await role('authenticated',owner);await deny(()=>db.query('select public.resale_claim_listing_refresh($1)',[op]),'42501');
 await role('service_role');const claim=async operation=>(await db.query('select public.resale_claim_listing_refresh($1) value',[operation])).rows[0].value;const lease=await claim(op);assert.equal(lease.read_only,true);await deny(()=>claim(op),'55000');
 const facts=()=>({v:1,observed_at:new Date().toISOString(),external_listing_id:'m12345678901',external_account_id:'seller1',account_handle:'synthetic_seller',editor_url:'https://www.mercari.com/sell/edit/m12345678901/',owner_controls_verified:true,raw_availability:'Deactivate control visible',activity:null,listing_fields:{title:'Synthetic',description:'Synthetic',category:null,brand:null,size:null,condition:null,quantity_control:null,photos:['photo1'],colors:[],measurements:[]},pricing:{currency:'USD',asking_minor:2000,mechanism:'mercari_smart_pricing',enabled:true,minimum_minor:1700}});
 const finish=(f,l=lease,operation=op)=>db.query('select public.resale_finish_listing_refresh($1,$2,$3) id',[operation,l.lease_token,f]);
 await deny(()=>finish({...facts(),external_account_id:'wrong'}),'22023');await deny(()=>finish({...facts(),raw_body:'private'}),'22023');
 await deny(()=>finish({...facts(),pricing:{...facts().pricing,minimum_minor:2500}}),'23514');assert.equal((await db.query('select count(*) n from public.resale_source_records')).rows[0].n,0);
 const f=facts(),proof=(await finish(f)).rows[0].id;assert.equal((await finish(f)).rows[0].id,proof);await deny(()=>finish({...f,activity:'changed'}),'40001');
 await role('postgres');const saved=(await db.query('select * from public.resale_listings where id=$1',[listing])).rows[0];assert.equal(saved.inventory_id,null);assert.equal(saved.match_status,'unmatched');assert.deepEqual(saved.desired_fields,{description:'preserve desired'});assert.equal(saved.observed_status,'active');assert.equal(saved.title,null);assert.equal(saved.asking_price,null);
 const price=(await db.query('select * from public.resale_listing_pricing where listing_id=$1',[listing])).rows[0];assert.equal(price.asking_minor,2000);assert.equal(price.minimum_minor,1700);assert.equal(price.enabled,true);
 assert.equal((await db.query('select count(*) n from public.resale_source_records')).rows[0].n,1);await deny(()=>db.query("update public.resale_actions set action='update' where id=$1",[op]),'40001');
 const second=randomUUID();await role('authenticated',owner);const next=(await request(second,payload(second,saved.observation_id))).rows[0].id;await role('service_role');const nextLease=await claim(next);
 const evidence=(await db.query('select id,snapshot_id from public.resale_source_records limit 1')).rows[0];
 await deny(()=>db.query("select private.resale_finish_evidence_operation($1,$2,'verified',$3,$4,'evidence_imported','Unrelated source is not an exact refresh')",[next,nextLease.lease_token,[evidence.id],[evidence.snapshot_id]]),'23514');
 await db.query('select public.resale_fail_listing_refresh($1,$2,$3)',[next,nextLease.lease_token,'browser_unavailable']);await db.query('select public.resale_fail_listing_refresh($1,$2,$3)',[next,nextLease.lease_token,'browser_unavailable']);assert.equal((await db.query('select count(*) n from public.resale_source_records')).rows[0].n,1);
 const retry=await claim(next);const unknown={...facts(),raw_availability:null,pricing:{currency:null,asking_minor:null,mechanism:'unknown',enabled:null,minimum_minor:null}};await finish(unknown,retry,next);
 const unknownPrice=(await db.query('select * from public.resale_listing_pricing where listing_id=$1',[listing])).rows[0];assert.equal(unknownPrice.pricing_status,'unknown');assert.equal(unknownPrice.asking_minor,null);assert.equal(unknownPrice.enabled,null);
 await role('postgres');assert.equal((await db.query('select observed_status from public.resale_listings where id=$1',[listing])).rows[0].observed_status,'unknown');
 for(const t of ['inventory','sales','sale_history','resale_order_lines'])assert.equal((await db.query(`select count(*) n from public.${t}`)).rows[0].n,0);
 const poshAccount=randomUUID(),poshListing=randomUUID();
 await db.query("insert into public.resale_accounts(id,marketplace,account_alias,external_account_id,username) values($1,'poshmark','synthetic-posh','posh-seller','synthetic_posh')",[poshAccount]);await db.query("insert into public.resale_listings(id,account_id,external_listing_id) values($1,$2,'1234567890abcdef12345678')",[poshListing,poshAccount]);
 let poshObservation=null;
 for(const [raw,status] of [['For Sale','active'],['Not For Sale','ended']]){
 const req=randomUUID(),input={...payload(req,poshObservation),account_id:poshAccount,listing_id:poshListing,requested:{scope:'exact_listing_refresh',external_listing_id:'1234567890abcdef12345678'}};
 await role('authenticated',owner);const action=(await request(req,input)).rows[0].id;await role('service_role');const leased=await claim(action);
 await finish({...facts(),external_listing_id:'1234567890abcdef12345678',external_account_id:'posh-seller',account_handle:'synthetic_posh',editor_url:'https://poshmark.com/edit-listing/1234567890abcdef12345678',raw_availability:raw,activity:'Inactive',pricing:{currency:'USD',asking_minor:2200,mechanism:'poshmark_smart_sell',enabled:false,minimum_minor:null}},leased,action);
 const current=(await db.query('select observed_status,observation_id from public.resale_listings where id=$1',[poshListing])).rows[0];assert.equal(current.observed_status,status);poshObservation=current.observation_id;
 }
 await role('postgres');
 await db.query("delete from private.memberships where user_id=$1 and area='resale'",[owner]);await role('service_role');await deny(()=>finish(f),'42501');await role('authenticated',owner);await deny(()=>request(),'42501');
 console.log('PASS exact refresh actor/lease/retry, immutable scope, source/pricing append, unknowns, failed-read recovery, revocation and unchanged desired/physical state');
}catch(e){console.error(e.message,e.code||'');process.exitCode=1;}finally{await db.close();}
