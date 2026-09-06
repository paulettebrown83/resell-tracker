export const utf8 = new TextEncoder();
export const hex = (bytes) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
export const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
export const sha256 = async (text) => hex(await crypto.subtle.digest('SHA-256', utf8.encode(text)));
export async function signHex(keyHex, text) {
  if (!/^[a-f0-9]{64}$/i.test(keyHex || '')) throw new Error('Signing configuration unavailable');
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(keyHex.match(/../g), h => parseInt(h, 16)), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, utf8.encode(text)));
}
export async function readBounded(response, maximum = 1048576) {
  if (!response.body) return '';
  const reader=response.body.getReader(), chunks=[]; let size=0;
  try { while (true) { const {done,value}=await reader.read(); if(done)break; size+=value.length; if(size>maximum)throw new Error('Response exceeds bounded intake'); chunks.push(value); } }
  finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
  const joined=new Uint8Array(size); let offset=0;
  for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.length;}
  return new TextDecoder('utf-8',{fatal:true}).decode(joined);
}
