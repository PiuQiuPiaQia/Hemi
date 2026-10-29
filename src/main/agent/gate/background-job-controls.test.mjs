import test from 'node:test';import assert from 'node:assert/strict';
import {createCommandScope} from './command-scope.mjs';import {CommandOutput} from './command-output.mjs';
import {withExecutionScope} from '../../agent-runtime/execution-scope.mjs';
const owner={conversationId:'c',rootRunId:'r',generation:1},other={...owner,rootRunId:'other'};
const command=body=>`"${process.execPath}" -e "${body}"`;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<300;i++){if(fn())return;await pause(10);}throw Error('timeout');}
test('bounded output retains the real tail and reports absolute gaps without consuming other readers',()=>{
 const log=new CommandOutput(8);log.append('out','12345678');log.append('err','FAIL');
 const a=log.read(0);assert.equal(a.text,'5678FAIL');assert.equal(a.lossy,true);assert.equal(a.next,12);assert.equal(log.read(8).text,'FAIL');assert.equal(log.read(8).text,'FAIL');
 const unicode=new CommandOutput(8);unicode.append('out','甲乙丙丁');const slice=unicode.read(0,4);assert.equal(slice.text,'丙');assert.equal(unicode.read(slice.next).text,'丁');
 assert.equal(log.text('err'),'FAIL');assert.throws(()=>log.read(20));
});
test('real jobs support bounded waits, isolated stop, owner fencing and non-consuming observers',{timeout:15000},async t=>{
 const c=createCommandScope({quietReviewMs:0});t.after(()=>c.abort());
 const run=body=>withExecutionScope({owner},null,()=>c.run({command:command(body),runInBackground:true,timeoutMs:10000}));
 const a=await run("process.stdout.write('FIRST');setTimeout(()=>{},8000)"),b=await run("setTimeout(()=>process.stdout.write('SECOND'),500)");
 await until(()=>c.list(owner).some(j=>j.output==='FIRST'));
 const early=await c.read(owner,a.jobId,{waitMs:20});assert.equal(early.status,'running');assert.equal(c.list(other).length,0);assert.throws(()=>c.inspect(other,a.jobId));
 assert.equal(c.inspect(owner,a.jobId).text,'FIRST');assert.equal(c.inspect(owner,a.jobId).text,'FIRST');
 const stopped=await c.stop(owner,a.jobId);assert.equal(stopped.status,'cancelled');assert.equal(stopped.cleanupConfirmed,true);assert.equal(c.inspect(owner,b.jobId).status,'running');
 const terminal=await c.read(owner,b.jobId,{waitMs:3000,collect:true});assert.equal(terminal.status,'succeeded');assert.equal(terminal.text,'SECOND');
 const events=c.takeCompleted(owner);assert.equal(events.length,1);assert.equal(events[0].id,a.jobId);assert.deepEqual(c.takeCompleted(owner),[]);
});
test('quiet observation fires once per output episode, manual review wakes immediately, cancellation still settles',{timeout:10000},async t=>{
 const c=createCommandScope({quietReviewMs:30,maxQuietReviews:1});t.after(()=>c.abort());
 const j=await withExecutionScope({owner},null,()=>c.run({command:command("process.stdout.write('ALIVE');setTimeout(()=>{},8000)"),runInBackground:true,timeoutMs:9000}));
 await until(()=>c.list(owner)[0]?.output==='ALIVE');
 const observation=await c.waitForUpdate(owner);assert.equal(observation.kind,'review');assert.equal(observation.requested,false);assert.equal(c.inspect(owner,j.jobId).status,'running');
 let settled=false;const wait=c.waitForUpdate(owner).then(r=>{settled=true;return r;});await pause(70);assert.equal(settled,false);
 assert.equal(c.requestReview(other),false);assert.equal(c.requestReview(owner),true);assert.equal((await wait).requested,true);
 await c.stop(owner,j.jobId);assert.equal((await c.waitForUpdate(owner)).kind,'settled');
});
test('an abandoned scheduler wait never consumes completion; the next reader collects it once',{timeout:10000},async t=>{
 const c=createCommandScope({quietReviewMs:0});t.after(()=>c.abort());
 const j=await withExecutionScope({owner},null,()=>c.run({command:command("setTimeout(()=>process.stdout.write('REAL_RESULT'),150)"),runInBackground:true,timeoutMs:5000}));
 const controller=new AbortController(),waiting=c.waitForUpdate(owner,{signal:controller.signal,collect:false});controller.abort();await assert.rejects(waiting,{name:'AbortError'});
 assert.equal((await c.waitForUpdate(owner,{collect:false})).kind,'settled');
 const events=await c.collectCompleted(owner);assert.equal(events.length,1);assert.equal(events[0].id,j.jobId);assert.match(events[0].text,/REAL_RESULT/);assert.deepEqual(await c.collectCompleted(owner),[]);
});
test('a budget race cannot consume an unacknowledged quiet or manual review',{timeout:10000},async t=>{
 const c=createCommandScope({quietReviewMs:30,maxQuietReviews:1});t.after(()=>c.abort());
 const j=await withExecutionScope({owner},null,()=>c.run({command:command('setTimeout(()=>{},8000)'),runInBackground:true,timeoutMs:9000}));
 assert.equal((await c.waitForUpdate(owner,{collect:false})).kind,'review');
 assert.equal((await c.waitForUpdate(owner)).requested,false,'the quiet episode was not spent by the losing waiter');
 c.requestReview(owner);assert.equal((await c.waitForUpdate(owner,{collect:false})).requested,true);
 assert.equal((await c.waitForUpdate(owner)).requested,true,'manual review remains pending until accepted');
 await c.stop(owner,j.jobId);
});
