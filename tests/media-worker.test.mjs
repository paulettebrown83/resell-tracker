import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../workers/resale-media/worker.mjs';
const id='11111111-1111-4111-8111-111111111111', item='22222222-2222-4222-8222-222222222222';
const png=Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1]);
const toHex=b=>Buffer.from(b).toString('hex');
function setup(t, overrides={}) {
 const objects=new Map(), calls=[];
 const row={id,inventory_id:item,kind:'original',state:'pending',bucket:'paulette-resale-originals-prod',object_key:`resale/items/${item}/${id}/original`,mime_type:'image/png',byte_size:png.length,sha256:null,...overrides};
 const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test',MEDIA_RECEIPT_KEY:'ab'.repeat(32),ALLOWED_ORIGINS:'https://app.example',RESALE_ORIGINALS:{
  async head(key){return objects.get(key)||null},
  async get(key){const o=objects.get(key);return o?{...o,body:o.bytes}:null},
  async put(key,bytes,opts){
   calls.push({key,opts});assert.equal(opts.onlyIf.get('If-None-Match'),'*');
   assert.equal(toHex(await crypto.subtle.digest('SHA-256',bytes)),toHex(opts.sha256));
   if(objects.has(key))return null;
   const object={bytes:new Uint8Array(bytes),size:bytes.length,httpMetadata:opts.httpMetadata,customMetadata:opts.customMetadata,checksums:{sha256:opts.sha256}};objects.set(key,object);return object;
  }
 }};
 const original=globalThis.fetch;
 globalThis.fetch=async (url,options)=>{
  // Match workerd's supported redirect modes; Node's fetch also accepts unsupported edge 'error'.
  assert.ok(['manual','follow'].includes(options.redirect));
  assert.equal(options.redirect,'manual');
  assert.equal(options.headers.apikey,'sb_publishable_test');
  assert.equal(options.headers.Authorization,'Bearer good');
  if(url.endsWith('/auth/v1/user'))return Response.json({id,is_anonymous:false});
  if(url.endsWith('/rpc/resale_access'))return Response.json(true);
  if(url.includes('/rest/v1/resale_media?'))return Response.json([row]);
  throw Error('Unexpected upstream');
 };
 t.after(()=>{globalThis.fetch=original});
 const request=(method='PUT',body=png,headers={})=>new Request(`https://media.example/v1/media/${id}`,{method,headers:{Origin:'https://app.example',Authorization:'Bearer good','Content-Type':'image/png',...headers},...(method==='PUT'?{body}:{})});
 return {env,row,objects,calls,request};
}
test('preserves bytes, signs exact receipt, retries safely, serves only ready originals',async t=>{
 const s=setup(t);
 const first=await worker.fetch(s.request(),s.env);assert.equal(first.status,200);
 const result=await first.json(), receipt=JSON.parse(result.receipt_payload);
 assert.equal(receipt.sha256,toHex(await crypto.subtle.digest('SHA-256',png)));
 assert.equal(receipt.media_id,id);assert.equal(receipt.byte_size,png.length);
 const key=await crypto.subtle.importKey('raw',Buffer.from(s.env.MEDIA_RECEIPT_KEY,'hex'),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 assert.equal(await crypto.subtle.verify('HMAC',key,Buffer.from(result.receipt_signature,'hex'),new TextEncoder().encode(result.receipt_payload)),true);
 assert.deepEqual(s.objects.get(s.row.object_key).bytes,png);
 assert.equal((await worker.fetch(s.request(),s.env)).status,200);assert.equal(s.calls.length,1);
 assert.equal((await worker.fetch(s.request('GET'),s.env)).status,409);
 s.row.state='ready';s.row.sha256=receipt.sha256;
 const get=await worker.fetch(s.request('GET'),s.env);assert.equal(get.status,200);assert.deepEqual(new Uint8Array(await get.arrayBuffer()),png);
 assert.equal(get.headers.get('Cache-Control'),'private, no-store');assert.equal(get.headers.get('Access-Control-Allow-Origin'),'https://app.example');
});
test('unauthenticated, unrelated and unavailable authorization never touch R2',async t=>{
 const s=setup(t);
 assert.equal((await worker.fetch(s.request('PUT',png,{Authorization:''}),s.env)).status,401);
 globalThis.fetch=async url=>Response.json(url.endsWith('/user')?{id}:false);
 assert.equal((await worker.fetch(s.request(),s.env)).status,403);
 globalThis.fetch=async()=>new Response('private upstream detail',{status:500});
 const unavailable=await worker.fetch(s.request(),s.env);assert.equal(unavailable.status,503);assert.doesNotMatch(await unavailable.text(),/private upstream/);
 assert.equal(s.calls.length,0);
});
test('wrong reservation, quarantined state and corrupt metadata fail closed',async t=>{
 const s=setup(t,{object_key:'../../other'});
 assert.equal((await worker.fetch(s.request(),s.env)).status,409);
 s.row.object_key=`resale/items/${item}/${id}/original`;s.row.state='quarantined';
 assert.equal((await worker.fetch(s.request(),s.env)).status,409);
 s.row.state='pending';s.objects.set(s.row.object_key,{size:png.length,customMetadata:{sha256:'bad'}});
 assert.equal((await worker.fetch(s.request(),s.env)).status,409);assert.equal(s.calls.length,0);
});
test('rejects spoofed MIME, active content, incomplete and oversized bodies',async t=>{
 const s=setup(t);
 assert.equal((await worker.fetch(s.request('PUT',png,{'Content-Type':'image/jpeg'}),s.env)).status,415);
 assert.equal((await worker.fetch(s.request('PUT',png,{'Content-Encoding':'gzip'}),s.env)).status,415);
 const script=new TextEncoder().encode('<svg onload="alert(1)"/>');s.row.byte_size=script.length;
 assert.equal((await worker.fetch(s.request('PUT',script),s.env)).status,415);
 s.row.byte_size=png.length;
 assert.equal((await worker.fetch(s.request('PUT',png.slice(0,10)),s.env)).status,400);
 assert.equal((await worker.fetch(s.request('PUT',new Uint8Array(25)),s.env)).status,413);
 s.row.byte_size=20*1024*1024+1;
 assert.equal((await worker.fetch(s.request(),s.env)).status,413);
 assert.equal(s.calls.length,0);
});
test('existing original and concurrent conditional-write winner cannot be overwritten',async t=>{
 const s=setup(t);await worker.fetch(s.request(),s.env);
 const different=png.slice();different[23]=2;
 assert.equal((await worker.fetch(s.request('PUT',different),s.env)).status,409);
 assert.deepEqual(s.objects.get(s.row.object_key).bytes,png);assert.equal(s.calls.length,1);
 // Both uploads initially see absence; only the first conditional PUT may win.
 s.objects.clear();s.calls.length=0;let checks=0;
 const realHead=s.env.RESALE_ORIGINALS.head;
 s.env.RESALE_ORIGINALS.head=async key=>++checks<=2?null:realHead(key);
 const results=await Promise.all([worker.fetch(s.request(),s.env),worker.fetch(s.request('PUT',different),s.env)]);
 assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);assert.deepEqual(s.objects.get(s.row.object_key).bytes,results[0].status===200?png:different);
});
test('CORS and path validation reject arbitrary origins, methods and query URLs',async t=>{
 const s=setup(t);
 assert.equal((await worker.fetch(s.request('PUT',png,{Origin:'https://evil.example'}),s.env)).status,403);
 assert.equal((await worker.fetch(new Request('https://media.example/v1/media/'+id+'?url=https://evil.example',{headers:{Authorization:'Bearer good'}}),s.env)).status,404);
 const preflight=await worker.fetch(new Request('https://media.example/v1/media/'+id,{method:'OPTIONS',headers:{Origin:'https://app.example','Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'Authorization, Content-Type'}}),s.env);
 assert.equal(preflight.status,204);assert.equal(preflight.headers.has('Access-Control-Allow-Credentials'),false);
 assert.equal(s.calls.length,0);
});
test('membership revocation denies subsequent image fetch even with same token',async t=>{
 const s=setup(t);const receipt=JSON.parse((await (await worker.fetch(s.request(),s.env)).json()).receipt_payload);s.row.state='ready';s.row.sha256=receipt.sha256;
 assert.equal((await worker.fetch(s.request('GET'),s.env)).status,200);
 globalThis.fetch=async url=>Response.json(url.endsWith('/user')?{id}:false);
 assert.equal((await worker.fetch(s.request('GET'),s.env)).status,403);
});

test('upstream redirects fail closed without forwarding bearer credentials',async t=>{
 const s=setup(t);let requests=0;
 globalThis.fetch=async (url,options)=>{requests++;assert.equal(options.redirect,'manual');return new Response(null,{status:302,headers:{Location:'https://untrusted.example'}})};
 const response=await worker.fetch(s.request(),s.env);assert.equal(response.status,503);assert.equal(requests,1);assert.equal(s.calls.length,0);
 assert.deepEqual(await response.json(),{error:'Photo authorization is temporarily unavailable.'});
});
