// 备份编排层：目标配置（本地文件夹 / WebDAV）、执行备份（本地打包→上传→保留策略）、
// 恢复准备（下载→校验→staging 预览）与应用、定时调度。凭据经 secretStorage 加密落
// settings JSON（密钥在 secrets/，永不进备份档）。需求：docs/requirements/data-backup.md。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createBackup,extractBackup,applyRestore,readManifest,listLocalBackups,BACKUP_DIR_PREFIX} from './backup-service.mjs';
import {createWebdavClient} from './webdav-client.mjs';

export const DEFAULT_REMOTE_DIR='hemi-backups';
const SCHEDULE_TICK_MS=60*60*1000;
const INTERVAL_MS={daily:24*60*60*1000,weekly:7*24*60*60*1000};

const DEFAULT_SETTINGS={schemaVersion:1,target:null,schedule:{enabled:false,interval:'daily',tier:'light'},keep:5,lastRun:null};

function normalizeSettings(raw){
  const s={...DEFAULT_SETTINGS,...(raw??{})};
  if(s.target){
    if(s.target.kind==='local')s.target={kind:'local',dir:String(s.target.dir)};
    else if(s.target.kind==='webdav')s.target={kind:'webdav',url:String(s.target.url||''),username:String(s.target.username||''),passwordEncrypted:s.target.passwordEncrypted??null,remoteDir:String(s.target.remoteDir||DEFAULT_REMOTE_DIR)};
    else s.target=null;
  }
  if(!['daily','weekly'].includes(s.schedule.interval))s.schedule.interval='daily';
  s.schedule.tier='light'; // 2026-11 用户裁决：仅轻量档；旧 schedule.tier=full 一律归一为 light
  s.keep=Math.min(Math.max(Number(s.keep)||5,1),50);
  return s;
}

