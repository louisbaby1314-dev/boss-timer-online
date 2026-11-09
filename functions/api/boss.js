// Cloudflare Pages Function: public reads, authenticated writes, 30-day signed sessions.
// JSONBin credentials and ADMIN_PASSWORD exist only in Cloudflare environment secrets.
const COOKIE_NAME = 'boss_admin_session';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const encoder = new TextEncoder();

export async function onRequest({request, env}) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  if (action) return authRequest(request, env, action);
  const mode = url.searchParams.get('mode');
  if (mode !== 'new' && mode !== 'old') return json({error:'Invalid mode'},400);
  if (!['GET','PUT'].includes(request.method)) return json({error:'Method not allowed'},405);
  const binId = mode === 'new' ? env.JSONBIN_NEW_BIN_ID : env.JSONBIN_OLD_BIN_ID;
  const masterKey = env.JSONBIN_MASTER_KEY;
  if (!binId || !masterKey) return json({error:'Server is not configured'},503);
  const headers = {'X-Master-Key':masterKey, 'Content-Type':'application/json'};
  if (request.method === 'PUT') {
    if (!sameOrigin(request)) return json({error:'Forbidden origin'},403);
    if (!(await isAuthenticated(request,env))) return json({error:'Unauthorized'},401);
    let data;
    try { data=await request.json(); } catch { return json({error:'Invalid JSON'},400); }
    if (!data || !Array.isArray(data.bosses) || data.bosses.length>500 || data.bosses.some(b=>!b||typeof b.name!=='string'||b.name.length>150))
      return json({error:'Invalid boss data'},400);
    const serialized=JSON.stringify(data);
    if(serialized.length>300000) return json({error:'Payload too large'},413);
    try {
      const response=await fetch('https://api.jsonbin.io/v3/b/'+binId,{method:'PUT',headers,body:serialized});
      if (!response.ok) return json({error:'JSONBin write failed',status:response.status},502);
      return json({ok:true,mode,updatedAt:data.updatedAt||null});
    } catch { return json({error:'Upstream unavailable'},502); }
  }
  try {
    const response=await fetch('https://api.jsonbin.io/v3/b/'+binId+'/latest',{headers:{'X-Master-Key':masterKey},cf:{cacheTtl:0}});
    if (!response.ok) return json({error:'JSONBin read failed',status:response.status},502);
    const content=await response.json();
    return json(content.record||{},200);
  } catch { return json({error:'Upstream unavailable'},502); }
}

async function authRequest(request, env, action) {
  if (!env.ADMIN_PASSWORD) return json({error:'Admin password not configured'},503);
  if (action === 'session' && request.method === 'GET') {
    return json({authenticated:await isAuthenticated(request,env)});
  }
  if (!['login','logout'].includes(action) || request.method !== 'POST') return json({error:'Method not allowed'},405);
  if (!sameOrigin(request)) return json({error:'Forbidden origin'},403);
  if (action === 'logout') return json({ok:true},{status:200,cookie:clearCookie()});
  let payload;
  try { payload=await request.json(); } catch { return json({error:'Invalid JSON'},400); }
  if (!payload || typeof payload.password !== 'string' || payload.password.length > 1024 || !payload.password)
    return json({error:'Invalid credentials'},401);
  // Fixed-length HMAC comparison rather than matching password text in JS.
  const expected=await digestText(env.ADMIN_PASSWORD);
  const actual=await digestText(payload.password);
  if (!constantTimeEqual(expected,actual)) return json({error:'Unauthorized'},401);
  const remember = payload.remember !== false;
  const expires = Math.floor(Date.now()/1000) + (remember ? SESSION_SECONDS : 12*60*60);
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const prefix = `v1.${expires}.${nonce}`;
  const sig = base64url(await sign(prefix,env.ADMIN_PASSWORD));
  const token = `${prefix}.${sig}`;
  const cookie = `${COOKIE_NAME}=${token}; Path=/api; HttpOnly; Secure; SameSite=Strict`+(remember?`; Max-Age=${SESSION_SECONDS}`:'');
  return json({ok:true,authenticated:true,expiresAt:new Date(expires*1000).toISOString()},{status:200,cookie});
}

async function isAuthenticated(request,env) {
  if(!env.ADMIN_PASSWORD) return false;
  const raw = request.headers.get('Cookie') || '';
  const match = raw.match(/(?:^|;\s*)boss_admin_session=([^;]+)/);
  if(!match) return false;
  const token=match[1];
  if(token.length>500) return false;
  const parts=token.split('.');
  if(parts.length!==4||parts[0]!=='v1'||!/^\d{10}$/.test(parts[1])||!/^[A-Za-z0-9_-]{22}$/.test(parts[2])||!/^[A-Za-z0-9_-]{43}$/.test(parts[3])) return false;
  const exp=Number(parts[1]);
  if(!Number.isSafeInteger(exp)||exp<=Date.now()/1000||exp>Date.now()/1000+SESSION_SECONDS+60) return false;
  const expected=base64url(await sign(parts.slice(0,3).join('.'),env.ADMIN_PASSWORD));
  return constantTimeEqual(expected,parts[3]);
}

async function sign(message,password) {
  const key=await crypto.subtle.importKey('raw',encoder.encode('boss-session-v1:'+password),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(message)));
}
async function digestText(value) {return new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)));}
function constantTimeEqual(a,b) {
  if(typeof a==='string' && typeof b==='string') {
    if(a.length!==b.length)return false;
    let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;
  }
  if(a.length!==b.length)return false;
  let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;
}
function base64url(bytes){return btoa(Array.from(bytes,b=>String.fromCharCode(b)).join('')).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function sameOrigin(request){
  const origin=request.headers.get('Origin');
  if(origin) {try{return new URL(origin).origin===new URL(request.url).origin;}catch{return false;}}
  // Browsers always send Origin on cross-origin unsafe requests; require fetch-metadata where available.
  const site=request.headers.get('Sec-Fetch-Site');
  return site==='same-origin';
}
function clearCookie(){return `${COOKIE_NAME}=; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;}
function json(obj,options=200) {
  const status=typeof options==='number'?options:options.status||200;
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
  if(typeof options==='object' && options.cookie)headers['Set-Cookie']=options.cookie;
  return new Response(JSON.stringify(obj),{status,headers});
}
