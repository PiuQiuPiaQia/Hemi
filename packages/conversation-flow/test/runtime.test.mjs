import test from 'node:test';
import assert from 'node:assert/strict';
import {moduleUnderTest} from './compile.mjs';
const {createFlowRuntime,ok}=await moduleUnderTest('../src/host/runtime.ts');
const scope={environmentId:'local',conversationId:'same',generation:'1'};
const capabilities={copyText:false,openLink:false,resolveResource:false,readResource:true,resourceActions:false};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('resource readers share a lease, cancel on last release, and release exactly once',async()=>{
 let reads=0,releases=0;
 const runtime=createFlowRuntime({scope,host:{version:1,capabilities,resources:{read:async({ref})=>{reads++;return ok({ref,content:{kind:'url',url:'blob:one',mimeType:'image/png'},release(){releases++;}});}}}});
 const a=runtime.acquire({id:'file',version:'1'},'thumbnail'),b=runtime.acquire({id:'file',version:'1'},'thumbnail');
 assert.equal((await a.result).ok,true);assert.equal((await b.result).ok,true);assert.equal(reads,1);
 a.release();assert.equal(releases,0);b.release();assert.equal(releases,1);b.release();runtime.dispose();assert.equal(releases,1);
});
test('an abandoned pending read aborts immediately and releases a late host lease',async()=>{
 let finish,signal,releases=0;
 const runtime=createFlowRuntime({scope,host:{version:1,capabilities,resources:{read:({ref},context)=>{signal=context.signal;return new Promise(resolve=>finish=()=>resolve(ok({ref,content:{kind:'url',url:'blob:late',mimeType:'image/png'},release(){releases++;}})));}}}});
 const acquired=runtime.acquire({id:'file',version:'1'},'thumbnail');await tick();acquired.release();
 assert.equal(signal.aborted,true);assert.equal((await acquired.result).error.code,'cancelled');finish();await tick();assert.equal(releases,1);runtime.dispose();assert.equal(releases,1);
});
test('same resource IDs in different environments and versions do not share reads',async()=>{
 let reads=0;const host={version:1,capabilities,resources:{read:async({ref})=>{reads++;return ok({ref,content:{kind:'text',text:ref.version,mimeType:'text/plain'},release(){}});}}};
 const a=createFlowRuntime({scope,host}),b=createFlowRuntime({scope:{...scope,environmentId:'remote'},host});
 const subscriptions=[a.acquire({id:'same',version:'1'},'thumbnail'),a.acquire({id:'same',version:'2'},'thumbnail'),b.acquire({id:'same',version:'1'},'thumbnail')];
 await Promise.all(subscriptions.map(item=>item.result));assert.equal(reads,3);subscriptions.forEach(item=>item.release());a.dispose();b.dispose();
});
test('mismatched resource version is discarded and its lease released',async()=>{
 let released=0;const runtime=createFlowRuntime({scope,host:{version:1,capabilities,resources:{read:async()=>ok({ref:{id:'file',version:'old'},content:{kind:'text',text:'stale',mimeType:'text/plain'},release(){released++;}})}}});
 const acquired=runtime.acquire({id:'file',version:'new'},'thumbnail');assert.equal((await acquired.result).ok,false);assert.equal(released,1);acquired.release();runtime.dispose();
});
test('actions deduplicate double clicks; unknown results require a new authoritative revision',async()=>{
 let calls=0;const runtime=createFlowRuntime({scope,timeoutMs:10,onAction:()=>{calls++;return new Promise(()=>{});}});
 const action={type:'workflow.start',targetId:'inv',invocationId:'inv',expectedRevision:'1'};
 const a=runtime.action(action),b=runtime.action(action);assert.equal(a,b);assert.equal((await a).error.code,'unknown');
 assert.equal((await runtime.action(action)).error.code,'unknown');assert.equal(calls,1);
 await runtime.action({...action,expectedRevision:'2'});assert.equal(calls,2);runtime.dispose();
});
test('scope disposal cancels a pending business wait without executing a stop/deny',async()=>{
 const actions=[];let finish;const runtime=createFlowRuntime({scope,onAction:action=>{actions.push(action);return new Promise(resolve=>finish=resolve);}});
 const value=runtime.action({type:'message.edit',targetId:'message',nextText:'new'});await tick();runtime.dispose();assert.equal((await value).error.code,'cancelled');finish(ok({receipt:'completed'}));assert.deepEqual(actions.map(action=>action.type),['message.edit']);
});
test('missing capabilities and readonly operation have an explicit result',async()=>{
 const runtime=createFlowRuntime({scope});assert.equal(runtime.can('copyText'),false);assert.equal((await runtime.action({type:'message.retry',targetId:'error'})).error.code,'unsupported');runtime.dispose();
});
test('StrictMode-style retain cleanup can be immediately reacquired',async()=>{
 const runtime=createFlowRuntime({scope});const first=runtime.retain();first();const second=runtime.retain();await tick();assert.equal(runtime.disposed,false);second();await tick();assert.equal(runtime.disposed,true);
});


test('invalid host results and business receipts are reported, never rejected or replayed automatically',async()=>{
 let calls=0;const runtime=createFlowRuntime({scope,onAction:async()=>{calls++;return {ok:true,value:undefined};}});
 const action={type:'message.retry',targetId:'error'};
 assert.equal((await runtime.action(action)).error.code,'unknown');assert.equal((await runtime.action(action)).error.code,'unknown');assert.equal(calls,1);
 assert.equal((await runtime.invoke(async()=>undefined)).error.code,'unknown');runtime.dispose();
});
test('invalid resource metadata still releases the host handle',async()=>{
 let releases=0;const runtime=createFlowRuntime({scope,host:{version:1,capabilities,resources:{read:async()=>ok({release(){releases++;}})}}});
 const value=runtime.acquire({id:'file',version:'1'},'thumbnail');assert.equal((await value.result).ok,false);assert.equal(releases,1);value.release();runtime.dispose();
});
