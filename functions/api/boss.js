// Boss Timer: safe two-stage JSONBin -> Cloudflare D1 migration.
// DEFAULT: JSONBin remains active. Explicitly set STORAGE_BACKEND=d1 only after
// BOTH modes are imported and verified. Same admin session / same-origin protection.
const COOKIE_NAME = 'boss_admin_session';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const encoder = new TextEncoder();
const MODES = new Set(['new','old']);
const PAYLOAD_MAX = 300000;
// V4 cross-server activity: JST Mon/Wed/Fri 00:00 to Tue/Thu/Sat 01:00.
// The activity ID is a JST date, not a user's browser time.
function jstActivity(now=Date.now()) {
  const j=new Date(now+9*3600000), day=j.getUTCDay(), hour=j.getUTCHours();
  const enabled=[1,3,5].includes(day) || ([2,4,6].includes(day)&&hour<1);
  let start=new Date(j);
  if([2,4,6].includes(day)&&hour<1)start.setUTCDate(start.getUTCDate()-1);
  const id=start.toISOString().slice(0,10);
  return {active:enabled,id:enabled?id:null};
}
function crossEventEndMs(id){return /^\d{4}-\d{2}-\d{2}$/.test(String(id||''))?Date.parse(id+'T00:00:00+09:00')+25*3600000:NaN;}
function visibleCross(data){const act=jstActivity();return act.active?(data._crossBosses||[]).filter(b=>b.activityId===act.id&&Number.isFinite(Date.parse(b.time))&&Date.parse(b.time)<crossEventEndMs(act.id)):[];}
function filterCross(data,now=Date.now()) {
  const act=jstActivity(now), old=Array.isArray(data._crossBosses)?data._crossBosses:[];
  const fresh=act.active?old.filter(b=>b&&b.activityId===act.id&&typeof b.name==='string'&&Number.isFinite(Date.parse(b.time))&&Date.parse(b.time)<crossEventEndMs(act.id)):[];
  data._crossBosses=fresh;
  return fresh.length!==old.length;
}
// Authenticated bulk postponement for this mode's cross-server records only.
// Values beyond the activity deadline are hidden and removed by the next GET cleanup.
async function delayCrossBatch(request,env,mode){
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  if(!sameOrigin(request)||!(await isAuthenticated(request,env)))return json({error:'Admin authorization required'},401);
  if(env.STORAGE_BACKEND!=='d1'||!env.BOSS_DB)return json({error:'D1 backend required'},409);
  const act=jstActivity();if(!act.active)return json({error:'Cross-server event is not active'},409);
  try{
    const row=await env.BOSS_DB.prepare('SELECT payload,updated_at FROM boss_state WHERE mode=?').bind(mode).first();
    if(!row)return json({error:'D1 mode not initialized'},409);
    const data=JSON.parse(row.payload);filterCross(data);
    const now=Date.now();let updated=0,hidden=0;
    for(const b of data._crossBosses){
      const ms=Date.parse(b.time),hours=Number(b.interval);
      if(!Number.isFinite(ms)||!Number.isFinite(hours)||hours<=0||ms>=now)continue;
      const step=hours*3600000;
      const cycles=Math.floor((now-ms)/step)+1;
      const next=ms+step*cycles;
      if(!Number.isFinite(next))continue;
      b.time=new Date(next).toISOString();updated++;
      if(next>=crossEventEndMs(act.id))hidden++;
    }
    if(updated){data.updatedAt=new Date().toISOString();const issue=validateBossData(data);if(issue)return json({error:issue},400);
      const result=await env.BOSS_DB.prepare('UPDATE boss_state SET payload=?,updated_at=? WHERE mode=? AND updated_at=?').bind(JSON.stringify(data),data.updatedAt+'-'+crypto.randomUUID(),mode,row.updated_at).run();
      if((result.meta?.changes??0)!==1)return json({error:'云端刚被其他操作修改，请重新顺延'},409);}
    return json({ok:true,updated,hidden,data:{...data,_crossBosses:visibleCross(data)}});
  }catch(e){return json({error:'D1 cross-server delay failed',detail:safeD1Error(e)},503)}
}

