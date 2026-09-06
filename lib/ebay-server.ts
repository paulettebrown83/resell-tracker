import { randomBytes } from 'node:crypto'
const ORIGIN = 'https://resell-tracker-beta.vercel.app'
const CALLBACK_PATH = '/api/integrations/ebay/callback'
const COOKIE = '__Secure-resale_ebay_oauth'
const baseHeaders = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }
const cookie = (value: string, age: number) => `${COOKIE}=${value}; Max-Age=${age}; Path=${CALLBACK_PATH}; Secure; HttpOnly; SameSite=Lax`
const token = /^[A-Za-z0-9_-]{43}$/
function enabled(request: Request) {
  return process.env.VERCEL_ENV !== 'preview' && process.env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV !== 'preview' && new URL(request.url).origin === ORIGIN
}
async function edge(input: object, bearer?: string) {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(base || '')) throw Error('Connection setup unavailable')
  const response = await fetch(`${base}/functions/v1/resale-ebay-connect`, {
    method: 'POST', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(55000),
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: bearer } : {}) }, body: JSON.stringify(input),
  })
  if (!response.ok) throw Object.assign(Error('Connection could not be verified'), {status:response.status})
  return await response.json()
}
export async function ebayStart(request: Request) {
  if (!enabled(request) || request.headers.get('Origin') !== ORIGIN) return Response.json({ error: 'Use the production app to connect eBay.' }, { status: 403, headers: baseHeaders })
  const bearer = request.headers.get('Authorization') || ''
  if (!/^Bearer [^\s]+$/.test(bearer)) return Response.json({ error: 'Sign in first.' }, { status: 401, headers: baseHeaders })
  try {
    const raw = await request.text()
    if (raw.length > 256) throw Error('Invalid request')
    const input = JSON.parse(raw)
    if (!/^[a-f0-9-]{36}$/i.test(input.account_id || '') || Object.keys(input).some(key => key !== 'account_id')) throw Error('Invalid request')
    const binding = randomBytes(32).toString('base64url')
    const result = await edge({ op: 'start', account_id: input.account_id, browser_binding: binding }, bearer)
    const url = new URL(result.authorization_url)
    if (url.origin !== 'https://auth.ebay.com' || url.pathname !== '/oauth2/authorize') throw Error('Invalid authorization response')
    return Response.json({ authorization_url: url.href }, { headers: { ...baseHeaders, 'Set-Cookie': cookie(binding, 600) } })
  } catch { return Response.json({ error: 'eBay connection could not start. Check the account setup and try again.' }, { status: 503, headers: baseHeaders }) }
}
export async function ebayCallback(request: Request) {
  let outcome = 'failed'
  if (enabled(request)) {
    try {
      const params = new URL(request.url).searchParams
      const bindings = (request.headers.get('Cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`))
      if (bindings.length !== 1 || params.getAll('state').length !== 1 || params.getAll('code').length > 1 || params.getAll('error').length > 1) throw Error('Invalid callback')
      const binding = bindings[0].slice(COOKIE.length + 1), state = params.get('state') || ''
      if (!token.test(binding) || !token.test(state)) throw Error('Invalid callback')
      const providerError = params.has('error')
      const code = params.get('code')
      if ((!providerError && (!code || code.length > 4096)) || (providerError && code)) throw Error('Invalid callback')
      const result = await edge({ op: 'callback', browser_binding: binding, state, ...(providerError ? { error: 'access_denied' } : { code }) })
      outcome = result.status === 'connected' ? 'connected' : result.status === 'cancelled' ? 'cancelled' : 'paused'
    } catch { /* Never log query parameters, cookies, provider errors or token material. */ }
  }
  return new Response(null, { status: 303, headers: { ...baseHeaders, 'Set-Cookie': cookie('', 0), Location: `${ORIGIN}/integrations/ebay?result=${outcome}` } })
}

export async function ebayRead(request: Request) {
  if (!enabled(request) || request.headers.get('Origin') !== ORIGIN) return Response.json({error:'Use the production tracker.'},{status:403,headers:baseHeaders})
  const bearer=request.headers.get('Authorization')||''
  if(!/^Bearer [^\s]+$/.test(bearer))return Response.json({error:'Sign in first.'},{status:401,headers:baseHeaders})
  try { const raw=await request.text(); if(raw.length>2048)throw Error('Too large');const input=JSON.parse(raw)
    if(Object.keys(input).some(key=>!['account_id','request_id','kind','page','from','to'].includes(key)))throw Error('Invalid request')
    return Response.json(await edge({...input,op:'read'},bearer),{headers:baseHeaders})
  }catch{return Response.json({error:'The eBay read was not confirmed. Retry the saved request after checking connection status.'},{status:409,headers:baseHeaders})}
}
export async function ebayDeletion(request: Request) {
  if(!enabled(request))return Response.json({error:'Endpoint unavailable'},{status:503,headers:baseHeaders})
  try {if(request.method==='GET'){const p=new URL(request.url).searchParams;if(p.getAll('challenge_code').length!==1)throw Error('Invalid challenge');const result=await edge({op:'deletion',challenge_code:p.get('challenge_code')});return Response.json(result,{headers:baseHeaders})}
    const reader=request.body?.getReader();if(!reader)throw Error('Empty body');let size=0;const chunks:Uint8Array[]=[]
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>60000)throw Error('Too large');chunks.push(value)}}finally{await reader.cancel().catch(()=>{})}
    const message=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))
    await edge({op:'deletion',signature:request.headers.get('x-ebay-signature'),message})
    return new Response(null,{status:202,headers:baseHeaders})
  }catch(error){return Response.json({error:'Notice not accepted'},{status:error instanceof Error && 'status' in error && error.status===412?412:503,headers:baseHeaders})}
}

export async function ebayListingRun(request: Request) {
  if (!enabled(request) || request.headers.get('Origin') !== ORIGIN) return Response.json({error:'Use the production tracker.'},{status:403,headers:baseHeaders})
  const bearer=request.headers.get('Authorization')||''
  if(!/^Bearer [^\s]+$/.test(bearer))return Response.json({error:'Sign in first.'},{status:401,headers:baseHeaders})
  try {const raw=await request.text();if(raw.length>512)throw Error('Too large');const input=JSON.parse(raw)
    if(!['listing_run_start','listing_run_step'].includes(input.op)||Object.keys(input).some(key=>!['op','account_id','run_id'].includes(key)))throw Error('Invalid request')
    return Response.json(await edge(input,bearer),{headers:baseHeaders})
  }catch{return Response.json({error:'The listing read paused. Resume the saved run after checking connection status.'},{status:409,headers:baseHeaders})}
}
