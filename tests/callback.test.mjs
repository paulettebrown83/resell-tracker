import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { JSDOM } from 'jsdom'
import React, { act, StrictMode } from 'react'

const dom = new JSDOM('<!doctype html><div id="root"></div>', {url:'http://localhost/auth/callback?code=synthetic-code'})
globalThis.document=dom.window.document
globalThis.self=dom.window
globalThis.window=dom.window
globalThis.IS_REACT_ACT_ENVIRONMENT=true
const {createRoot}=await import('react-dom/client')
const require=createRequire(import.meta.url)
const exchanges=[], destinations=[], clears=[]
let exchange
// Preserve the real component/effects. Replace only external auth and navigation.
globalThis.window={location:{search:'?code=synthetic-code',replace:value=>destinations.push(value)},
  history:{replaceState:(_state,_unused,path)=>clears.push(path)}}
const source=readFileSync(new URL('../app/auth/callback/page.tsx',import.meta.url),'utf8')
const {outputText}=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,esModuleInterop:true}})
const mod={exports:{}}
new Function('require','module','exports',outputText)(name=>name==='@/lib/supabase'?{
  completeGoogleSignIn(search){exchanges.push(search);return exchange.promise}
}:require(name),mod,mod.exports)
const Callback=mod.exports.default
const root=createRoot(document.getElementById('root'))
try {
  exchange=Promise.withResolvers()
  await act(()=>root.render(React.createElement(StrictMode,null,React.createElement(Callback,{key:'success'}))))
  assert.equal(exchanges.length,1)
  assert.deepEqual(clears,['/auth/callback'])
  await act(async()=>{exchange.resolve();await exchange.promise})
  assert.deepEqual(destinations,['/'])
  exchange=Promise.withResolvers()
  window.location.search='?error=access_denied&error_description=private-provider-detail'
  await act(()=>root.render(React.createElement(StrictMode,null,React.createElement(Callback,{key:'failure'}))))
  assert.equal(exchanges.length,2)
  await act(async()=>{exchange.reject(new Error('private-provider-detail'));await exchange.promise.catch(()=>{})})
  assert.match(document.querySelector('[role="alert"]').textContent,/start again/)
  assert.doesNotMatch(document.body.textContent,/private-provider-detail/)
  assert.deepEqual(destinations,['/'])
  assert.equal(document.querySelector('a').getAttribute('href'),'/')
  console.log('PASS actual callback exchanges once under Strict Mode, clears query, returns only home and safely renders cancellation')
} finally {
  await act(()=>root.unmount())
  dom.window.close()
}
