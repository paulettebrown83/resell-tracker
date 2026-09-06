import assert from 'node:assert/strict'
process.env.NEXT_PUBLIC_SUPABASE_URL='https://example.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY='sb_publishable_test_placeholder'
const {supabase,signInWithGoogle,completeGoogleSignIn}=await import('../lib/supabase.ts')
Object.defineProperty(globalThis,'window',{value:{location:{origin:'http://localhost:3017'}}})
let options
supabase.auth.signInWithOAuth=async input=>{options=input;return {data:{url:'https://accounts.google.com'},error:null}}
await signInWithGoogle()
assert.deepEqual(options,{provider:'google',options:{redirectTo:'http://localhost:3017/auth/callback',queryParams:{prompt:'select_account'}}})
assert.equal(supabase.auth.flowType,'pkce')
assert.equal(supabase.auth.detectSessionInUrl,false)
console.log('PASS Google flow uses PKCE and a same-origin callback without automatic competing code exchange')
let exchanges=[]
supabase.auth.exchangeCodeForSession=async(...args)=>{exchanges.push(args);return{data:{session:{user:{id:'synthetic'}}},error:null}}
await completeGoogleSignIn('?code=one-use-code&sb_flow_id=bound-flow&next=https://attacker.invalid')
assert.deepEqual(exchanges[0],['one-use-code',{flowId:'bound-flow'}])
for(const query of ['','?code=a&code=b','?error=access_denied&error_description=private-detail','?code=a&sb_flow_id=b&sb_flow_id=c']) await assert.rejects(()=>completeGoogleSignIn(query))
assert.equal(exchanges.length,1)
supabase.auth.exchangeCodeForSession=async()=>({data:{session:null},error:{message:'sensitive-provider-details'}})
await assert.rejects(()=>completeGoogleSignIn('?code=expired'),error=>!error.message.includes('sensitive-provider-details'))
console.log('PASS callback binds flow ID, ignores external next URLs, rejects malformed/cancelled/expired flows and hides provider error details')
