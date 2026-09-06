'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import AuthGate from '@/components/AuthGate'
import { supabase, requireAccess, requireWritableDeployment } from '@/lib/supabase'
type Feed = { id: string; status: string; last_success_at?: string | null; last_error_code?: string | null; account_id: string; owner_id?: string }
function GmailConnection() {
  const [feeds, setFeeds] = useState<Feed[]>([]), [accounts, setAccounts] = useState<Array<{id:string;username:string|null}>>([])
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[ready,setReady]=useState(false)
  const preview=process.env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV==='preview'
  useEffect(()=>{let alive=true;void (async()=>{try{
    await requireAccess()
    const [feedRows,accountRows]=await Promise.all([supabase.from('resale_gmail_feeds').select('id,status,account_id,last_success_at,last_error_code'),supabase.from('resale_accounts').select('id,username').eq('marketplace','vinted')])
    if(feedRows.error||accountRows.error)throw Error('Feed setup unavailable')
    if(alive){setFeeds(feedRows.data);setAccounts(accountRows.data);setReady(true)}
    const outcome=new URLSearchParams(window.location.search).get('result')
    if(alive&&outcome){setNotice(outcome==='connected'?'Gmail connected. The status below shows whether a complete check has finished.':outcome==='paused'?'Consent was saved, but the feed is paused until its production setup is verified.':outcome==='cancelled'?'Gmail consent was cancelled. No new connection was activated.':'Gmail could not be connected. Start again from this page.');window.history.replaceState({},'',window.location.pathname)}
  }catch{if(alive)setError('Gmail feed setup is not ready or your account cannot access it.')}})();return()=>{alive=false}},[])
  async function connect(accountId:string,feedId?:string){if(busy||preview)return;setBusy(true);setError('');try{
    requireWritableDeployment();await requireAccess()
    const {data:{session}}=await supabase.auth.getSession();if(!session)throw Error('Sign in again')
    if(!feedId){const storageKey=`gmail-enroll:${session.user.id}:${accountId}`;let request=sessionStorage.getItem(storageKey);if(!request){request=crypto.randomUUID();sessionStorage.setItem(storageKey,request)}
      const enrolled=await supabase.rpc('resale_enroll_gmail_feed',{p_request_id:request,p_payload:{mailbox_email:'paulettebrown83@gmail.com',account_id:accountId,parser_version:'vinted-gmail-v1'}});if(enrolled.error)throw Error('Enrollment could not be confirmed');feedId=enrolled.data;sessionStorage.removeItem(storageKey);setFeeds(current=>[...current,{id:feedId!,account_id:accountId,status:'not_connected'}])}
    const response=await fetch('/api/integrations/gmail/start',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.access_token}`},body:JSON.stringify({feed_id:feedId})});if(!response.ok)throw Error('Google connection could not start')
    const result=await response.json(),url=new URL(result.authorization_url);if(url.origin!=='https://accounts.google.com')throw Error('Unexpected authorization response');window.location.assign(url.href)
  }catch{setError('Connection could not be started. Your existing records are unchanged. Retry after checking account access and setup.');setBusy(false)}}
  async function pause(feedId:string){if(busy||preview)return;setBusy(true);setError('');try{requireWritableDeployment();await requireAccess();const result=await supabase.rpc('resale_pause_gmail_feed',{p_feed_id:feedId});if(result.error)throw result.error;setFeeds(rows=>rows.map(row=>row.id===feedId?{...row,status:'paused',last_error_code:'paused_by_owner'}:row));setNotice('Background checks are paused. Previously saved evidence stays available.')}catch{setError('The pause was not confirmed. Refresh connection status and retry.')}finally{setBusy(false)}}
  return (
    <main className="wb-integration-page">
      <Link className="wb-text-button" href="/">← Back to resale studio</Link>
      <header className="wb-integration-heading">
        <p className="wb-eyebrow">CONNECTED SOURCES</p>
        <h1>Gmail notification feed</h1>
        <p>Keep Vinted notifications with the items and shop requests they help explain.</p>
      </header>
      <div className="wb-note"><div><strong>Evidence first. Your inventory stays under your control.</strong>
        <p>Messages become evidence and review tasks. They do not mark items sold or change marketplace listings.</p>
      </div></div>
      {notice && <p className="wb-note" role="status">{notice}</p>}
      {error && <p className="wb-alert" role="alert">{error}</p>}
      {!ready && !error && <p className="wb-help" role="status">Checking connection setup…</p>}
      {ready && accounts.map(account => {
        const feed = feeds.find(row => row.account_id === account.id);
        const label = feed?.status === 'active' ? 'Connected' : feed?.status === 'paused' ? 'Paused' : feed?.status === 'reconnect_required' ? 'Reconnect needed' : 'Not connected';
        return <section className="wb-panel wb-integration-card" key={account.id}>
          <div className="wb-section-heading"><div><p className="wb-eyebrow">VINTED</p><h2>{account.username || 'Account handle unverified'}</h2></div>
            <span className={`wb-badge ${feed?.status === 'active' ? 'wb-badge-green' : 'wb-badge-amber'}`}>{label}</span>
          </div>
          <div className="wb-integration-card-body">
            <dl><dt>Last successful complete check</dt><dd>{feed?.last_success_at ? new Date(feed.last_success_at).toLocaleString() : 'Not yet completed'}</dd></dl>
            {feed?.last_error_code && <p className="wb-alert">Needs attention: {feed.last_error_code.replace(/_/g, ' ')}.</p>}
            {['message_unavailable', 'message_unreadable'].includes(feed?.last_error_code || '') && <p className="wb-help">A saved message needs review. Ask Codex to check the gap before resuming; reconnecting alone will not skip it.</p>}
            <div className="wb-integration-actions">
              <button className="wb-button wb-button-primary" disabled={busy || preview || !account.username} onClick={() => connect(account.id, feed?.id)}>{busy ? 'Working…' : feed ? 'Reconnect Gmail' : 'Connect Gmail'}</button>
              {feed && <button className="wb-button wb-button-secondary" disabled={busy || preview || feed.status === 'paused'} onClick={() => pause(feed.id)}>Pause background checks</button>}
            </div>
          </div>
        </section>;
      })}
      {ready && !accounts.length && <p className="wb-note">A verified Vinted account must be recorded before connecting this feed.</p>}
      <section className="wb-panel wb-integration-permission"><h2>What Google allows</h2><p>Google’s permission allows reading this mailbox. This feed requests only Vinted sender messages within a bounded date window; it cannot send, change or delete mail.</p><p className="wb-help">Pausing keeps earlier evidence. To remove Google access itself, use <a href="https://myaccount.google.com/connections">Google Account connections</a>. Read the <Link href="/privacy">privacy notice</Link>.</p></section>
    </main>
  );
}
export default function Page(){return <AuthGate><GmailConnection/></AuthGate>}
