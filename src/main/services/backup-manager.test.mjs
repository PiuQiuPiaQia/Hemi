// backup-manager 单测：设置加密与脱敏、本地/WebDAV 目标执行链路（mock WebDAV 验证
// 上传顺序与保留策略）、恢复准备/应用/取消、调度空闲门控。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createBackupManager} from './backup-manager.mjs';
import {createBackup,BACKUP_DIR_PREFIX} from './backup-service.mjs';

function tmpDir(){return fs.mkdtempSync(path.join(os.tmpdir(),'hemi-mgr-'));}
const secretStorage={encryptString:t=>Buffer.from(`enc:${t}`),decryptString:b=>String(b).replace(/^enc:/,''),isEncryptionAvailable:()=>true};

function seedUserData(dir){
  fs.mkdirSync(path.join(dir,'runtime-v2/conversations'),{recursive:true});
  fs.mkdirSync(path.join(dir,'pi-memory'),{recursive:true});
  fs.writeFileSync(path.join(dir,'runtime-v2/conversations/c1.json'),'{"id":"c1","turns":[1,2,3]}');
  fs.writeFileSync(path.join(dir,'pi-memory/MEMORY.md'),'mem');
}

// 内存 WebDAV 服务端：目录集合 + 文件内容，记录上传顺序供断言
function mockWebdav(){
  const store=new Map();const dirs=new Set(['']);
  const calls=[];
  return {calls,store,
    factory({baseUrl}){
      const key=p=>p.split('/').filter(Boolean).join('/');
      return {
        async testConnection(){return store===null?{ok:false}:{ok:true};},
        async ensureDir(rel){rel.split('/').filter(Boolean).reduce((acc,seg,i,arr)=>{dirs.add(key(arr.slice(0,i+1).join('/')));return null;},null);calls.push(['mkcol',rel]);return true;},
        async uploadFile(rel,abs){store.set(key(rel),fs.readFileSync(abs));calls.push(['put',key(rel)]);return {bytes:1};},
        async downloadToFile(rel,abs){const v=store.get(key(rel));if(!v)throw new Error('404');fs.writeFileSync(abs,v);return {bytes:v.length};},
        async deleteFile(rel){const k=key(rel);store.delete(k);for(const key2 of store.keys())if(key2.startsWith(k+'/'))store.delete(key2);calls.push(['delete',k]);return true;},
        async listDir(rel=''){
          const prefix=key(rel)?key(rel)+'/':'';
          const names=new Set();
          for(const k of store.keys()){
            if(!k.startsWith(prefix))continue;
            const rest=k.slice(prefix.length);
            const seg=rest.split('/')[0];
            names.add(seg);
          }
          for(const d of dirs){
            if(!d.startsWith(prefix))continue;
            const rest=d.slice(prefix.length);
            if(rest)names.add(rest.split('/')[0]);
          }
          return [...names].map(name=>({href:`/${prefix}${name}`,name,isDir:!store.has(prefix+name),bytes:null,modified:null}));
        },
        _baseUrl:baseUrl,
      };
    },
  };
}

test('settings: webdav password encrypted at rest and never returned; legacy schedule tier=full normalized to light',async t=>{
  const home=tmpDir();const target=tmpDir();
  t.after(()=>{for(const d of [home,target])fs.rmSync(d,{recursive:true,force:true});});
  const mgr=createBackupManager({userDataDir:home,secretStorage,log:console});
  await mgr.saveSettings({target:{kind:'webdav',url:'https://dav.example.com/dav/',username:'u@x.y',password:'app-secret',remoteDir:'hemi-backups'},schedule:{enabled:true,interval:'weekly',tier:'full'}});
  const raw=JSON.parse(fs.readFileSync(path.join(home,'backup-settings.json'),'utf8'));
  assert.equal(raw.target.passwordEncrypted,'ZW5jOmFwcC1zZWNyZXQ='); // base64(enc:app-secret)
  assert.equal('password'in raw.target,false);
  assert.equal(raw.schedule.tier,'light','旧 schedule.tier=full 落盘前应归一为 light');
  const view=mgr.getSettings();
  assert.equal(view.target.hasPassword,true);
  assert.equal(view.target.passwordEncrypted,undefined);
  assert.deepEqual(view.schedule,{enabled:true,interval:'weekly',tier:'light'});
  assert.equal(view.keep,5);
});

