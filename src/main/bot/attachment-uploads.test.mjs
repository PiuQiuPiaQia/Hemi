import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createAttachmentUploads} from './attachment-uploads.mjs';
const CHUNK=256*1024;
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hemi-upload-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let now=Date.now(),registrations=0;
  const options={dataDir:root,now:()=>now,requireSession:id=>{assert.ok(['one','two'].includes(id));},register(item,bytes){registrations++;assert.equal(bytes.length,item.size);return{attachmentId:'att-'+item.uploadId,conversationId:item.conversationId,name:item.name,status:'ready'};}};
  let request=createAttachmentUploads(options);
  const call=(method,params)=>request('attachment.upload.'+method,params);
  const input=(bytes=Buffer.from('canary'),extra={})=>({id:'one',uploadId:randomUUID(),name:'说明.md',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),...extra});
  return{root,call,input,restart(){request=createAttachmentUploads(options);},advance(ms){now+=ms;},get registrations(){return registrations;}};
}
test('chunk upload > gateway body limit resumes after restart, verifies bytes and completes exactly once',t=>{
  const f=fixture(t),bytes=Buffer.alloc(1300000,83),p=f.input(bytes);
  assert.equal(f.call('begin',p).received,0);
  const first={...p,offset:0,base64:bytes.subarray(0,CHUNK).toString('base64')};
  assert.equal(f.call('chunk',first).received,CHUNK);assert.equal(f.call('chunk',first).received,CHUNK);
  assert.throws(()=>f.call('chunk',{...first,base64:Buffer.alloc(CHUNK,84).toString('base64')}),{code:'conflict'});
  // Simulate uncommitted tail bytes after a crash.
  fs.appendFileSync(path.join(f.root,'attachment-uploads',p.uploadId+'.part'),'uncommitted');f.restart();
  assert.equal(f.call('status',p).received,CHUNK);
  for(let offset=CHUNK;offset<bytes.length;offset+=CHUNK)f.call('chunk',{...p,offset,base64:bytes.subarray(offset,offset+CHUNK).toString('base64')});
  assert.equal(f.registrations,0);
  const done=f.call('complete',p);assert.equal(done.status,'done');assert.equal(f.registrations,1);
  f.restart();assert.deepEqual(f.call('complete',p),done);assert.deepEqual(f.call('begin',p),done);assert.equal(f.registrations,1);
  assert.equal(fs.existsSync(path.join(f.root,'attachment-uploads',p.uploadId+'.part')),false);
});
test('upload boundaries reject unsupported/oversize files, invalid chunks, cross-session access and failed hashes',t=>{
  const f=fixture(t),p=f.input();
  for(const extra of [{name:'virus.exe'},{name:'huge.png',size:10*1024*1024+1},{size:20*1024*1024+1},{size:0},{sha256:'bad'},{uploadId:'../escape'}])assert.throws(()=>f.call('begin',{...p,...extra}),{code:'invalid'});
  f.call('begin',p);assert.throws(()=>f.call('status',{...p,id:'two'}),{code:'permission'});
  assert.throws(()=>f.call('begin',{...p,name:'different.md'}),{code:'conflict'});
  assert.throws(()=>f.call('complete',p),{code:'conflict'});
  for(const extra of [{offset:1,base64:'eA=='},{offset:0,base64:'??'},{offset:-1,base64:'eA=='},{offset:0,base64:Buffer.alloc(CHUNK+1).toString('base64')}])assert.throws(()=>f.call('chunk',{...p,...extra}));
  f.call('chunk',{...p,offset:0,base64:Buffer.from('wrong!').toString('base64')});assert.throws(()=>f.call('complete',p),/校验/);assert.equal(f.registrations,0);
  assert.throws(()=>f.call('unknown',p),{code:'unsupported'});
});
test('cancel and expiry delete partial bytes; quota is released and cancelled uploads never register',t=>{
  const f=fixture(t),p=f.input();f.call('begin',p);f.call('chunk',{...p,offset:0,base64:Buffer.from('canary').toString('base64')});
  assert.equal(f.call('cancel',p).status,'cancelled');assert.equal(f.call('cancel',p).status,'cancelled');assert.throws(()=>f.call('complete',p),{code:'conflict'});
  assert.equal(fs.existsSync(path.join(f.root,'attachment-uploads',p.uploadId+'.part')),false);
  const pending=Array.from({length:3},()=>f.input());for(const item of pending)f.call('begin',item);
  assert.throws(()=>f.call('begin',f.input()),{code:'busy'});f.call('cancel',pending[0]);f.call('begin',f.input());
  f.advance(3600001);assert.throws(()=>f.call('status',pending[1]),{code:'missing'});assert.equal(fs.readdirSync(path.join(f.root,'attachment-uploads')).filter(x=>x.endsWith('.part')).length,0);assert.equal(f.registrations,0);
});
