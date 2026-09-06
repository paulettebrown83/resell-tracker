import assert from 'node:assert/strict'
process.env.NEXT_PUBLIC_SUPABASE_URL='https://example.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY='sb_publishable_test_placeholder'
const { supabase, saveSale, retryPendingSale, addExpense, addInventoryItem, archiveExpense, archiveInventoryItem } = await import('../lib/supabase.ts')
const storage=new Map()
Object.defineProperty(globalThis,'sessionStorage',{value:{
  getItem:key=>storage.get(key)??null,
  setItem:(key,value)=>storage.set(key,value),
  removeItem:key=>storage.delete(key)
}})
let account='synthetic-owner'
supabase.auth.getSession=async()=>({data:{session:{user:{id:account}}},error:null})
const calls=[]
let result={data:null,error:{code:'',message:'Network response lost'}}
supabase.rpc=async(name,args)=>{ calls.push({name,args}); return result }
await assert.rejects(()=>saveSale({item_name:'Synthetic garment'}))
assert.equal(storage.size,1)
await assert.rejects(()=>saveSale({item_name:'Another garment'}),/previous sale request/)
assert.equal(calls.length,1)
// After a lost response, permission denial must not discard the identity of a possibly committed sale.
result={data:null,error:{code:'42501',message:'Membership revoked'}}
await assert.rejects(()=>retryPendingSale())
assert.equal(storage.size,1)
// Successful retry must use the original payload and ID, even after the first form disappeared.
result={data:{id:'same-sale'},error:null}
await retryPendingSale()
assert.deepEqual(calls[2].args,calls[0].args)
assert.equal(storage.size,0)
console.log('PASS lost response blocks a second save; permission denial preserves pending request; retry reuses exact ID/payload')
result={data:null,error:{code:'22023',message:'Invalid amount'}}
await assert.rejects(()=>saveSale({sale_price:-1}))
assert.equal(storage.size,0)
result={data:{id:'valid-sale'},error:null}
await saveSale({sale_price:1})
console.log('PASS confirmed SQL rollback lets corrected input start a fresh request')
result={data:null,error:{code:'',message:'Network response lost'}}
await assert.rejects(()=>saveSale({sale_price:2}))
account='synthetic-other'
await assert.rejects(()=>retryPendingSale(),/No pending save/)
console.log('PASS a different signed-in account cannot replay another account’s pending save')

process.env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV='preview'
for (const action of [() => saveSale({}), () => retryPendingSale(), () => addExpense({}), () => addInventoryItem({}), () => archiveExpense('id'), () => archiveInventoryItem('id')]) {
  await assert.rejects(action, /preview is read only/)
}
console.log('PASS preview environment blocks every application write path before network access')
