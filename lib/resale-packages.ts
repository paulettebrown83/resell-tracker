import { supabase, requireWritableDeployment } from './supabase'
export type PackageFile = { name: string; sha256: string; byte_size: number }
export type ListingPackage = { id: string; state: 'pending'|'processing'|'failed'|'ready'|'discarding'|'discarded'; current: boolean; draft_version: number; completed_images: number; image_count: number; outputs: Partial<Record<'csv'|'zip'|'manifest',PackageFile>>; last_error: string|null; lease_until: string|null; updated_at: string }
export type PackageOptions = { departments: string[]; categories: string[]; subcategories: string[]; sizes: string[]; colors: string[] }
export type PackageRequest = { listing_id: string; account_id: string; inventory_id: string; expected_version: number; quantity: 1; native_fields: Record<string,string> }
async function bearer() { const {data,error}=await supabase.auth.getSession(); if(error || !data.session) throw Error('Sign in to prepare files.'); return data.session.access_token }
export async function packageCall<T>(input: object): Promise<T> {
 requireWritableDeployment()
 const response=await fetch('/api/listing-packages',{method:'POST',headers:{Authorization:`Bearer ${await bearer()}`,'Content-Type':'application/json'},body:JSON.stringify(input),cache:'no-store'})
 const data=await response.json();if(!response.ok)throw Error(data.error||'Preparation paused. Resume the saved package.');return data
}
export async function packagePendingKey(listingId:string) { const {data,error}=await supabase.auth.getUser();if(error||!data.user)throw Error('Sign in to prepare files.');return `resale-package:${data.user.id}:${listingId}` }
export async function downloadPackageFile(pkg:ListingPackage,kind:'csv'|'zip'|'manifest') {
 const suffix={csv:'listings.csv',zip:'photos.zip',manifest:'manifest.json'}[kind],file=pkg.outputs[kind]
 if(!pkg.current||pkg.state!=='ready'||!file||file.name!==`${pkg.id}/${suffix}`||!/^[0-9a-f]{64}$/.test(file.sha256)||file.byte_size>64*1024**2)throw Error('This prepared file is unavailable or the draft has changed.')
 // Storage checks current membership and saved item/account/draft/media binding on every download.
 const base=process.env.NEXT_PUBLIC_SUPABASE_URL!,key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY||process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
 const response=await fetch(`${base}/storage/v1/object/authenticated/resale-listing-packages/${file.name}`,{headers:{Authorization:`Bearer ${await bearer()}`,apikey:key},cache:'no-store'})
 if(!response.ok)throw Error('The file is no longer available for this saved draft. Refresh its progress.')
 const bytes=await response.arrayBuffer()
 if(bytes.byteLength!==file.byte_size)throw Error('The downloaded file size did not match. Try again.')
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('')
 if(hash!==file.sha256)throw Error('The downloaded file did not match its saved checksum. Try again.')
 const objectUrl=URL.createObjectURL(new Blob([bytes],{type:{csv:'text/csv',zip:'application/zip',manifest:'application/json'}[kind]}))
 const link=document.createElement('a');link.href=objectUrl;link.download=`poshmark-${pkg.id.slice(0,8)}-${suffix}`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(objectUrl),1000)
}
