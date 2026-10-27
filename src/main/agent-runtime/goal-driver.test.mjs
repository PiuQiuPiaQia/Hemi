import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRunJournal,GOAL_VERIFICATION_PURPOSE} from './run-journal.mjs';
import {goalPolicy,parseGoalVerdict} from './goal-driver.mjs';
const owner={conversationId:'goal-test',rootRunId:'root',generation:1};
const next={status:'continue',reason:'成果还缺少最后验证',evidence:['已安装依赖'],remaining:['验证成果'],nextAction:'运行剩余验证'};
const complete={status:'complete',reason:'实际结果已验证',evidence:['实际测试成功且符合请求'],remaining:[],nextAction:''};
async function fixture(t,options={}){const dir=await mkdtemp(path.join(os.tmpdir(),'hemi-goal-journal-'));t.after(()=>rm(dir,{recursive:true,force:true}));const journal=createRunJournal({dir});await journal.beginRoot(owner,{policySnapshot:{budgets:{maxRequestsPerRun:2}}});await journal.beginGoal(owner,'完成请求',goalPolicy({maxRequestsPerRound:2,...options}));return{journal,dir};}
const request=(journal,id,who=owner,purpose='main')=>journal.requestStart(who,{requestId:id,role:'main',purpose},2);
const finish=(journal,id)=>journal.requestEnd(id,{error:null});
test('主子和辅助共享每段额度；单段触顶可校验一次，持久续跑不重置总预算',async t=>{
 const {journal}=await fixture(t,{maxRequests:3});const child={...owner,taskId:'child'},aux={...owner,rootRunId:'aux'};
 await journal.beginRoot(aux,{kind:'auxiliary',sourceRootRunId:owner.rootRunId});
 await request(journal,'a',child,'subagent');await finish(journal,'a');await request(journal,'b',aux,'title');await finish(journal,'b');
 await assert.rejects(request(journal,'over'),/上限 2/);await journal.checkGoal(owner);
 await request(journal,'verify',owner,GOAL_VERIFICATION_PURPOSE);await finish(journal,'verify');await assert.rejects(request(journal,'verify2',owner,GOAL_VERIFICATION_PURPOSE),/不可用/);
 await journal.recordGoalCheck(owner,next);const round=await journal.continueGoal(owner);assert.equal(round.requestOffset,2);assert.equal(round.round,2);
 await request(journal,'c');await finish(journal,'c');await assert.rejects(request(journal,'total-over',child,'subagent'),/上限 3/);
 await journal.checkGoal(owner);await journal.recordGoalCheck(owner,next);await assert.rejects(journal.continueGoal(owner),{code:'goal-budget-limit'});
 assert.equal(Object.keys((await journal.snapshot()).requests).length,4);
});
for(const kind of ['request','tool','process','dispatch','inbox'])test(`未确认的 ${kind} 不能通过完成边界`,async t=>{
 const {journal}=await fixture(t);
 if(kind==='request')await request(journal,'active');
 if(kind==='tool')await journal.observationStart({id:'active',owner,tool:'write'});
 if(kind==='process')await journal.processStart({id:'active',owner,pid:99999,token:'fixture'});
 if(kind==='dispatch')await journal.reserveDispatch('active',{owner});
 if(kind==='inbox')await journal.completeTask({owner,result:{taskId:'active'},background:true});
 await assert.rejects(journal.checkGoal(owner),/未确认/);await journal.finishRoot(owner,'completed');assert.equal((await journal.root(owner)).status,'partial');
});
test('重启保存目标和校验证据，禁止自动恢复旧副作用',async t=>{
 const {journal,dir}=await fixture(t);await journal.checkGoal(owner);await journal.recordGoalCheck(owner,next);await journal.continueGoal(owner);
 const restored=createRunJournal({dir});await restored.recover();const root=await restored.root(owner);assert.equal(root.status,'interrupted');assert.equal(root.goal.phase,'interrupted');assert.equal(root.goal.round,2);assert.equal(root.goal.verifications[0].status,'continue');await assert.rejects(restored.continueGoal(owner),/停止/);
});
test('取消后的迟到完成校验无效，触顶总结不能把未完成变成 completed',async t=>{
 const {journal}=await fixture(t);await journal.checkGoal(owner);await journal.finishRoot(owner,'cancelled');await assert.rejects(journal.recordGoalCheck(owner,complete),/失效/);assert.equal((await journal.root(owner)).goal.phase,'cancelled');
});
test('完成判断严格校验结构、证据、剩余项和下一步',()=>{
 assert.deepEqual(parseGoalVerdict(JSON.stringify(complete)),complete);
 for(const value of ['{}','OK',JSON.stringify({...complete,evidence:[]}),JSON.stringify({...complete,remaining:['未做']}),JSON.stringify({...next,nextAction:''})])assert.throws(()=>parseGoalVerdict(value));
 assert.throws(()=>goalPolicy({maxRequests:0}));
});