async function applyOcrBatch(request,env,mode) {
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  if(!sameOrigin(request)||!(await isAuthenticated(request,env)))return json({error:'Admin authorization required'},401);
  if(env.STORAGE_BACKEND!=='d1'||!env.BOSS_DB)return json({error:'D1 backend required'},409);
  let input;try{input=await request.json()}catch{return json({error:'Invalid JSON'},400)}
  const rows=input?.rows;
  if(!Array.isArray(rows)||rows.length<1||rows.length>100)return json({error:'Invalid selected rows'},400);
  const act=jstActivity();
  if(rows.some(r=>r.scope==='cross')&&!act.active)return json({error:'Cross-server event is not active in Japan time'},409);
  for(const r of rows){
    if(!r||typeof r.name!=='string'||r.name.length>150||!['local','cross'].includes(r.scope)
      ||typeof r.nextTime!=='string'||!Number.isFinite(Date.parse(r.nextTime)))return json({error:'Invalid Boss row'},400);
    if(r.scope==='cross'&&Date.parse(r.nextTime)<Date.now()-86400000)return json({error:'Old cross-server time'},409);
  }
  try{
    // Atomic read-modify-write for the selected zone; never replace the whole catalog with browser copies.
    const result=await env.BOSS_DB.prepare('SELECT payload,updated_at FROM boss_state WHERE mode=?').bind(mode).first();
    if(!result)return json({error:'D1 mode not initialized'},409);
    const data=JSON.parse(result.payload);filterCross(data);
    const catalog=Array.isArray(data._catalog?.bosses)?data._catalog.bosses:data.bosses;
    const configByName=new Map(catalog.map(b=>[b.name,b]));
    for(const r of rows){
      const config=configByName.get(r.name);
      if(!config)return json({error:'Boss not in current D1 catalog: '+r.name},409);
      if(!Number.isFinite(Number(config.interval))||Number(config.interval)<=0)return json({error:'Invalid Boss interval: '+r.name},409);
      if(r.scope==='cross'){
        const existing=data._crossBosses.find(b=>b.name===r.name&&b.activityId===act.id);
        const record={id:'cross_'+String(config.id||r.name).replace(/[^a-zA-Z0-9_]/g,'').slice(0,60),
          name:r.name,time:r.nextTime,interval:Number(config.interval),prob:Number(config.prob)||0,zone:config.zone||'',scope:'cross',activityId:act.id};
        if(existing)Object.assign(existing,record);else data._crossBosses.push(record);
      }else{
        const existing=data.bosses.find(b=>b.name===r.name);
        if(!existing)return json({error:'Boss missing in mode: '+r.name},409);
        existing.time=r.nextTime;
        // Do not modify interval or config; reset alert markers for this boss.
        data._remindedBosses=(data._remindedBosses||[]).filter(id=>id!==existing.id);
        data._stoppedFlashing=(data._stoppedFlashing||[]).filter(id=>id!==existing.id);
      }
    }
    data.updatedAt=new Date().toISOString();
    const invalid=validateBossData(data);if(invalid)return json({error:invalid},400);
    const saved=await env.BOSS_DB.prepare('UPDATE boss_state SET payload=?,updated_at=? WHERE mode=? AND updated_at=?').bind(JSON.stringify(data),data.updatedAt+'-'+crypto.randomUUID(),mode,result.updated_at).run();
    if((saved.meta?.changes??0)!==1)return json({error:'云端已被其他操作修改，请重新识别后更新'},409);
    return json({ok:true,updated:rows.length,data:{...data,_crossBosses:visibleCross(data)}});
  }catch(e){return json({error:'D1 OCR update failed',detail:safeD1Error(e)},503)}
}

const CACHE_HEADERS = {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};

