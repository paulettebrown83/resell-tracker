import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
const code=ts.transpileModule(fs.readFileSync(new URL('../lib/listing-guidance.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const context={exports:{}};vm.runInNewContext(code,context)
const {validateListingDraft:validate,resolveDraftFields:resolve,PLATFORM_GUIDANCE}=context.exports
const now={channel:'consumer',market:'US',today:'2026-09-06'},exceeds=r=>r.issues.some(x=>x.code==='exceeds_sourced_limit')
assert.equal(validate('ebay',{price:-1},now).draft_save_allowed,false)
assert.equal(validate('ebay',{price:null},now).draft_save_allowed,true)
assert(exceeds(validate('ebay',{title:'x'.repeat(81)},now)))
assert(!exceeds(validate('poshmark',{description:'x'.repeat(1501)},now)))
assert(exceeds(validate('poshmark',{description:'x'.repeat(1501)},{...now,channel:'bulk'})))
assert(!exceeds(validate('depop',{description:'x'.repeat(1001)},now)))
assert(exceeds(validate('depop',{description:'x'.repeat(1001)},{...now,channel:'api'})))
assert(!exceeds(validate('ebay',{title:'x'.repeat(100)},{...now,today:'2026-12-01'})))
assert(validate('ebay',{}, {...now,today:'2026-12-01'}).issues.some(x=>x.code==='rule_needs_refresh'))
assert(!exceeds(validate('vinted',{title:'x'.repeat(500),description:'x'.repeat(3000)},now)))
assert.equal(resolve({title:'base',price:10},{title:null,price:undefined}).title,null)
assert.equal(resolve({price:10},{price:undefined}).price,10)
assert.equal(validate('depop',{description:'#one'},{...now,channel:'api'},{hashtag_target:5}).publish_ready,false)
assert(!exceeds(validate('depop',{description:'#one'},{...now,channel:'api'},{hashtag_target:5})))
assert(validate('ebay',{description:'Hello 🌞'},now,{avoid_emojis:true}).issues.some(x=>x.code==='writing_preference'))
for(const item of Object.values(PLATFORM_GUIDANCE))for(const r of item.rules)assert(r.source.reference&&r.source.retrieved_at&&r.channels.length&&r.market)
console.log('PASS scoped/sourced rules, stale limits, unknowns, clearing overrides, preferences and no publish-ready claim')
