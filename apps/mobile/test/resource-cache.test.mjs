import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID}from'node:crypto';
import {moduleUnderTest}from'../../../packages/conversation-flow/test/compile.mjs';import{resourceFixture,wait}from'./resource-fixture.mjs';
const {createResourceCache,createBotResources}=await moduleUnderTest('../../../apps/mobile/test/resource-cache-test-api.ts');
const signal=()=>new AbortController().signal;
test('completed cache has a fixed TTL, uses LRU byte/count limits, and refresh/disposal invalidate it',async t=>{
 let clock=0,loads=0;const cache=createResourceCache({now:()=>clock,ttlMs:600000,maxBytes:10,maxEntries:2,sizeOf:value=>value.size});t.after(()=>cache.dispose());
 const load=async()=>({size:6,revision:++loads});const first=await cache.get('one',signal(),load);clock=300000;assert.equal(await cache.get('one',signal(),load),first);assert.equal(cache.getProgress('one').expiresAt,600000);
 clock=600000;assert.notEqual(await cache.get('one',signal(),load),first);assert.equal(loads,2);
 await cache.get('two',signal(),load);assert.equal(cache.getCached('one'),undefined);assert.ok(cache.getCached('two'));
 cache.invalidate('two');assert.equal(cache.getCached('two'),undefined);await cache.get('two',signal(),load);cache.dispose();await assert.rejects(cache.get('two',signal(),load),{name:'AbortError'});
});
test('deduplicated consumers cancel independently; last cancellation prevents late data from entering the cache',async t=>{
 const cache=createResourceCache({sizeOf:()=>1});t.after(()=>cache.dispose());let finish,loads=0;
 const load=()=>{loads++;return new Promise(resolve=>{finish=resolve;});};
 const a=new AbortController(),b=new AbortController(),first=cache.get('file',a.signal,load),second=cache.get('file',b.signal,load);await wait(()=>!!finish);a.abort();await assert.rejects(first,{name:'AbortError'});finish('complete');assert.equal(await second,'complete');assert.equal(loads,1);
 let finishLate;const c=new AbortController(),late=cache.get('other',c.signal,()=>new Promise(resolve=>{finishLate=resolve;}));await wait(()=>!!finishLate);c.abort();await assert.rejects(late,{name:'AbortError'});finishLate('late');await new Promise(resolve=>setTimeout(resolve,0));assert.equal(cache.getCached('other'),undefined);
});
test('a refresh does not accept or report an older in-flight result; failed data is never cached',async t=>{
 const cache=createResourceCache({sizeOf:()=>1});t.after(()=>cache.dispose());let release,reportOld;
 const old=cache.get('file',signal(),async(_signal,report)=>{reportOld=report;return new Promise(resolve=>{release=resolve;});});await wait(()=>!!release);cache.invalidate('file');
 const fresh=await cache.get('file',signal(),async()=> 'new');reportOld({phase:'downloading',received:1,total:99});release('old');await assert.rejects(old,{name:'AbortError'});assert.equal(fresh,'new');assert.equal(cache.getCached('file'),'new');assert.notEqual(cache.getProgress('file').total,99);
 await assert.rejects(cache.get('bad',signal(),async()=>{throw new Error('checksum');}),/checksum/);assert.equal(cache.getCached('bad'),undefined);
});
test('at most two cold downloads run concurrently; cancelling queued work does not consume a slot',async t=>{
 const cache=createResourceCache({sizeOf:()=>1});t.after(()=>cache.dispose());let running=0,peak=0;const releases=[];
 const load=async()=>{running++;peak=Math.max(peak,running);await new Promise(resolve=>releases.push(resolve));running--;return 'ok';};
 const one=cache.get('one',signal(),load),two=cache.get('two',signal(),load),controller=new AbortController(),third=cache.get('three',controller.signal,load);await wait(()=>releases.length===2);controller.abort();await assert.rejects(third,{name:'AbortError'});releases.splice(0).forEach(fn=>fn());await Promise.all([one,two]);assert.equal(peak,2);
});
test('real Host: cold download has confirmed progress, warm preview/save/share use no RPC, expiry and refresh read new bytes',async t=>{
 const f=await resourceFixture();t.after(()=>f.close());let clock=Date.now(),requests=0;const snapshots=[],stages=new Map(),presented=[];
 const files={async begin(meta){const id=randomUUID();stages.set(id,{meta,parts:[]});return{id};},async append({id,base64}){stages.get(id).parts.push(Buffer.from(base64,'base64'));},async finish(){},async present(id,action){presented.push({action,bytes:Buffer.concat(stages.get(id).parts)});return{presented:true};},async remove(id){stages.delete(id);}};
 const resources=createBotResources({now:()=>clock,environmentId:'bot:'+f.instanceId,files,request:async(method,params,signal)=>{signal?.throwIfAborted();requests++;return f.call(method,params);}});t.after(()=>resources.dispose());
 const scope={environmentId:'bot:'+f.instanceId,conversationId:f.id,generation:'1'},ref={id:'deliverable:'+f.byName['大文件.zip'],version:'0'},context=()=>({scope,requestId:randomUUID(),signal:signal()});
 const unsubscribe=resources.subscribe(()=>snapshots.push(resources.getProgress(scope,ref)));t.after(unsubscribe);
 assert.equal((await resources.perform({ref,actionId:'save'},context())).ok,true);assert.equal(requests,3);assert.deepEqual(presented[0].bytes,f.files['大文件.zip']);assert.ok(snapshots.some(x=>x.phase==='downloading'&&x.received===1024*1024&&x.total===1200000));assert.ok(snapshots.some(x=>x.phase==='verifying'));assert.ok(resources.getProgress(scope,ref).expiresAt>clock);
 for(const actionId of ['open','share'])assert.equal((await resources.perform({ref,actionId},context())).ok,true);assert.equal(requests,3);
 clock+=600001;assert.equal((await resources.perform({ref,actionId:'save'},context())).ok,true);assert.equal(requests,6);
 resources.invalidate(scope,ref);assert.equal((await resources.perform({ref,actionId:'save'},context())).ok,true);assert.equal(requests,9);
 const image={id:'deliverable:'+f.byName['预览图片.png'],version:'0'},thumbnail=await resources.read({ref:image,purpose:'thumbnail'},context()),count=requests,preview=await resources.read({ref:image,purpose:'preview'},context());assert.equal(thumbnail.ok,true);assert.equal(preview.ok,true);assert.equal(requests,count);thumbnail.value.release();preview.value.release();
});