// A single latest-upload snapshot per mode; no separate D1 migration needed.
async function ensureUndoTable(db){
 await db.prepare('CREATE TABLE IF NOT EXISTS boss_last_upload (mode TEXT PRIMARY KEY, before_payload TEXT NOT NULL, after_revision TEXT NOT NULL, created_at TEXT NOT NULL)').run();
}
function uploadConflicts(incoming,old){
 const matches=new Map((old.bosses||[]).map(b=>[b.name,b]));
 const conflicts=[];
 for(const b of incoming.bosses||[]){
   const existing=matches.get(b.name);if(!existing)continue;
   const from=Date.parse(b.time||''),was=Date.parse(existing.time||'');
   if(Number.isFinite(from)&&Number.isFinite(was)&&from<was)conflicts.push({name:b.name,reason:'本地刷新时间早于云端',localTime:b.time,cloudTime:existing.time});
 }
 return conflicts;
}
// V4.5.1: manual cross edits are explicit, version-checked operations.
// OCR rows retain the old latest-time-only merge, but cannot undo a manual edit/delete.
function sameCrossRecord(a,b){
  if(!a&&!b)return true;if(!a||!b)return false;
  return ['name','time','interval','zone','prob','activityId'].every(k=>{
    if(k==='interval'||k==='prob')return Number(a[k]??0)===Number(b[k]??0);
    if(k==='time')return Date.parse(a[k])===Date.parse(b[k]);
    return String(a[k]??'')===String(b[k]??'');
  });
}
function prepareCrossUpload(incoming,old){
  const act=jstActivity(),ops=incoming._crossOps===undefined?[]:incoming._crossOps;
  if(!Array.isArray(ops)||ops.length>120)return {error:'跨服编辑记录无效或过多'};
  if(ops.length&&!act.active)return {error:'跨服活动已结束，请重新下载后更新'};
  const catalog=Array.isArray(old._catalog?.bosses)?old._catalog.bosses:old.bosses;
  const byCatalog=new Map((catalog||[]).map(b=>[b.name,b]));
  const current=Array.isArray(old._crossBosses)?old._crossBosses:[];
  const byName=new Map(current.map(b=>[b.name,b]));
  const locked=new Set(),seenIds=new Set();
  const end=act.active?crossEventEndMs(act.id):NaN;
  for(const op of ops){
    if(!op||typeof op!=='object'||typeof op.id!=='string'||op.id.length>130||!op.id||seenIds.has(op.id))return {error:'跨服编辑操作不合法或重复'};
    seenIds.add(op.id);
    const before=op.before,after=op.after;
    if(!before&&!after)return {error:'跨服编辑缺少记录'};
    if(op.activityId!==act.id||before&&before.activityId!==act.id||after&&after.activityId!==act.id)
      return {error:'跨服编辑属于旧活动，已停止上传'};
    if(before&&(typeof before.name!=='string'||!before.name||before.name.length>150))return {error:'跨服原始名称无效'};
    if(after&&(typeof after.name!=='string'||!after.name||after.name.length>150))return {error:'跨服新名称无效'};
    const original=before?byName.get(before.name):null;
    if(before&&!sameCrossRecord(original,before))return {error:'跨服「'+before.name+'」云端已经变化，请先从云端下载后核对'};
    if(!before&&after&&byName.has(after.name))return {error:'跨服「'+after.name+'」已存在云端，不能作为新记录覆盖'};
    if(before&&locked.has(before.name))return {error:'同一只跨服 Boss 存在多次冲突操作'};
    if(before){byName.delete(before.name);locked.add(before.name);}
    if(after){
      const cfg=byCatalog.get(after.name);
      const t=Date.parse(after.time||''),interval=Number(after.interval),prob=Number(after.prob);
      if(!cfg)return {error:'跨服 Boss 未入库：'+after.name};
      if(!Number.isFinite(t)||t>=end||t<Date.now()-86400000)return {error:'跨服「'+after.name+'」刷新时间无效或超过活动结束时间'};
      if(!Number.isFinite(interval)||interval<=0||interval>720)return {error:'跨服「'+after.name+'」刷新间隔无效'};
      if(!Number.isFinite(prob)||prob<0||prob>100||typeof after.zone!=='string'||after.zone.length>80)
        return {error:'跨服「'+after.name+'」配置异常'};
      if(byName.has(after.name))return {error:'跨服「'+after.name+'」已存在，不能重复更名'};
      if(locked.has(after.name)&&after.name!==before?.name)return {error:'跨服编辑命名冲突：'+after.name};
      const id=String(after.id||op.id);
      if(id.length>130||!/^[a-zA-Z0-9_-]+$/.test(id))return {error:'跨服记录 ID 无效'};
      byName.set(after.name,{id,name:after.name,time:new Date(t).toISOString(),interval,prob,zone:after.zone,scope:'cross',activityId:act.id});
      locked.add(after.name);
    }
  }
  // Legacy screenshot updates are latest-only. Only explicit ops may correct an earlier
  // time, rename or delete a record; otherwise server-owned rows are preserved.
  if(act.active)for(const b of Array.isArray(incoming._crossBosses)?incoming._crossBosses:[]){
    if(!b||locked.has(b.name)||b.activityId!==act.id)continue;
    const cfg=byCatalog.get(b.name),t=Date.parse(b.time||'');
    if(!cfg||!Number.isFinite(t)||t>=end||t<Date.now()-86400000)continue;
    const prior=byName.get(b.name);
    if(!prior||Date.parse(prior.time)<t)byName.set(b.name,{
      id:'cross_'+String(cfg.id||b.name).replace(/[^a-zA-Z0-9_]/g,'').slice(0,60),
      name:b.name,time:new Date(t).toISOString(),interval:Number(cfg.interval),prob:Number(cfg.prob)||0,
      zone:cfg.zone||'',scope:'cross',activityId:act.id
    });
  }
  return {records:act.active?[...byName.values()]:[]};
}
async function uploadCheck(request,env,mode){
 if(request.method!=='POST')return json({error:'Method not allowed'},405);
 if(!sameOrigin(request)||!(await isAuthenticated(request,env)))return json({error:'请先登录管理员'},401);
 if(env.STORAGE_BACKEND!=='d1'||!env.BOSS_DB)return json({error:'仅支持 D1 云端'},409);
 let incoming;try{incoming=await request.json()}catch{return json({error:'Invalid JSON'},400)}
 const issue=validateBossData(incoming);if(issue)return json({error:issue},400);
 const row=await env.BOSS_DB.prepare('SELECT payload,updated_at FROM boss_state WHERE mode=?').bind(mode).first();
 if(!row)return json({error:'云端记录不存在'},409);
  const prior=JSON.parse(row.payload);filterCross(prior);
  const cross=prepareCrossUpload(incoming,prior);if(cross.error)return json({error:cross.error},409);
  return json({ok:true,revision:row.updated_at,conflicts:uploadConflicts(incoming,prior)});
}
async function undoUpload(request,env,mode){
 if(request.method!=='POST')return json({error:'Method not allowed'},405);
 if(!sameOrigin(request)||!(await isAuthenticated(request,env)))return json({error:'请先登录管理员'},401);
 if(env.STORAGE_BACKEND!=='d1'||!env.BOSS_DB)return json({error:'仅支持 D1 云端'},409);
 try{
   await ensureUndoTable(env.BOSS_DB);
   const [current,snap]=await Promise.all([
     env.BOSS_DB.prepare('SELECT updated_at FROM boss_state WHERE mode=?').bind(mode).first(),
     env.BOSS_DB.prepare('SELECT before_payload,after_revision FROM boss_last_upload WHERE mode=?').bind(mode).first()
   ]);
   if(!snap)return json({error:'没有可撤销的云端上传记录'},409);
   if(current?.updated_at!==snap.after_revision)return json({error:'云端数据已有新修改，不能撤销以免覆盖其他人的更新'},409);
   const old=JSON.parse(snap.before_payload);filterCross(old);
   const rev=new Date().toISOString()+'-'+crypto.randomUUID();old.updatedAt=new Date().toISOString();
   const res=await env.BOSS_DB.prepare('UPDATE boss_state SET payload=?,updated_at=? WHERE mode=? AND updated_at=?')
      .bind(JSON.stringify(old),rev,mode,snap.after_revision).run();
   if((res.meta?.changes||0)!==1)return json({error:'云端状态已变化，请重新确认'},409);
   await env.BOSS_DB.prepare('DELETE FROM boss_last_upload WHERE mode=? AND after_revision=?').bind(mode,snap.after_revision).run();
   return json({ok:true,mode});
 }catch(e){return json({error:'撤销失败',detail:safeD1Error(e)},503)}
}
export async function onRequest({request,env}) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  if (action === 'login' || action === 'logout' || action === 'session') return authRequest(request,env,action);
  if (action === 'ocr-apply') { const mode=url.searchParams.get('mode'); return MODES.has(mode)?applyOcrBatch(request,env,mode):json({error:'Invalid mode'},400); }
  if (action === 'cross-delay') return json({error:'请升级至 V4.5.1：跨服批量顺延现在只更新本地，需手动上传'},409);
  if(action==='upload-check'||action==='undo-upload'){const mode=url.searchParams.get('mode');return MODES.has(mode)?(action==='upload-check'?uploadCheck(request,env,mode):undoUpload(request,env,mode)):json({error:'Invalid mode'},400);}
  if (action === 'storage-status') return storageStatus(request,env);
  if (action === 'catalog-mutate' || action === 'reset-both') return changeBothModes(request,env,action);
  const mode = url.searchParams.get('mode');
  if (!MODES.has(mode)) return json({error:'Invalid mode'},400);
  if (action === 'import-d1') return importD1(request,env,mode);
  if (action) return json({error:'Unknown action'},404);
  if (!['GET','PUT'].includes(request.method)) return json({error:'Method not allowed'},405);
  const backend = env.STORAGE_BACKEND === 'd1' ? 'd1' : 'jsonbin';
  if (request.method === 'PUT') {
    if (!sameOrigin(request)) return json({error:'Forbidden origin'},403);
    if (!(await isAuthenticated(request,env))) return json({error:'Unauthorized'},401);
    let data;
    try { data = await request.json(); } catch { return json({error:'Invalid JSON'},400); }
    const problem = validateBossData(data);
    if (problem) return json({error:problem},400);
    if (backend === 'd1') {
      if (!env.BOSS_DB) return json({error:'D1 binding BOSS_DB is missing'},503);
      try {
        // If either mode is unseeded, stop writes rather than clobbering it.
        const row=await env.BOSS_DB.prepare('SELECT mode FROM boss_state WHERE mode=?').bind(mode).first();
        if(!row) return json({error:'D1 mode not imported yet; open /migrate-d1.html first',mode},409);
        // Merge against the exact D1 revision checked by the admin; never let an old
        // browser tab blindly replace server rows or undo a concurrent cross edit.
        const oldRow=await env.BOSS_DB.prepare('SELECT payload,updated_at FROM boss_state WHERE mode=?').bind(mode).first();
        if(!oldRow||!data._expectedRevision||oldRow.updated_at!==data._expectedRevision)return json({error:'云端版本已变化，请重新检查后上传'},409);
        const old=JSON.parse(oldRow.payload);filterCross(old);
        const unsafe=uploadConflicts(data,old);
        // V4.5.3: an authenticated admin can explicitly confirm an older local timestamp.
        // Never bypass the revision CAS or independent cross-edit conflict checks.
        if(unsafe.length && data._forceOlderLocal!==true)
          return json({error:'发现本服时间较云端旧，需在管理员上传窗口确认覆盖：'+unsafe.map(x=>x.name).slice(0,8).join('、')},409);
        const crossResult=prepareCrossUpload(data,old);
        if(crossResult.error)return json({error:crossResult.error},409);
        data._crossBosses=crossResult.records;
        delete data._crossOps;delete data._expectedRevision;delete data._forceOlderLocal;
        filterCross(data);
        await ensureUndoTable(env.BOSS_DB);
        const revision=new Date().toISOString()+'-'+crypto.randomUUID();
        // D1 batch keeps the last-upload snapshot and the new state together.
        // D1 batch executes these statements in one transaction. Update the state FIRST;
        // only create an undo snapshot when that exact revision was successfully written.
        // A stale-tab CAS failure (0 changed rows) must never damage a valid undo snapshot.
        const writeResults=await env.BOSS_DB.batch([
          env.BOSS_DB.prepare('UPDATE boss_state SET payload=?,updated_at=? WHERE mode=? AND updated_at=?').bind(JSON.stringify(data),revision,mode,oldRow.updated_at),
          env.BOSS_DB.prepare(`INSERT INTO boss_last_upload(mode,before_payload,after_revision,created_at)
            SELECT ?,?,?,? WHERE EXISTS
            (SELECT 1 FROM boss_state WHERE mode=? AND updated_at=?)
            ON CONFLICT(mode) DO UPDATE SET before_payload=excluded.before_payload,
              after_revision=excluded.after_revision,created_at=excluded.created_at`)
            .bind(mode,oldRow.payload,revision,new Date().toISOString(),mode,revision)
        ]);
        if((writeResults[0]?.meta?.changes??0)!==1)return json({error:'上传时云端已变化，未覆盖云端，请重试'},409);
        if((writeResults[1]?.meta?.changes??0)!==1)return json({error:'上传状态已写入，但撤销快照异常；请停止上传并检查云端'},503);
        return json({ok:true,mode,updatedAt:data.updatedAt||null,storage:'d1',crossBosses:visibleCross(data)});
      } catch(e) {return json({error:'D1 write failed',detail:safeD1Error(e)},503);}
    }
    return writeJsonbin(env,mode,data);
  }
  if(backend==='d1') {
    if(!env.BOSS_DB) return json({error:'D1 binding BOSS_DB is missing'},503);
    try {
      // Concurrent-safe cleanup. Never write a stale whole-row payload over a newer upload.
      for(let attempt=0;attempt<3;attempt++){
        const row=await env.BOSS_DB.prepare('SELECT payload,updated_at FROM boss_state WHERE mode=?').bind(mode).first();
        if(!row)return json({error:'D1 mode not imported yet',mode},503);
        const data=JSON.parse(row.payload);
        if(!filterCross(data))return json({...data,_crossBosses:visibleCross(data)},200);
        const revision=new Date().toISOString()+'-'+crypto.randomUUID();
        const result=await env.BOSS_DB.prepare('UPDATE boss_state SET payload=?,updated_at=? WHERE mode=? AND updated_at=?')
          .bind(JSON.stringify(data),revision,mode,row.updated_at).run();
        if((result.meta?.changes??0)===1)return json({...data,_crossBosses:visibleCross(data)},200);
      }
      // A concurrent writer won every attempt. Return its latest state without a stale write.
      const latest=await env.BOSS_DB.prepare('SELECT payload FROM boss_state WHERE mode=?').bind(mode).first();
      if(!latest)return json({error:'D1 mode unavailable'},503);
      const state=JSON.parse(latest.payload);filterCross(state);
      return json({...state,_crossBosses:visibleCross(state)},200);
    } catch(e) {return json({error:'D1 read failed',detail:safeD1Error(e)},503);}
  }
  return readJsonbin(env,mode);
}

