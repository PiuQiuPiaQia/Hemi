import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlowSnapshot, applyFlowFact } from '../../shared/conversation-flow.mjs';
import { conversationStatus } from '../../shared/conversation-status.mjs';
import { createTaskFactPublisher } from './task-fact-publisher.mjs';

test('聚合广播：A 终态不会被仍在运行的 primary B 遮住；分别写回所属会话', () => {
  const controllers = new Map();
  const timers = new Map(); let seq = 0;
  for (const id of ['a', 'b']) {
    let snapshot = createFlowSnapshot({ conversationId: id });
    snapshot.timeline = [{ kind: 'assistant', runId: 'r', parts: [{ partId: 'd1', kind: 'delegation', toolCallId: `call-${id}` }] }];
    controllers.set(id, { getSnapshot: () => snapshot, applyFact: fact => { snapshot = applyFlowFact(snapshot, fact).snapshot; } });
  }
  const publisher = createTaskFactPublisher({
    flowService: { has: id => controllers.has(id), controllerFor: id => controllers.get(id) },
    schedule: fn => { const key = ++seq; timers.set(key, fn); return key; }, cancel: key => timers.delete(key),
  });
  const a = { taskId: 'ta', conversationId: 'a', toolCallId: 'call-a', phase: 'running' };
  const b = { taskId: 'tb', conversationId: 'b', toolCallId: 'call-b', phase: 'running' };
  const tick = () => { for (const fn of [...timers.values()]) fn(); };
  publisher.publish({ ...b, tasks: [a, b] }); tick();
  assert.equal(conversationStatus(controllers.get('a').getSnapshot(), { live: true }), 'running');
  publisher.publish({ ...b, tasks: [{ ...a, phase: 'terminal', outcome: 'complete', endedAt: 5 }, b] });
  assert.equal(controllers.get('a').getSnapshot().tasks.ta.outcome, 'complete');
  assert.equal(conversationStatus(controllers.get('a').getSnapshot(), { live: true }), null);
  assert.equal(conversationStatus(controllers.get('b').getSnapshot(), { live: true }), 'running');
  const rev = controllers.get('b').getSnapshot().revision;
  publisher.publish({ ...b, tasks: [{ ...a, phase: 'terminal', outcome: 'complete', endedAt: 5 }, b] }); tick();
  assert.equal(controllers.get('b').getSnapshot().revision, rev, '其他任务广播不能重复写入相同快照');
  controllers.get('a').getSnapshot().timeline = [];
  publisher.publish({ tasks: [{ ...a, phase: 'running', runs: 2 }] }); tick();
  assert.equal(controllers.get('a').getSnapshot().tasks.ta.outcome, 'complete', '撤回的调用不能被聚合快照复活');
  publisher.dispose();
});

test('同一会话的并发任务：非 primary 的终态立即冲刷，B 仍可继续更新', () => {
  let flow = createFlowSnapshot({ conversationId: 'c' });
  const controller = { getSnapshot: () => flow, applyFact: fact => { flow = applyFlowFact(flow, fact).snapshot; } };
  let tick;
  const publisher = createTaskFactPublisher({ flowService: { has: () => true, controllerFor: () => controller }, schedule: fn => { tick = fn; return 1; }, cancel: () => {} });
  const a = { taskId: 'a', conversationId: 'c', phase: 'running' }, b = { taskId: 'b', conversationId: 'c', phase: 'running' };
  publisher.publish({ ...b, tasks: [a, b] }); tick();
  publisher.publish({ ...b, tasks: [{ ...a, phase: 'terminal', outcome: 'complete' }, { ...b, progressText: '仍在执行' }] });
  assert.equal(flow.tasks.a.phase, 'terminal');
  tick(); assert.equal(flow.tasks.b.progressText, '仍在执行');
  publisher.dispose();
});


test('064：同名短调用在不同根目标内按任务身份关联，撤回后不复活', () => {
  let flow = createFlowSnapshot({ conversationId: 'c' });
  flow.runs = { r1: {runId:'r1'}, r2: {runId:'r2'} };
  flow.timeline = ['r1','r2'].map(runId => ({kind:'assistant',itemId:runId,runId,parts:[{partId:`${runId}-d`,kind:'delegation',toolCallId:'call-0'}]}));
  const controller={getSnapshot:()=>flow,applyFact:fact=>{flow=applyFlowFact(flow,fact).snapshot;}};
  const publisher=createTaskFactPublisher({flowService:{has:()=>true,controllerFor:()=>controller}});
  const tasks=['r1','r2'].map(rootRunId=>({taskId:`t-${rootRunId}`,conversationId:'c',rootRunId,toolCallId:'call-0',phase:'terminal',outcome:'complete'}));
  publisher.publish({tasks});
  assert.deepEqual(flow.timeline.map(item=>item.parts[0].taskId),['t-r1','t-r2']);
  assert.equal(Object.keys(flow.tasks).length,2);
  flow.timeline.shift();
  publisher.publish({tasks:[{...tasks[0],phase:'running'}]});
  assert.equal(flow.tasks['t-r1'].phase,'terminal');
  publisher.dispose();
});
