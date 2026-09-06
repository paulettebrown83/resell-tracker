import {supabase,requireWritableDeployment} from './supabase';
export interface ListingPhotoRef {
 id:string; listing_id:string; account_id:string; source_record_id:string; position:number; role:'cover'|'gallery';
 kind:'marketplace_copy'; state:'available'|'saving'|'ready'|'failed'; source_observed_at:string; fetched_at:string|null;
 object_sha256:string|null; last_error:string|null;
}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function gateway(){const raw=process.env.NEXT_PUBLIC_RESALE_MEDIA_URL;if(!raw)throw Error('Photo storage is not connected.');const u=new URL(raw);if(u.protocol!=='https:'||u.pathname!=='/'||u.username||u.password||u.search||u.hash)throw Error('Photo storage address is invalid.');return u.origin;}
async function session(){const {data,error}=await supabase.auth.getSession();if(error||!data.session)throw Error('Sign in to access saved photos.');return data.session;}
export async function listMarketplacePhotos(listingId:string):Promise<ListingPhotoRef[]>{
 if(!uuid.test(listingId))throw Error('Invalid listing identifier.');
 const {data,error}=await supabase.from('resale_listing_photo_refs').select('id,listing_id,account_id,source_record_id,position,role,kind,state,source_observed_at,fetched_at,object_sha256,last_error').eq('listing_id',listingId).order('source_observed_at',{ascending:false}).order('position');
 if(error)throw Error('Saved marketplace photos could not be loaded.');return data||[];
}
/** Keep one request through ambiguous transport responses; only a confirmed failed job retires it. */
export async function preserveMarketplacePhoto(refId:string):Promise<void>{
 requireWritableDeployment();if(!uuid.test(refId))throw Error('Invalid photo identifier.');const base=gateway(),s=await session(),key=`resale-photo-copy:${s.user.id}:${refId}`;
 let requestId=sessionStorage.getItem(key);if(!requestId){requestId=crypto.randomUUID();sessionStorage.setItem(key,requestId);}if(!uuid.test(requestId))throw Error('Saved photo request is invalid.');
 const response=await fetch(`${base}/v1/listing-photos/${refId}`,{method:'POST',credentials:'omit',cache:'no-store',redirect:'error',headers:{Authorization:`Bearer ${s.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({request_id:requestId})});
 let body;try{body=await response.json();}catch{throw Error('Photo saving was not confirmed. Retry this photo.');}
 if(!response.ok){if(body.retry_new_request===true)sessionStorage.removeItem(key);throw Error(body.retry_new_request===true?'The previous attempt ended. Choose Save copy again to start a new attempt.':'Photo saving was not confirmed. Retry this photo; its saved request is retained.');}
 if(body.ref?.id!==refId||body.ref?.state!=='ready')throw Error('Photo linking was not confirmed. Retry this photo.');sessionStorage.removeItem(key);
}
export async function loadMarketplacePhoto(refId:string,signal?:AbortSignal):Promise<{url:string;filename:string;revoke:()=>void}>{
 if(!uuid.test(refId))throw Error('Invalid photo identifier.');const s=await session();
 const response=await fetch(`${gateway()}/v1/listing-photos/${refId}`,{credentials:'omit',cache:'no-store',redirect:'error',signal,headers:{Authorization:`Bearer ${s.access_token}`}});
 if(!response.ok)throw Error('The private marketplace copy could not be loaded.');const blob=await response.blob();const suffix=({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'} as Record<string,string>)[blob.type];
 if(!suffix||blob.size<1||blob.size>20*1024*1024)throw Error('Photo bytes could not be verified.');if(signal?.aborted)throw new DOMException('Aborted','AbortError');const url=URL.createObjectURL(blob);return {url,filename:`marketplace-copy-${refId}.${suffix}`,revoke:()=>URL.revokeObjectURL(url)};
}
