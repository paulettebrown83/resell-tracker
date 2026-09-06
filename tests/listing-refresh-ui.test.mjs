import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url);
function compile(file,imports={}) {const m={exports:{}};const code=ts.transpileModule(fs.readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;new Function('require','module','exports',code)(n=>imports[n]||require(n),m,m.exports);return m.exports;}
const domain=compile('../lib/listing-refresh.ts');
const Panel=compile('../components/ListingRefreshRequest.tsx',{'@/lib/listing-refresh':domain,'@/lib/resale-operation-retry':{requestOperationWithRetry:async()=>{}}}).default;
const listing={id:'listing',account_id:'account',external_listing_id:'m12345678901',inventory_id:null,observation_id:'observation'};
const intent=domain.listingRefreshIntent(listing);assert.equal(intent.inventory_id,null);assert.equal(intent.action,'import');assert.deepEqual(intent.requested,{scope:'exact_listing_refresh',external_listing_id:'m12345678901'});
const html=(extra={})=>renderToStaticMarkup(React.createElement(Panel,{listing,marketplace:'mercari',pending:false,onChanged:async()=>{},...extra}));
assert.match(html(),/Agent-assisted check/);assert.match(html(),/physical inventory stay unchanged/);assert.match(html({pending:true}),/disabled/);assert.match(html({pending:true}),/Listing check requested/);assert.equal(html({marketplace:'ebay'}),'');assert.equal(html({listing:{...listing,external_listing_id:null}}),'');
console.log('PASS exact read-only intent, unmatched support, pending request and truthful supervised availability');
