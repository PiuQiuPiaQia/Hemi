// webdav-client 单测：mock fetch 验证连接测试错误映射、逐级 MKCOL、
// 上传/下载/删除、429 退避重试、PROPFIND 多命名空间解析与自排除。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {createWebdavClient} from './webdav-client.mjs';

function tmpDir(){return fs.mkdtempSync(path.join(os.tmpdir(),'hemi-webdav-'));}
const PROPFIND_XML=`<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
 <d:response><d:href>/dav/hemi-backups/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
 <d:response><d:href>/dav/hemi-backups/20261031-1011/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
 <d:response><d:href>/dav/hemi-backups/20261031-1011/manifest.json</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>523</d:getcontentlength><d:getlastmodified>Sat, 31 Oct 2026 02:11:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>
</d:multistatus>`;

function respond(status,body='',headers={}){
  return {status,ok:status>=200&&status<300,headers:new Map(Object.entries(headers)),text:async()=>body,body:null};
}

test('testConnection maps 401 to AUTH_FAILED and accepts 207',async()=>{
  const seen=[];
  const auth401=createWebdavClient({baseUrl:'https://dav.jianguoyun.com/dav/',username:'a@b.c',password:'wrong',fetchImpl:async(url,init)=>{seen.push({url,init,who:'auth'});return respond(401);}});
  assert.deepEqual(await auth401.testConnection(),{ok:false,code:'AUTH_FAILED',message:'账号或应用密码不正确'});
  const ok=createWebdavClient({baseUrl:'https://dav.example.com/dav/sub',username:'u',password:'p',fetchImpl:async(url,init)=>{seen.push({url,init,who:'ok'});return respond(207);}});
  assert.equal((await ok.testConnection()).ok,true);
  const propfind=seen.filter(c=>c.who==='ok').find(c=>c.init.method==='PROPFIND');
  assert.equal(propfind.url,'https://dav.example.com/dav/sub');
  assert.equal(propfind.init.headers.Depth,'0');
  assert.match(propfind.init.headers.Authorization,/^Basic /);
});

test('ensureDir creates collections level by level; 405 means exists',async()=>{
  const mades=[];const existing=new Set();
  const client=createWebdavClient({baseUrl:'https://d.example/dav/',username:'u',password:'p',fetchImpl:async(url,init)=>{
    if(init.method==='MKCOL'){
      const rel=url.replace('https://d.example/dav/','');
      if(existing.has(rel))return respond(405);
      existing.add(rel);mades.push(rel);return respond(201);
    }
    return respond(500);
  }});
  await client.ensureDir('hemi-backups/20261031-1011');
  assert.deepEqual(mades,['hemi-backups','hemi-backups/20261031-1011']);
  // 第二次逐级创建：已存在（405）应幂等成功且不重复入 mades
  await client.ensureDir('hemi-backups/20261031-1011');
  assert.equal(mades.length,2);
});

test('uploadFile streams with PUT and reports bytes; downloadToFile writes body; delete is idempotent on 404',async()=>{
  const dir=tmpDir();const src=path.join(dir,'payload.bin');fs.writeFileSync(src,Buffer.alloc(2048,7));
  const client=createWebdavClient({baseUrl:'https://d.example/dav/',username:'u',password:'p',fetchImpl:async(url,init)=>{
    if(init.method==='PUT')return respond(201);
    if(init.method==='GET')return {status:200,ok:true,headers:new Map(),text:async()=>'',body:Readable.toWeb(fs.createReadStream(src))};
    if(init.method==='DELETE')return respond(404);
    return respond(500);
  }});
  assert.deepEqual(await client.uploadFile('hemi-backups/x/part-0000.gz',src),{bytes:2048});
  const target=path.join(dir,'down.bin');
  await client.downloadToFile('hemi-backups/x/part-0000.gz',target);
  assert.equal(fs.statSync(target).size,2048);
  assert.equal(await client.deleteFile('hemi-backups/x/part-0000.gz'),true);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('429 responses are retried with backoff then succeed',async()=>{
  let n=0;const log={warn(msg){this.last=msg;}};
  const client=createWebdavClient({baseUrl:'https://d.example/dav/',username:'u',password:'p',fetchImpl:async()=>{
    n+=1;return n<3?respond(429,'',{'retry-after':'0'}):respond(204);
  },log});
  await client.deleteFile('x');
  assert.equal(n,3);
  assert.match(log.last,/重试/);
});

test('listDir parses multistatus, drops self, decodes hrefs',async()=>{
  const client=createWebdavClient({baseUrl:'https://d.example/dav/',username:'u',password:'p',fetchImpl:async()=>respond(207,PROPFIND_XML)});
  const items=await client.listDir('hemi-backups');
  assert.equal(items.length,2);
  assert.ok(items.some(i=>i.isDir&&i.href==='/dav/hemi-backups/20261031-1011'));
  const manifest=items.find(i=>!i.isDir);
  assert.equal(manifest.bytes,523);
  assert.equal(manifest.name,'manifest.json');
  assert.equal(manifest.modified,'Sat, 31 Oct 2026 02:11:00 GMT');
  // 集合自身（/hemi-backups）不得出现在结果里
  assert.ok(!items.some(i=>i.href==='/dav/hemi-backups'));
});

test('non-http baseUrl is rejected',()=>{
  assert.throws(()=>createWebdavClient({baseUrl:'dav.jianguoyun.com',username:'u',password:'p'}),/http/);
});

test('listDir drops self regardless of multistatus order (jianguoyun may list children first)',async()=>{
  const xmlReversed=`<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
 <D:response><D:href>/dav/hemi-backups/hemi-backup-20261031-143012/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
 <D:response><D:href>/dav/hemi-backups/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
</D:multistatus>`;
  const client=createWebdavClient({baseUrl:'https://d.example.com/dav/',username:'u',password:'p',fetchImpl:async()=>respond(207,xmlReversed)});
  const items=await client.listDir('hemi-backups');
  assert.equal(items.length,1,'子项在前、自身在后时也应只剩 1 个子项');
  assert.equal(items[0].name,'hemi-backup-20261031-143012');
  assert.equal(items[0].isDir,true);
});

test('listDir treats collection with size as dir (resourcetype wins)',async()=>{
  const xml=`<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
 <d:response><d:href>/dav/hemi-backups/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
 <d:response><d:href>/dav/hemi-backups/hemi-backup-x/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getcontentlength>0</d:getcontentlength></d:prop></d:propstat></d:response>
</d:multistatus>`;
  const client=createWebdavClient({baseUrl:'https://d.example.com/dav/',username:'u',password:'p',fetchImpl:async()=>respond(207,xml)});
  const items=await client.listDir('hemi-backups');
  assert.equal(items.length,1);
  assert.equal(items[0].isDir,true,'collection 即使带 size 也是目录');
});
