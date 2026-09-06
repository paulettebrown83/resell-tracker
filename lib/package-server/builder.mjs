import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { zipSync, unzipSync } from 'fflate'
import { parse } from 'csv-parse/sync'
import template from './poshmark-template.json' with { type: 'json' }

// Bound libvips per-process cache and photo decoding; requests still run one original at a time.
sharp.cache(false)
sharp.concurrency(1)
export const LIMITS = Object.freeze({ source: 20 * 1024 ** 2, pixels: 40_000_000, photos: 16, derivative: 8 * 1024 ** 2, total: 60 * 1024 ** 2, output: 64 * 1024 ** 2 })
export const TEMPLATE_SHA = 'f6c51f1f8d319122b6b1fea1d96f886e26e28d87811ff36a402b7cbe6b3b35f2'
export const RUNTIME = 'poshmark-package-node-v1'
export const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export class PackageError extends Error { constructor(code, message) { super(message); this.code = code } }
export function need(ok, code, message) { if (!ok) throw new PackageError(code, message) }
export const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const contractSHA = 'b03a120ba0a40c1d25315f7b5ed27b4f32dc5140cd118e1f595e865020ea6606'
need(sha(JSON.stringify(template) + '\n') === contractSHA && template.source_sha256 === TEMPLATE_SHA && template.columns_exact.length === 30, 'template_changed', 'The inspected Poshmark template needs review.')
const colors = new Set(['Red', 'Pink', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple', 'Gold', 'Silver', 'Black', 'Gray', 'White', 'Cream', 'Brown', 'Tan'])
export const nativeKeys = ['Department', 'Category', 'Sub-category', 'Brand', 'Color1', 'Color2', 'Orig price ']
const lengths = { Title: 80, 'Description ': 1500, Department: 100, Category: 100, 'Sub-category': 100, Size: 100, Condition: 20, Brand: 100, Color1: 100, Color2: 100, 'Orig price ': 20, 'Listing price': 20 }
export function options(department, category) {
  return { departments: [...new Set(template.category_rows.map(r => r[0]))], categories: department ? [...new Set(template.category_rows.filter(r => r[0] === department).map(r => r[1]))] : [], subcategories: category ? [...new Set(template.category_rows.filter(r => r[0] === department && r[1] === category).map(r => r[2]).filter(Boolean))] : [], sizes: category ? [...new Set(template.size_rows.filter(r => r[0] === category).map(r => r[1]))] : [], colors: [...colors] }
}
export function rowFor(job) {
  need(uuid(job.id) && uuid(job.account_id) && uuid(job.inventory_id) && uuid(job.listing_id) && Number.isInteger(job.draft_version) && job.draft_version > 0, 'invalid_binding', 'The saved package identity is incomplete.')
  const s = job.snapshot, f = s.fields
  need(s.runtime_version === RUNTIME && s.template_sha256 === TEMPLATE_SHA && s.external_account_id === '5bb5431e42aa76fee623d5a6', 'invalid_binding', 'The saved account or preparation version changed.')
  need(s.native_fields && Object.keys(s.native_fields).every(k => nativeKeys.includes(k)), 'unsupported_field', 'Unsupported Poshmark preparation field.')
  const fields = { ...s.native_fields }
  for (const [key, dest] of [['title', 'Title'], ['description', 'Description '], ['size', 'Size'], ['condition', 'Condition']]) if (f[key] != null) fields[dest] = f[key]
  if (f.price != null) {
    need(Number.isSafeInteger(f.price) && f.price >= 0 && f.price < 100000000 && f.currency === 'USD', 'price_review', 'Save a whole-dollar USD price for this Poshmark file. The price was not rounded.')
    fields['Listing price'] = String(f.price)
  }
  const row = Object.fromEntries(template.columns_exact.map(k => [k, '']))
  Object.assign(row, { SKU: 'R' + job.inventory_id.replaceAll('-', '').toUpperCase(), 'Quantity ': '1', Availability: 'Draft' })
  for (const [key, value] of Object.entries(fields)) {
    need(typeof value === 'string' && value.length <= lengths[key], 'copy_review', `${key.trim()} needs a supported text value.`)
    need(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) && !/^[\s]*[=+@-]/.test(value), 'copy_review', `${key.trim()} contains a control or formula-like value. Review the saved copy; it was not changed.`)
    if (key === 'Description ') need(!/^\s*[-*•]\s/m.test(value) && !/<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]*)?\/?>|<!--|<!DOCTYPE|<\?/i.test(value), 'copy_review', 'The Poshmark description needs plain text without HTML or bullet lists. Saved copy was not changed.')
    row[key] = value
  }
  need(template.category_rows.some(r => r[0] === row.Department && r[1] === row.Category && (!row['Sub-category'] || r[2] === row['Sub-category'])), 'category_review', 'Choose a department and category from the inspected Poshmark template.')
  need(template.size_rows.some(r => r[0] === row.Category && r[1] === row.Size), 'size_review', 'The saved size does not match this Poshmark category. Update the saved draft size first.')
  need(['', 'NWT', 'Like New', 'Good', 'Fair'].includes(row.Condition), 'condition_review', 'The saved condition needs a supported Poshmark value: NWT, Like New, Good or Fair.')
  for (const key of ['Orig price ', 'Listing price']) need(!row[key] || /^\d+$/.test(row[key]), 'price_review', 'The Poshmark file needs a whole-dollar price.')
  for (const key of ['Color1', 'Color2']) need(!row[key] || colors.has(row[key]), 'color_review', 'Choose a supported Poshmark color.')
  need(Array.isArray(s.media) && s.media.length > 0 && s.media.length <= LIMITS.photos && new Set(s.media.map(m => m.id)).size === s.media.length, 'media_review', 'Choose one to sixteen distinct original photos.')
  for (const m of s.media) need(uuid(m.id) && m.inventory_id === job.inventory_id && m.bucket === 'paulette-resale-originals-prod' && m.object_key === `resale/items/${job.inventory_id}/${m.id}/original` && /^[0-9a-f]{64}$/.test(m.sha256) && Number.isSafeInteger(m.byte_size) && m.byte_size > 0 && m.byte_size <= LIMITS.source, 'media_review', 'A saved original photo has changed or belongs to another item.')
  return row
}
export async function derivative(bytes, source) {
  need(bytes.length === source.byte_size && sha(bytes) === source.sha256 && bytes.length <= LIMITS.source, 'original_changed', 'Original photo verification failed. Refresh the item before trying again.')
  let pipeline = sharp(bytes, { limitInputPixels: LIMITS.pixels, failOn: 'error' }).timeout({ seconds: 35 })
  let meta
  try { meta = await pipeline.metadata() } catch (error) {
    if (/pixel limit/i.test(error.message)) throw new PackageError('photo_limit', 'This original exceeds the local 40-million-pixel preparation limit. Choose a smaller original or review the photo separately.')
    throw new PackageError('unsupported_photo', 'This original could not be decoded as a supported photo. Choose another saved original or review the photo separately.')
  }
  need(({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' })[meta.format] === source.mime_type, 'unsupported_photo', 'This original is not a supported raster photo.')
  need((meta.pages || 1) === 1 && meta.width * meta.height <= LIMITS.pixels, 'photo_limit', 'This photo is animated or exceeds the local 40-million-pixel preparation limit.')
  need(meta.space !== 'cmyk' || meta.icc, 'color_review', 'This CMYK photo needs a color profile before preparation.')
  pipeline = pipeline.autoOrient().withIccProfile('srgb', { attach: false }).flatten({ background: '#ffffff' }).resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true })
  need(data.length <= LIMITS.derivative, 'photo_limit', 'This prepared photo exceeds the local 8 MiB limit.')
  const clean = await sharp(data).metadata()
  need(!clean.exif && !clean.icc && !clean.xmp && !clean.iptc && !clean.comments, 'metadata_check', 'Prepared photo metadata could not be removed.')
  return { data, sha256: sha(data), byte_size: data.length, width: info.width, height: info.height, media_id: source.id }
}
export async function pack(job, photos) {
  const row = rowFor(job)
  need(photos.length === job.snapshot.media.length && photos.length === job.derivatives.length, 'incomplete_photos', 'The package is still missing prepared photos.')
  let total = 0
  const entries = {}, media = []
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i], d = job.derivatives[i], original = job.snapshot.media[i]
    need(d.name === `${job.id}/photo-${i}.jpg` && d.media_id === original.id && p.length === d.byte_size && sha(p) === d.sha256, 'derivative_changed', 'A prepared photo no longer matches its saved checkpoint.')
    total += p.length
    need(p.length <= LIMITS.derivative && total <= LIMITS.total, 'package_limit', 'This package exceeds the local 60 MiB photo limit. Choose fewer photos.')
    const meta = await sharp(p).metadata()
    need(meta.format === 'jpeg' && meta.width === d.width && meta.height === d.height && !meta.exif && !meta.icc && !meta.xmp && !meta.iptc && !meta.comments, 'metadata_check', 'A prepared photo failed its final privacy check.')
    const filename = `${row.SKU}-${i === 0 ? 'CS' : i}.jpg`
    entries[filename] = [new Uint8Array(p), { level: 0, mtime: new Date(1980, 0, 1, 0, 0, 0), os: 3, attrs: 0o100600 << 16 }]
    media.push({ ...original, position: i, filename, derivative_sha256: d.sha256, derivative_byte_size: d.byte_size, dimensions: [d.width, d.height] })
  }
  const quote = s => /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
  const expected = [template.columns_exact, template.columns_exact.map(k => row[k])]
  const csv = Buffer.from(expected.map(r => r.map(quote).join(',')).join('\r\n') + '\r\n')
  need(JSON.stringify(parse(csv)) === JSON.stringify(expected), 'csv_check', 'The listing file could not be verified.')
  const zip = Buffer.from(zipSync(entries, { level: 0 }))
  need(zip.length <= LIMITS.output, 'package_limit', 'The photos ZIP exceeds the local 64 MiB limit.')
  const reopened = unzipSync(zip)
  need(JSON.stringify(Object.keys(reopened)) === JSON.stringify(Object.keys(entries)) && photos.every((p, i) => Buffer.from(reopened[media[i].filename]).equals(p)), 'zip_check', 'The photos ZIP could not be verified.')
  const manifest = Buffer.from(JSON.stringify({ version: 1, purpose: 'prepare_poshmark_draft_files', package_id: job.id, inventory_id: job.inventory_id, listing_id: job.listing_id, account_id: job.account_id, external_account_id: job.snapshot.external_account_id, draft_version: job.draft_version, external_listing_id: null, quantity: 1, sku: row.SKU, template_sha256: TEMPLATE_SHA, runtime_version: RUNTIME, sharp_version: sharp.versions.sharp, columns_exact: template.columns_exact, row, media, csv_sha256: sha(csv), zip_sha256: sha(zip), remote_execution: false, next_checkpoint: 'Verify the exact Poshmark account, item not already listed and SKU absent across all closet listings and variants before native upload. Matching an existing SKU can edit a listing. Upload requires both files under Photos on Your Computer; verify the resulting native draft before any publication.' }, null, 2) + '\n')
  return { csv, zip, manifest }
}