// Changes both D1 rows in one D1 batch; never update just one zone on a partial failure.
async function changeBothModes(request,env,action) {
  if (request.method!=='POST') return json({error:'Method not allowed'},405);
  if (!sameOrigin(request)) return json({error:'Forbidden origin'},403);
  if (!(await isAuthenticated(request,env))) return json({error:'Admin login required'},401);
  if (env.STORAGE_BACKEND!=='d1' || !env.BOSS_DB) return json({error:'D1 must be active before modifying both modes'},409);
  let body={};
  if(action==='catalog-mutate') {
    try{body=await request.json();}catch{return json({error:'Invalid JSON'},400);}
    if(!['upsert','delete'].includes(body.op))return json({error:'Invalid operation'},400);
    if(typeof body.previousName!=='string'||body.previousName.length>150)return json({error:'Invalid previous name'},400);
    if(body.op==='upsert'){
      const b=body.boss;
      if(!b||typeof b.name!=='string'||!b.name.trim()||b.name.length>150||
        !Number.isFinite(Number(b.interval))||Number(b.interval)<=0||
        !Number.isFinite(Number(b.prob))||Number(b.prob)<0||Number(b.prob)>100||
        typeof b.zone!=='string'||!b.zone.trim()||b.zone.length>80)
        return json({error:'Invalid Boss configuration'},400);
    }
  }
  try {
    const rows=await env.BOSS_DB.prepare('SELECT mode,payload FROM boss_state WHERE mode IN (?,?)').bind('new','old').all();
    const states={};
    for(const r of rows.results||[]){states[r.mode]=JSON.parse(r.payload);filterCross(states[r.mode]);}
    if(!states.new||!states.old||!Array.isArray(states.new.bosses)||!Array.isArray(states.old.bosses))
      return json({error:'Both D1 modes must be imported before this operation'},409);
    const catalogs=[states.new._catalog,states.old._catalog].filter(c=>c&&Array.isArray(c.bosses));
    const shared=new Map();
    const zones=new Set();
    for(const c of catalogs){
      for(const z of c.zones||[])if(typeof z==='string'&&z.trim())zones.add(z);
      for(const b of c.bosses){if(b&&typeof b.name==='string'&&b.name.trim())shared.set(b.name,{...b,time:''});}
    }
    // Recover legacy records from either mode rather than dropping them on reset.
    for(const m of ['new','old'])for(const b of states[m].bosses){
      if(b&&typeof b.name==='string'&&b.name.trim()&&!shared.has(b.name))
        shared.set(b.name,{id:b.id,name:b.name,time:'',interval:Number(b.interval)||1,prob:Number(b.prob)||0,zone:b.zone||'未分区'});
    }
    if(action==='catalog-mutate'){
      if(body.op==='upsert'){
        const b=body.boss;const name=b.name.trim();const old=body.previousName.trim();
        if(old&&old!==name&&shared.has(name))return json({error:'Target Boss name already exists'},409);
        if(!old&&shared.has(name))return json({error:'Boss already exists'},409);
        if(old&&old!==name)shared.delete(old);
        const previous=catalogs.flatMap(c=>c.bosses).find(x=>x.name===old)||shared.get(old);
        shared.set(name,{id:previous?.id||String(b.id||('custom_'+crypto.randomUUID())),name,time:'',interval:Number(b.interval),prob:Number(b.prob),zone:b.zone.trim()});
        zones.add(b.zone.trim());
      }else{
        if(!body.previousName.trim())return json({error:'Missing Boss name'},400);
        shared.delete(body.previousName.trim());
        if(!shared.size)return json({error:'Cannot delete the last Boss'},409);
      }
    }
    const catalog={version:2,zones:[...zones],bosses:[...shared.values()]};
    for(const m of ['new','old']){
      const s=states[m];
      if(action==='reset-both'){
        s.bosses=catalog.bosses.map(b=>({...b,id:(m==='new'?'n_':'o_')+String(b.id),time:''}));
        s._remindedBosses=[];s._stoppedFlashing=[];
      }else if(body.op==='upsert'){
        const b=catalog.bosses.find(x=>x.name===body.boss.name.trim());
        let found=false;
        s.bosses=s.bosses.map(x=>{
          if(x.name!==body.previousName.trim()&&x.name!==b.name)return x;
          found=true;return {...x,name:b.name,interval:b.interval,prob:b.prob,zone:b.zone};
        });
        if(!found)s.bosses.push({...b,id:(m==='new'?'n_':'o_')+String(b.id),time:''});
      }else s.bosses=s.bosses.filter(x=>x.name!==body.previousName.trim());
      s._catalog=catalog;s.mode=m;s.updatedAt=new Date().toISOString();
      const issue=validateBossData(s);if(issue)return json({error:'Invalid '+m+' state: '+issue},400);
    }
    await env.BOSS_DB.batch(['new','old'].map(m=>env.BOSS_DB.prepare(
      'UPDATE boss_state SET payload=?,updated_at=? WHERE mode=?').bind(JSON.stringify(states[m]),new Date().toISOString(),m)));
    return json({ok:true,new:states.new,old:states.old,operation:action});
  }catch(e){return json({error:'D1 two-mode update failed',detail:safeD1Error(e)},503);}
}

