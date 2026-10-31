// webdav-client 集成测试：真实 Node fetch（undici）+ 本地 HTTP 服务器，非 mock。
// 覆盖：流式 PUT 的 duplex:'half'（坚果云报错 RequestInit: duplex option is required）、
// 一次上传的字节完整性与 Content-Length/Content-Type、429/503 重试时请求体重建与
// 响应体释放、非成功状态的可读错误且不泄漏凭据。仅连 127.0.0.1，不访问外网。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWebdavClient} from './webdav-client.mjs';

function tmpDir(){return fs.mkdtempSync(path.join(os.tmpdir(),'hemi-webdav-http-'));}
function sha256(buf){return crypto.createHash('sha256').update(buf).digest('hex');}

function startServer(handler){
  const server=http.createServer(handler);
  return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>{
    resolve({server,baseUrl:`http://127.0.0.1:${server.address().port}/dav/`});
  }));
}
async function readBody(req){
  const chunks=[];
  for await(const chunk of req)chunks.push(chunk);
  return Buffer.concat(chunks);
}
// 生成跨多个 highWaterMark（1MiB）块的载荷
function writePayload(dir,name){
  const payload=crypto.randomBytes((2<<20)+7);
  const src=path.join(dir,name);
  fs.writeFileSync(src,payload);
  return {src,payload};
}

test('uploadFile 一次上传成功：字节完整、Content-Length/Content-Type/路径正确',async t=>{
  const dir=tmpDir();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const {src,payload}=writePayload(dir,'part-0000.gz');
  const seen=[];
  const {server,baseUrl}=await startServer(async(req,res)=>{
    const body=await readBody(req);
    seen.push({method:req.method,url:req.url,headers:req.headers,bytes:body.length,sha:sha256(body)});
    res.writeHead(201);res.end();
  });
  t.after(()=>server.close());
  const client=createWebdavClient({baseUrl,username:'user@example.com',password:'app-password'});
  const result=await client.uploadFile('hemi-backups/set/part-0000.gz',src);
  assert.deepEqual(result,{bytes:payload.length});
  assert.equal(seen.length,1,'应恰好一次 PUT');
  const [put]=seen;
  assert.equal(put.method,'PUT');
  assert.equal(put.url,'/dav/hemi-backups/set/part-0000.gz');
  assert.equal(put.bytes,payload.length,'服务器收到的字节数应与文件一致');
  assert.equal(put.sha,sha256(payload),'服务器收到的字节内容应与文件一致');
  assert.equal(Number(put.headers['content-length']),payload.length,'Content-Length 应为文件大小（非 chunked）');
  assert.equal(put.headers['content-type'],'application/octet-stream');
  assert.match(put.headers.authorization,/^Basic /);
});

test('429 重试：每次重试重建文件流，两次 PUT 均完整，带 body 的 429 响应被释放',async t=>{
  const dir=tmpDir();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const {src,payload}=writePayload(dir,'part-0000.gz');
  const puts=[];
  const {server,baseUrl}=await startServer(async(req,res)=>{
    const body=await readBody(req); // 必须读完请求体再响应，避免中途断开连接
    puts.push({bytes:body.length,sha:sha256(body)});
    if(puts.length===1){
      res.writeHead(429,{'Content-Type':'application/json','Retry-After':'0'});
      res.end('{"error":"rate limited"}'); // 带 body：验证重试前释放响应体
    }else{res.writeHead(201);res.end();}
  });
  t.after(()=>server.close());
  const warns=[];
  const client=createWebdavClient({baseUrl,username:'u',password:'p',log:{warn:m=>warns.push(m)}});
  const result=await client.uploadFile('hemi-backups/set/part-0000.gz',src);
  assert.deepEqual(result,{bytes:payload.length});
  assert.equal(puts.length,2,'第一次 429 后应重试一次');
  for(const [i,put] of puts.entries()){
    assert.equal(put.bytes,payload.length,`第 ${i+1} 次请求体应完整`);
    assert.equal(put.sha,sha256(payload),`第 ${i+1} 次请求体应与文件一致（重试必须重建流）`);
  }
  assert.match(warns[0]??'',/429/);
});

test('503 重试（指数退避）后上传完整成功',async t=>{
  const dir=tmpDir();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const {src,payload}=writePayload(dir,'part-0001.gz');
  const puts=[];
  const {server,baseUrl}=await startServer(async(req,res)=>{
    const body=await readBody(req);
    puts.push({bytes:body.length,sha:sha256(body)});
    if(puts.length===1){res.writeHead(503,{'Retry-After':'0'});res.end('maintenance');}
    else{res.writeHead(204);res.end();}
  });
  t.after(()=>server.close());
  const client=createWebdavClient({baseUrl,username:'u',password:'p'});
  const result=await client.uploadFile('hemi-backups/set/part-0001.gz',src);
  assert.deepEqual(result,{bytes:payload.length});
  assert.equal(puts.length,2);
  assert.equal(puts[1].sha,sha256(payload),'重试请求体必须重建且完整');
  assert.equal(puts[1].bytes,payload.length);
});

test('非成功状态（500）错误可读：含状态码与响应文本，不含 Authorization/密码',async t=>{
  const dir=tmpDir();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const {src}=writePayload(dir,'part-0002.gz');
  const secret='app-secret-value';
  const {server,baseUrl}=await startServer(async(req,res)=>{
    await readBody(req);
    res.writeHead(500,{'Content-Type':'text/plain'});
    res.end('server exploded');
  });
  t.after(()=>server.close());
  const client=createWebdavClient({baseUrl,username:'u',password:secret});
  await assert.rejects(client.uploadFile('hemi-backups/set/part-0002.gz',src),error=>{
    assert.match(error.message,/HTTP 500/);
    assert.match(error.message,/server exploded/);
    assert.ok(!error.message.includes('Basic'),'错误消息不得包含 Authorization');
    assert.ok(!error.message.includes(secret),'错误消息不得包含密码');
    return true;
  });
});

test('网络层失败（连接拒绝）错误可读且不泄漏凭据',async t=>{
  const dir=tmpDir();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const {src}=writePayload(dir,'part-0003.gz');
  // 找一个确定没有监听的本地端口
  const probe=http.createServer();
  const port=await new Promise(resolve=>probe.listen(0,'127.0.0.1',()=>{const p=probe.address().port;probe.close(()=>resolve(p));}));
  const secret='conn-secret-value';
  const client=createWebdavClient({baseUrl:`http://127.0.0.1:${port}/dav/`,username:'u',password:secret});
  await assert.rejects(client.uploadFile('hemi-backups/set/part-0003.gz',src),error=>{
    assert.match(error.message,/上传 hemi-backups\/set\/part-0003\.gz 失败：/);
    assert.match(error.message,/ECONNREFUSED|fetch failed|连接/,'应带可读的底层原因');
    assert.ok(!error.message.includes('Basic'));
    assert.ok(!error.message.includes(secret));
    return true;
  });
});
