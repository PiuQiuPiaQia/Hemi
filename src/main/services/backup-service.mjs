// 数据备份/恢复核心引擎（需求：docs/requirements/data-backup.md）。
// 快照式归档：白名单收集 → ustar+gzip 流式打包 → 按 chunkBytes 切卷（逐卷 sha256）
// → manifest.json。不加密（2026-10-31 裁决），凭据类数据由范围过滤硬排除。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createGzip,createGunzip} from 'node:zlib';
import {pipeline} from 'node:stream/promises';

export const BACKUP_SCHEMA_VERSION=1;
export const BACKUP_KIND='hemi-backup';
export const DEFAULT_CHUNK_BYTES=300*1024*1024;
export const BACKUP_DIR_PREFIX='hemi-backup-';

// 白名单（相对 userData 根）。2026-11 用户裁决：仅保留轻量档，sessions/contexts/
// attachments 等完整档目录不再归档（恢复旧 full 包仍兼容，extractBackup 不看 tier）。
const LIGHT_ENTRIES=[
  'runtime-v2/conversations','runtime-v2/conversation-operations','runtime-v2/task-history',
  'runtime-v2/run-journal.json','runtime-v2/text-model-profiles.json','runtime-v2/migration.json',
  'pi-memory','drafts','bot','appearance.json','onboarding.json','access-grants.json',
];
// 白名单内部仍要剔除的相对路径（可重建或设备绑定凭据）。
const SKIP_REL=new Set(['bot/cache.json']);
// 凭据防线：任何路径段命中即拒之门外（兜底，防止未来白名单误加）。
const NEVER_SEGMENTS=new Set(['secrets','provider-logins','oauth-credentials.json','remote-passwords.json','doubao-asr.json']);

function isExcludedRel(rel){
  if(SKIP_REL.has(rel)||NEVER_SEGMENTS.has(rel))return true;
  const segs=rel.split('/');
  if(segs.some(seg=>NEVER_SEGMENTS.has(seg)))return true;
  const name=segs.at(-1);
  return name.endsWith('.tmp')||name.endsWith('.log')||name.startsWith('.');
}

// 同秒内多次备份：目录名加序号防互相覆盖
function resolveBackupDir(outDir,baseName){
  let dirName=baseName,n=2;
  while(fs.existsSync(path.join(outDir,dirName))&&n<=999){dirName=`${baseName}-${n}`;n+=1;}
  return path.join(outDir,dirName);
}

export function collectEntries(userDataDir){
  const wanted=LIGHT_ENTRIES;
  const entries=new Map();
  const walk=rel=>{
    if(isExcludedRel(rel))return;
    const abs=path.join(userDataDir,rel);
    let st;try{st=fs.statSync(abs);}catch{return;}
    if(st.isDirectory()){
      entries.set(rel,{rel,type:'dir'});
      for(const e of fs.readdirSync(abs,{withFileTypes:true}))walk(`${rel}/${e.name}`);
    }else if(st.isFile()){
      entries.set(rel,{rel,type:'file',bytes:st.size,mtimeMs:st.mtimeMs});
    }
  };
  for(const entry of wanted){
    if(!fs.existsSync(path.join(userDataDir,entry)))continue;
    walk(entry);
  }
  return [...entries.values()].sort((a,b)=>a.rel<b.rel?-1:a.rel>b.rel?1:0);
}

