import {listingPhotoRoute} from './listing-photos.mjs';
/** Private originals gateway. No secret, token, request body, or upstream error logging. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BUCKET = 'paulette-resale-originals-prod';
const LIMIT = 20 * 1024 * 1024;
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});

export function detectMime(b) {
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.length >= 24 && [137,80,78,71,13,10,26,10].every((v,i) => b[i] === v) && String.fromCharCode(...b.slice(12,16)) === 'IHDR') return 'image/png';
  if (b.length >= 10 && ['GIF87a','GIF89a'].includes(String.fromCharCode(...b.slice(0,6)))) return 'image/gif';
  if (b.length >= 16 && String.fromCharCode(...b.slice(0,4)) === 'RIFF' && String.fromCharCode(...b.slice(8,12)) === 'WEBP' && ['VP8 ','VP8L','VP8X'].includes(String.fromCharCode(...b.slice(12,16)))) return 'image/webp';
  return null;
}
async function boundedBody(request, expected, max) {
  if (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity') fail(415, 'Upload original uncompressed file bytes.');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) !== expected)) fail(400, 'Upload size does not match its reservation.');
  if (!Number.isSafeInteger(expected) || expected <= 0 || expected > max) fail(413, 'Image exceeds the upload limit.');
  if (!request.body) fail(400, 'Image bytes are missing.');
  const bytes = new Uint8Array(expected), reader = request.body.getReader();
  let count = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      if (count + value.byteLength > expected) { await reader.cancel(); fail(413, 'Upload exceeds its reserved size.'); }
      bytes.set(value, count); count += value.byteLength;
    }
  } finally { reader.releaseLock(); }
  if (count !== expected) fail(400, 'Upload was incomplete. Retry the same original.');
  return bytes;
}
async function api(env, token, path, options = {}) {
  // Workers only supports manual/follow. Never follow upstream redirects with bearer credentials.
  const response = await fetch(`${env.SUPABASE_URL}${path}`, {
    ...options, redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: {'apikey': env.SUPABASE_PUBLISHABLE_KEY, 'Authorization': token, 'Content-Type': 'application/json', ...options.headers},
  });
  if (!response.ok) fail(response.status === 401 || response.status === 403 ? 401 : 503, response.status === 401 || response.status === 403 ? 'Sign in again to access photos.' : 'Photo authorization is temporarily unavailable.');
  return response.json();
}
async function reservation(request, env, id) {
  const token = request.headers.get('authorization') || '';
  if (!/^Bearer [A-Za-z0-9._~-]+$/.test(token)) fail(401, 'Sign in to access photos.');
  const user = await api(env, token, '/auth/v1/user');
  if (!UUID.test(user.id || '') || user.is_anonymous === true) fail(401, 'A verified account is required.');
  const member = await api(env, token, '/rest/v1/rpc/resale_access', {method:'POST', body:'{}'});
  if (member !== true) fail(403, 'This account does not have resale access.');
  const rows = await api(env, token, `/rest/v1/resale_media?id=eq.${id}&select=id,inventory_id,bucket,object_key,kind,state,mime_type,byte_size,sha256&limit=1`);
  const row = Array.isArray(rows) && rows[0];
  if (!row || row.id !== id) fail(404, 'Photo reservation was not found.');
  if (!UUID.test(row.inventory_id) || row.kind !== 'original' || row.bucket !== BUCKET || row.object_key !== `resale/items/${row.inventory_id}/${id}/original`) fail(409, 'Photo reservation is invalid.');
  return row;
}
function matches(object, row, hash, size, mime) {
  return object && object.size === size && object.customMetadata?.media_id === row.id && object.customMetadata?.inventory_id === row.inventory_id && object.customMetadata?.sha256 === hash && object.httpMetadata?.contentType === mime && object.checksums?.sha256 && hex(object.checksums.sha256) === hash;
}
async function receipt(env, row, hash, size, mime) {
  const payload = JSON.stringify({v:1, media_id:row.id, inventory_id:row.inventory_id, bucket:BUCKET, object_key:row.object_key, sha256:hash, byte_size:size, mime_type:mime, expires_at:Math.floor(Date.now()/1000)+600});
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(env.MEDIA_RECEIPT_KEY.match(/../g), h => parseInt(h,16)), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  return {receipt_payload:payload, receipt_signature:hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))};
}
async function route(request, env) {
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(env.SUPABASE_URL || '') || !env.SUPABASE_PUBLISHABLE_KEY || !/^[a-f0-9]{64}$/.test(env.MEDIA_RECEIPT_KEY || '')) fail(503, 'Photo service is not configured.');
  const url = new URL(request.url);
  if(url.pathname.startsWith('/v1/listing-photo'))return listingPhotoRoute(request,env,{api,fail,json,hex,detectMime});
  const match = url.pathname.match(/^\/v1\/media\/([0-9a-f-]+)$/);
  if (!match || !UUID.test(match[1]) || url.search) fail(404, 'Not found.');
  if (!['PUT','GET'].includes(request.method)) fail(405, 'Method not allowed.');
  const row = await reservation(request, env, match[1]);
  if (request.method === 'GET') {
    if (row.state !== 'ready') fail(409, 'Photo is not ready.');
    const object = await env.RESALE_ORIGINALS.get(row.object_key);
    if (!matches(object, row, row.sha256, row.byte_size, row.mime_type)) fail(409, 'Stored original could not be verified.');
    return new Response(object.body, {headers:{'Content-Type':row.mime_type,'Content-Length':String(object.size), 'Content-Disposition':`attachment; filename="${row.id}.${({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'})[row.mime_type] || 'bin'}"`}});
  }
  if (!['pending','ready'].includes(row.state)) fail(409, 'This photo reservation cannot receive uploads.');
  const configuredMax = Number(env.MAX_UPLOAD_BYTES || LIMIT);
  if (!Number.isSafeInteger(configuredMax) || configuredMax < 1 || configuredMax > LIMIT) fail(503, 'Photo upload limit is not configured.');
  const bytes = await boundedBody(request, row.byte_size, configuredMax);
  const mime = detectMime(bytes);
  if (!mime || mime !== row.mime_type || request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== mime) fail(415, 'Use a JPEG, PNG, WebP, or GIF original matching its reservation.');
  const hashBuffer = await crypto.subtle.digest('SHA-256',bytes), hash = hex(hashBuffer);
  if (row.sha256 && row.sha256 !== hash) fail(409, 'These bytes differ from the reserved original.');
  const existing = await env.RESALE_ORIGINALS.head(row.object_key);
  if (existing && !matches(existing,row,hash,bytes.byteLength,mime)) fail(409, 'An original already exists here. Create a new photo reservation.');
  if (!existing) {
    if (row.state === 'ready') fail(409, 'Stored original is missing. Contact support before replacing it.');
    await env.RESALE_ORIGINALS.put(row.object_key, bytes, {onlyIf:new Headers({'If-None-Match':'*'}),sha256:hashBuffer,httpMetadata:{contentType:mime,cacheControl:'private, no-store'},customMetadata:{media_id:row.id,inventory_id:row.inventory_id,sha256:hash}});
  }
  // Check the actual winner after conditional PUT, including concurrent retry/race.
  const stored = await env.RESALE_ORIGINALS.head(row.object_key);
  if (!matches(stored,row,hash,bytes.byteLength,mime)) fail(409, 'Upload was not confirmed. Retry this original without replacing it.');
  return json(await receipt(env,row,hash,bytes.byteLength,mime));
}
const worker = {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);
    let response;
    if (origin && !allowed.includes(origin)) response = json({error:'This site cannot access the photo service.'},403);
    else if (request.method === 'OPTIONS') {
      const method = request.headers.get('Access-Control-Request-Method');
      const headers = (request.headers.get('Access-Control-Request-Headers') || '').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
      response = origin && ['PUT','GET','POST'].includes(method) && headers.every(h=>['authorization','content-type'].includes(h)) ? new Response(null,{status:204,headers:{'Access-Control-Allow-Methods':'GET, PUT, POST','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'600'}}) : json({error:'Preflight denied.'},403);
    } else {
      try { response = await route(request,env); }
      catch (error) { response = json({error:error instanceof HttpError ? error.message : 'Photo service is temporarily unavailable. Retry the same original.'}, error instanceof HttpError ? error.status : 503); }
    }
    const headers = new Headers(response.headers);
    headers.set('Cache-Control','private, no-store'); headers.set('Vary','Origin');
    headers.set('X-Content-Type-Options','nosniff'); headers.set('Content-Security-Policy',"default-src 'none'; sandbox");
    if (origin && allowed.includes(origin)) headers.set('Access-Control-Allow-Origin',origin);
    return new Response(response.body,{status:response.status,headers});
  }
};

export default worker;