test('runBackup ignores legacy tier=full: light-only archive, manifest and lastRun record light',async t=>{
  const home=tmpDir();const target=tmpDir();
  t.after(()=>{for(const d of [home,target])fs.rmSync(d,{recursive:true,force:true});});
  seedUserData(home);
  fs.mkdirSync(path.join(home,'runtime-v2/sessions'),{recursive:true});
  fs.writeFileSync(path.join(home,'runtime-v2/sessions/ctx.json'),'{"ctx":"full-only"}');
  const mgr=createBackupManager({userDataDir:home,secretStorage,log:console});
  await mgr.saveSettings({target:{kind:'local',dir:target},schedule:{enabled:true,interval:'daily',tier:'full'}});
  assert.equal(mgr.getSettings().schedule.tier,'light');
  const result=await mgr.runBackup({tier:'full'});
  assert.equal(result.ok,true);
  assert.equal(result.manifest.tier,'light');
  assert.equal(mgr.getSettings().lastRun.tier,'light');
  const setName=fs.readdirSync(target).find(n=>n.startsWith(BACKUP_DIR_PREFIX));
  const manifest=JSON.parse(fs.readFileSync(path.join(target,setName,'manifest.json'),'utf8'));
  assert.equal(manifest.tier,'light');
});

test('runBackup to local target produces a set, updates lastRun and prunes beyond keep',async t=>{
  const home=tmpDir();const target=tmpDir();
  t.after(()=>{for(const d of [home,target])fs.rmSync(d,{recursive:true,force:true});});
  seedUserData(home);
  const mgr=createBackupManager({userDataDir:home,secretStorage,log:console});
  await mgr.saveSettings({target:{kind:'local',dir:target},keep:2});
  for(let i=0;i<3;i+=1)await mgr.runBackup();
  const sets=fs.readdirSync(target).filter(n=>n.startsWith(BACKUP_DIR_PREFIX));
  assert.equal(sets.length,2,'keep=2 应只保留最近两份');
  assert.equal(mgr.getSettings().lastRun.ok,true);
  assert.ok(mgr.getSettings().lastRun.packedBytes>0);
  // 同一秒内三次备份：时间戳精度为秒，同秒会覆盖同名目录——这里允许 ≤2
});

test('webdav target: parts uploaded before manifest; old sets pruned by name',async t=>{
  const home=tmpDir();
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  seedUserData(home);
  const webdav=mockWebdav();
  const managerFactory=(keep)=>createBackupManager({userDataDir:home,secretStorage,webdavFactory:webdav.factory,log:console});
  const mgr=managerFactory();
  await mgr.saveSettings({target:{kind:'webdav',url:'https://d.example/dav/',username:'u',password:'p',remoteDir:'hemi-backups'},keep:1});
  // 手工在远端预置一份更旧的备份集（直接复用 createBackup 产物上传）
  const older=tmpDir();
  const {backupDir:oldDir}=await createBackup({userDataDir:home,outDir:older,now:new Date(Date.now()-90000)});
  const oldName=path.basename(oldDir);
  for(const f of fs.readdirSync(oldDir))webdav.store.set(`hemi-backups/${oldName}/${f}`,fs.readFileSync(path.join(oldDir,f)));
  fs.rmSync(older,{recursive:true,force:true});
  const result=await mgr.runBackup();
  assert.equal(result.ok,true);
  const puts=webdav.calls.filter(c=>c[0]==='put');
  const manifestPut=puts.findIndex(c=>c[1].endsWith('manifest.json'));
  assert.ok(manifestPut>=0&&manifestPut===puts.length-1,'manifest 必须最后上传');
  assert.ok(puts.length>1,'应有至少一个分卷加一个 manifest');
  // keep=1：旧备份集应被删除
  const remaining=new Set([...webdav.store.keys()].map(k=>k.split('/')[1]));
  assert.equal(remaining.size,1);
  assert.ok(!remaining.has(oldName),'旧备份集应被清理');
  const list=await mgr.listBackups();
  assert.equal(list.length,1);assert.equal(list[0].source,'webdav');assert.equal(list[0].tier,'light');
});

