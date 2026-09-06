'use client'
import { useEffect, useRef, useState } from 'react'
import type { PreparedListing } from '@/lib/resale-drafts'
import { packageCall, packagePendingKey, downloadPackageFile, type ListingPackage, type PackageOptions, type PackageRequest } from '@/lib/resale-packages'

type Pending = { id: string; payload: PackageRequest }
export default function PoshmarkPackage({ listing, disabled=false }: {listing:PreparedListing;disabled?:boolean}) {
 const [jobs,setJobs]=useState<ListingPackage[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
 const [department,setDepartment]=useState(''),[category,setCategory]=useState(''),[subcategory,setSubcategory]=useState(''),[oneUnit,setOneUnit]=useState(false)
 const [choices,setChoices]=useState<PackageOptions>({departments:[],categories:[],subcategories:[],sizes:[],colors:[]})
 const [pending,setPending]=useState<Pending|null>(null),[pendingKey,setPendingKey]=useState('')
 const live=useRef(true),lock=useRef(false)
 async function refresh() { const data=await packageCall<ListingPackage[]>({action:'list',listing_id:listing.id});if(live.current)setJobs(data);return data }
 useEffect(()=>{live.current=true;let cancelled=false
  if(!disabled)Promise.all([packagePendingKey(listing.id),packageCall<ListingPackage[]>({action:'list',listing_id:listing.id})]).then(([key,rows])=>{if(cancelled)return;setPendingKey(key);setJobs(rows);const saved=localStorage.getItem(key);if(saved){try{const value=JSON.parse(saved);if(value.payload?.listing_id===listing.id && typeof value.id==='string')setPending(value)}catch{setError('The saved request could not be read. Refresh before preparing another package.')}}}).catch(e=>{if(!cancelled)setError(e.message)})
  return()=>{cancelled=true;live.current=false}
 },[listing.id,disabled])
 useEffect(()=>{let cancelled=false;if(!disabled)packageCall<PackageOptions>({action:'options',department,category}).then(value=>{if(!cancelled)setChoices(value)}).catch(e=>{if(!cancelled)setError(e.message)});return()=>{cancelled=true}},[department,category,disabled])
 async function advance(id:string) { let done=false;while(live.current&&!done){const job=await packageCall<ListingPackage>({action:'step',id});if(live.current)setJobs(old=>[job,...old.filter(p=>p.id!==job.id)]);done=job.state==='ready'}if(live.current&&done)setNotice('Files are ready. The Poshmark upload and draft readback are still to do.') }
 async function run(action:()=>Promise<void>) {if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');try{await action()}catch(e){if(live.current)setError(e instanceof Error?e.message:'Preparation paused. Resume saved progress.')}finally{lock.current=false;if(live.current){setBusy(false);await refresh().catch(()=>{})}}}
 async function start() {await run(async()=>{let request=pending;if(!request){if(!pendingKey)throw Error('Sign in and refresh before preparing files.');request={id:crypto.randomUUID(),payload:{listing_id:listing.id,inventory_id:listing.inventory_id!,account_id:listing.account_id,expected_version:listing.draft_version,quantity:1,native_fields:{Department:department,Category:category,'Sub-category':subcategory}}};localStorage.setItem(pendingKey,JSON.stringify(request));setPending(request)}
  const job=await packageCall<ListingPackage>({action:'start',...request});localStorage.removeItem(pendingKey);setPending(null);setJobs(old=>[job,...old.filter(p=>p.id!==job.id)]);await advance(job.id)
 })}
 const progress=jobs.find(p=>p.current&&p.draft_version===listing.draft_version&&p.state!=='discarding')
 return <section className="wb-package" aria-label="Prepare Poshmark files">
  <h3>Prepare Poshmark files</h3>
  <p>Use this saved draft and its original photos to make the listing file and photos ZIP. Originals stay private and unchanged.</p>
  <p className="wb-help">For one genuinely unlisted item. An existing Poshmark SKU can edit a listing, so the exact account and SKU must be checked before upload. These files do not publish anything.</p>
  {error&&<p className="wb-alert" role="alert">{error}</p>}{notice&&<p className="wb-note" role="status">{notice}</p>}
  {!progress&&<div className="wb-field-grid">
   <label className="wb-field">Poshmark department<select value={department} disabled={busy||!!pending||disabled} onChange={e=>{setDepartment(e.target.value);setCategory('');setSubcategory('')}}><option value="">Choose department</option>{choices.departments.map(v=><option key={v}>{v}</option>)}</select></label>
   <label className="wb-field">Poshmark category<select value={category} disabled={busy||!!pending||disabled||!department} onChange={e=>{setCategory(e.target.value);setSubcategory('')}}><option value="">Choose category</option>{choices.categories.map(v=><option key={v}>{v}</option>)}</select></label>
   <label className="wb-field">Poshmark subcategory (optional)<select value={subcategory} disabled={busy||!!pending||disabled||!category} onChange={e=>setSubcategory(e.target.value)}><option value="">No subcategory</option>{choices.subcategories.map(v=><option key={v}>{v}</option>)}</select></label>
   <p className="wb-help">Saved size: {String(listing.desired_fields.size||'not supplied')}. {category&&!choices.sizes.includes(String(listing.desired_fields.size||''))?'Update the saved draft size to match this category before preparing.':''}</p>
   <label className="wb-check"><input type="checkbox" checked={oneUnit} disabled={busy||!!pending||disabled} onChange={e=>setOneUnit(e.target.checked)}/>This preparation is for exactly one available unit.</label>
   <button type="button" className="wb-button wb-button-primary" disabled={busy||disabled||(!pending&&(!oneUnit||!category||!department||!pendingKey))} onClick={start}>{pending?'Retry the same preparation request':'Prepare Poshmark files'}</button>
  </div>}
  {pending&&<button type="button" className="wb-text-button" disabled={busy||disabled} onClick={()=>run(async()=>{const receipt=await packageCall<{id:string;accepted:boolean;current?:boolean;state?:string}>({action:'receipt',id:pending.id});if(receipt.id!==pending.id)throw Error('The saved request could not be verified. Keep it for retry.');if(receipt.accepted===false||receipt.state==='discarded'){const abandoned=await packageCall<{id:string;abandoned:boolean}>({action:'abandon',id:pending.id});if(abandoned.id!==pending.id||abandoned.abandoned!==true)throw Error('The earlier request could not be replaced. Keep it for retry.');localStorage.removeItem(pendingKey);setPending(null);setNotice('The earlier request was not accepted, or its files were removed. You can prepare from the current saved draft.')}else{setNotice(receipt.current?'The request is saved. Retry that exact preparation.':'The earlier package is saved for an older draft. Remove its prepared files below before making a new one.')}})}>Check pending preparation</button>}
  {busy&&<p role="status">Preparing saved files… {progress?`${progress.completed_images} of ${progress.image_count} photos saved.`:''} Keep this page open. Closing it pauses after the current step.</p>}
  {jobs.map(job=><article className="wb-note" key={job.id}><div>
   <strong>{!job.current?'Older preparation · draft changed':job.state==='ready'?'Files ready · upload still to do':job.state==='discarding'?'File removal unfinished':`${job.completed_images} of ${job.image_count} photos saved`}</strong>
   <p className="wb-help">Saved draft version {job.draft_version}. {job.current&&job.state!=='ready'?'Resume continues automatically while this page stays open.':''}</p>
   <div className="wb-action-row">
    {job.current&&job.state!=='ready'&&job.state!=='discarding'&&<button type="button" className="wb-button" disabled={busy||disabled} onClick={()=>run(()=>advance(job.id))}>Resume preparation</button>}
    {job.current&&job.state==='ready'&&<><button type="button" className="wb-button wb-button-primary" disabled={busy||disabled} onClick={()=>run(()=>downloadPackageFile(job,'csv'))}>Download listing file</button><button type="button" className="wb-button" disabled={busy||disabled} onClick={()=>run(()=>downloadPackageFile(job,'zip'))}>Download photos</button><a className="wb-button" href="https://poshmark.com/bulk-upload-create" target="_blank" rel="noreferrer">Open Poshmark upload</a></>}
    <button type="button" className="wb-text-button" disabled={busy||disabled} onClick={()=>run(async()=>{await packageCall({action:'discard',id:job.id});if(pending?.id===job.id){localStorage.removeItem(pendingKey);setPending(null)}setNotice('Prepared files removed. Original photos are unchanged.')})}>Remove prepared files</button>
   </div>
   {job.current&&job.state==='ready'&&<p>Next: verify the correct account and that this SKU is unused, then upload both files under “Photos on Your Computer.” Check the resulting Poshmark draft before publishing. An agent can handle these digital steps; physical facts and account challenges may still need you.</p>}
   <details><summary>Preparation details</summary><p>Package {job.id} · saved {new Date(job.updated_at).toLocaleString()} · {job.last_error||'No saved error'}</p>{job.current&&job.state==='ready'&&<button type="button" className="wb-text-button" disabled={busy||disabled} onClick={()=>run(()=>downloadPackageFile(job,'manifest'))}>Download verification manifest</button>}</details>
  </div></article>)}
 </section>
}
