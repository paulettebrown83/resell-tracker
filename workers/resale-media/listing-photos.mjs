const LIMIT=20*1024*1024,BUCKET='paulette-resale-originals-prod';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function safePhotoUrl(ref){
 if(!/^[a-f0-9]{24}$/.test(ref.external_listing_id||''))return false;
 return new RegExp(`^https://di2ponv0v5otw\\.cloudfront\\.net/posts/[0-9]{4}/[0-9]{2}/[0-9]{2}/${ref.external_listing_id}/l_[a-f0-9]{24}\\.(jpg|jpeg|png|webp)$`).test(ref.source_url||'');
}
export async function photoMac(key,domain,text){
 if(!['dispatch','receipt'].includes(domain)||!/^[a-f0-9]{64}$/.test(key||''))throw Error('Invalid signature configuration');
 const k=await crypto.subtle.importKey('raw',Uint8Array.from(key.match(/../g),h=>parseInt(h,16)),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const out=await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(`resale:marketplace-copy:${domain}:v1\n${text}`));return Array.from(new Uint8Array(out),b=>b.toString(16).padStart(2,'0')).join('');
}
async function readBounded(body,max){
 if(!body)throw Error('source_unavailable');const reader=body.getReader(),chunks=[];let size=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();throw Error('oversized');}chunks.push(value);}}finally{reader.releaseLock();}
 if(!size)throw Error('unsupported_image');const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
