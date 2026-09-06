import {sha256} from './crypto.mjs';
export const PARSER_VERSION='vinted-gmail-v1';
export const VINTED_SENDER='no-reply@vinted.com';
const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
function decodeEntities(value){return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_,code)=>{if(code[0]!=='#')return entities[code.toLowerCase()];const n=code[1].toLowerCase()==='x'?parseInt(code.slice(2),16):Number(code.slice(1));return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';});}
function clean(value,max=500){return decodeEntities(value).replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);}
function base64Text(data){if(!/^[A-Za-z0-9_-]*={0,2}$/.test(data)||data.length>350000)throw Error('unsupported_body');return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(data.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)));}
function htmlBody(payload){let size=0,nodes=0;const bodies=[];function walk(part,depth){if(!part||depth>10||++nodes>64)throw Error('unsupported_body');if(part.mimeType==='text/html'||part.mimeType==='text/plain'){if(part.filename||part.body?.attachmentId)throw Error('unsupported_body');const text=base64Text(part.body?.data||'');size+=text.length;if(size>250000)throw Error('unsupported_body');bodies.push({mime:part.mimeType,text});}for(const child of part.parts||[])walk(child,depth+1);}walk(payload,0);return bodies.find(b=>b.mime==='text/html')?.text||bodies.map(b=>b.text).join('\n');}
function conversationIds(html){const ids=[];for(const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)){try{let u=new URL(decodeEntities(match[1]));if(u.hostname==='links.vinted.com'&&/^\/t\/[A-Za-z0-9_-]+$/.test(u.pathname)){u=new URL(base64Text(u.pathname.slice(3)).split('|')[0]);}if(u.protocol==='https:'&&u.hostname==='www.vinted.com'&&/^\/inbox\/\d+$/.test(u.pathname))ids.push(u.pathname.split('/').pop());}catch{ /* Unknown navigation is not evidence. Never fetch any link. */ }}return [...new Set(ids)].slice(0,10);}
/** Gmail message IDs and internalDate are source evidence, never marketplace order identity. */
export async function parseVintedMessage(message,expectedHandle){
 const headers=(Array.isArray(message.payload?.headers)?message.payload.headers:[]).filter(h=>h&&typeof h.name==='string'&&typeof h.value==='string'),values=(name)=>headers.filter(h=>h.name.toLowerCase()===name).map(h=>h.value);
 const from=values('from'),auth=values('authentication-results')[0]||'',subjects=values('subject');
 const sender=from.length===1&&(from[0].trim().toLowerCase()===VINTED_SENDER||/^Team Vinted\s*<no-reply@vinted\.com>$/i.test(from[0].trim()));
 const authenticated=sender&&/^mx\.google\.com\s*;/i.test(auth)&&/\bdkim=pass\s+header\.i=@vinted\.com(?:\s|;)/i.test(auth)&&/\bdmarc=pass\b[^;]*\bheader\.from=vinted\.com(?:\s|;|$)/i.test(auth);
 const normalized={subject:clean(subjects[0]||'',500),account_handle:null,product_titles:[],money_mentions:[],conversation_ids:[],transaction_id:null,order_id:null,listing_id:null,parser_status:'quarantined',quarantine_reason:null,authentication_pass:Boolean(authenticated)};
 let kind='unknown';const quarantine=(reason)=>{normalized.quarantine_reason=reason;};
 if(!authenticated)quarantine('sender_authentication');
 else if(subjects.length!==1)quarantine('ambiguous_subject');
 else {try{
  const html=htmlBody(message.payload),text=clean(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' '),250000);
  const greeting=text.match(/\bHello\s+([A-Za-z0-9_.-]+),/);
  if(!expectedHandle||greeting?.[1]!==expectedHandle)quarantine('mailbox_account_mismatch');
  else {
   normalized.account_handle=greeting[1];
   if(normalized.subject==='You sold an item on Vinted'&&/\bhas bought\b/.test(text)&&text.includes("payment to your Vinted Wallet once the order is completed")){
    kind='sale_notification';
    normalized.product_titles=[...html.matchAll(/<img\b[^>]*\balt\s*=\s*["']([^"']*)["'][^>]*>/gi)].map(m=>clean(m[1])).filter(Boolean).slice(0,20);
    normalized.conversation_ids=conversationIds(html);
    normalized.money_mentions=[...new Set(text.match(/\$\d{1,8}(?:,\d{3})*(?:\.\d{2})?/g)||[])].slice(0,10).map(raw=>{const minor=Math.round(Number(raw.replace(/[$,]/g,''))*100);return {raw,amount_minor:Number.isSafeInteger(minor)&&minor<=1000000000?minor:null,currency_symbol:'$',currency_code:null,meaning:'unallocated'};});
    if(!normalized.product_titles.length||!normalized.conversation_ids.length){kind='unknown';quarantine('unrecognized_template');}
   } else if(/ shipping label [–-] use by /.test(normalized.subject)&&text.includes('Your shipping label is attached to this message.')&&text.includes('Shipping information')){
    kind='shipping_notification';normalized.product_titles=[normalized.subject.split(/ shipping label [–-] use by /)[0]];
    normalized.transaction_id=text.match(/\bTransaction ID:\s*(\d{5,30})\b/)?.[1]||null;
   } else quarantine('unrecognized_template');
   if(kind!=='unknown'){normalized.parser_status='recognized';normalized.quarantine_reason=null;}
  }
 }catch{quarantine('unsupported_body');}}
 const source={id:message.id,threadId:message.threadId,internalDate:message.internalDate,payload:message.payload};
 return {kind,normalized,source_sha256:await sha256(JSON.stringify(source))};
}
