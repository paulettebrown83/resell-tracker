'use client';
/* Private authenticated blob URLs must stay in the browser; image optimization cannot fetch them. */
/* eslint-disable @next/next/no-img-element */
import {useEffect,useState} from 'react';
import {listMarketplacePhotos,loadMarketplacePhoto,preserveMarketplacePhoto,type ListingPhotoRef} from '@/lib/marketplace-photos';
function Photo({photo,onSaved}:{photo:ListingPhotoRef;onSaved:()=>Promise<void>}){
 const [preview,setPreview]=useState<{url:string;filename:string}|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 useEffect(()=>{if(photo.state!=='ready')return;const controller=new AbortController();let release:(()=>void)|undefined;void loadMarketplacePhoto(photo.id,controller.signal).then(result=>{if(controller.signal.aborted){result.revoke();return;}release=result.revoke;setPreview(result);}).catch(()=>{if(!controller.signal.aborted)setMessage('Private image preview unavailable. Close and reopen photos to retry.');});return()=>{controller.abort();release?.();};},[photo.id,photo.state]);
 async function save(){setBusy(true);setMessage('');try{await preserveMarketplacePhoto(photo.id);await onSaved();}catch(error){setMessage(error instanceof Error?error.message:'Photo saving was not confirmed.');}finally{setBusy(false);}}
 return <article className="wb-marketplace-photo"><strong>{photo.role==='cover'?'Saved cover source':`Photo ${photo.position+1}`}</strong>{preview&&<><img src={preview.url} alt={`Marketplace copy, photo ${photo.position+1}`} /><a className="wb-button wb-button-secondary" href={preview.url} download={preview.filename}>Download marketplace copy</a></>}
 <p>{photo.state==='ready'?'Private copy preserved':photo.state==='saving'?'Saving needs confirmation':photo.state==='failed'?'Copy not saved':'Source captured; copy not saved'}</p><small>Source seen {new Date(photo.source_observed_at).toLocaleString()}{photo.fetched_at&&<> · Bytes saved {new Date(photo.fetched_at).toLocaleString()}</>}</small>
 {photo.state!=='ready'&&<button className="wb-button wb-button-secondary" disabled={busy||process.env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV==='preview'} onClick={save}>{busy?'Saving copy…':photo.state==='saving'?'Retry saved photo request':'Save private copy'}</button>}{message&&<p role="status">{message}</p>}
 </article>;
}
export default function ListingMarketplacePhotos({listingId,marketplace}:{listingId:string;marketplace:string}){
 const [open,setOpen]=useState(false),[photos,setPhotos]=useState<ListingPhotoRef[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState('');
 async function refresh(){setLoading(true);setError('');try{setPhotos(await listMarketplacePhotos(listingId));}catch{setError('Photo records could not be loaded.');}finally{setLoading(false);}}
 if(!['poshmark','mercari'].includes(marketplace))return null;
 return <section className="wb-marketplace-photos"><button className="wb-button wb-button-secondary" aria-expanded={open} onClick={()=>{if(!open)void refresh();setOpen(!open);}}>{open?'Close listing photos':'Listing photos'}</button>{open&&<div><p>Private marketplace copies for viewing or download. These are shop images, not camera originals. A saved cover does not include the full gallery.</p>{loading&&<p role="status">Loading photo records…</p>}{error&&<p role="alert">{error} <button onClick={()=>void refresh()}>Retry loading photos</button></p>}{!loading&&!error&&photos.length===0&&<p>No exact photo sources have been recorded for this listing yet. An agent needs to capture the listing’s photo links.</p>}<div className="wb-marketplace-photo-grid">{photos.map(photo=><Photo key={photo.id} photo={photo} onSaved={refresh}/>)}</div></div>}</section>;
}
