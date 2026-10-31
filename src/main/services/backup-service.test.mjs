// backup-service 单测：范围过滤（凭据/缓存硬排除）、打包→恢复 roundtrip（含多分卷、
// 长路径、二进制内容）、损坏分卷校验失败、manifest 版本护栏、恢复应用与安全副本。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {collectEntries,createBackup,readManifest,extractBackup,applyRestore,listLocalBackups,BACKUP_DIR_PREFIX} from './backup-service.mjs';

function tmpDir(){return fs.mkdtempSync(path.join(os.tmpdir(),'hemi-backup-'));}
function seedUserData(dir){
  fs.mkdirSync(path.join(dir,'runtime-v2/conversations'),{recursive:true});
  fs.mkdirSync(path.join(dir,'runtime-v2/sessions/abc'),{recursive:true});
  fs.mkdirSync(path.join(dir,'secrets'),{recursive:true});
  fs.mkdirSync(path.join(dir,'pi-memory/daily'),{recursive:true});
  fs.mkdirSync(path.join(dir,'bot'),{recursive:true});
  fs.mkdirSync(path.join(dir,'drafts'),{recursive:true});
  fs.writeFileSync(path.join(dir,'runtime-v2/conversations/conv-1.json'),JSON.stringify({id:'conv-1',turns:[{role:'user',text:'你好备份'},{role:'assistant',text:'收到'}]}));
  // 不可压缩随机数据：保证小 chunkBytes 也能切出多卷
  fs.writeFileSync(path.join(dir,'runtime-v2/conversations/payload.bin'),crypto.randomBytes(3000));
  const binary=Buffer.from(Array.from({length:70000},(_,i)=>i%251)); // 非对齐二进制，验证 tar padding
  fs.writeFileSync(path.join(dir,'runtime-v2/sessions/abc/blob-1.bin'),binary);
  fs.writeFileSync(path.join(dir,'runtime-v2/run-journal.json'),JSON.stringify({runs:[{id:'r1'}]}));
  fs.writeFileSync(path.join(dir,'pi-memory/daily/2026-10-31.md'),'# 今天\n- 备份功能单测');
  fs.writeFileSync(path.join(dir,'pi-memory/MEMORY.md'),'长期记忆');
  fs.writeFileSync(path.join(dir,'drafts/draft-new.json'),'{"text":"草稿"}');
  fs.writeFileSync(path.join(dir,'bot/state.json'),'{"paired":true}');
  fs.writeFileSync(path.join(dir,'bot/cache.json'),'{"cache":true}');
  fs.writeFileSync(path.join(dir,'appearance.json'),'{"skinId":"aurora"}');
  // 以下绝不允许进备份
  fs.writeFileSync(path.join(dir,'secrets/local-secrets.json'),'{"apiKey":"SUPER"}');
  fs.writeFileSync(path.join(dir,'remote-passwords.json'),'{"pw":"SUPER"}');
  fs.writeFileSync(path.join(dir,'doubao-asr.json'),'{"encryptedApiKey":"SUPER"}');
  fs.writeFileSync(path.join(dir,'runtime-v2/oauth-credentials.json'),'{"token":"SUPER"}');
  fs.writeFileSync(path.join(dir,'runtime-v2/conversations/rogue.tmp'),'tmp');
  fs.writeFileSync(path.join(dir,'hemi.log'),'log');
}

test('collection is light-only: credentials, caches and legacy full-only dirs excluded',async t=>{
  const dir=tmpDir();seedUserData(dir);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const rels=collectEntries(dir).map(e=>e.rel);
  assert.ok(rels.includes('runtime-v2/conversations/conv-1.json'));
  assert.ok(rels.includes('pi-memory/MEMORY.md'));
  assert.ok(rels.includes('bot/state.json'));
  assert.ok(!rels.includes('bot/cache.json'));
  // 2026-11 用户裁决：仅轻量档，sessions/contexts/attachments（原完整档目录）不再归档
  assert.ok(!rels.some(r=>r.startsWith('runtime-v2/sessions')));
  assert.ok(!rels.some(r=>r.startsWith('runtime-v2/contexts')));
  assert.ok(!rels.some(r=>r.startsWith('runtime-v2/attachments')));
  // 2026-11 用户裁决：凭据（secrets 密钥目录、oauth、ASR、远端密码）随备份进包
  assert.ok(rels.includes('secrets/local-secrets.json'),'secrets 目录应进包');
  assert.ok(rels.includes('remote-passwords.json')&&rels.includes('doubao-asr.json')&&rels.includes('runtime-v2/oauth-credentials.json'),'各凭据文件应进包');
  assert.ok(!rels.some(r=>r.endsWith('.tmp')||r.endsWith('.log')));
  assert.ok(!rels.some(r=>r.endsWith('.tmp')||r.endsWith('.log')));
});

