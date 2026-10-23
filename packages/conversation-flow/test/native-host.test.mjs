import test from 'node:test';
import assert from 'node:assert/strict';
import {moduleUnderTest} from './compile.mjs';
const {createNativeHost}=await moduleUnderTest('../src/adapters/native-host.ts');
const scope={environmentId:'ios',conversationId:'one',generation:'1'};
const caps={copyText:true,openLink:false,resolveResource:false,readResource:true,resourceActions:false};
function transport(){const sent=[];let listener;return {sent,emit:response=>listener(response),send:request=>sent.push(request),subscribe:callback=>{listener=callback;return()=>{listener=()=>{};};}};}
test('JSON bridge correlates scope, returns capabilities and releases native resources',async()=>{
 const wire=transport(),adapter=createNativeHost({transport:wire,capabilities:caps});
 const ctx={scope,requestId:'request-1',signal:new AbortController().signal};
 const reading=adapter.host.resources.read({ref:{id:'image',version:'3'},purpose:'thumbnail'},ctx);
 wire.emit({version:1,scope:{...scope,generation:'old'},requestId:ctx.requestId,result:{ok:true,value:undefined}});
 wire.emit({version:1,scope,requestId:ctx.requestId,result:{ok:true,value:{ref:{id:'image',version:'3'},content:{kind:'url',url:'blob:1',mimeType:'image/png'},releaseToken:'lease-1'}}});
 const result=await reading;assert.equal(result.ok,true);result.value.release();result.value.release();assert.equal(wire.sent.filter(item=>item.method==='resources.release').length,1);adapter.dispose();
});
test('aborts are forwarded, timeout is unknown, and late native leases are released',async()=>{
 const wire=transport(),adapter=createNativeHost({transport:wire,capabilities:caps,timeoutMs:10});
 const controller=new AbortController(),ctx={scope,requestId:'cancel',signal:controller.signal};
 const copy=adapter.host.copyText({text:'hello'},ctx);controller.abort();assert.equal((await copy).error.code,'cancelled');assert.equal(wire.sent.at(-1).method,'cancel');
 const value=adapter.host.resources.read({ref:{id:'image',version:'1'},purpose:'thumbnail'},{...ctx,requestId:'late',signal:new AbortController().signal});assert.equal((await value).error.code,'unknown');
 wire.emit({version:1,scope,requestId:'late',result:{ok:true,value:{releaseToken:'late-lease'}}});assert.equal(wire.sent.at(-1).method,'resources.release');adapter.dispose();
});