const awaiting = {status:'awaiting_user',question:'文件里写什么内容？',reason:'需要用户提供文件内容',evidence:['助手已询问文件内容'],remaining:['获得内容并写入文件'],nextAction:'等待用户答复'};
test('等待用户答复独立落盘、重启保持等待；答复明确续接原目标且累计预算不清零',async t=>{
 const {journal,dir}=await fixture(t,{maxRequests:3});await request(journal,'before');await finish(journal,'before');
 await journal.checkGoal(owner);await journal.recordGoalCheck(owner,awaiting);await journal.finishRoot(owner,'awaiting_user');
 assert.equal((await journal.root(owner)).status,'awaiting_user');await assert.rejects(request(journal,'while-waiting'),/挂起/);
 await assert.rejects(journal.beginRoot(owner),/不能自行恢复/);
 const restored=createRunJournal({dir});await restored.recover();assert.equal((await restored.root(owner)).goal.phase,'awaiting_user');
 const reply={...owner,rootRunId:'reply'};await restored.beginRoot(reply);const goal=await restored.beginGoal(reply,'用户答复',goalPolicy({maxRequests:999}),{rootRunId:owner.rootRunId,inputId:'answer',answer:'写入测试内容'});
 assert.equal(goal.id,owner.rootRunId);assert.equal(goal.objective,'完成请求');assert.equal(goal.requestOffset,1);assert.equal(goal.policy.maxRequests,3);assert.equal(goal.replies[0].inputId,'answer');assert.equal((await restored.root(owner)).status,'continued');
 await request(restored,'after-1',reply);await finish(restored,'after-1');await request(restored,'after-2',reply);await finish(restored,'after-2');await assert.rejects(request(restored,'over',reply),/上限 3/);
});
test('澄清等待不能被其他会话、代次或第二次答复冒领',async t=>{
 const {journal}=await fixture(t);await journal.checkGoal(owner);await journal.recordGoalCheck(owner,awaiting);await journal.finishRoot(owner,'awaiting_user');
 for(const nextOwner of [{...owner,conversationId:'foreign',rootRunId:'foreign'},{...owner,generation:2,rootRunId:'new-generation'}]){
  await journal.beginRoot(nextOwner);await assert.rejects(journal.beginGoal(nextOwner,'answer',goalPolicy(),{rootRunId:owner.rootRunId,inputId:'answer',answer:'x'}),/已变化/);
 }
 assert.equal((await journal.root(owner)).status,'awaiting_user');
});
test('awaiting_user 必须携带实际问题、证据和未完成事项',()=>{
 assert.deepEqual(parseGoalVerdict(JSON.stringify(awaiting)),awaiting);
 for(const patch of [{question:''},{question:undefined},{evidence:[]},{remaining:[]}])assert.throws(()=>parseGoalVerdict(JSON.stringify({...awaiting,...patch})));
});
