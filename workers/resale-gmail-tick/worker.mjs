async function signHex(keyHex,text){
 if(!/^[a-f0-9]{64}$/i.test(keyHex||''))throw Error('Gmail tick signing configuration unavailable');
 const key=await crypto.subtle.importKey('raw',Uint8Array.from(keyHex.match(/../g),h=>parseInt(h,16)),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
}
const worker = {
 async scheduled(_event,env){
  if(!/^https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/resale-gmail-sync$/.test(env.GMAIL_EDGE_URL||''))throw Error('Gmail tick configuration unavailable');
  const tick=JSON.stringify({v:1,nonce:crypto.randomUUID(),expires_at:Math.floor(Date.now()/1000)+120});
  const signature=await signHex(env.GMAIL_TICK_SIGNING_KEY,`gmail_tick_v1\n${tick}`);
  const response=await fetch(env.GMAIL_EDGE_URL,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'tick',tick,signature}),signal:AbortSignal.timeout(90000)});
  if(!response.ok)throw Error('Gmail tick was not accepted');
 },
 fetch(){return new Response('Not found',{status:404});},
};

export default worker;