test('LRU count limit preserves a recently reused resource',async t=>{
 const cache=createResourceCache({maxEntries:2,maxBytes:100,sizeOf:()=>1});t.after(()=>cache.dispose());const load=async()=> 'verified';
 await cache.get('one',signal(),load);await cache.get('two',signal(),load);await cache.get('one',signal(),load);await cache.get('three',signal(),load);
 assert.ok(cache.getCached('one'));assert.equal(cache.getCached('two'),undefined);assert.ok(cache.getCached('three'));
});
test('a corrupted actual Host chunk never becomes a cache hit and a later retry downloads again',async t=>{
 const f=await resourceFixture();t.after(()=>f.close());let corrupt=true,requests=0;
 const resources=createBotResources({environmentId:'bot:'+f.instanceId,request:async(method,params)=>{requests++;const value=await f.call(method,params);if(corrupt&&method==='resource.chunk'){corrupt=false;const bytes=Buffer.from(value.base64,'base64');bytes[0]^=1;return{...value,base64:bytes.toString('base64')};}return value;}});t.after(()=>resources.dispose());
 const ref={id:'deliverable:'+f.byName['预览图片.png'],version:'0'},scope={environmentId:'bot:'+f.instanceId,conversationId:f.id,generation:'1'},ctx=()=>({scope,requestId:randomUUID(),signal:signal()});
 const failed=await resources.read({ref,purpose:'preview'},ctx());assert.equal(failed.ok,false);assert.match(failed.error.message,/校验失败/);assert.equal(resources.getProgress(scope,ref).phase,'failed');
 const read=await resources.read({ref,purpose:'preview'},ctx());assert.equal(read.ok,true);assert.equal(requests,4);read.value.release();
 const warm=await resources.read({ref,purpose:'preview'},ctx());assert.equal(warm.ok,true);assert.equal(requests,4);warm.value.release();
});

test('an invalid preview reference stays a file error and cannot crash progress subscribers',async t=>{
 const resources=createBotResources({environmentId:'bot:test',request:async()=>{throw new Error('Invalid references must not reach RPC');}});t.after(()=>resources.dispose());const scope={environmentId:'bot:test',conversationId:'one',generation:'1'},ref={id:'null',version:'0'};
 assert.equal(resources.getProgress(scope,ref).phase,'idle');assert.doesNotThrow(()=>resources.invalidate(scope,ref));assert.equal((await resources.read({ref,purpose:'preview'},{scope,signal:signal(),requestId:randomUUID()})).ok,false);
});
