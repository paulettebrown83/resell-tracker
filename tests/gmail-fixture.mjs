import { randomBytes, randomUUID, createHash, createHmac } from 'node:crypto'
export const uid=randomUUID, hash=value=>createHash('sha256').update(value).digest('hex')
export const tickKey=randomBytes(32).toString('hex'), ingressKey=randomBytes(32).toString('hex')
export const sign=(kind,value)=>createHmac('sha256',Buffer.from(kind==='tick'?tickKey:ingressKey,'hex')).update(`gmail_${kind}_v1\n${value}`).digest('hex')
export const mailbox='paulettebrown83@gmail.com',scope=['https://www.googleapis.com/auth/gmail.readonly']
export async function fixture(db) {
 await (db.exec?.bind(db) ?? db.query.bind(db))(`create schema vault; create table vault.secrets(id uuid primary key default gen_random_uuid(), name text not null,secret text);
 create view vault.decrypted_secrets as select id,name,secret as decrypted_secret from vault.secrets;
 create function vault.create_secret(p_secret text,p_name text,p_description text) returns uuid language sql as $$ insert into vault.secrets(name,secret) values(p_name,p_secret) returning id $$;
 create function vault.update_secret(p_id uuid,p_secret text) returns void language sql as $$ update vault.secrets set secret=p_secret where id=p_id $$;`)
 const owner=uid(),other=uid(),outsider=uid(),account=uid(),accountB=uid()
 await db.query('insert into auth.users values($1),($2),($3)',[owner,other,outsider])
 await db.query("insert into private.memberships(user_id,area) values($1,'resale'),($2,'resale')",[owner,other])
 await db.query("insert into public.resale_accounts(id,marketplace,account_alias,username) values($1,'vinted','synthetic_main','synthetic_seller'),($2,'vinted','synthetic_other','someoneelse')",[account,accountB])
 await db.query("insert into private.resale_gmail_config(client_id,redirect_uri,publishing_status) values('synthetic-client-one','https://resell-tracker-beta.vercel.app/api/integrations/gmail/callback','testing')")
 for(const [suffix,value] of [['oauth_client_secret','synthetic-client-secret'],['tick_signing_key',tickKey],['ingress_signing_key',ingressKey]]) await db.query('insert into vault.secrets(name,secret) values($1,$2)',[`resale_gmail_paulettebrown83_production_${suffix}`,value])
 return {owner,other,outsider,account,accountB}
}
export const normalized=()=>({subject:'Synthetic notification',account_handle:'synthetic_seller',product_titles:['Synthetic item'],money_mentions:[{raw:'$12',amount_minor:1200,currency_symbol:'$',currency_code:null,meaning:'unallocated'}],conversation_ids:['123'],transaction_id:null,order_id:null,listing_id:null,parser_status:'recognized',quarantine_reason:null,authentication_pass:true})
export function receipt(feed,lease,account,overrides={}) {return {v:1,nonce:uid(),feed_id:feed,lease_token:lease,parser_version:'vinted-gmail-v1',account_id:account,message_id:'syntheticmsg1',thread_id:'syntheticthread',received_at:Date.now()-100000,captured_at:Date.now(),kind:'sale_notification',source_sha256:hash('synthetic-message'),expires_at:Math.floor(Date.now()/1000)+300,normalized:normalized(),...overrides}}
export async function rpc(db,name,args) {return (await db.query(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) value`,args.map(v=>v&&typeof v==='object'&&!Array.isArray(v)?JSON.stringify(v):v))).rows[0].value}
export const enroll=(db,account,id=uid())=>rpc(db,'resale_enroll_gmail_feed',[id,{mailbox_email:mailbox,account_id:account,parser_version:'vinted-gmail-v1'}])
export async function oauth(db,owner,feed,{consume=true}={}) {const state=hash(uid()),binding=hash(uid()),s=await rpc(db,'resale_gmail_oauth_start',[owner,feed,state,binding,'a'.repeat(43)]);if(consume)await rpc(db,'resale_gmail_oauth_consume',[state,binding]);return {...s,state,binding}}
export const complete=(db,s,token='synthetic-refresh-token')=>rpc(db,'resale_gmail_oauth_complete',[s.state_id,mailbox,scope,token])
export async function claim(db,overrides={}) {const text=JSON.stringify({v:1,nonce:uid(),expires_at:Math.floor(Date.now()/1000)+300,...overrides});return {result:await rpc(db,'resale_gmail_verify_tick_and_claim',[text,sign('tick',text)]),text}}
export async function ingest(db,value) {const text=JSON.stringify(value);return rpc(db,'resale_ingest_gmail_message',[text,sign('ingest',text)])}