// —— ustar 写入（>255 字节路径走 GNU 'L' 长名兜底；常规路径用 prefix 拆分）——
function octal(n,len){return n.toString(8).padStart(len-1,'0')+'\0';}
function buildHeader({name,type,size,mtimeMs}){
  let prefix='';let base=name;
  if(name.length>100){
    const split=name.lastIndexOf('/',name.length-101);
    if(split>0&&name.length-split-1<=100){prefix=name.slice(0,split);base=name.slice(split+1);}
    else return {needsLong:true};
  }
  const buf=Buffer.alloc(512,0);
  buf.write(base,0,100,'utf8');
  buf.write(octal(type==='dir'?0o755:0o644,8),100);
  buf.write(octal(0,8),108);buf.write(octal(0,8),116);
  buf.write(octal(type==='dir'?0:size,12),124);
  buf.write(octal(Math.floor(mtimeMs/1000),12),136);
  buf.write('        ',148); // checksum 先置空格再算
  buf.write(type==='dir'?'5':'0',156);
  buf.write('ustar\0',257);buf.write('00',263);
  if(prefix)buf.write(prefix,345,155,'utf8');
  let sum=0;for(const b of buf)sum+=b;
  buf.write(octal(sum,8),148);
  return {needsLong:false,header:buf};
}
async function writeAll(stream,chunk){
  if(!stream.write(chunk))await new Promise(resolve=>stream.once('drain',resolve));
}
async function writeLongNameEntry(gzip,name){
  const content=Buffer.from(`${name}\0`,'utf8');
  const longHeader=buildHeader({name:'././@LongLink',type:'long',size:content.length,mtimeMs:0});
  if(longHeader.needsLong)throw new Error(`备份路径过长（>255）：${name}`);
  longHeader.header.write('L',156); // buildHeader 的 type 只区分 dir/file，长名条目类型手动覆盖
  longHeader.header.write('        ',148); // 重算 checksum 前必须把校验字段归位空格
  let sum=0;for(const b of longHeader.header)sum+=b;
  longHeader.header.write(octal(sum,8),148);
  await writeAll(gzip,longHeader.header);
  await writeAll(gzip,content);
  const pad=(512-(content.length%512))%512;
  if(pad)await writeAll(gzip,Buffer.alloc(pad,0));
}
async function writeTarEntries(gzip,entries,userDataDir){
  for(const entry of entries){
    const header=buildHeader({name:entry.rel,type:entry.type,size:entry.type==='dir'?0:entry.bytes,mtimeMs:entry.mtimeMs??Date.now()});
    if(header.needsLong){await writeLongNameEntry(gzip,entry.rel);const retry=buildHeader({name:'_L',type:entry.type,size:entry.type==='dir'?0:entry.bytes,mtimeMs:entry.mtimeMs??Date.now()});await writeAll(gzip,retry.header);}
    else await writeAll(gzip,header.header);
    if(entry.type==='file'){
      const abs=path.join(userDataDir,entry.rel);
      // 快照一致性防御：stat 与读取之间文件可能被追加（活跃会话）。按收集时刻
      // 的 size 截断——多读的丢弃；读少了（被截断重写）说明快照不可靠，直接失败。
      let remaining=entry.bytes;
      for await(const chunk of fs.createReadStream(abs,{highWaterMark:1<<20})){
        if(remaining<=0)break; // 文件在备份窗口内变大：超出部分不属于本次快照
        const piece=chunk.length>remaining?chunk.subarray(0,remaining):chunk;
        await writeAll(gzip,piece);
        remaining-=piece.length;
      }
      if(remaining>0)throw new Error(`文件在备份期间被改写变短：${entry.rel}（缺 ${remaining} 字节），快照不一致`);
      const pad=(512-(entry.bytes%512))%512;
      if(pad)await writeAll(gzip,Buffer.alloc(pad,0));
    }
  }
  await writeAll(gzip,Buffer.alloc(1024,0)); // 结尾双零块
}

