import test from 'node:test';
import assert from 'node:assert/strict';
import {moduleUnderTest} from '../../../packages/conversation-flow/test/compile.mjs';
const {createNativeBotRpc}=await moduleUnderTest('../../../apps/mobile/test/native-test-api.ts');

test('aborting a read cancels its actual native request and rejects without waiting for a late reply',async()=>{
 let started,finish;const cancelled=[];
 const rpc=createNativeBotRpc({request(input){started=input;return new Promise(resolve=>finish=resolve)},async cancelRequest(input){cancelled.push(input.requestId)}});
 const controller=new AbortController(),pending=rpc.request('flow.snapshot',{id:'same'},{signal:controller.signal});
 controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.deepEqual(cancelled,[started.requestId]);
 finish({ok:true,result:{old:true}});await new Promise(r=>setImmediate(r));assert.equal(cancelled.length,1);
});

test('a signal aborted before dispatch never starts or cancels an unrelated native call',async()=>{
 let calls=0;const rpc=createNativeBotRpc({async request(){calls++;return {ok:true,result:{}}},async cancelRequest(){calls++}});
 const controller=new AbortController();controller.abort();await assert.rejects(rpc.request('snapshot',{}, {signal:controller.signal}),{name:'AbortError'});assert.equal(calls,0);
});
