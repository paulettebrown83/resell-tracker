import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { parse } from 'csv-parse/sync'
import { unzipSync } from 'fflate'
import { rowFor, options, derivative, pack, sha, TEMPLATE_SHA, RUNTIME } from '../lib/package-server/builder.mjs'
import { handle, step } from '../lib/package-server/service.mjs'
const id = randomUUID(), item = randomUUID(), photo = randomUUID()
function fixture(bytes) {
 return { id, listing_id: randomUUID(), account_id: randomUUID(), inventory_id: item, draft_version: 1, completed_images: 0, derivatives: [], outputs: {}, state: 'pending', snapshot: { template_sha256: TEMPLATE_SHA, runtime_version: RUNTIME, external_account_id: '5bb5431e42aa76fee623d5a6', fields: { title: 'Synthetic cotton shirt', description: 'Cotton "shirt"\nMeasurement < 10 and > 2.', size: 'L', price: 22, currency: 'USD', media_ids: [photo] }, native_fields: { Department: 'Women', Category: 'Tops' }, media: [{ id: photo, inventory_id: item, bucket: 'paulette-resale-originals-prod', object_key: `resale/items/${item}/${photo}/original`, mime_type: 'image/png', byte_size: bytes.length, sha256: sha(bytes) }] } }
}
const png = await sharp({ create: { width: 20, height: 12, channels: 4, background: '#ff000080' } }).png().toBuffer()
test('template taxonomy and saved fields produce exact draft controls; rejects markup/formula/identity mismatch', () => {
 const job = fixture(png), row = rowFor(job)
 assert.equal(row.Availability, 'Draft'); assert.equal(row['Quantity '], '1'); assert.equal(Object.keys(row).length, 30); assert.equal(row.SKU, 'R' + item.replaceAll('-', '').toUpperCase()); assert(options('Women', 'Tops').sizes.includes('L'))
 for (const desc of ['<b>shirt</b>', '=SUM(1,2)', 'Cotton\n• soft']) { const j = structuredClone(job); j.snapshot.fields.description = desc; assert.throws(() => rowFor(j)) }
 for (const mutate of [j => j.snapshot.fields.price = 22.1, j => j.snapshot.media[0].inventory_id = randomUUID(), j => j.snapshot.native_fields.SKU = 'forged', j => j.snapshot.media.push(j.snapshot.media[0])]) { const j = structuredClone(job); mutate(j); assert.throws(() => rowFor(j)) }
})
test('transparency, oriented dimensions, no enlargement, no private metadata and source-byte preservation', async () => {
 const before = Buffer.from(png), job = fixture(png), d = await derivative(png, job.snapshot.media[0])
 assert(png.equals(before)); assert.deepEqual([d.width, d.height], [20, 12]); const m = await sharp(d.data).metadata(); assert.equal(m.format, 'jpeg'); assert(!m.icc && !m.exif && !m.xmp)
 const pixel = await sharp(d.data).raw().toBuffer(); assert(pixel[0] > 245 && pixel[1] > 115 && pixel[1] < 145)
 const oriented = await sharp(png).withMetadata({ orientation: 6 }).jpeg().toBuffer(); const src = { ...job.snapshot.media[0], mime_type: 'image/jpeg', byte_size: oriented.length, sha256: sha(oriented) }; const o = await derivative(oriented, src); assert.deepEqual([o.width, o.height], [12, 20])
 const palette = await sharp(png).withIccProfile('srgb').png({ palette: true }).toBuffer(); const p = await derivative(palette, { ...src, mime_type: 'image/png', byte_size: palette.length, sha256: sha(palette) }); const rgb = await sharp(p.data).raw().toBuffer(); assert(rgb[0] > 245 && rgb[1] > 115 && rgb[1] < 145)
 await assert.rejects(() => derivative(png, { ...src, sha256: '0'.repeat(64) }))
})
test('CSV and ZIP reopen to exact identity and derivative bytes without originals or extras', async () => {
 const j = fixture(png), d = await derivative(png, j.snapshot.media[0]); j.derivatives = [{ ...d, data: undefined, name: `${j.id}/photo-0.jpg` }]
 const out = await pack(j, [d.data]), rows = parse(out.csv), files = unzipSync(out.zip), manifest = JSON.parse(out.manifest)
 assert.equal(rows.length, 2); assert.equal(rows[0].length, 30); assert.equal(rows[1][rows[0].indexOf('Description ')], j.snapshot.fields.description)
 assert.deepEqual(Object.keys(files), [`${rowFor(j).SKU}-CS.jpg`]); assert(Buffer.from(Object.values(files)[0]).equals(d.data)); assert.equal(manifest.remote_execution, false); assert.equal(manifest.media[0].sha256, sha(png)); assert.equal(manifest.csv_sha256, sha(out.csv))
 await assert.rejects(() => pack(j, [Buffer.from('tampered')]))
})
test('one-photo steps checkpoint then separate final package; failed checkpoint never reports ready', async () => {
 let j = fixture(png); const stored = new Map(); let checks = 0
 const svc = { original: async () => png, put: async (name, data) => { stored.set(name, data); return { name, byte_size: data.length, sha256: sha(data) } }, download: async name => stored.get(name), rpc: async (name, args) => {
  if (name === 'resale_claim_package') { j.state = 'processing'; j.lease_token = randomUUID(); return structuredClone(j) }
  if (name === 'resale_checkpoint_package') { checks++; j.derivatives.push(args.p_artifact); j.completed_images++; j.state = 'pending'; return j }
  if (name === 'resale_finish_package') { j.state = args.p_error ? 'failed' : 'ready'; j.outputs = args.p_outputs; return j }
 } }
 assert.equal((await step(j.id, svc)).state, 'pending'); assert.equal(checks, 1); assert.equal((await step(j.id, svc)).state, 'ready'); assert.equal(stored.size, 4)
})
test('route denies signed-out/foreign origin/preview before private work', async () => {
 const env = { NODE_ENV: 'production' }, make = () => { throw Error('must not access') }
 for (const [init, expected] of [[{},401],[{headers:{origin:'https://foreign.test',authorization:'Bearer nope'}},403]]) {
  const r = await handle(new Request('https://resell-tracker-beta.vercel.app/api/listing-packages',{method:'POST',headers:{origin:'https://resell-tracker-beta.vercel.app',...init.headers},body:'{}'}), make, env); assert.equal(r.status,expected)
 }
 const r = await handle(new Request('https://resell-tracker-beta.vercel.app/api/listing-packages',{method:'POST'}), make, {...env,VERCEL_ENV:'preview'});assert.equal(r.status,403)
})
test('actual SDK transport adopts only byte-identical stored retry and never overwrites', async () => {
 const {services}=await import('../lib/package-server/service.mjs');let duplicate=false,corrupt=false;const seen=[]
 const bytes=Buffer.from('synthetic prepared file'),svc=services('synthetic-bearer',{NEXT_PUBLIC_SUPABASE_URL:'https://tsgazdqrihjbzjjexdwv.supabase.co',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'public-fixture'},async(url,init)=>{
  seen.push({url:String(url),method:init?.method,upsert:new Headers(init?.headers).get('x-upsert')})
  if(String(url).includes('/object/authenticated/'))return new Response(corrupt?Buffer.from('different'):bytes)
  return duplicate?Response.json({statusCode:'409',error:'Duplicate',message:'The resource already exists'},{status:409}):Response.json({Key:'resale-listing-packages/'+id+'/listings.csv'})
 })
 assert.equal((await svc.put(id+'/listings.csv',bytes,'text/csv')).sha256,sha(bytes));duplicate=true;assert.equal((await svc.put(id+'/listings.csv',bytes,'text/csv')).sha256,sha(bytes));corrupt=true;await assert.rejects(()=>svc.put(id+'/listings.csv',bytes,'text/csv'))
 assert(seen.filter(s=>s.method==='POST').every(s=>s.upsert==='false'));assert(!seen.some(s=>s.url.includes('/public/')))
})
test('20 MiB original boundary remains byte-preserved; over40MP fails clearly', async()=>{
 const padded=Buffer.concat([png,Buffer.alloc(20*1024**2-png.length)]),job=fixture(padded),before=sha(padded)
 const d=await derivative(padded,job.snapshot.media[0]);assert.equal(sha(padded),before);assert.equal(d.width,20)
 const tooWide=await sharp({create:{width:6400,height:6300,channels:3,background:'#888888'}}).png().toBuffer()
 await assert.rejects(()=>derivative(tooWide,{...job.snapshot.media[0],byte_size:tooWide.length,sha256:sha(tooWide)}),e=>e.code==='photo_limit')
})
