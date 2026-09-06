import assert from 'node:assert/strict'
import fs from 'node:fs'
import {createRequire} from 'node:module'
import ts from 'typescript'
import {JSDOM} from 'jsdom'
import React,{act} from 'react'
const dom=new JSDOM('<div id="root"></div>',{url:'https://resell-tracker-beta.vercel.app'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})
const {createRoot}=await import('react-dom/client'),require=createRequire(import.meta.url)
const listing={id:'listing-exact',account_id:'account-exact',inventory_id:'item-exact',draft_version:3,desired_fields:{size:'L'}}
let rows=[],calls=[],downloads=[],failStart=false,failStep=false,holdStep=null
const api={packagePendingKey:async()=> 'test-owned-package',downloadPackageFile:async(p,k)=>downloads.push([p.id,k]),packageCall:async input=>{
 calls.push(structuredClone(input))
 if(input.action==='options')return {departments:['Women'],categories:['Tops'],subcategories:[],sizes:['L'],colors:[]}
 if(input.action==='list')return structuredClone(rows)
 if(input.action==='start'){if(failStart){failStart=false;throw Error('Response lost. Retry the same request.')}const j={id:input.id,state:'pending',current:true,completed_images:0,image_count:2,draft_version:3,outputs:{},updated_at:'2026-09-06T00:00:00Z'};rows=[j];return structuredClone(j)}
 if(input.action==='receipt')return {id:input.id,accepted:rows.some(p=>p.id===input.id)}
 if(input.action==='abandon')return {id:input.id,abandoned:true}
 if(input.action==='step'){if(holdStep){const hold=holdStep;holdStep=null;await hold}if(failStep){failStep=false;throw Error('Photo read paused. Resume.')}const j=rows[0];if(j.completed_images<2)j.completed_images++;else j.state='ready';return structuredClone(j)}
 if(input.action==='discard'){rows=rows.filter(p=>p.id!==input.id);return{state:'discarded'}}
}}
const compiled={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync(new URL('../components/PoshmarkPackage.tsx',import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText)(name=>name==='@/lib/resale-packages'?api:require(name),compiled,compiled.exports)
const Component=compiled.exports.default;let root=createRoot(document.getElementById('root'))
const render=()=>act(async()=>{root.render(React.createElement(Component,{listing}));await new Promise(r=>setTimeout(r,0))})
const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text)
const click=async text=>act(async()=>{assert(button(text),text);button(text).click();await new Promise(r=>setTimeout(r,0))})
const choose=async(index,value)=>act(async()=>{const e=document.querySelectorAll('select')[index];e.value=value;e.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await new Promise(r=>setTimeout(r,0))})
await render();await choose(0,'Women');await choose(1,'Tops');await act(async()=>document.querySelector('input').click())
failStart=true;await click('Prepare Poshmark files');const first=calls.find(c=>c.action==='start');assert.equal(first.payload.listing_id,listing.id);assert.equal(first.payload.expected_version,3);assert(localStorage.getItem('test-owned-package'))
failStep=true;await click('Retry the same preparation request');const retry=calls.filter(c=>c.action==='start')[1];assert.deepEqual(retry,first);assert.equal(localStorage.getItem('test-owned-package'),null);assert(document.body.textContent.includes('0 of 2 photos saved'))
await act(async()=>root.unmount());root=createRoot(document.getElementById('root'));await render();await click('Resume preparation');assert.equal(calls.filter(c=>c.action==='step').length,4);assert(document.body.textContent.includes('Files ready · upload still to do'));assert(document.body.textContent.includes('before publishing'))
await click('Download listing file');await click('Download photos');assert.deepEqual(downloads,[[first.id,'csv'],[first.id,'zip']]);assert.equal(document.querySelector('a').href,'https://poshmark.com/bulk-upload-create')
rows[0].current=false;await act(async()=>root.unmount());root=createRoot(document.getElementById('root'));await render();assert(document.body.textContent.includes('Older preparation'));assert.equal(button('Download listing file'),undefined);await click('Remove prepared files');assert.equal(rows.length,0)
// A request that never reached the server can be checked and atomically replaced.
failStart=true;await choose(0,'Women');await choose(1,'Tops');await act(async()=>document.querySelector('input').click());await click('Prepare Poshmark files');assert(localStorage.getItem('test-owned-package'));await click('Check pending preparation');assert.equal(localStorage.getItem('test-owned-package'),null);assert(calls.some(c=>c.action==='abandon'))
// Parent keys this component by listing ID. A completed in-flight step must not start another after unmount.
let release;holdStep=new Promise(r=>{release=r});await act(async()=>{button('Prepare Poshmark files').click();await new Promise(r=>setTimeout(r,0))});const stepCount=calls.filter(c=>c.action==='step').length;await act(async()=>root.unmount());root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(Component,{key:'different-listing',listing:{...listing,id:'different-listing'},disabled:true})));await act(async()=>{release();await new Promise(r=>setTimeout(r,0))});assert.equal(calls.filter(c=>c.action==='step').length,stepCount);await act(async()=>root.unmount());dom.window.close();console.log('PASS package rendered exact retry, reload resume, automatic steps, truthful ready/downloads, stale refusal and owned cleanup')
