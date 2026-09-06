import {utf8,b64url,randomToken,sha256,signHex,readBounded} from './crypto.mjs';
import {PARSER_VERSION,VINTED_SENDER,parseVintedMessage} from './parser.mjs';
export const GMAIL_SCOPE='https://www.googleapis.com/auth/gmail.readonly';
export const CALLBACK='https://resell-tracker-beta.vercel.app/api/integrations/gmail/callback';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const token=/^[A-Za-z0-9_-]{43}$/;
export class FeedError extends Error {constructor(code,status=503){super(code);this.code=code;this.status=status;}}
const one=value=>Array.isArray(value)?value[0]||null:value;
const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});
/** All network hosts are fixed. No caller-controlled URL or database operation is accepted. */
export function createServices(env,fetcher=fetch){
 const base=env.SUPABASE_URL;
 if(!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(base||''))throw Error('Supabase configuration unavailable');
 const admin=env.SUPABASE_SECRET_KEYS?JSON.parse(env.SUPABASE_SECRET_KEYS).default:env.SUPABASE_SERVICE_ROLE_KEY;
 const publicKey=env.SUPABASE_PUBLISHABLE_KEYS?JSON.parse(env.SUPABASE_PUBLISHABLE_KEYS).default:env.SUPABASE_ANON_KEY;
 if(!admin||!publicKey)throw Error('Supabase configuration unavailable');
 async function request(url,options={},limit=1048576,allowNoContent=false){
  let response;try{response=await fetcher(url,{...options,redirect:'manual',signal:AbortSignal.timeout(8000)});}catch{throw new FeedError('network_error');}
  if(allowNoContent&&response.status===204)return null;
  let value;try{value=JSON.parse(await readBounded(response,limit));}catch{throw new FeedError('invalid_response');}
  if(!response.ok){
   if(value.error==='invalid_grant')throw new FeedError('invalid_grant',401);
   if(response.status===429)throw new FeedError('rate_limited',429);
   if(response.status===404&&url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages/'))throw new FeedError('message_unavailable',409);
   if(response.status===401||response.status===403)throw new FeedError('access_denied',403);
   if(response.status===400&&value.error?.status==='INVALID_ARGUMENT')throw new FeedError('page_token_invalid',400);
   if(typeof value.code==='string'&&/^(22|23|40|P0)/.test(value.code))throw new FeedError('database_rejected',409);
   throw new FeedError('provider_error');
  }
  return value;
 }
 return {
  async rpc(name,args){const headers={'apikey':admin,'Content-Type':'application/json'};if(!admin.startsWith('sb_'))headers.Authorization=`Bearer ${admin}`;return one(await request(`${base}/rest/v1/rpc/${name}`,{method:'POST',headers,body:JSON.stringify(args)},1048576,true));},
  async user(bearer){if(!/^Bearer [^\s]+$/.test(bearer||''))throw new FeedError('access_denied',401);const result=await request(`${base}/auth/v1/user`,{headers:{apikey:publicKey,Authorization:bearer}},32768);if(!uuid.test(result.id||''))throw new FeedError('access_denied',401);return result.id;},
  async googleToken(values){return request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(values)},32768);},
  async profile(access){return request('https://gmail.googleapis.com/gmail/v1/users/me/profile',{headers:{Authorization:`Bearer ${access}`}},32768);},
  async list(access,query,page){const params=new URLSearchParams({q:query,maxResults:'25',includeSpamTrash:'false'});if(page)params.set('pageToken',page);return request(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,{headers:{Authorization:`Bearer ${access}`}},32768);},
  async message(access,id){if(!/^[a-f0-9]{1,40}$/i.test(id))throw new FeedError('invalid_message');try{return await request(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,{headers:{Authorization:`Bearer ${access}`}},1500000);}catch(error){if(error instanceof FeedError&&error.code==='invalid_response')throw new FeedError('message_unreadable');throw error;}},
 };
}
function exactScope(scope){return typeof scope==='string'&&scope.trim().split(/\s+/).length===1&&scope.trim()===GMAIL_SCOPE;}
function validAccess(result){if(typeof result.access_token!=='string'||!result.access_token||result.token_type?.toLowerCase()!=='bearer')throw new FeedError('invalid_token_response');}
function checkedConfig(config){if(!config||config.redirect_uri!==CALLBACK||!/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/i.test(config.client_id||'')||config.expected_mailbox!=='paulettebrown83@gmail.com')throw new FeedError('configuration_mismatch');}
export async function startOAuth(input,bearer,services){
 if(!uuid.test(input.feed_id||'')||!token.test(input.browser_binding||''))throw new FeedError('invalid_request',400);
 const member=await services.user(bearer),state=randomToken(),verifier=randomToken();
 const config=await services.rpc('resale_gmail_oauth_start',{p_member_id:member,p_feed_id:input.feed_id,p_state_sha256:await sha256(state),p_browser_binding_sha256:await sha256(input.browser_binding),p_code_verifier:verifier});
 checkedConfig(config);
 const params=new URLSearchParams({client_id:config.client_id,redirect_uri:CALLBACK,response_type:'code',scope:GMAIL_SCOPE,access_type:'offline',prompt:'consent select_account',state,code_challenge:b64url(await crypto.subtle.digest('SHA-256',utf8.encode(verifier))),code_challenge_method:'S256'});
 return {authorization_url:`https://accounts.google.com/o/oauth2/v2/auth?${params}`};
}
export async function completeOAuth(input,services){
 if(!token.test(input.state||'')||!token.test(input.browser_binding||'')||(!input.error&&(typeof input.code!=='string'||!input.code||input.code.length>2048)))throw new FeedError('invalid_request',400);
 const state=await services.rpc('resale_gmail_oauth_consume',{p_state_sha256:await sha256(input.state),p_browser_binding_sha256:await sha256(input.browser_binding)});
 checkedConfig(state);
 if(input.error)return {status:'cancelled'};
 const result=await services.googleToken({grant_type:'authorization_code',code:input.code,client_id:state.client_id,client_secret:state.client_secret,redirect_uri:CALLBACK,code_verifier:state.code_verifier});
 validAccess(result);if(!exactScope(result.scope))throw new FeedError('scope_mismatch',403);
 const profile=await services.profile(result.access_token);
 if(profile.emailAddress?.toLowerCase()!==state.expected_mailbox)throw new FeedError('mailbox_mismatch',403);
 if(result.refresh_token!==undefined&&(typeof result.refresh_token!=='string'||!result.refresh_token||result.refresh_token.length>8192))throw new FeedError('invalid_token_response');
 const saved=await services.rpc('resale_gmail_oauth_complete',{p_state_id:state.state_id,p_mailbox:profile.emailAddress.toLowerCase(),p_scopes:[GMAIL_SCOPE],p_refresh_token:result.refresh_token||null});
 return {status:saved.status,feed_id:saved.feed_id};
}
export function nextWindow(cursor,now){
 if(cursor&&!cursor.window_complete)return {...cursor};
 const end=Math.floor((now-60000)/1000)*1000;
 return {window_start_ms:cursor?Math.max(0,cursor.window_end_ms-300000):end-7*86400000,window_end_ms:end,page_token:null,window_complete:false,pending_message_ids:null,next_page_token:null};
}
export async function runTick(input,services,clock=()=>Date.now()){
 if(typeof input.tick!=='string'||input.tick.length>1024||!/^[a-f0-9]{64}$/.test(input.signature||''))throw new FeedError('invalid_request',400);
 const lease=await services.rpc('resale_gmail_verify_tick_and_claim',{p_tick:input.tick,p_signature:input.signature});
 if(!lease)return {status:'idle'};
 const started=clock();let cursor=nextWindow(lease.cursor,started),count=0;
 const args={p_feed_id:lease.feed_id,p_lease_token:lease.lease_token};
 try{
  if(lease.parser_version!==PARSER_VERSION||lease.mailbox_email!=='paulettebrown83@gmail.com'||!lease.account_handle)throw new FeedError('configuration_mismatch');
  await services.rpc('resale_gmail_checkpoint_run',{...args,p_cursor:cursor});
  const refreshed=await services.googleToken({grant_type:'refresh_token',refresh_token:lease.refresh_token,client_id:lease.client_id,client_secret:lease.client_secret});
  validAccess(refreshed);
  if(refreshed.scope!==undefined&&!exactScope(refreshed.scope))throw new FeedError('scope_mismatch',403);
  if(refreshed.refresh_token&&refreshed.refresh_token!==lease.refresh_token)throw new FeedError('refresh_token_rotation');
  const profile=await services.profile(refreshed.access_token);
  if(profile.emailAddress?.toLowerCase()!==lease.mailbox_email)throw new FeedError('mailbox_mismatch',403);
  const query=`from:${VINTED_SENDER} after:${Math.floor(cursor.window_start_ms/1000)} before:${Math.ceil(cursor.window_end_ms/1000)}`;
  if(cursor.pending_message_ids==null){
   const page=await services.list(refreshed.access_token,query,cursor.page_token);
   if((page.messages!==undefined&&!Array.isArray(page.messages))||(page.messages?.length||0)>25||(page.nextPageToken!==undefined&&(typeof page.nextPageToken!=='string'||!page.nextPageToken||page.nextPageToken.length>2048)))throw new FeedError('invalid_response');
   const ids=(page.messages||[]).map(entry=>entry.id);
   if(ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{1,40}$/i.test(id))||new Set(ids).size!==ids.length)throw new FeedError('invalid_response');
   cursor={...cursor,pending_message_ids:ids,next_page_token:page.nextPageToken||null};
   await services.rpc('resale_gmail_checkpoint_run',{...args,p_cursor:cursor});
  }
  while(cursor.pending_message_ids.length){
   if(clock()-started>45000){
    await services.rpc('resale_gmail_finish_run',{...args,p_outcome:'partial',p_cursor:cursor,p_error_code:'run_budget'});
    return {status:'partial',processed:count};
   }
   const messageId=cursor.pending_message_ids[0],message=await services.message(refreshed.access_token,messageId);
   if(message.id!==messageId||!/^[a-f0-9]{1,40}$/i.test(message.threadId||'')||!/^\d{10,16}$/.test(message.internalDate||''))throw new FeedError('invalid_message');
   const received=Number(message.internalDate);
   if(received<cursor.window_start_ms||received>=cursor.window_end_ms)throw new FeedError('message_outside_window');
   const parsed=await parseVintedMessage(message,lease.account_handle),now=clock();
   const receipt=JSON.stringify({v:1,nonce:crypto.randomUUID(),feed_id:lease.feed_id,lease_token:lease.lease_token,parser_version:PARSER_VERSION,account_id:lease.account_id,message_id:message.id,thread_id:message.threadId,received_at:received,captured_at:now,kind:parsed.kind,source_sha256:parsed.source_sha256,normalized:parsed.normalized,expires_at:Math.floor(now/1000)+120});
   await services.rpc('resale_ingest_gmail_message',{p_receipt:receipt,p_signature:await signHex(lease.ingress_signing_key,`gmail_ingest_v1\n${receipt}`)});count++;
   cursor={...cursor,pending_message_ids:cursor.pending_message_ids.slice(1)};
   await services.rpc('resale_gmail_checkpoint_run',{...args,p_cursor:cursor});
  }
  cursor={...cursor,page_token:cursor.next_page_token||null,window_complete:!cursor.next_page_token,pending_message_ids:null,next_page_token:null};
  await services.rpc('resale_gmail_finish_run',{...args,p_outcome:cursor.window_complete?'complete':'partial',p_cursor:cursor,p_error_code:null});
  return {status:cursor.window_complete?'complete':'partial',processed:count};
 }catch(failure){
  const known=['invalid_grant','scope_mismatch','mailbox_mismatch','refresh_token_rotation','access_denied'];
  const error=failure instanceof FeedError?failure.code:'runtime_error';
  if(error==='page_token_invalid')cursor={...cursor,page_token:null,window_complete:false,pending_message_ids:null,next_page_token:null};
  const outcome=known.includes(error)?'reconnect_required':['message_unavailable','message_unreadable','invalid_message','message_outside_window','configuration_mismatch'].includes(error)?'paused':'retry';
  await services.rpc('resale_gmail_finish_run',{...args,p_outcome:outcome,p_cursor:{...cursor,window_complete:false},p_error_code:error});
  return {status:outcome,processed:count};
 }
}
export function createHandler(services){return async request=>{
 try{
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  const input=JSON.parse(await readBounded(request,8192));
  if(input.op==='start')return json(await startOAuth(input,request.headers.get('Authorization'),services));
  if(input.op==='callback')return json(await completeOAuth(input,services));
  if(input.op==='tick')return json(await runTick(input,services));
  return json({error:'invalid_request'},400);
 }catch(error){return json({error:error instanceof FeedError?error.code:'request_failed'},error instanceof FeedError?error.status:503);}
};}