// 历史调用方可能仍传 tier 入参，此处一律忽略：后端只创建轻量范围，manifest 恒记 light。
export async function createBackup({userDataDir,outDir,chunkBytes=DEFAULT_CHUNK_BYTES,now=new Date(),appVersion=null}){
  const entries=collectEntries(userDataDir);
  if(!entries.some(e=>e.type==='file'))throw new Error('备份范围内没有任何文件，已取消（数据目录异常？）');
  const pad2=n=>String(n).padStart(2,'0');
  const stamp=`${now.getFullYear()}${pad2(now.getMonth()+1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  const backupDir=resolveBackupDir(outDir,BACKUP_DIR_PREFIX+stamp);
  fs.mkdirSync(backupDir,{recursive:true});
  const gzip=createGzip({level:6});
  const pump=(async()=>{try{await writeTarEntries(gzip,entries,userDataDir);}finally{gzip.end();}})();
  pump.catch(()=>{}); // 写入侧错误由下方 await pump 统一抛出；先挂占位 catch 避免等待期间的 unhandledRejection
  const parts=[];let index=0,hash,written=0,handle=null,name='';
  const rollPart=()=>{name=`part-${String(index).padStart(4,'0')}.gz`;handle=fs.createWriteStream(path.join(backupDir,name));hash=crypto.createHash('sha256');written=0;};
  // 收卷：空尾卷（切卷后流恰好结束）不记录、不留文件
  const closePart=async()=>{if(!handle)return;await new Promise(resolve=>handle.end(resolve));if(written>0||parts.length===0){parts.push({name,bytes:written,sha256:hash.digest('hex')});}else fs.rmSync(path.join(backupDir,name),{force:true});};
  rollPart();
  try{
    for await(const chunk of gzip){
      let offset=0;
      while(offset<chunk.length){
        if(written>=chunkBytes&&index<9999){await closePart();index+=1;rollPart();}
        const take=Math.min(chunkBytes-written,chunk.length-offset);
        const piece=chunk.subarray(offset,offset+take);
        if(!handle.write(piece))await new Promise(resolve=>handle.once('drain',resolve));
        hash.update(piece);written+=take;offset+=take;
      }
    }
    await closePart();
    await pump;
  }catch(error){fs.rmSync(backupDir,{recursive:true,force:true});throw error;}
  const rawBytes=entries.reduce((sum,e)=>sum+(e.bytes||0),0);
  const manifest={kind:BACKUP_KIND,schemaVersion:BACKUP_SCHEMA_VERSION,tier:'light',createdAt:now.toISOString(),appVersion,compression:'gzip',chunkBytes,
    parts,entries:{files:entries.filter(e=>e.type==='file').length,dirs:entries.filter(e=>e.type==='dir').length},
    totals:{rawBytes,packedBytes:parts.reduce((s,p)=>s+p.bytes,0)}};
  fs.writeFileSync(path.join(backupDir,'manifest.json'),JSON.stringify(manifest,null,2));
  return {backupDir,manifest};
}

export function readManifest(backupDir){
  const manifest=JSON.parse(fs.readFileSync(path.join(backupDir,'manifest.json'),'utf8'));
  if(manifest?.kind!==BACKUP_KIND)throw new Error('不是 Hemi 备份目录（manifest.kind 不匹配）');
  if((manifest.schemaVersion|0)>BACKUP_SCHEMA_VERSION)throw new Error(`备份格式版本（${manifest.schemaVersion}）高于当前应用支持（${BACKUP_SCHEMA_VERSION}），请先升级应用`);
  if(!Array.isArray(manifest.parts)||manifest.parts.length===0)throw new Error('manifest 缺少分卷清单');
  return manifest;
}

async function* partsConcat(backupDir,parts){
  for(const part of parts)yield* fs.createReadStream(path.join(backupDir,part.name),{highWaterMark:1<<20});
}
async function sha256File(abs){
  const h=crypto.createHash('sha256');
  await new Promise((resolve,reject)=>{fs.createReadStream(abs,{highWaterMark:1<<20}).on('data',c=>h.update(c)).on('error',reject).on('end',resolve);});
  return h.digest('hex');
}

// 增量 tar 解析器：push(chunk) 边到边写盘，不在内存堆积。
class TarExtractor{
  constructor(stagingDir){this.dir=stagingDir;this.buf=Buffer.alloc(0);this.state='header';this.need=512;this.longName=null;this.fileStream=null;this.contentSink=null;this.restored=[];this.dirs=0;}
  onHeader(header){
    if(header.every(b=>b===0)){this.state='header';this.need=512;return;} // 尾部零块，忽略
    const name=header.subarray(0,100).toString('utf8').replace(/\0.*$/,'');
    const size=parseInt(header.toString('utf8',124,136).replace(/\0.*$/,'').trim(),8)||0;
    const type=String.fromCharCode(header[156]);
    const prefix=header.subarray(345,500).toString('utf8').replace(/\0.*$/,'');
    if(type==='L'){this.state='content';this.need=size;this.fileStream=null;this.contentSink=[];this.sinkKind='long';this.pendingPad=(512-(size%512))%512;return;}
    const rel=this.longName??(prefix?`${prefix}/${name}`:name);this.longName=null;
    const pad=(512-(size%512))%512;this.pendingPad=pad;
    if(type==='5'){fs.mkdirSync(path.join(this.dir,rel),{recursive:true});this.dirs+=1;this.state=pad?'pad':'header';this.need=pad||512;return;}
    // 普通文件（'0' 与旧式 '\0'）；未知类型跳过内容不落盘
    const write=type==='0'||type==='\0';
    if(write){
      const target=path.join(this.dir,rel);
      fs.mkdirSync(path.dirname(target),{recursive:true});
      this.fileStream=fs.createWriteStream(target);
      this.restored.push({rel,type:'file',bytes:size});
    }else this.fileStream=null;
    this.sinkKind='file';
    this.state='content';this.need=size;
  }
  async push(chunk){
    this.buf=Buffer.concat([this.buf,chunk]);
    for(;;){
      if(this.state==='header'&&this.buf.length>=512){
        const header=this.buf.subarray(0,512);this.buf=this.buf.subarray(512);
        this.onHeader(header);
      }else if(this.state==='content'){
        if(this.need===0){
          if(this.sinkKind==='long'&&this.contentSink){this.longName=Buffer.concat(this.contentSink).toString('utf8').replace(/\0.*$/,'');this.contentSink=null;}
          if(this.fileStream){await new Promise(resolve=>this.fileStream.end(resolve));this.fileStream=null;}
          this.state=this.pendingPad?'pad':'header';this.need=this.pendingPad||512;this.pendingPad=0;
        }else if(this.buf.length>0){
          const take=Math.min(this.buf.length,this.need);
          const piece=this.buf.subarray(0,take);this.buf=this.buf.subarray(take);this.need-=take;
          if(this.fileStream){if(!this.fileStream.write(piece))await new Promise(resolve=>this.fileStream.once('drain',resolve));}
          else if(this.sinkKind==='long')this.contentSink.push(Buffer.from(piece));
        }else break;
      }else if(this.state==='pad'){
        if(this.need===0){this.state='header';this.need=512;continue;}
        if(this.buf.length===0)break;
        const take=Math.min(this.buf.length,this.need);
        this.buf=this.buf.subarray(take);this.need-=take;
      }else break;
    }
  }
}

export async function extractBackup({backupDir,stagingDir}){
  const manifest=readManifest(backupDir);
  for(const part of manifest.parts){ // 逐卷完整性预检，坏卷直接失败
    const abs=path.join(backupDir,part.name);const st=fs.statSync(abs);
    if(st.size!==part.bytes)throw new Error(`分卷 ${part.name} 大小不符（期望 ${part.bytes}，实际 ${st.size}）`);
    if(await sha256File(abs)!==part.sha256)throw new Error(`分卷 ${part.name} 校验失败，备份可能损坏`);
  }
  fs.rmSync(stagingDir,{recursive:true,force:true});
  fs.mkdirSync(stagingDir,{recursive:true});
  const extractor=new TarExtractor(stagingDir);
  await pipeline(
    partsConcat(backupDir,manifest.parts),
    createGunzip(),
    async source=>{for await(const chunk of source)await extractor.push(chunk);},
  );
  return {manifest,entries:extractor.restored,dirs:extractor.dirs};
}

export function applyRestore({stagingDir,userDataDir,safeCopyRoot}){
  fs.mkdirSync(safeCopyRoot,{recursive:true});
  const items=fs.readdirSync(stagingDir,{withFileTypes:true}).map(e=>({name:e.name,isDir:e.isDirectory()}));
  const applied=[];
  for(const item of items){
    const stagingAbs=path.join(stagingDir,item.name);
    const targetAbs=path.join(userDataDir,item.name);
    if(fs.existsSync(targetAbs))fs.renameSync(targetAbs,path.join(safeCopyRoot,item.name));
    fs.renameSync(stagingAbs,targetAbs);
    applied.push(item.name);
  }
  return {applied,safeCopyRoot};
}

export function listLocalBackups(rootDir){
  if(!fs.existsSync(rootDir))return [];
  return fs.readdirSync(rootDir,{withFileTypes:true})
    .filter(e=>e.isDirectory()&&e.name.startsWith(BACKUP_DIR_PREFIX))
    .map(e=>{const dir=path.join(rootDir,e.name);try{const m=readManifest(dir);return {dir,name:e.name,createdAt:m.createdAt,tier:m.tier,totals:m.totals,appVersion:m.appVersion};}catch{return null;}})
    .filter(Boolean)
    .sort((a,b)=>a.createdAt<b.createdAt?1:-1);
}
