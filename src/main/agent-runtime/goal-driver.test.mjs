import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRunJournal,GOAL_VERIFICATION_PURPOSE} from './run-journal.mjs';
import {goalPolicy,parseGoalVerdict,goalRunOutcome,driveGoal} from './goal-driver.mjs';
const owner={conversationId:'goal-test',rootRunId:'root',generation:1};
const next={status:'continue',reason:'成果还缺少最后验证',evidence:['已安装依赖'],remaining:['验证成果'],nextAction:'运行剩余验证'};
const complete={status:'complete',reason:'实际结果已验证',evidence:['实际测试成功且符合请求'],remaining:[],nextAction:''};
test('PC 和 Bot 区分已完成、受阻、等待用户和已停止的共享运行结果',()=>{
 assert.equal(goalRunOutcome({goalComplete:true}),'completed');
 assert.equal(goalRunOutcome({waitingForUser:{question:'内容是什么？'}}),'awaiting-user');
 assert.equal(goalRunOutcome({aborted:true}),'stopped');
 assert.equal(goalRunOutcome(null,{cancelled:true}),'stopped');
 assert.equal(goalRunOutcome({blocked:{reason:'外部资源尚不可用'}}),'blocked');
 assert.equal(goalRunOutcome({blocked:{reason:'外部资源尚不可用'}},{cancelled:true}),'stopped');
 for(const result of [{blocked:{}},{blocked:{reason:' '}},{blocked:{reason:'资源不可用'},goalComplete:true},{blocked:{reason:'资源不可用'},budgetLimited:true},{blocked:{reason:'资源不可用'},waitingForUser:{question:'等待答复'}}])assert.throws(()=>goalRunOutcome(result),{code:'goal-incomplete'});
 for(const result of [null,{}, {budgetLimited:true,goalComplete:true}])assert.throws(()=>goalRunOutcome(result),{code:'goal-incomplete'});
});
async function fixture(t,options={}){const dir=await mkdtemp(path.join(os.tmpdir(),'hemi-goal-journal-'));t.after(()=>rm(dir,{recursive:true,force:true}));const journal=createRunJournal({dir});await journal.beginRoot(owner,{policySnapshot:{budgets:{maxRequestsPerRun:2}}});await journal.beginGoal(owner,'完成请求',goalPolicy({maxRequestsPerRound:2,...options}));return{journal,dir};}
const request=(journal,id,who=owner,purpose='main')=>journal.requestStart(who,{requestId:id,role:'main',purpose},2);
const finish=(journal,id)=>journal.requestEnd(id,{error:null});
test('blocked 正常返回结构化结果；终态保留原因、禁止旧动作，重启不复活并可接收新目标',async t=>{
 const {journal,dir}=await fixture(t),aux={...owner,rootRunId:'blocked-aux'};
 await journal.beginRoot(aux,{kind:'auxiliary',sourceRootRunId:owner.rootRunId});
 await assert.rejects(journal.finishRoot(owner,'blocked'),/缺少目标阻塞/);
 const verdict={status:'blocked',reason:'已核对外部资源仍不可用',evidence:['实际命令返回资源不可用'],remaining:['资源恢复后完成工作'],nextAction:'请恢复外部资源后继续'};
 let calls=0;
 const result=await driveGoal({journal,owner,objective:'完成请求',policy:goalPolicy(),signal:new AbortController().signal,
  run:async()=>{calls++;return{texts:['外部资源不可用'],requests:1};},verify:async()=>verdict,evidence:async()=>'',persist:async()=>{}});
 assert.equal(calls,1);assert.equal(result.goalComplete,false);assert.equal(result.budgetLimited,false);
 assert.deepEqual(result.blocked,{reason:verdict.reason,evidence:verdict.evidence,remaining:verdict.remaining,nextAction:verdict.nextAction});
 await journal.finishRoot(owner,goalRunOutcome(result));assert.equal((await journal.root(owner)).status,'blocked');assert.equal((await journal.root(owner)).reason,verdict.reason);
 await assert.rejects(request(journal,'old-action'),/已停止/);await assert.rejects(request(journal,'aux-action',aux,'title'),/所属目标已停止/);
 const restored=createRunJournal({dir});await restored.recover();const root=await restored.root(owner);
 assert.equal(root.status,'blocked');assert.equal(root.goal.phase,'blocked');assert.equal(root.goal.reason,verdict.reason);
 const nextOwner={...owner,rootRunId:'explicit-next'};await restored.beginRoot(nextOwner);await restored.beginGoal(nextOwner,'用户的新请求',goalPolicy());
});
test('主子和辅助共享每段额度；单段触顶可校验一次，持久续跑不重置总预算',async t=>{
 const {journal}=await fixture(t,{maxRequests:4});const child={...owner,taskId:'child'},aux={...owner,rootRunId:'aux'};
 await journal.beginRoot(aux,{kind:'auxiliary',sourceRootRunId:owner.rootRunId});
 await request(journal,'a',child,'subagent');await finish(journal,'a');await request(journal,'b',aux,'title');await finish(journal,'b');
 // 057 软复盘：段边界（perRound=2）不再拒绝请求，第 3 个跨段继续（R-02 子任务不等待祖先）。
 await request(journal,'over');await finish(journal,'over');
 await journal.checkGoal(owner);
 await request(journal,'verify',owner,GOAL_VERIFICATION_PURPOSE);await finish(journal,'verify');await assert.rejects(request(journal,'verify2',owner,GOAL_VERIFICATION_PURPOSE),/不可用/);
 await journal.recordGoalCheck(owner,next);const round=await journal.continueGoal(owner);assert.equal(round.requestOffset,3);assert.equal(round.round,2);
 // 硬预算（maxRequests=4）仍原子拒绝并保留触顶事实（R-07）。
 await request(journal,'c');await finish(journal,'c');await assert.rejects(request(journal,'total-over',child,'subagent'),/上限 4/);
 await journal.checkGoal(owner);await journal.recordGoalCheck(owner,next);await assert.rejects(journal.continueGoal(owner),{code:'goal-budget-limit'});
 assert.equal(Object.keys((await journal.snapshot()).requests).length,5);
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


test('答复时预算已耗尽正常返回 partial，不调用模型或重置原预算',async t=>{
 const {journal}=await fixture(t,{maxRounds:1});await journal.checkGoal(owner);await journal.recordGoalCheck(owner,awaiting);await journal.finishRoot(owner,'awaiting_user');
 const reply={...owner,rootRunId:'budget-answer'};await journal.beginRoot(reply);
 const result=await driveGoal({journal,owner:reply,objective:'用户答复',continuation:{rootRunId:owner.rootRunId,inputId:'answer',answer:'继续'},policy:goalPolicy(),signal:new AbortController().signal,
 run:async()=>assert.fail('exhausted goal must not execute'),verify:async()=>assert.fail('exhausted goal must not call verifier'),persist:async()=>{},evidence:async()=>''});
 assert.equal(result.halted.kind,'budget_limited');assert.deepEqual(result.texts,[]);assert.equal(goalRunOutcome(result),'partial');
 await journal.finishRoot(reply,'partial');assert.equal((await journal.root(reply)).goal.phase,'budget_limited');
});

test('分段检查点保留后台归属，完成门仍拒绝活动进程；重启不自动重放',async t=>{
 const {journal,dir}=await fixture(t);
 await journal.processStart({id:'live',owner,pid:99999,token:'fixture',description:'长任务'});await journal.processBackground('live');
 await request(journal,'one');await finish(journal,'one');await request(journal,'two');await finish(journal,'two');
 // 057 软复盘：段边界不再拒绝；第 3 个请求跨段继续后，在回合边界交接段事实。
 await request(journal,'cap');await finish(journal,'cap');
 const checkpoint=await journal.checkpointGoal(owner);assert.equal(checkpoint.goal.round,2);assert.equal(checkpoint.goal.requestOffset,3);assert.equal(checkpoint.work.processes[0].id,'live');
 assert.equal((await journal.snapshot()).processes.live.state,'active');await assert.rejects(journal.checkGoal(owner),/未确认/);
 await assert.rejects(journal.checkpointGoal(owner),/尚未耗尽/);
 const restored=createRunJournal({dir});await restored.recover();const root=await restored.root(owner);assert.equal(root.status,'interrupted');assert.equal(root.goal.checkpoints.length,1);
 await assert.rejects(restored.checkpointGoal(owner),/停止/);
});

test('分段触顶与续跑通知可取消、按归属隔离，子请求仍阻止完成',async t=>{
 const {journal}=await fixture(t,{maxRequests:3}),aux={...owner,rootRunId:'wait-aux'};
 await assert.rejects(journal.waitForRequestLimit({...owner,generation:2}),/归属/);
 await journal.beginRoot(aux,{kind:'auxiliary',sourceRootRunId:owner.rootRunId});
 const controller=new AbortController();const cancelled=journal.waitForRequestLimit(owner,{signal:controller.signal});controller.abort();await assert.rejects(cancelled,{name:'AbortError'});
 // 057 软复盘：段（perRound=2）内第 3 个请求跨段继续，不设置触顶标志；硬预算（maxRequests=3）拒绝时才设置。
 const guard=new AbortController();const limited=journal.waitForRequestLimit(owner,{signal:guard.signal});
 await request(journal,'one');await finish(journal,'one');await request(journal,'two',{...owner,taskId:'child'},'subagent');
 await request(journal,'edge');await finish(journal,'edge');
 await assert.rejects(request(journal,'cap'),{code:'request-limit'});assert.ok((await limited).requestLimitReached);
 // 硬预算是终局：段交接不再推进（不重置总预算），标志不再被清除。
 await assert.rejects(journal.checkpointGoal(owner),{code:'goal-budget-limit'});
 await assert.rejects(journal.checkGoal(owner),/未确认/);await finish(journal,'two');await journal.checkGoal(owner);
 guard.abort();
});