test('backup roundtrip: multi-volume light backup restores identical bytes',async t=>{
  const dir=tmpDir();seedUserData(dir);const out=tmpDir();const stage=tmpDir();
  t.after(()=>{for(const d of [dir,out,stage])fs.rmSync(d,{recursive:true,force:true});});
  const {backupDir,manifest}=await createBackup({userDataDir:dir,outDir:out,chunkBytes:1024,now:new Date('2026-10-31T11:00:00+08:00')});
  assert.ok(path.basename(backupDir).startsWith(BACKUP_DIR_PREFIX+'20261031-'));
  assert.ok(manifest.parts.length>=2,'小分卷应切出多卷');
  for(const part of manifest.parts)assert.match(part.name,/^part-\d{4}\.gz$/);
  const {entries}=await extractBackup({backupDir,stagingDir:stage});
  const rels=entries.map(e=>e.rel);
  assert.ok(rels.includes('runtime-v2/conversations/conv-1.json'));
  assert.ok(rels.includes('bot/state.json'));
  assert.ok(!rels.some(r=>r.includes('cache.json')),'bot/cache.json 不进包');
  assert.equal(fs.readFileSync(path.join(stage,'runtime-v2/conversations/conv-1.json'),'utf8'),fs.readFileSync(path.join(dir,'runtime-v2/conversations/conv-1.json'),'utf8'));
  assert.equal(fs.readFileSync(path.join(stage,'drafts/draft-new.json'),'utf8'),'{"text":"草稿"}');
  assert.equal(fs.readFileSync(path.join(stage,'pi-memory/daily/2026-10-31.md'),'utf8'),'# 今天\n- 备份功能单测');
});

test('binary blobs roundtrip byte-for-byte; legacy tier=full arg normalized to light',async t=>{
  const dir=tmpDir();seedUserData(dir);const out=tmpDir();const stage=tmpDir();
  t.after(()=>{for(const d of [dir,out,stage])fs.rmSync(d,{recursive:true,force:true});});
  fs.mkdirSync(path.join(dir,'pi-memory/blobs'),{recursive:true});
  const binary=Buffer.from(Array.from({length:70000},(_,i)=>i%251)); // 非对齐二进制，验证 tar padding
  fs.writeFileSync(path.join(dir,'pi-memory/blobs/blob-1.bin'),binary);
  // 旧调用方可能仍传 tier:'full'：应被忽略，只按轻量范围打包并如实记录 light
  const {backupDir,manifest}=await createBackup({userDataDir:dir,tier:'full',outDir:out});
  assert.equal(manifest.tier,'light');
  const {entries}=await extractBackup({backupDir,stagingDir:stage});
  const rels=entries.map(e=>e.rel);
  assert.ok(rels.includes('pi-memory/blobs/blob-1.bin'));
  assert.deepEqual(fs.readFileSync(path.join(stage,'pi-memory/blobs/blob-1.bin')),binary);
  assert.ok(!rels.some(r=>r.startsWith('runtime-v2/sessions')),'原完整档目录不应再进备份');
});

test('corrupted part fails sha256 verification before restore',async t=>{
  const dir=tmpDir();seedUserData(dir);const out=tmpDir();const stage=tmpDir();
  t.after(()=>{for(const d of [dir,out,stage])fs.rmSync(d,{recursive:true,force:true});});
  const {backupDir,manifest}=await createBackup({userDataDir:dir,outDir:out,chunkBytes:512});
  const partPath=path.join(backupDir,manifest.parts[0].name);
  const buf=fs.readFileSync(partPath);assert.ok(buf.length>=64,'首卷应有可篡改的体积');buf.write('X',Math.floor(buf.length/2));fs.writeFileSync(partPath,buf);
  await assert.rejects(extractBackup({backupDir,stagingDir:stage}),/校验失败|大小不符/);
});

test('manifest guards: wrong kind rejected, future schema rejected, listing works',async t=>{
  const dir=tmpDir();seedUserData(dir);const out=tmpDir();
  t.after(()=>{for(const d of [dir,out])fs.rmSync(d,{recursive:true,force:true});});
  const {backupDir,manifest}=await createBackup({userDataDir:dir,outDir:out});
  const list=listLocalBackups(out);
  assert.equal(list.length,1);assert.equal(list[0].tier,'light');
  const future={...manifest,schemaVersion:99};
  fs.writeFileSync(path.join(backupDir,'manifest.json'),JSON.stringify(future));
  assert.throws(()=>readManifest(backupDir),/高于当前应用支持/);
  fs.writeFileSync(path.join(backupDir,'manifest.json'),JSON.stringify({...manifest,kind:'other'}));
  assert.throws(()=>readManifest(backupDir),/不是 Hemi 备份目录/);
});

