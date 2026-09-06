import { supabase, requireWritableDeployment } from './supabase'

/** Original uploads are immutable. Keep this intent and the same File until confirmed. */
export interface MediaUploadIntent { requestId: string; inventoryId: string; file: File }
export interface OriginalMedia {
  id: string; inventory_id: string; bucket: string; object_key: string; kind: string;
  mime_type: string; byte_size: number; sha256: string | null; state: string;
}
export const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024
const MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
function gateway() {
  const raw = process.env.NEXT_PUBLIC_RESALE_MEDIA_URL
  if (!raw) throw new Error('Photo storage is not connected yet.')
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Photo storage address is invalid.')
  return url.origin
}
async function token() {
  const { data: { session }, error } = await supabase.auth.getSession()
  if (error || !session) throw new Error('Sign in before accessing photos.')
  return session.access_token
}
export function createMediaUploadIntent(inventoryId: string, file: File): MediaUploadIntent {
  requireWritableDeployment()
  if (!MIMES.includes(file.type)) throw new Error('Choose a JPEG, PNG, WebP, or GIF original. HEIC and RAW files need a separate preservation workflow.')
  if (file.size < 1 || file.size > MAX_ORIGINAL_BYTES) throw new Error('Choose an original photo up to 20 MiB.')
  return { requestId: crypto.randomUUID(), inventoryId, file }
}
async function checked(response: Response) {
  if (!response.ok) {
    let message = 'Photo upload was not confirmed. Retry the same original.'
    try { const body = await response.json(); if (typeof body.error === 'string') message = body.error } catch { /* Avoid echoing upstream HTML or tokens. */ }
    throw new Error(message)
  }
  return response
}
/** Call again with the SAME intent after any uncertain reserve/upload/finalize response. */
export async function uploadOriginal(intent: MediaUploadIntent, signal?: AbortSignal): Promise<OriginalMedia> {
  requireWritableDeployment()
  const base = gateway() // Fail before reserving when runtime is not connected.
  const { data: row, error } = await supabase.rpc('resale_reserve_media', {
    p_request_id: intent.requestId, p_inventory_id: intent.inventoryId,
    p_mime_type: intent.file.type, p_byte_size: intent.file.size,
  })
  if (error) throw new Error(error.message || 'Could not reserve the photo. Keep this original and retry.')
  if (row?.id !== intent.requestId || row?.inventory_id !== intent.inventoryId) throw new Error('Photo reservation did not match this item.')
  const response = await checked(await fetch(`${base}/v1/media/${row.id}`, {
    method: 'PUT', credentials: 'omit', cache: 'no-store', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': intent.file.type }, body: intent.file,
  }))
  const receipt = await response.json()
  if (typeof receipt.receipt_payload !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.receipt_signature)) throw new Error('Photo verification was not confirmed. Retry this original.')
  const result = await supabase.rpc('finalize_resale_media', { p_receipt: receipt.receipt_payload, p_signature: receipt.receipt_signature })
  if (result.error) throw new Error(result.error.message || 'Photo linking was not confirmed. Retry this original.')
  if (result.data?.id !== row.id || result.data?.state !== 'ready') throw new Error('Photo linking was not confirmed. Retry this original.')
  return result.data as OriginalMedia
}
/** Revoke this local URL on unmount, sign-out, account change, or when replacing it. */
export async function loadOriginalPreview(mediaId: string, signal?: AbortSignal): Promise<{ url: string; revoke: () => void }> {
  if (!/^[0-9a-f-]{36}$/.test(mediaId)) throw new Error('Invalid photo identifier.')
  const response = await checked(await fetch(`${gateway()}/v1/media/${mediaId}`, {
    credentials: 'omit', cache: 'no-store', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${await token()}` },
  }))
  const blob = await response.blob()
  if (!MIMES.includes(blob.type)) throw new Error('Photo format could not be verified.')
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const url = URL.createObjectURL(blob)
  return { url, revoke: () => URL.revokeObjectURL(url) }
}