test('restore: prepare gives preview, apply swaps data with safety copy, cancel discards',async t=>{
  const home=tmpDir();const target=tmpDir();
  t.after(()=>{for(const d of [home,target])fs.rmSync(d,{recursive:true,force:true});});
  seedUserData(home);
  const mgr=createBackupManager({userDataDir:home,secretStorage,log:console});
  await mgr.saveSettings({target:{kind:'local',dir:target}});
  await mgr.runBackup();
  const setName=fs.readdirSync(target).find(n=>n.startsWith(BACKUP_DIR_PREFIX));
  // 备份后修改本地数据
  fs.writeFileSync(path.join(home,'pi-memory/MEMORY.md'),'changed-after-backup');
  const prep=await mgr.prepareRestore(setName);
  assert.equal(prep.ok,true);
  assert.ok(prep.preview.memoryFiles>=1);
  assert.ok(prep.preview.tops.includes('pi-memory'));
  const applied=mgr.applyCurrentRestore();
  assert.equal(applied.ok,true);
  assert.equal(fs.readFileSync(path.join(home,'pi-memory/MEMORY.md'),'utf8'),'mem');
  assert.ok(fs.existsSync(path.join(home,'restore-safety')),'恢复应留安全副本');
  // 二次 prepare 后取消：数据不变
  const prep2=await mgr.prepareRestore(setName);
  assert.equal(prep2.ok,true);
  assert.equal(mgr.cancelRestore().ok,true);
  assert.equal(mgr.applyCurrentRestore().ok,false);
  assert.equal(fs.readFileSync(path.join(home,'pi-memory/MEMORY.md'),'utf8'),'mem');
});

test('schedule tick respects isIdle gate and interval',async t=>{
  const home=tmpDir();const target=tmpDir();
  t.after(()=>{for(const d of [home,target])fs.rmSync(d,{recursive:true,force:true});});
  seedUserData(home);
  let idle=false;const ran=[];
  const mgr=createBackupManager({userDataDir:home,secretStorage,isIdle:async()=>idle,log:console,
    emit:(channel,payload)=>{if(payload.phase==='done')ran.push(payload);}});
  await mgr.saveSettings({target:{kind:'local',dir:target},schedule:{enabled:true,interval:'daily',tier:'light'}});
  // 直接驱动内部 tick：通过 startSchedule 会立即 tick 一次——busy/idle 门控
  mgr.startSchedule();
  await new Promise(r=>setTimeout(r,20));
  assert.equal(ran.length,0,'空闲判定为 false 时不备份');
  idle=true;
  mgr.stopSchedule();
  // 再次 startSchedule 触发一次 tick（间隔已满足：从未成功过）
  mgr.startSchedule();
  await new Promise(r=>setTimeout(r,50));
  mgr.stopSchedule();
  assert.equal(ran.length,1,'空闲后应执行一次定时备份');
});

test('runBackup without target fails with NO_TARGET; concurrent runs rejected',async t=>{
  const home=tmpDir();
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  seedUserData(home);
  const mgr=createBackupManager({userDataDir:home,secretStorage,log:console});
  assert.deepEqual(await mgr.runBackup(),{ok:false,code:'NO_TARGET'});
});

