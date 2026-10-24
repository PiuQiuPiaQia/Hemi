import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import{createHash,randomUUID}from'node:crypto';
import{moduleUnderTest}from'../../../packages/conversation-flow/test/compile.mjs';import{resourceFixture}from'./resource-fixture.mjs';
const {createBotWorkspace,BotCommandRejected}=await moduleUnderTest('../../../apps/mobile/test/workspace-test-api.ts');
async function fixture(t){const f=await resourceFixture();t.after(()=>f.close());const saved=new Map(),local=new Map(),presentations=[],removed=[];let hold,release,failPresent=false;const methods=[];
 const resourceFiles={async begin(meta){const id=randomUUID();local.set(id,{meta,parts:[]});return{id};},async append({id,base64,offset}){const item=local.get(id);assert.equal(Buffer.concat(item.parts).length,offset);item.parts.push(Buffer.from(base64,'base64'));},async finish(id){const item=local.get(id),bytes=Buffer.concat(item.parts);assert.equal(bytes.length,item.meta.size);assert.equal(createHash('sha256').update(bytes).digest('hex'),item.meta.sha256);},async present(id,action){if(failPresent)throw new Error('系统面板打开失败');const item=local.get(id);presentations.push({action,name:item.meta.name,bytes:Buffer.concat(item.parts)});return{presented:true};},async remove(id){removed.push(id);local.delete(id);}};
 const rpc={async request(method,params,{signal}){signal.throwIfAborted();methods.push(method);if(method==='resource.chunk'&&hold)await new Promise(r=>{release=r;});try{const result=await f.host.request(method,params);signal.throwIfAborted();return result;}catch(error){if(error.code)throw new BotCommandRejected(error.code,error.message);throw error;}}};
 const workspace=createBotWorkspace({rpc,target:{endpoint:'https://127.0.0.1:29421',botInstanceId:f.instanceId,name:'Fixture'},resourceFiles,storage:{getItem:key=>saved.get(key)??null,setItem:(key,v)=>saved.set(key,v),removeItem:key=>saved.delete(key)}});t.after(()=>workspace.dispose());
 const context=(id=f.id,controller=new AbortController())=>({scope:{environmentId:workspace.environmentId,conversationId:id,generation:'1'},requestId:randomUUID(),signal:controller.signal});
 return{...f,workspace,resources:workspace.resources,context,local,presentations,removed,methods,set hold(value){hold=value;},release(){hold=false;release?.();},set failPresent(value){failPresent=value;}};
}
test('mobile resources read real registered text/image and body links; blob lease releases its object URL',async t=>{
 const f=await fixture(t),ctx=f.context();
 const ref={id:'deliverable:'+f.byName['交付说明.md'],version:'0'},read=await f.resources.read({ref,purpose:'preview'},ctx);assert.equal(read.ok,true);assert.match(read.value.content.text,/MOBILE_DELIVERY/);assert.equal(read.value.content.mimeType,'text/markdown');read.value.release();
 const picture=await f.resources.read({ref:{id:'deliverable:'+f.byName['预览图片.png'],version:'0'},purpose:'thumbnail'},ctx);assert.equal(picture.ok,true);const url=picture.value.content.url;assert.deepEqual(Buffer.from(await(await fetch(url)).arrayBuffer()),f.files['预览图片.png']);picture.value.release();await assert.rejects(fetch(url));
 const link=await f.resources.resolve({href:'./普通正文.md'},ctx);assert.equal(link.ok,true);assert.equal((await f.resources.read({ref:link.value,purpose:'preview'},ctx)).value.content.text,'# BODY_PREVIEW');assert.deepEqual((await f.resources.listActions({ref:link.value},ctx)).value,[]);assert.equal((await f.resources.perform({ref:link.value,actionId:'save'},ctx)).ok,false);
 assert.equal((await f.resources.read({ref,purpose:'preview'},f.context(f.other))).ok,false);assert.equal((await f.resources.read({ref:link.value,purpose:'preview'},f.context(f.other))).ok,false);
 assert.equal((await f.resources.resolve({href:path.join(f.root,'data/state.json')},ctx)).error.code,'denied');
});
test('open/save/share stage exact >1MB bytes with original filenames and cleanup, including failed native presentation',async t=>{
 const f=await fixture(t),ref={id:'deliverable:'+f.byName['大文件.zip'],version:'0'},ctx=f.context();
 assert.deepEqual((await f.resources.listActions({ref},ctx)).value.map(x=>x.id),['open','save','share']);
 for(const actionId of ['open','save','share']){assert.equal((await f.resources.perform({ref,actionId},ctx)).ok,true);const value=f.presentations.at(-1);assert.equal(value.name,'大文件.zip');assert.deepEqual(value.bytes,f.files['大文件.zip']);assert.equal(f.local.size,0);}
 f.failPresent=true;assert.equal((await f.resources.perform({ref,actionId:'save'},ctx)).ok,false);assert.equal(f.local.size,0);assert.equal(f.removed.length,4);
 const empty={id:'deliverable:'+f.byName['空文件.txt'],version:'0'};f.failPresent=false;assert.equal((await f.resources.perform({ref:empty,actionId:'save'},ctx)).ok,true);assert.equal(f.presentations.at(-1).bytes.length,0);
});
test('closing while downloading aborts late chunks and cleans native staging without presenting',async t=>{
 const f=await fixture(t),controller=new AbortController(),ref={id:'deliverable:'+f.byName['大文件.zip'],version:'0'};f.hold=true;
 const pending=f.resources.perform({ref,actionId:'share'},f.context(f.id,controller));for(let i=0;i<100&&!f.local.size;i++)await new Promise(r=>setTimeout(r,10));controller.abort();f.release();const result=await pending;assert.equal(result.ok,false);assert.equal(f.local.size,0);assert.equal(f.presentations.length,0);
});
test('actual Host chunk authority rejects unregistered/cross-session files and changed or replaced files',async t=>{
 const f=await fixture(t),params={id:f.id,kind:'deliverable',artifactId:f.byName['交付说明.md']},info=await f.call('resource.stat',params);
 await assert.rejects(f.call('resource.stat',{...params,id:f.other}),{code:'missing'});
 await assert.rejects(f.call('resource.chunk',{...params,version:info.version,offset:0,length:info.chunkSize+1}),{code:'invalid'});
 const link=await f.call('file.resolve',{id:f.id,path:'./普通正文.md'});await assert.rejects(f.call('resource.stat',{...params,artifactId:link.artifactId,path:link.path}),{code:'missing'});
 await fs.writeFile(path.join(f.work,'交付说明.md'),'CHANGED');await assert.rejects(f.call('resource.chunk',{...params,version:info.version,offset:0,length:12}),{code:'conflict'});
 await fs.unlink(path.join(f.work,'交付说明.md'));await fs.symlink(path.join(f.root,'data/state.json'),path.join(f.work,'交付说明.md'));await assert.rejects(f.call('resource.stat',params),{code:'permission'});
});