export function createBackupManager({userDataDir,settingsFile=null,secretStorage,webdavFactory=createWebdavClient,appVersion='unknown',isIdle=async()=>true,log={info(){},warn(){}},emit=()=>{}}){
  const settingsPath=settingsFile??path.join(userDataDir,'backup-settings.json');
  let settings=null,running=false,tickTimer=null;
  const load=()=>{
    if(settings)return settings;
    try{settings=normalizeSettings(JSON.parse(fs.readFileSync(settingsPath,'utf8')));}catch{settings=normalizeSettings(null);}
    return settings;
  };
  const persist=()=>{fs.mkdirSync(path.dirname(settingsPath),{recursive:true});fs.writeFileSync(settingsPath,JSON.stringify(load(),null,2));};
  const status=payload=>{try{emit('backup:progress',payload);}catch{}};
  const webdavPassword=()=>{
    const enc=load().target?.passwordEncrypted;
    return enc?secretStorage.decryptString(Buffer.from(enc,'base64')):'';
  };
  const clientFor=target=>{
    if(target.kind!=='webdav')throw new Error('当前目标不是 WebDAV');
    return webdavFactory({baseUrl:target.url,username:target.username,password:webdavPassword(),log});
  };
  const tmpRoot=()=>fs.mkdtempSync(path.join(os.tmpdir(),'hemi-backup-run-'));

  async function uploadBackupSet(backupDir,setName){
    const target=load().target;const client=clientFor(target);
    status({phase:'upload',detail:'连接云端目标'});
    await client.ensureDir(`${target.remoteDir}/${setName}`);
    for(const file of fs.readdirSync(backupDir).filter(n=>n.startsWith('part-')).sort()){
      status({phase:'upload',detail:`上传 ${file}`});
      await client.uploadFile(`${target.remoteDir}/${setName}/${file}`,path.join(backupDir,file));
    }
    status({phase:'upload',detail:'上传 manifest'});
    await client.uploadFile(`${target.remoteDir}/${setName}/manifest.json`,path.join(backupDir,'manifest.json'));
  }
  async function pruneRemote(client,remoteDir,keep){
    const children=await client.listDir(remoteDir);
    const sets=children.filter(c=>c.isDir&&c.name.startsWith(BACKUP_DIR_PREFIX)).sort((a,b)=>a.name<b.name?1:-1);
    for(const stale of sets.slice(keep)){
      status({phase:'prune',detail:`清理旧备份 ${stale.name}`});
      await client.deleteFile(`${remoteDir}/${stale.name}`);
    }
  }
  function pruneLocal(dir,keep){
    const sets=listLocalBackups(dir);
    for(const stale of sets.slice(keep))fs.rmSync(stale.dir,{recursive:true,force:true});
  }

  // 仅轻量档：入参 tier 一律忽略（兼容旧调用方），打包/记录恒为 light。
  async function runBackup({trigger='manual'}={}){
    const tier='light';
    if(running)return {ok:false,code:'BUSY'};
    const target=load().target;
    if(!target)return {ok:false,code:'NO_TARGET'};
    running=true;const startedAt=Date.now();
    status({phase:'start',tier,trigger});
    try{
      let backupDir,manifest;
      if(target.kind==='local'){
        status({phase:'pack',detail:'打包中'});
        ({backupDir,manifest}=await createBackup({userDataDir,tier,outDir:target.dir,appVersion}));
      }else{
        const tmp=tmpRoot();
        try{
          status({phase:'pack',detail:'打包中'});
          ({backupDir,manifest}=await createBackup({userDataDir,tier,outDir:tmp,appVersion}));
          await uploadBackupSet(backupDir,path.basename(backupDir));
        }finally{fs.rmSync(tmp,{recursive:true,force:true});}
      }
      const keep=load().keep;
      if(target.kind==='local')pruneLocal(target.dir,keep);
      else await pruneRemote(clientFor(target),target.remoteDir,keep);
      load().lastRun={at:new Date().toISOString(),ok:true,tier,trigger,packedBytes:manifest.totals.packedBytes,files:manifest.entries.files,durationMs:Date.now()-startedAt};
      persist();
      status({phase:'done',tier,packedBytes:manifest.totals.packedBytes});
      return {ok:true,manifest:{tier:manifest.tier,createdAt:manifest.createdAt,files:manifest.entries.files,packedBytes:manifest.totals.packedBytes}};
    }catch(error){
      load().lastRun={at:new Date().toISOString(),ok:false,tier,trigger,message:String(error.message??error)};
      persist();
      status({phase:'error',message:String(error.message??error)});
      log.warn(`备份失败：${error.message??error}`);
      return {ok:false,code:'FAILED',message:String(error.message??error)};
    }finally{running=false;}
  }

  async function listBackups(){
    const target=load().target;
    if(!target)return [];
    if(target.kind==='local')return listLocalBackups(target.dir).map(b=>({...b,source:'local'}));
    const client=clientFor(target);
    const children=await client.listDir(target.remoteDir);
    const sets=[];
    for(const child of children.filter(c=>c.isDir&&c.name.startsWith(BACKUP_DIR_PREFIX)).sort((a,b)=>a.name<b.name?1:-1)){
      const tmp=tmpRoot();
      try{
        await client.downloadToFile(`${target.remoteDir}/${child.name}/manifest.json`,path.join(tmp,'manifest.json'));
        const m=readManifest(tmp);
        sets.push({name:child.name,createdAt:m.createdAt,tier:m.tier,totals:m.totals,appVersion:m.appVersion,source:'webdav'});
      }catch{sets.push({name:child.name,createdAt:null,tier:null,totals:null,appVersion:null,source:'webdav',broken:true});}
      finally{fs.rmSync(tmp,{recursive:true,force:true});}
    }
    return sets;
  }

  /** 手动删除单个备份集：本地删目录；WebDAV DELETE 集合（递归）。名称必须带备份目录前缀，防误删任意远端路径。 */
  async function deleteBackupSet(setName){
    const name=String(setName??'');
    if(!name.startsWith(BACKUP_DIR_PREFIX)||name.includes('..')||name.includes('/'))return {ok:false,code:'INVALID_NAME',message:'无效的备份集名称'};
    const target=load().target;
    if(!target)return {ok:false,code:'NO_TARGET'};
    if(target.kind==='local'){
      fs.rmSync(path.join(target.dir,name),{recursive:true,force:true});
      return {ok:true};
    }
    const client=clientFor(target);
    try{await client.deleteFile(`${target.remoteDir}/${name}`);}
    catch(error){return {ok:false,code:'FAILED',message:String(error.message??error)};}
    return {ok:true};
  }

  let currentRestore=null;
  async function prepareRestore(setName){
    if(currentRestore)return {ok:false,code:'RESTORE_BUSY'};
    const target=load().target;
    if(!target)return {ok:false,code:'NO_TARGET'};
    const staging=path.join(os.tmpdir(),`hemi-restore-${crypto.randomUUID()}`);
    status({phase:'restore-download',detail:setName});
    try{
      if(target.kind==='local'){
        const {entries}=await extractBackup({backupDir:path.join(target.dir,setName),stagingDir:staging});
        currentRestore={staging,setName};
        return {ok:true,preview:summarize(staging,entries)};
      }
      const client=clientFor(target);
      const tmp=tmpRoot();
      try{
        await client.downloadToFile(`${target.remoteDir}/${setName}/manifest.json`,path.join(tmp,'manifest.json'));
        const manifest=readManifest(tmp);
        for(const part of manifest.parts)await client.downloadToFile(`${target.remoteDir}/${setName}/${part.name}`,path.join(tmp,part.name));
        const {entries}=await extractBackup({backupDir:tmp,stagingDir:staging});
        currentRestore={staging,setName};
        return {ok:true,preview:summarize(staging,entries)};
      }finally{fs.rmSync(tmp,{recursive:true,force:true});}
    }catch(error){
      fs.rmSync(staging,{recursive:true,force:true});
      return {ok:false,code:'FAILED',message:String(error.message??error)};
    }
  }
  function summarize(staging,entries){
    const conversations=entries.filter(e=>e.rel.startsWith('runtime-v2/conversations/')&&e.rel.endsWith('.json')).length;
    const memoryFiles=entries.filter(e=>e.rel.startsWith('pi-memory/')).length;
    return {files:entries.length,conversations,memoryFiles,tops:fs.readdirSync(staging)};
  }
  function applyCurrentRestore(){
    if(!currentRestore)return {ok:false,code:'NO_RESTORE'};
    const safeCopyRoot=path.join(userDataDir,'restore-safety',`${Date.now()}`);
    const {applied}=applyRestore({stagingDir:currentRestore.staging,userDataDir,safeCopyRoot});
    fs.rmSync(currentRestore.staging,{recursive:true,force:true});
    currentRestore=null;
    return {ok:true,applied,safeCopyRoot};
  }
  function cancelRestore(){
    if(!currentRestore)return {ok:false,code:'NO_RESTORE'};
    fs.rmSync(currentRestore.staging,{recursive:true,force:true});
    currentRestore=null;
    return {ok:true};
  }

  async function tick(){
    const s=load();
    if(!s.schedule.enabled||!s.target||running)return;
    if(s.lastRun?.ok){
      const elapsed=Date.now()-new Date(s.lastRun.at).getTime();
      if(elapsed<INTERVAL_MS[s.schedule.interval])return;
    }
    if(!await isIdle())return;
    await runBackup({trigger:'scheduled'});
  }
  return {
    getSettings:()=>{const s=load();const {passwordEncrypted,...target}=s.target??{};return {...s,target:s.target?{...target,hasPassword:Boolean(passwordEncrypted)}:null};},
    async saveSettings(next){
      const prev=load();
      const merged=normalizeSettings({...prev,...next});
      if(next.target?.kind==='webdav'&&typeof next.target.password==='string'&&next.target.password){
        merged.target.passwordEncrypted=secretStorage.encryptString(next.target.password).toString('base64');
      }
      if(next.target&&!next.target.password)merged.target.passwordEncrypted=prev.target?.passwordEncrypted??null;
      settings=merged;persist();
      return this.getSettings();
    },
    async testConnection(targetSpec){
      const spec=targetSpec??load().target;
      if(!spec)return {ok:false,code:'NO_TARGET'};
      if(spec.kind==='local'){
        try{fs.mkdirSync(spec.dir,{recursive:true});const probe=path.join(spec.dir,`.hemi-probe-${crypto.randomUUID()}`);fs.writeFileSync(probe,'ok');fs.rmSync(probe);return {ok:true};}
        catch(error){return {ok:false,code:'UNWRITABLE',message:String(error.message??error)};}
      }
      let password=spec.password;
      if(!password&&spec.hasPassword)password=webdavPassword();
      if(!password)return {ok:false,code:'NO_PASSWORD',message:'未填写应用密码'};
      const client=webdavFactory({baseUrl:spec.url,username:spec.username,password,log});
      const result=await client.testConnection();
      if(result.ok){try{await client.ensureDir(spec.remoteDir||DEFAULT_REMOTE_DIR);}catch(error){return {ok:false,code:'MKCOL_FAILED',message:String(error.message??error)};}}
      return result;
    },
    runBackup,
    listBackups,
    deleteBackupSet,
    prepareRestore,
    applyCurrentRestore,
    cancelRestore,
    isRunning:()=>running,
    startSchedule(){if(tickTimer)return;tickTimer=setInterval(()=>{void tick();},SCHEDULE_TICK_MS);if(typeof tickTimer.unref==='function')tickTimer.unref();void tick();},
    stopSchedule(){if(tickTimer){clearInterval(tickTimer);tickTimer=null;}},
  };
}