function validateBossData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.bosses)) return 'Missing bosses array';
  if (data.bosses.length > 500 || data.bosses.some(b=>!b||typeof b.name!=='string'||b.name.length>150)) return 'Invalid boss data';
  if (JSON.stringify(data).length > PAYLOAD_MAX) return 'Payload too large';
  return null;
}
function safeD1Error(e){
  const msg=String(e?.message||'Unknown D1 failure');
  // Avoid SQL contents or backend details in public errors.
  return /no such table/i.test(msg) ? 'Run schema.sql in the D1 console first' : 'Check D1 binding and database schema';
}
async function writeD1(db,mode,data) {
  await db.prepare('INSERT INTO boss_state (mode,payload,updated_at) VALUES (?,?,?) ON CONFLICT(mode) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at')
    .bind(mode,JSON.stringify(data),new Date().toISOString()).run();
}
async function storageStatus(request,env) {
  if(request.method!=='GET')return json({error:'Method not allowed'},405);
  if(!env.BOSS_DB)return json({configured:false,backend:env.STORAGE_BACKEND==='d1'?'d1':'jsonbin',modes:{new:false,old:false}});
  try {
    const result=await env.BOSS_DB.prepare('SELECT mode, LENGTH(payload) AS bytes, updated_at FROM boss_state WHERE mode IN (?,?)').bind('new','old').all();
    const modes={new:null,old:null};
    for(const row of result.results||[]) modes[row.mode]={bytes:row.bytes,updatedAt:row.updated_at};
    return json({configured:true,backend:env.STORAGE_BACKEND==='d1'?'d1':'jsonbin',modes});
  } catch(e){return json({error:'D1 status failed',detail:safeD1Error(e)},503);}
}
async function importD1(request,env,mode) {
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  if(!sameOrigin(request))return json({error:'Forbidden origin'},403);
  if(!(await isAuthenticated(request,env)))return json({error:'Unauthorized'},401);
  if(!env.BOSS_DB)return json({error:'D1 binding BOSS_DB is missing'},503);
  // Import is intentionally separate from active production write path.
  if(env.STORAGE_BACKEND==='d1')return json({error:'Imports disabled after D1 activation'},409);
  let data;
  try {data=await request.json();}catch{return json({error:'Invalid JSON'},400);}
  const problem=validateBossData(data);
  if(problem)return json({error:problem},400);
  try {
    const old=await env.BOSS_DB.prepare('SELECT mode FROM boss_state WHERE mode=?').bind(mode).first();
    if(old)return json({error:'D1 data already imported for this mode. Re-import is blocked to prevent overwriting.',mode},409);
    await writeD1(env.BOSS_DB,mode,data);
    return json({ok:true,imported:true,mode,bossCount:data.bosses.length});
  } catch(e){return json({error:'D1 import failed',detail:safeD1Error(e)},503);}
}
async function readJsonbin(env,mode){
  const binId = mode==='new'?env.JSONBIN_NEW_BIN_ID:env.JSONBIN_OLD_BIN_ID;
  if(!binId||!env.JSONBIN_MASTER_KEY)return json({error:'JSONBin not configured'},503);
  try {
    const response=await fetch('https://api.jsonbin.io/v3/b/'+binId+'/latest',{headers:{'X-Master-Key':env.JSONBIN_MASTER_KEY},cf:{cacheTtl:0}});
    if(!response.ok)return json({error:'JSONBin read failed',status:response.status},502);
    const content=await response.json();
    return json(content.record||{},200);
  }catch{return json({error:'Upstream unavailable'},502);}
}
async function writeJsonbin(env,mode,data){
  const binId=mode==='new'?env.JSONBIN_NEW_BIN_ID:env.JSONBIN_OLD_BIN_ID;
  if(!binId||!env.JSONBIN_MASTER_KEY)return json({error:'JSONBin not configured'},503);
  try {
    const response=await fetch('https://api.jsonbin.io/v3/b/'+binId,{method:'PUT',headers:{'X-Master-Key':env.JSONBIN_MASTER_KEY,'Content-Type':'application/json'},body:JSON.stringify(data)});
    if(!response.ok)return json({error:'JSONBin write failed',status:response.status},502);
    return json({ok:true,mode,updatedAt:data.updatedAt||null,storage:'jsonbin'});
  }catch{return json({error:'Upstream unavailable'},502);}
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
