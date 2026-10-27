import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {createClarificationFixture,CLARIFICATION_QUESTION} from '../../../scripts/lib/goal-clarification-fixture.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(read){const end=Date.now()+15000;while(true){const value=await read();if(value)return value;assert.ok(Date.now()<end,'clarification did not settle');await pause(20);}}
const errors=f=>f.timeline.flatMap(x=>x.parts??[]).filter(p=>p.kind==='notice'&&p.level==='error');
async function waitForAnswer(f){await f.send('创建 seed.txt 后帮我写 proof.txt，但文件内容请先向我询问。','question-input');return until(async()=>{const v=await f.flow();return v.awaitingUser&&v.phase==='idle'?v:null;});}
for(const restart of [false,true])test(`real Host/SDK clarification -> ${restart?'restart -> ':''}user answer -> write/read/verified completion`,{timeout:30000},async t=>{
 const f=await createClarificationFixture();t.after(()=>f.close());const waiting=await waitForAnswer(f),runId=waiting.awaitingUser.runId;
 assert.equal(waiting.awaitingUser.question,CLARIFICATION_QUESTION);assert.equal(waiting.runs[runId].outcome,'awaiting-user');assert.equal(waiting.activeRunId,null);assert.deepEqual(errors(waiting),[]);
 const before=await f.journal();assert.equal(before.roots[runId].status,'awaiting_user');assert.equal(f.seedCalls,1);assert.equal((await f.call('handshake')).activeJobs,0);
 if(restart){const journalCount=Object.keys((await f.journal()).requests).length;await f.restart();const count=f.requests.length;await pause(100);assert.equal(f.requests.length,count,'restart must not dispatch goal work');assert.equal(Object.keys((await f.journal()).requests).length,journalCount);assert.deepEqual((await f.flow()).awaitingUser,waiting.awaitingUser);}
 await f.send('文件内容写入 CLARIFIED_VALUE。','answer-input');const done=await until(async()=>{const v=await f.flow();return v.phase==='idle'&&!v.awaitingUser&&Object.keys(v.runs).length===2?v:null;});
 assert.deepEqual(errors(done),[]);const next=Object.values(done.runs).at(-1);assert.equal(next.outcome,'completed');assert.equal(next.continuationOf,runId);
 const journal=await f.journal(),goal=journal.roots[next.runId].goal;assert.equal(journal.roots[runId].status,'continued');assert.equal(goal.id,runId);assert.equal(goal.phase,'complete');assert.equal(goal.replies[0].inputId,'answer-input');assert.equal(goal.objective,before.roots[runId].goal.objective);assert.deepEqual(goal.verifications.map(v=>v.status),['awaiting_user','complete']);
 assert.equal(await fs.readFile(path.join(f.workspace,'proof.txt'),'utf8'),'CLARIFIED_VALUE');assert.equal(f.seedCalls,1);assert.deepEqual(done.timeline.filter(x=>x.kind==='user').map(x=>x.id),['question-input','answer-input']);
 const count=f.requests.length;await f.send('文件内容写入 CLARIFIED_VALUE。','answer-input');await pause(50);assert.equal(f.requests.length,count,'duplicate answer input must not execute twice');
 const resumed=f.requests.find(b=>b.tools?.length&&JSON.stringify(b.messages).includes('CLARIFIED_VALUE'));assert.ok(JSON.stringify(resumed.messages).includes('INITIAL_EFFECT_ONCE')||JSON.stringify(resumed.messages).includes('seed.txt'));assert.ok(JSON.stringify(resumed.messages).includes(CLARIFICATION_QUESTION));
});
test('normal user wait can be cancelled explicitly without resuming on restart',{timeout:30000},async t=>{
 const f=await createClarificationFixture();t.after(()=>f.close());const waiting=await waitForAnswer(f);await f.call('flow.command',{id:f.id,command:{type:'stop'}});assert.equal((await f.flow()).awaitingUser,null);assert.equal((await f.journal()).roots[waiting.awaitingUser.runId].status,'cancelled');const journalCount=Object.keys((await f.journal()).requests).length;await f.restart();const count=f.requests.length;await pause(100);assert.equal(f.requests.length,count);assert.equal(Object.keys((await f.journal()).requests).length,journalCount);
});
test('a real verification failure after clarification remains failed and produces one error notice',{timeout:30000},async t=>{
 const f=await createClarificationFixture({verificationFailsAfterAnswer:true});t.after(()=>f.close());await waitForAnswer(f);await f.send('写入 CLARIFIED_VALUE','answer-input');const done=await until(async()=>{const v=await f.flow();return v.phase==='idle'&&Object.keys(v.runs).length===2?v:null;});assert.equal(Object.values(done.runs).at(-1).outcome,'failed');assert.equal(errors(done).length,1);assert.match(errors(done)[0].text,/JSON/);
});
