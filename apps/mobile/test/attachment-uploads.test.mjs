import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createBotHost} from '../../../src/main/bot/host.mjs';
import {moduleUnderTest} from '../../../packages/conversation-flow/test/compile.mjs';
const {createBotWorkspace,BotCommandRejected}=await moduleUnderTest('../../../apps/mobile/test/workspace-test-api.ts');
async function wait(fn){for(let i=0;i<300;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('upload condition timed out');}
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-mobile-upload-')),runs=[];
 const host=await createBotHost({dataDir:path.join(root,'data'),defaultDir:path.join(root,'work'),validateModel:async()=>{},executorFactory:()=>({run:async spec=>{runs.push(spec);return{stopped:false};},stop:async()=>{},close:async()=>{}})});
 t.after(async()=>{await host.close();await fs.rm(root,{recursive:true,force:true});});
 const {instanceId}=await host.request('handshake'),call=(method,params={})=>host.request(method,{instanceId,requestId:randomUUID(),...params});
 await call('model.sync',{models:[{modelKey:'fixture/model',providerId:'fixture',name:'Fixture',model:'fixture',api:'openai-completions',baseUrl:'https://example.invalid',apiKey:'NOT_A_CREDENTIAL'}]});
 const {id}=await call('session.create'),other=(await call('session.create')).id;
 const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
 const bytes=Buffer.from('MOBILE_ATTACHMENT_CANARY_'.repeat(50000)),file={id:randomUUID(),name:'手机文件.md',size:bytes.length,kind:'text',sha256:createHash('sha256').update(bytes).digest('hex')};
 const removed=[],methods=[];let picked=[file],failChunk=false,dropComplete=false,hold,resolve,chunkCalls=0;
 const files={async pick(){return picked;},async read(id,offset,length){assert.equal(id,file.id);return{base64:bytes.subarray(offset,offset+length).toString('base64'),size:length};},async remove(id){removed.push(id);}};
 const rpc={async request(method,params,{signal}){signal.throwIfAborted();methods.push({method,params});if(method==='attachment.upload.chunk'){chunkCalls++;if(hold)await new Promise(r=>{resolve=r;});if(failChunk){failChunk=false;throw new Error('断网测试');}}try{const result=await host.request(method,params);if(dropComplete&&method==='attachment.upload.complete'){dropComplete=false;throw new Error('完成回执丢失');}signal.throwIfAborted();return result;}catch(error){if(error.code)throw new BotCommandRejected(error.code,error.message);throw error;}}};
 const target={endpoint:'https://127.0.0.1:29421',botInstanceId:instanceId,name:'Fixture'};
 let workspace;const open=()=>{workspace=createBotWorkspace({rpc,target,storage,files});return workspace;};t.after(()=>workspace?.dispose());
 return{root,id,other,call,runs,values,removed,methods,file,bytes,open,get workspace(){return workspace;},set failChunk(value){failChunk=value;},set dropComplete(value){dropComplete=value;},set hold(value){hold=value;},release(){hold=false;resolve?.();},get chunkCalls(){return chunkCalls;},set picked(value){picked=value;}};
}
test('mobile files reach actual Host bytes, join the correct SDK draft without clearing text and send as an attachment-only input',async t=>{
 const f=await fixture(t),workspace=f.open();await workspace.reconnect();const client=workspace.getClient(f.id),release=client.retain();t.after(release);await client.start();
 client.draft.setText('上传时保留的文字');f.hold=true;await workspace.pickAttachments(f.id,'files');await wait(()=>f.chunkCalls>0);workspace.select(f.other);f.release();
 await wait(()=>client.draft.getSnapshot().attachments.length===1);await wait(()=>!workspace.getSnapshot().uploads.length);
 assert.equal(client.draft.getSnapshot().text,'上传时保留的文字');assert.equal(f.removed[0],f.file.id);
 const attachment=client.draft.getSnapshot().attachments[0],state=JSON.parse(await fs.readFile(path.join(f.root,'data/state.json'),'utf8'));
 assert.deepEqual(await fs.readFile(state.sessions[f.id].attachments[attachment.attachmentId].path),f.bytes);
 const other=workspace.getClient(f.other),releaseOther=other.retain();t.after(releaseOther);await other.start();assert.equal(other.draft.getSnapshot().attachments.length,0);
 assert.equal([...f.values.values()].some(value=>value.includes('MOBILE_ATTACHMENT_CANARY_')),false);
 client.draft.setText('');const sent=await client.sendDraft();assert.equal(sent.ok,true,JSON.stringify(sent));await wait(()=>f.runs.length===1);
 assert.deepEqual(f.runs[0].envelope.attachmentIds,[attachment.attachmentId]);assert.equal(client.draft.getSnapshot().attachments.length,0);
});
test('retry resumes lost chunk/completion receipts across workspace reload without duplicate registration',async t=>{
 const f=await fixture(t);let workspace=f.open();await workspace.reconnect();f.failChunk=true;
 await workspace.pickAttachments(f.id,'files');await wait(()=>workspace.getSnapshot().uploads[0]?.status==='failed');
 const job=workspace.getSnapshot().uploads[0];workspace.dispose();workspace=f.open();await workspace.reconnect();assert.equal(workspace.getSnapshot().uploads[0].id,job.id);
 f.dropComplete=true;workspace.retryUpload(job.id);await wait(()=>workspace.getSnapshot().uploads[0]?.error==='完成回执丢失');
 const count=f.chunkCalls;workspace.retryUpload(job.id);await wait(()=>workspace.getSnapshot().uploads.length===0);
 assert.equal(f.chunkCalls,count);assert.equal((await f.call('session.open',{id:f.id})).attachments.length,1);
 const client=workspace.getClient(f.id),release=client.retain();t.after(release);await client.start();assert.equal(client.draft.getSnapshot().attachments.length,1);
});
test('cancelling an in-flight chunk ignores its late response, cleans local bytes and never adds a draft attachment',async t=>{
 const f=await fixture(t),workspace=f.open();await workspace.reconnect();f.hold=true;await workspace.pickAttachments(f.id,'photos');await wait(()=>f.chunkCalls>0);
 const job=workspace.getSnapshot().uploads[0],cancel=workspace.cancelUpload(job.id);assert.equal(workspace.getSnapshot().uploads.length,0);f.release();await cancel;
 assert.equal((await f.call('attachment.upload.status',{id:f.id,uploadId:job.id})).status,'cancelled');assert.equal((await f.call('session.open',{id:f.id})).attachments.length,0);assert.deepEqual(f.removed,[f.file.id]);
});
test('picker cancellation is benign and three pending files prevent a fourth pick',async t=>{
 const f=await fixture(t),workspace=f.open();await workspace.reconnect();f.picked=[];await workspace.pickAttachments(f.id,'files');assert.equal(workspace.getSnapshot().uploads.length,0);
 f.picked=[f.file];f.hold=true;for(let i=0;i<3;i++)await workspace.pickAttachments(f.id,'files');await assert.rejects(workspace.pickAttachments(f.id,'files'),/最多 3/);
 const cancelled=workspace.getSnapshot().uploads.map(job=>workspace.cancelUpload(job.id));f.release();await Promise.all(cancelled);
});