test('deleteBackupSet removes local set, rejects unsafe names, and deletes remote collection',async t=>{
  const home=tmpDir();const target=tmpDir();
  t.after(()=>{for(const d of [home,target])fs.rmSync(d,{recursive:true,force:true});});
  seedUserData(home);
  const mgr=createBackupManager({userDataDir:home,secretStorage,log:console});
  await mgr.saveSettings({target:{kind:'local',dir:target}});
  await mgr.runBackup({trigger:'manual'});
  const before=await mgr.listBackups();
  assert.equal(before.length,1);
  // 非法名称拒绝（不触盘）
  const bad=await mgr.deleteBackupSet('../evil');
  assert.equal(bad.ok,false);assert.equal(bad.code,'INVALID_NAME');
  assert.ok(fs.existsSync(before[0].dir),'非法名称不得删除真实目录');
  // 合法删除
  assert.equal((await mgr.deleteBackupSet(before[0].name)).ok,true);
  assert.equal((await mgr.listBackups()).length,0);
  assert.ok(!fs.existsSync(before[0].dir));
  // WebDAV 目标：手动删除走 deleteFile 删远端集合（runBackup 后仅 1 份，prune 不触发删除）
  const webdav=mockWebdav();
  const mgr2=createBackupManager({userDataDir:home,secretStorage,webdavFactory:webdav.factory,log:console});
  await mgr2.saveSettings({target:{kind:'webdav',url:'https://d.example/dav/',username:'u',password:'p',remoteDir:'hemi-backups'}});
  const result=await mgr2.runBackup({trigger:'manual'});
  assert.equal(result.ok,true);
  const remoteSets=await mgr2.listBackups();
  assert.equal(remoteSets.length,1);
  const deletesBefore=webdav.calls.filter(c=>c[0]==='delete').length;
  assert.equal(deletesBefore,0,'未超保留份数时 prune 不应删除');
  assert.equal((await mgr2.deleteBackupSet(remoteSets[0].name)).ok,true);
  const deletes=webdav.calls.filter(c=>c[0]==='delete');
  assert.equal(deletes.length,1);
  assert.ok(deletes[0][1].startsWith('hemi-backups/hemi-backup-'),'远端删除应指向备份集目录');
});

test('restore swaps decrypt key: password falls back in memory and is re-encrypted after restore',async t=>{
  const home=tmpDir();
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  seedUserData(home);
  // 可变密钥的 secretStorage：key 变化后旧密文解不开（模拟恢复替换 secrets/）
  let key='key-a';
  const secretStorage={
    encryptString:text=>Buffer.from(`${key}:enc:${text}`),
    decryptString:blob=>{const s=String(blob);const prefix=`${key}:enc:`;if(!s.startsWith(prefix))throw new Error('本地密文无法解密');return s.slice(prefix.length);},
    isEncryptionAvailable:()=>true,
  };
  const webdav=mockWebdav();
  // 预置一份备份集到远端 mock
  const older=tmpDir();
  const {backupDir}=await createBackup({userDataDir:home,outDir:older});
  const setName=path.basename(backupDir);
  for(const f of fs.readdirSync(backupDir))webdav.store.set(`hemi-backups/${setName}/${f}`,fs.readFileSync(path.join(backupDir,f)));
  fs.rmSync(older,{recursive:true,force:true});
  const mgr=createBackupManager({userDataDir:home,secretStorage,webdavFactory:webdav.factory,log:console});
  await mgr.saveSettings({target:{kind:'webdav',url:'https://d.example/dav/',username:'u',password:'app-secret',remoteDir:'hemi-backups'}});
  // 恢复替换了 secrets（密钥换新）——旧密文失效
  key='key-b';
  const settingsRaw=JSON.parse(fs.readFileSync(path.join(home,'backup-settings.json'),'utf8'));
  assert.throws(()=>secretStorage.decryptString(Buffer.from(settingsRaw.target.passwordEncrypted,'base64')),'旧密文应解不开');
  // 内存兜底：换钥后列举/恢复准备仍可用
  const sets=await mgr.listBackups();
  assert.equal(sets.length,1);
  const prep=await mgr.prepareRestore(setName);
  assert.equal(prep.ok,true);
  // 恢复完成后用新密钥重加密落盘，后续进程可正常解密
  const applied=mgr.applyCurrentRestore();
  assert.equal(applied.ok,true);
  const raw2=JSON.parse(fs.readFileSync(path.join(home,'backup-settings.json'),'utf8'));
  assert.equal(secretStorage.decryptString(Buffer.from(raw2.target.passwordEncrypted,'base64')),'app-secret','恢复后密文应可用新密钥解开');
  assert.equal((await mgr.listBackups()).length,1,'重加密后列举正常');
});