async function requestJson(request,max=16384){const b=await readBounded(request.body,max);return JSON.parse(new TextDecoder().decode(b));}
function matches(object,row,hex){return object&&object.size===row.byte_size&&object.httpMetadata?.contentType===row.mime_type&&object.customMetadata?.sha256===row.sha256&&object.checksums?.sha256&&hex(object.checksums.sha256)===row.sha256;}
async function signedRpc(env,name,body){
 const response=await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{apikey:env.SUPABASE_PUBLISHABLE_KEY,'Content-Type':'application/json'},body:JSON.stringify(body)});
 if(!response.ok)throw Error('database_rejected');return response.json();
}
function receiptBase(job){return {v:1,kind:'marketplace_copy',request_id:job.request_id,member_id:job.member_id,ref_id:job.ref.id,source_record_id:job.ref.source_record_id,account_id:job.ref.account_id,listing_id:job.ref.listing_id,external_account_id:job.ref.external_account_id,external_listing_id:job.ref.external_listing_id,source_url:job.ref.source_url,nonce:job.nonce,lease_token:job.lease_token,expires_at:Math.floor(Date.now()/1000)+600};}
async function finalize(env,body){const p_receipt=JSON.stringify(body),p_signature=await photoMac(env.MEDIA_RECEIPT_KEY,'receipt',p_receipt);return signedRpc(env,'resale_finish_listing_photo',{p_receipt,p_signature});}
async function readManifest(stored,job,h){
 if(!stored||stored.size>16384||stored.httpMetadata?.contentType!=='application/json'||stored.customMetadata?.request_id!==job.request_id||stored.customMetadata?.nonce!==job.nonce||!stored.checksums?.sha256)throw Error('storage_unconfirmed');
 const text=await stored.text(),bytes=new TextEncoder().encode(text);
 if(bytes.length!==stored.size||h.hex(await crypto.subtle.digest('SHA-256',bytes))!==h.hex(stored.checksums.sha256))throw Error('storage_unconfirmed');
 const m=JSON.parse(text),base=receiptBase(job);
 for(const [key,value] of Object.entries(base))if(key!=='expires_at'&&m[key]!==value)throw Error('storage_unconfirmed');
 if(!/^[a-f0-9]{64}$/.test(m.sha256||'')||m.bucket!==BUCKET||m.object_key!==`resale/marketplace-copies/sha256/${m.sha256}`||!Number.isInteger(m.byte_size)||m.byte_size<1||m.byte_size>LIMIT||!['image/jpeg','image/png','image/webp','image/gif'].includes(m.mime_type)||!Number.isFinite(Date.parse(m.fetched_at)))throw Error('storage_unconfirmed');
 return m;
}
async function capture(env,job,h){
 if(!job||!UUID.test(job.request_id||'')||!UUID.test(job.ref?.id||'')||job.ref.kind!=='marketplace_copy'||!safePhotoUrl(job.ref))h.fail(409,'The saved marketplace photo source could not be verified.');
 if(job.ref.state==='ready'){
  const object=job.object;if(!object||object.bucket!==BUCKET||object.object_key!==`resale/marketplace-copies/sha256/${object.sha256}`||!matches(await env.RESALE_ORIGINALS.head(object.object_key),object,h.hex))h.fail(409,'The saved marketplace copy could not be verified.');
  return h.json({ref:job.ref,object,already_saved:true});
 }
 if(job.job_state==='failed')return h.json({error:'The previous capture failed. Start a new photo attempt.',retry_new_request:true},409);
 if(job.job_state!=='leased'||job.expires_at<=Date.now()/1000)h.fail(409,'The photo capture needs a fresh request.');
 let captured=false;
 try{
  const captureKey=`resale/marketplace-copies/captures/${job.request_id}/${job.nonce}.json`;
  const saved=await env.RESALE_ORIGINALS.get(captureKey);let manifest=null;
  if(saved){captured=true;manifest=await readManifest(saved,job,h);
   captured=true;const object=await env.RESALE_ORIGINALS.head(manifest.object_key);if(object){if(!matches(object,manifest,h.hex))throw Error('storage_unconfirmed');const ref=await finalize(env,{...receiptBase(job),...manifest,expires_at:Math.floor(Date.now()/1000)+600});return h.json({ref,object:manifest,already_saved:true});}
  }
  const response=await fetch(job.ref.source_url,{method:'GET',redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(10000),headers:{Accept:'image/jpeg,image/png,image/webp,image/gif','Accept-Encoding':'identity'}});
  if(response.status>=300&&response.status<400)throw Error('source_rejected');if(!response.ok)throw Error('source_unavailable');
  if(response.headers.get('content-encoding')&&!['identity'].includes(response.headers.get('content-encoding')))throw Error('source_rejected');
  const length=response.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>LIMIT)){await response.body?.cancel();throw Error('oversized');}
  const bytes=await readBounded(response.body,LIMIT),mime=h.detectMime(bytes);if(!mime||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!==mime)throw Error('unsupported_image');
  if(length&&Number(length)!==bytes.length)throw Error('source_unavailable');
  const hashBuffer=await crypto.subtle.digest('SHA-256',bytes),sha256=h.hex(hashBuffer),object={sha256,bucket:BUCKET,object_key:`resale/marketplace-copies/sha256/${sha256}`,byte_size:bytes.length,mime_type:mime};
  const proposed={...receiptBase(job),...object,fetched_at:new Date().toISOString()};
  if(manifest){if(manifest.sha256!==sha256||manifest.byte_size!==bytes.length||manifest.mime_type!==mime)throw Error('storage_unconfirmed');}
  else{captured=true;const manifestBytes=new TextEncoder().encode(JSON.stringify(proposed));await env.RESALE_ORIGINALS.put(captureKey,manifestBytes,{onlyIf:new Headers({'If-None-Match':'*'}),sha256:await crypto.subtle.digest('SHA-256',manifestBytes),httpMetadata:{contentType:'application/json',cacheControl:'private, no-store'},customMetadata:{request_id:job.request_id,nonce:job.nonce}});const winner=await env.RESALE_ORIGINALS.get(captureKey);manifest=await readManifest(winner,job,h);if(manifest.sha256!==sha256||manifest.byte_size!==bytes.length||manifest.mime_type!==mime)throw Error('storage_unconfirmed');}
  captured=true;
  const existing=await env.RESALE_ORIGINALS.head(object.object_key);if(existing&&!matches(existing,object,h.hex))throw Error('storage_unconfirmed');
  if(!existing)await env.RESALE_ORIGINALS.put(object.object_key,bytes,{onlyIf:new Headers({'If-None-Match':'*'}),sha256:hashBuffer,httpMetadata:{contentType:mime,cacheControl:'private, no-store'},customMetadata:{sha256}});
  if(!matches(await env.RESALE_ORIGINALS.head(object.object_key),object,h.hex))throw Error('storage_unconfirmed');
  const ref=await finalize(env,{...manifest,expires_at:Math.floor(Date.now()/1000)+600});return h.json({ref,object,already_saved:false});
 }catch(error){
  const reason=['source_unavailable','source_rejected','oversized','unsupported_image','storage_unconfirmed'].includes(error.message)?error.message:'runtime_error';
  try{if(!captured)await finalize(env,{...receiptBase(job),kind:'marketplace_copy_error',error:reason});}catch{/* A late or uncertain result cannot overwrite a saved copy. */}
  h.fail(503,'Marketplace photo preservation was not confirmed. Retry the saved photo request.');
 }
}
export async function listingPhotoRoute(request,env,h){
 const url=new URL(request.url);if(url.search)h.fail(404,'Not found.');
 if(url.pathname==='/v1/listing-photo-dispatch'){
  if(request.method!=='POST')h.fail(405,'Method not allowed.');let body;try{body=await requestJson(request);}catch{h.fail(400,'Invalid capture dispatch.');}
  if(typeof body.ticket!=='string'||body.ticket.length>12000||! /^[a-f0-9]{64}$/.test(body.signature||'')||body.signature!==await photoMac(env.MEDIA_RECEIPT_KEY,'dispatch',body.ticket))h.fail(401,'Invalid capture dispatch.');
  let job;try{job=await signedRpc(env,'resale_claim_listing_photo_dispatch',{p_ticket:body.ticket,p_signature:body.signature});}catch{h.fail(403,'Capture dispatch is expired or unavailable.');}return capture(env,job,h);
 }
 const match=url.pathname.match(/^\/v1\/listing-photos\/([0-9a-f-]+)$/);if(!match||!UUID.test(match[1]))h.fail(404,'Not found.');if(!['POST','GET'].includes(request.method))h.fail(405,'Method not allowed.');
 const token=request.headers.get('authorization')||'';if(!/^Bearer [A-Za-z0-9._~-]+$/.test(token))h.fail(401,'Sign in to access marketplace copies.');
 const user=await h.api(env,token,'/auth/v1/user');if(!UUID.test(user.id||'')||user.is_anonymous===true)h.fail(401,'A verified account is required.');if(await h.api(env,token,'/rest/v1/rpc/resale_access',{method:'POST',body:'{}'})!==true)h.fail(403,'This account does not have resale access.');
 if(request.method==='POST'){
  let body;try{body=await requestJson(request,1024);}catch{h.fail(400,'Invalid photo request.');}if(!UUID.test(body.request_id||'')||Object.keys(body).length!==1)h.fail(400,'Exact photo request ID required.');
  const job=await h.api(env,token,'/rest/v1/rpc/resale_prepare_listing_photo',{method:'POST',body:JSON.stringify({p_request_id:body.request_id,p_ref_id:match[1]})});if(job.member_id!==user.id||job.ref?.id!==match[1])h.fail(409,'Photo request did not match.');return capture(env,job,h);
 }
 const rows=await h.api(env,token,`/rest/v1/resale_listing_photo_refs?id=eq.${match[1]}&select=*&limit=1`),ref=rows?.[0];if(!ref||ref.id!==match[1]||ref.kind!=='marketplace_copy'||ref.state!=='ready'||! /^[a-f0-9]{64}$/.test(ref.object_sha256||''))h.fail(404,'Saved marketplace copy was not found.');
 const objects=await h.api(env,token,`/rest/v1/resale_marketplace_photo_objects?sha256=eq.${ref.object_sha256}&select=*&limit=1`),object=objects?.[0];if(!object||object.bucket!==BUCKET||object.object_key!==`resale/marketplace-copies/sha256/${ref.object_sha256}`)h.fail(409,'Saved marketplace copy metadata differs.');
 const stored=await env.RESALE_ORIGINALS.get(object.object_key);if(!matches(stored,object,h.hex))h.fail(409,'Saved marketplace copy bytes could not be verified.');
 return new Response(stored.body,{headers:{'Content-Type':object.mime_type,'Content-Length':String(object.byte_size),'Content-Disposition':`attachment; filename="marketplace-copy-${ref.id}.${({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'})[object.mime_type]}"`}});
}