test('file appended during backup window is truncated to snapshot size (archive stays consistent)',async t=>{
  const dir=tmpDir();const out=tmpDir();const stage=tmpDir();
  t.after(()=>{for(const d of [dir,out,stage])fs.rmSync(d,{recursive:true,force:true});});
  fs.mkdirSync(path.join(dir,'runtime-v2/conversations'),{recursive:true});
  const target=path.join(dir,'runtime-v2/conversations/live.json');
  fs.writeFileSync(target,'a'.repeat(1000));
  const m=await import('./backup-service.mjs');
  const backupPromise=m.createBackup({userDataDir:dir,outDir:out});
  const timer=setTimeout(()=>fs.appendFileSync(target,'b'.repeat(500)),0); // 并发追加，模拟活跃会话写入
  await backupPromise;clearTimeout(timer);
  const {entries}=await m.extractBackup({backupDir:path.join(out,fs.readdirSync(out)[0]),stagingDir:stage});
  const restored=fs.readFileSync(path.join(stage,'runtime-v2/conversations/live.json'),'utf8');
  assert.ok([1000,1500].includes(restored.length),`恢复长度应为 1000 或 1500，实际 ${restored.length}`);
  assert.equal(entries.length,1);
});

test('file truncated during backup window fails honestly instead of producing a corrupt archive',async t=>{
  const dir=tmpDir();const out=tmpDir();
  t.after(()=>{for(const d of [dir,out])fs.rmSync(d,{recursive:true,force:true});});
  fs.mkdirSync(path.join(dir,'runtime-v2/conversations'),{recursive:true});
  const target=path.join(dir,'runtime-v2/conversations/live.json');
  fs.writeFileSync(target,'x'.repeat(4096));
  const m=await import('./backup-service.mjs');
  const origCreateReadStream=fs.createReadStream.bind(fs);
  t.after(()=>{fs.createReadStream=origCreateReadStream;for(const d of [dir,out])fs.rmSync(d,{recursive:true,force:true});});
  // 收集时刻 4096；首次读取该文件前同步截断为 10 字节 → 应失败而非产出坏档
  fs.createReadStream=(p,...args)=>{
    if(typeof p==='string'&&p===target)fs.truncateSync(p,10);
    return origCreateReadStream(p,...args);
  };
  await assert.rejects(m.createBackup({userDataDir:dir,outDir:out}),/被改写变短|快照不一致/);
});

test('applyRestore swaps in restored data and keeps a safe copy of overwritten originals',async t=>{
  const dir=tmpDir();seedUserData(dir);const out=tmpDir();const stage=tmpDir();const safe=tmpDir();
  t.after(()=>{for(const d of [dir,out,stage,safe])fs.rmSync(d,{recursive:true,force:true});});
  const {backupDir}=await createBackup({userDataDir:dir,outDir:out});
  // 本地数据在备份后被改动（模拟继续使用后误恢复）
  fs.writeFileSync(path.join(dir,'runtime-v2/conversations/conv-1.json'),'{"id":"conv-1","turns":[]}');
  fs.writeFileSync(path.join(dir,'runtime-v2/conversations/conv-new.json'),'new-after-backup');
  await extractBackup({backupDir,stagingDir:stage});
  const {applied}=applyRestore({stagingDir:stage,userDataDir:dir,safeCopyRoot:safe});
  assert.ok(applied.includes('runtime-v2')&&applied.includes('pi-memory'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'runtime-v2/conversations/conv-1.json'),'utf8')).turns.length,2);
  assert.ok(!fs.existsSync(path.join(dir,'runtime-v2/conversations/conv-new.json')),'恢复为目录级替换，备份后新增文件被安全副本接管');
  assert.ok(fs.existsSync(path.join(safe,'runtime-v2/conversations/conv-new.json')),'被替换的本地数据进了安全副本');
});

test('long paths (>100 chars) roundtrip via ustar prefix or GNU longname',async t=>{
  const dir=tmpDir();const out=tmpDir();const stage=tmpDir();
  t.after(()=>{for(const d of [dir,out,stage])fs.rmSync(d,{recursive:true,force:true});});
  // 相对路径 >100 字符即触发 ustar prefix/长名逻辑；段数控制在 Windows
  // MAX_PATH(260) 内——绝对路径前缀（macOS /var/folders、Windows %TEMP%）已占 40-55 字符。
  const deep=['pi-memory','workspace',...Array.from({length:2},(_,i)=>`很长的目录名段-${i}-abcdefghijklmnop`)].join('/');
  fs.mkdirSync(path.join(dir,deep),{recursive:true});
  const rel=`${deep}/超长文件名-abcdefghijklmnopqrstuvwxyz0123456789.md`;
  fs.writeFileSync(path.join(dir,rel),'长路径内容');
  assert.ok(rel.length>100,'测试前提：相对路径需超过 ustar name 字段 100 字节');
  const {backupDir,manifest}=await createBackup({userDataDir:dir,outDir:out});
  assert.equal(manifest.entries.files,1);
  const {entries}=await extractBackup({backupDir,stagingDir:stage});
  assert.ok(entries.map(e=>e.rel).includes(rel),'长路径应完整还原');
  assert.equal(fs.readFileSync(path.join(stage,rel),'utf8'),'长路径内容');
});
