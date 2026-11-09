// Cloudflare Pages Function. Keep JSONBin credentials in Pages Secrets, never in public HTML.
export async function onRequest({request, env}) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode');
  if (mode !== 'new' && mode !== 'old') return json({error:'Invalid mode'},400);
  if (!['GET','PUT'].includes(request.method)) return json({error:'Method not allowed'},405);
  const binId = mode === 'new' ? env.JSONBIN_NEW_BIN_ID : env.JSONBIN_OLD_BIN_ID;
  const masterKey = env.JSONBIN_MASTER_KEY;
  if (!binId || !masterKey) return json({error:'Server is not configured'},503);
  const headers = {'X-Master-Key':masterKey, 'Content-Type':'application/json'};
  if (request.method === 'PUT') {
    if (!env.ADMIN_PASSWORD || request.headers.get('X-Admin-Password') !== env.ADMIN_PASSWORD)
      return json({error:'Unauthorized'},401);
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
function json(obj,status=200){return new Response(JSON.stringify(obj),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
