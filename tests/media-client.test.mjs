import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../lib/resale-media.ts',import.meta.url),'utf8');
const stageCompiled=ts.transpileModule(fs.readFileSync(new URL('../lib/media-stage.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function setup(options={}) {
 const calls=[], urls=[], revoked=[], signals=[], deadlines=[];let attempts=0;
 let release; const stuck=new Promise(resolve=>{release=resolve});
 const session={access_token:'test-token'};
 const supabase={auth:{async getSession(){if(options.hang==='auth')await stuck;return {data:{session:options.signedOut?null:session}}}},rpc(name,args){calls.push({name,args}); const result=(async()=>{
  if(options.hang===(name==='resale_reserve_media'?'reserve':'finalize'))await stuck;
  if(name==='resale_reserve_media')return {data:{id:args.p_request_id,inventory_id:args.p_inventory_id}};
  if(name==='finalize_resale_media'){if(options.failFinalize && attempts++===0)return {error:{message:'temporarily unavailable'}};return {data:{id:JSON.parse(args.p_receipt).media_id,state:'ready'}}}
  throw Error('Unexpected RPC');
 })(); result.abortSignal=signal=>{signals.push(signal);return result};return result;
 }};
 const stageContext={exports:{},AbortController,DOMException,setTimeout(fn,ms){deadlines.push(ms);return setTimeout(fn,options.fastTimeout?10:ms)},clearTimeout};vm.runInNewContext(stageCompiled,stageContext);
 const context={exports:{},require(name){if(name==='./media-stage')return stageContext.exports;assert.equal(name,'./supabase');return {supabase,requireWritableDeployment(){if(options.preview)throw Error('preview read only')}}},
  process:{env:{NEXT_PUBLIC_RESALE_MEDIA_URL:options.noUrl?'':'https://media.example'}},crypto,DOMException,
  URL:class extends URL {static createObjectURL(){return 'blob:local-photo'}static revokeObjectURL(url){revoked.push(url)}},
  async fetch(url,init){urls.push({url,init});if(options.hang==='put')await stuck;assert.equal(init.headers.Authorization,'Bearer test-token');assert.equal(init.credentials,'omit');
   if(options.hang==='body')return {ok:true,json:()=>stuck};
   if(init.method==='PUT')return Response.json({receipt_payload:JSON.stringify({media_id:calls.find(x=>x.name==='resale_reserve_media').args.p_request_id}),receipt_signature:'a'.repeat(64)});
   return new Response(new Blob(['photo'],{type:'image/png'}));
  }
 };
 vm.runInNewContext(compiled,context);return {api:context.exports,calls,urls,revoked,signals,deadlines,release,options};
}
test('same intent retries reserve, PUT, and finalize without allocating another ID',async()=>{
 const s=setup({failFinalize:true}),file=new File(['photo'],'photo.png',{type:'image/png'}),intent=s.api.createMediaUploadIntent('item',file);
 await assert.rejects(s.api.uploadOriginal(intent),/temporarily unavailable/);
 await s.api.uploadOriginal(intent);
 const reservations=s.calls.filter(x=>x.name==='resale_reserve_media');assert.equal(reservations.length,2);
 assert.equal(reservations[0].args.p_request_id,reservations[1].args.p_request_id);
 assert.equal(s.urls[0].init.body,file);assert.equal(s.urls[1].init.body,file);
 assert.equal(s.calls.filter(x=>x.name==='finalize_resale_media')[0].args.p_receipt,s.calls.filter(x=>x.name==='finalize_resale_media')[1].args.p_receipt);
});
test('preview and disconnected storage cannot reserve or upload',async()=>{
 const preview=setup({preview:true});assert.throws(()=>preview.api.createMediaUploadIntent('item',new File(['x'],'x.png',{type:'image/png'})),/preview/);
 const s=setup({noUrl:true});await assert.rejects(s.api.uploadOriginal({requestId:'id',inventoryId:'item',file:new File(['x'],'x.png',{type:'image/png'})}),/not connected/);assert.equal(s.calls.length,0);
});
test('unsupported file types and large originals are rejected',()=>{
 const s=setup();assert.throws(()=>s.api.createMediaUploadIntent('item',new File(['x'],'photo.svg',{type:'image/svg+xml'})),/JPEG/);
 assert.throws(()=>s.api.createMediaUploadIntent('item',{type:'image/png',size:20971521}),/20 MiB/);
});
test('authorized preview returns explicit blob cleanup and signed-out preview fails',async()=>{
 const s=setup();const preview=await s.api.loadOriginalPreview('11111111-1111-4111-8111-111111111111');assert.equal(preview.url,'blob:local-photo');preview.revoke();assert.deepEqual(s.revoked,['blob:local-photo']);
 const denied=setup({signedOut:true});await assert.rejects(denied.api.loadOriginalPreview('11111111-1111-4111-8111-111111111111'),/Sign in/);assert.equal(denied.urls.length,0);
});

for(const [hang,label,expectedPuts,expectedFinalizes] of [
 ['reserve','Reserving this photo',0,0],['auth','Checking photo access',0,0],
 ['put','Saving original bytes',1,0],['body','Saving original bytes',1,0],['finalize','Linking the saved photo',1,1],
]) test(`hung ${hang} stops visibly and late resolution cannot advance the pipeline`,async()=>{
 const s=setup({hang,fastTimeout:true}),file=new File(['photo'],'photo.png',{type:'image/png'}),intent=s.api.createMediaUploadIntent('item',file);
 await assert.rejects(s.api.uploadOriginal(intent),new RegExp(label+'.*timed out'));
 const count=()=>[s.urls.length,s.calls.filter(x=>x.name==='finalize_resale_media').length];
 assert.deepEqual(count(),[expectedPuts,expectedFinalizes]);
 s.release({receipt_payload:JSON.stringify({media_id:intent.requestId}),receipt_signature:'a'.repeat(64)});
 await new Promise(r=>setTimeout(r,15));assert.deepEqual(count(),[expectedPuts,expectedFinalizes]);
 s.options.hang=null; await s.api.uploadOriginal(intent);
 assert.ok(s.calls.filter(x=>x.name==='resale_reserve_media').every(x=>x.args.p_request_id===intent.requestId));
 assert.ok(s.urls.every(x=>x.init.body===file));
 assert.ok(s.signals.length>=2);assert.ok(s.deadlines.includes(30_000));if(expectedPuts)assert.ok(s.deadlines.includes(120_000));
});
test('caller cancellation settles a hung auth wait and no late PUT is started',async()=>{
 const s=setup({hang:'auth'}),intent=s.api.createMediaUploadIntent('item',new File(['x'],'x.png',{type:'image/png'})),controller=new AbortController();
 const pending=s.api.uploadOriginal(intent,controller.signal);await new Promise(r=>setTimeout(r,0));controller.abort();
 await assert.rejects(pending,/abort/i);s.release();await new Promise(r=>setTimeout(r,0));assert.equal(s.urls.length,0);
});
test('already cancelled uploads do not even reserve a photo',async()=>{
 const s=setup(),controller=new AbortController();controller.abort();
 await assert.rejects(s.api.uploadOriginal({requestId:'id',inventoryId:'item',file:new File(['x'],'x.png',{type:'image/png'})},controller.signal),/abort/i);
 assert.equal(s.calls.length,0);
});
