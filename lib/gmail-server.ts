import { randomBytes } from 'node:crypto'
const ORIGIN = 'https://resell-tracker-beta.vercel.app'
const CALLBACK_PATH = '/api/integrations/gmail/callback'
const COOKIE = '__Secure-resale_gmail_oauth'
const baseHeaders = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }
const cookie = (value: string, age: number) => `${COOKIE}=${value}; Max-Age=${age}; Path=${CALLBACK_PATH}; Secure; HttpOnly; SameSite=Lax`
const token = /^[A-Za-z0-9_-]{43}$/
function enabled(request: Request) {
  return process.env.VERCEL_ENV !== 'preview' && process.env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV !== 'preview' && new URL(request.url).origin === ORIGIN
}
async function edge(input: object, bearer?: string) {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(base || '')) throw Error('Connection setup unavailable')
  const response = await fetch(`${base}/functions/v1/resale-gmail-sync`, {
    method: 'POST', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(25000),
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: bearer } : {}) }, body: JSON.stringify(input),
  })
  if (!response.ok) throw Error('Connection could not be verified')
  return await response.json()
}
export async function gmailStart(request: Request) {
  if (!enabled(request) || request.headers.get('Origin') !== ORIGIN) return Response.json({ error: 'Use the production app to connect Gmail.' }, { status: 403, headers: baseHeaders })
  const bearer = request.headers.get('Authorization') || ''
  if (!/^Bearer [^\s]+$/.test(bearer)) return Response.json({ error: 'Sign in first.' }, { status: 401, headers: baseHeaders })
  try {
    const raw = await request.text()
    if (raw.length > 256) throw Error('Invalid request')
    const input = JSON.parse(raw)
    if (!/^[a-f0-9-]{36}$/i.test(input.feed_id || '') || Object.keys(input).some(key => key !== 'feed_id')) throw Error('Invalid request')
    const binding = randomBytes(32).toString('base64url')
    const result = await edge({ op: 'start', feed_id: input.feed_id, browser_binding: binding }, bearer)
    const url = new URL(result.authorization_url)
    if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth') throw Error('Invalid authorization response')
    return Response.json({ authorization_url: url.href }, { headers: { ...baseHeaders, 'Set-Cookie': cookie(binding, 600) } })
  } catch { return Response.json({ error: 'Gmail connection could not start. Check the feed setup and try again.' }, { status: 503, headers: baseHeaders }) }
}
export async function gmailCallback(request: Request) {
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
      if ((!providerError && (!code || code.length > 2048)) || (providerError && code)) throw Error('Invalid callback')
      const result = await edge({ op: 'callback', browser_binding: binding, state, ...(providerError ? { error: 'access_denied' } : { code }) })
      outcome = result.status === 'active' ? 'connected' : result.status === 'cancelled' ? 'cancelled' : 'paused'
    } catch { /* Never log query parameters, cookies, provider errors or token material. */ }
  }
  return new Response(null, { status: 303, headers: { ...baseHeaders, 'Set-Cookie': cookie('', 0), Location: `${ORIGIN}/integrations/gmail?result=${outcome}` } })
}
