'use client'
import {useEffect,useRef,useState} from 'react'
import {supabase,requireAccess,requireWritableDeployment} from '@/lib/supabase'
export type EbayRun={id:string;account_id:string;status:'running'|'complete'|'needs_review'|'cancelled'|'deletion_pending';pages_read:number;records_read:number;expected_pages:number|null;last_error:string|null;started_at:string;finished_at:string|null}
export function EbayListingRun({accountId,connected}:{accountId:string;connected:boolean}) {
 const [run,setRun]=useState<EbayRun|null>(null),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false),[error,setError]=useState('')
 const epoch=useRef(0),stop=useRef(false)
 const preview=process.env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV==='preview'
 useEffect(()=>{const current=++epoch.current;void (async()=>{try{await requireAccess();const q=await supabase.from('resale_ebay_listing_runs').select('id,account_id,status,pages_read,records_read,expected_pages,last_error,started_at,finished_at').eq('account_id',accountId).order('started_at',{ascending:false}).limit(1).maybeSingle();if(q.error)throw q.error;if(epoch.current===current){setRun(q.data as EbayRun|null);setLoaded(true)}}catch{if(epoch.current===current)setError('Saved listing progress is unavailable. Reload before starting a new read.')}})();return()=>{epoch.current=current+1;stop.current=true}},[accountId])
 async function call(input:object){requireWritableDeployment();await requireAccess();const {data:{session}}=await supabase.auth.getSession();if(!session)throw Error('Sign in again');const response=await fetch('/api/integrations/ebay/listing-run',{method:'POST',headers:{Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},body:JSON.stringify(input)});if(!response.ok)throw Error('Run paused');const data=await response.json();if(data.run?.account_id!==accountId||typeof data.run.id!=='string')throw Error('Changed response');return data.run as EbayRun}
 async function advance(fresh:boolean){if(busy||!loaded||!connected)return;const current=epoch.current;stop.current=false;setBusy(true);setError('');try{let next=run;
 if(fresh){const {data:{session}}=await supabase.auth.getSession();if(!session)throw Error('Sign in again');const key=`ebay-listing-run:${session.user.id}:${accountId}`;let id=localStorage.getItem(key);if(!id){id=crypto.randomUUID();localStorage.setItem(key,id)}next=await call({op:'listing_run_start',account_id:accountId,run_id:id});if(epoch.current!==current)return;setRun(next);localStorage.removeItem(key)}
 if(!next)throw Error('Run not found');
 const {data:{session:acceptedSession}}=await supabase.auth.getSession();if(acceptedSession){const key=`ebay-listing-run:${acceptedSession.user.id}:${accountId}`;if(localStorage.getItem(key)===next.id)localStorage.removeItem(key)}

 while(next.status==='running'&&!stop.current&&epoch.current===current){next=await call({op:'listing_run_step',run_id:next.id});if(epoch.current!==current)return;setRun(next)}
 }catch{if(epoch.current===current)setError('The listing read paused. Resume uses its saved page request; it will not create duplicate listings.')}finally{if(epoch.current===current)setBusy(false)}}
 async function cancel(){if(!run||busy)return;setBusy(true);setError('');const current=epoch.current;try{requireWritableDeployment();await requireAccess();const q=await supabase.rpc('resale_ebay_cancel_listing_run',{p_run_id:run.id});if(q.error)throw q.error;if(epoch.current===current)setRun({...run,status:'cancelled'})}catch{if(epoch.current===current)setError('Stopping the old run was not confirmed. Reload and retry.')}finally{if(epoch.current===current)setBusy(false)}}
 const canStart=!run||['complete','cancelled'].includes(run.status)
 return <section className="wb-panel wb-integration-card"><h2>Read all active listing pages</h2><p>Bring exact eBay listings into the tracker. New listings stay unmatched until their physical item is confirmed.</p>
 <p className="wb-help">Keep this page open while it reads. Closing it pauses progress; Resume continues the saved page.</p>
 {error&&<p role="alert" className="wb-alert">{error}</p>}
 {run&&<><p role="status">{run.pages_read} pages · {run.records_read} listings saved{run.expected_pages!==null?` · ${run.expected_pages} pages reported by eBay`:''}</p>
 {run.status==='complete'&&<p className="wb-note">All returned pages were read during this run. The shop can change while it is being read; missing items are not marked sold or ended.</p>}
 {run.status==='needs_review'&&<p className="wb-alert">This read is incomplete: {run.last_error?.replaceAll('_',' ')||'the provider changed'}. Saved evidence remains. Stop this run, then start a fresh read.</p>}
 {run.status==='deletion_pending'&&<p className="wb-alert">The seller deletion workflow removed this run’s API evidence. Further reads are disabled.</p>}
 <p className="wb-help">Started {new Date(run.started_at).toLocaleString()}{run.finished_at?` · Finished ${new Date(run.finished_at).toLocaleString()}`:''}</p></>}
 <div className="wb-integration-actions">
 {canStart&&<button className="wb-button wb-button-primary" disabled={busy||preview||!loaded||!connected} onClick={()=>void advance(true)}>Read active listings</button>}
 {run?.status==='running'&&!busy&&<button className="wb-button wb-button-primary" disabled={preview||!connected} onClick={()=>void advance(false)}>Resume listing read</button>}
 {busy&&<button className="wb-button wb-button-secondary" onClick={()=>{stop.current=true}}>Pause after this page</button>}
 {run&&['running','needs_review'].includes(run.status)&&!busy&&<button className="wb-text-button" disabled={preview} onClick={()=>void cancel()}>Stop this run</button>}
 </div><p className="wb-help">Each page preserves its own check time. This reads shop evidence only; it does not change prices, publish listings or change physical stock.</p></section>
}
