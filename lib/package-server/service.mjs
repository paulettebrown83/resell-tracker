import { createClient } from '@supabase/supabase-js'
import { PackageError, need, uuid, sha, rowFor, derivative, pack, options, LIMITS } from './builder.mjs'
export const BUCKET = 'resale-listing-packages'
const ORIGIN = 'https://resell-tracker-beta.vercel.app'
const MEDIA = 'https://paulette-resale-media-prod.paulettebrown.workers.dev'
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }
export async function bounded(response, limit) {
  need(response.ok && response.body, 'read_failed', 'A private file could not be read. Resume the saved package to retry.')
  need(!response.headers.has('content-length') || Number(response.headers.get('content-length')) <= limit, 'file_limit', 'A private file exceeds the local preparation limit.')
  const reader = response.body.getReader(), chunks = []; let size = 0
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; need(size <= limit, 'file_limit', 'A private file exceeds the local preparation limit.'); chunks.push(value) } } finally { await reader.cancel().catch(() => {}) }
  return Buffer.concat(chunks, size)
}
export function services(token, env = process.env, fetcher = fetch) {
  const base = env.NEXT_PUBLIC_SUPABASE_URL, key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  need(base === 'https://tsgazdqrihjbzjjexdwv.supabase.co' && key, 'configuration', 'Package preparation is not configured.')
  const deadline = AbortSignal.timeout(105000)
  const requestSignal = () => AbortSignal.any([deadline, AbortSignal.timeout(45000)])
  const client = createClient(base, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` }, fetch: (url, init) => fetcher(url, { ...init, signal: requestSignal() }) } })
  const rpc = async (name, args) => { const { data, error } = await client.rpc(name, args); if (error) throw new PackageError(error.code, error.message); return data }
  const download = async (name, limit) => bounded(await fetcher(`${base}/storage/v1/object/authenticated/${BUCKET}/${name}`, { headers: { Authorization: `Bearer ${token}`, apikey: key }, redirect: 'error', cache: 'no-store', signal: requestSignal() }), limit)
  return {
    async access() { const { data, error } = await client.auth.getUser(token); need(!error && data.user && !data.user.is_anonymous, 'unauthorized', 'Sign in to prepare files.'); need(await rpc('resale_access', {}), 'forbidden', 'This account does not have resale access.') },
    rpc,
    async job(id) { const { data, error } = await client.from('resale_listing_packages').select('*').eq('id', id).single(); need(!error && data, 'stale', 'This package is unavailable or its saved draft changed. Refresh the draft.'); return data },
    original: async m => bounded(await fetcher(`${MEDIA}/v1/media/${m.id}`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', cache: 'no-store', signal: requestSignal() }), LIMITS.source),
    download,
    async put(name, bytes, contentType) {
      const { error } = await client.storage.from(BUCKET).upload(name, bytes, { contentType, upsert: false, cacheControl: '0' })
      // A prior attempt may have stored this immutable file and lost its response.
      // Every success/retry is reread under current access before its hash is adopted.
      if (error && !['400', '409'].includes(String(error.statusCode))) throw new PackageError('store_failed', 'Prepared file storage failed. Resume to retry.')
      const stored = await download(name, bytes.length)
      need(stored.length === bytes.length && sha(stored) === sha(bytes), 'stored_conflict', 'An existing prepared file differs from this exact request. Remove this package and prepare a new one.')
      return { name, sha256: sha(bytes), byte_size: bytes.length }
    },
    async remove(id) { const names = [...Array.from({ length: 16 }, (_, i) => `${id}/photo-${i}.jpg`), `${id}/listings.csv`, `${id}/photos.zip`, `${id}/manifest.json`]; const { error } = await client.storage.from(BUCKET).remove(names); need(!error, 'remove_failed', 'Some prepared files could not be removed. Retry removal.') },
  }
}
export function summary(job) { return { id: job.id, state: job.state, draft_version: job.draft_version, completed_images: job.completed_images, image_count: job.snapshot.media.length, current: true, outputs: job.outputs, last_error: job.last_error, lease_until: job.lease_until, updated_at: job.updated_at } }
let activeStep = false
export async function step(id, svc) {
  need(!activeStep, '55P03', 'Another preparation step is running. Resume shortly.')
  activeStep = true
  try { return await runStep(id, svc) } finally { activeStep = false }
}
async function runStep(id, svc) {
  const job = await svc.rpc('resale_claim_package', { p_id: id })
  if (job.state === 'ready') return summary(job)
  try {
    rowFor(job)
    if (job.completed_images < job.snapshot.media.length) {
      const source = job.snapshot.media[job.completed_images]
      const bytes = await svc.original(source)
      const image = await derivative(bytes, source)
      const stored = await svc.put(`${job.id}/photo-${job.completed_images}.jpg`, image.data, 'image/jpeg')
      const done = await svc.rpc('resale_checkpoint_package', { p_id: id, p_lease: job.lease_token, p_artifact: { ...stored, width: image.width, height: image.height, media_id: image.media_id } })
      return summary(done)
    }
    const photos = []
    for (const d of job.derivatives) photos.push(await svc.download(d.name, LIMITS.derivative))
    const files = await pack(job, photos), outputs = {}
    for (const [kind, name, type] of [['csv', 'listings.csv', 'text/csv'], ['zip', 'photos.zip', 'application/zip'], ['manifest', 'manifest.json', 'application/json']]) outputs[kind] = await svc.put(`${id}/${name}`, files[kind], type)
    return summary(await svc.rpc('resale_finish_package', { p_id: id, p_lease: job.lease_token, p_outputs: outputs, p_error: null }))
  } catch (error) {
    const code = error instanceof PackageError && /^[a-z_]{1,60}$/.test(error.code) ? error.code : 'preparation_failed'
    await svc.rpc('resale_finish_package', { p_id: id, p_lease: job.lease_token, p_outputs: null, p_error: code }).catch(() => {})
    throw error
  }
}
export async function handle(request, makeServices = services, env = process.env) {
  try {
    const url = new URL(request.url)
    const local = env.NODE_ENV === 'development' && ['http://localhost:3018', 'http://127.0.0.1:3018'].includes(url.origin)
    need((url.origin === ORIGIN || local) && env.VERCEL_ENV !== 'preview' && env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV !== 'preview', 'forbidden', 'Use the production tracker to prepare files.')
    need(request.headers.get('origin') === url.origin, 'forbidden', 'Open package preparation from the tracker.')
    const auth = request.headers.get('authorization') || ''
    need(/^Bearer [^\s]{1,8192}$/.test(auth), 'unauthorized', 'Sign in to prepare files.')
    const svc = makeServices(auth.slice(7)); await svc.access()
    const raw = await bounded(new Response(request.body), 10000), input = JSON.parse(raw.toString('utf8'))
    need(input && typeof input === 'object' && !Array.isArray(input), 'request_invalid', 'Invalid package request.')
    if (input.action === 'options') return Response.json(options(input.department, input.category), { headers })
    if (input.action === 'list') { need(uuid(input.listing_id), 'request_invalid', 'Choose a saved draft.'); return Response.json(await svc.rpc('resale_package_summaries', { p_listing_id: input.listing_id }), { headers }) }
    need(uuid(input.id), 'request_invalid', 'A stable package request is required.')
    if (input.action === 'abandon') return Response.json(await svc.rpc('resale_abandon_package_request', { p_id: input.id }), { headers })
    if (input.action === 'receipt') return Response.json(await svc.rpc('resale_package_receipt', { p_id: input.id }), { headers })
    if (input.action === 'start') {
      const job = await svc.rpc('resale_request_package', { p_request_id: input.id, p_payload: input.payload })
      rowFor(job)
      return Response.json(summary(job), { headers })
    }
    if (input.action === 'step') return Response.json(await step(input.id, svc), { headers })
    if (input.action === 'discard') { await svc.rpc('resale_discard_package', { p_id: input.id, p_complete: false }); await svc.remove(input.id); return Response.json(await svc.rpc('resale_discard_package', { p_id: input.id, p_complete: true }), { headers }) }
    throw new PackageError('request_invalid', 'Unknown package action.')
  } catch (error) {
    const known = error instanceof PackageError
    const status = known && ['unauthorized'].includes(error.code) ? 401 : known && ['forbidden', '42501'].includes(error.code) ? 403 : known && ['40001', '55P03', 'stale', 'stored_conflict'].includes(error.code) ? 409 : 422
    return Response.json({ error: known ? error.message : 'Preparation paused. Resume the saved package to try again.', code: known ? error.code : 'preparation_failed' }, { status, headers })
  }
}
