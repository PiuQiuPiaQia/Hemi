import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFlowSnapshot } from '../../shared/conversation-flow.mjs';
import { recoverConversationFlow } from './conversation-recovery.mjs';

test('interrupted record cannot erase the newer child conversation from its persisted flow', () => {
  const flow = createFlowSnapshot({ conversationId: 'c' });
  const conversation = { revision: 2, messages: [{ id: 'm', author: 'hemi', text: 'partial' }] };
  flow.timeline = [{ kind: 'assistant', runId: 'r', parts: [{ kind: 'delegation', toolCallId: 'call', taskId: 't' }] }];
  flow.runs.r = { runId: 'r', closedAt: 10 };
  flow.tasks.t = { taskId: 't', rootRunId: 'r', toolCallId: 'call', phase: 'running', conversation };
  recoverConversationFlow(flow, { readTaskRecord: () => ({ taskId: 't', conversationId: 'c', rootRunId: 'r', toolCallId: 'call', interrupted: true }) });
  assert.deepEqual(flow.tasks.t.conversation, conversation);
  assert.equal(flow.tasks.t.phase, 'terminal');
});

test('旧任务终态和声明交付按保留调用恢复；幂等且不重跑、不复活撤回项', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-recover-'));
  try {
    const file = path.join(dir, '成片.mp4'); fs.writeFileSync(file, 'test video');
    const flow = createFlowSnapshot({ conversationId: 'c' });
    flow.generation = 5;
    flow.runs.r1 = { runId: 'r1', generation: 2, closedAt: 10, outcome: 'completed' };
    flow.timeline = [{ kind: 'assistant', runId: 'r1', parts: [{ kind: 'delegation', toolCallId: 'call-kept' }] }];
    flow.tasks = {
      kept: { taskId: 'kept', toolCallId: 'call-kept', phase: 'running', executions: { 'older-call': { taskId: 'kept', toolCallId: 'older-call', phase: 'running' } } },
      removed: { taskId: 'removed', toolCallId: 'call-removed', phase: 'running' },
      missing: { taskId: 'missing', phase: 'running' },
    };
    const record = { taskId: 'kept', conversationId: 'c', toolCallId: 'call-kept', outcome: 'complete', endedAt: 10,
      workspace: { dir }, resultText: '确已完成', deliverables: [{ kind: 'file', path: file, registeredAt: 8 }] };
    const readTaskRecord = id => id === 'kept' ? record : id === 'removed' ? { ...record, taskId: id, toolCallId: 'call-removed' } : null;
    const recovered = recoverConversationFlow(flow, { readTaskRecord });
    assert.equal(recovered.changed, true);
    assert.equal(flow.tasks.kept.outcome, 'complete');
    assert.equal(flow.tasks.kept.executions['older-call'].outcome, 'interrupted', '旧执行没有完成证据时只标中断');
    assert.equal(flow.tasks.missing.outcome, 'interrupted', '没有档案不能伪造完成');
    assert.equal(flow.tasks.removed.outcome, 'interrupted');
    const artifacts = Object.values(flow.artifacts);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].previewKind, 'video');
    assert.equal(artifacts[0].producers[0].taskId, 'kept');
    assert.equal(artifacts[0].producers[0].generation, 2, '恢复不得把旧生产者伪装成本代新交付');
    assert.equal(flow.timeline[0].parts.at(-1).kind, 'deliverable');
    assert.equal(recoverConversationFlow(flow, { readTaskRecord }).changed, false);
    assert.equal(Object.values(flow.artifacts).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('别的会话档案不能修成成功或导入交付，远端路径不查本机', () => {
  const flow = createFlowSnapshot({ conversationId: 'c' });
  flow.runs.r1 = { runId: 'r1', closedAt: 10 };
  flow.timeline = [{ kind: 'assistant', runId: 'r1', parts: [{ toolCallId: 'call' }] }];
  flow.tasks.t = { taskId: 't', toolCallId: 'call', phase: 'running' };
  const record = { taskId: 't', conversationId: 'other', toolCallId: 'call', outcome: 'complete', endedAt: 10, deliverables: [{ kind: 'file', path: '/home/u/movie.mp4' }], workspace: { host: 'server', dir: '/home/u' } };
  recoverConversationFlow(flow, { readTaskRecord: () => record });
  assert.equal(flow.tasks.t.outcome, 'interrupted');
  assert.equal(Object.keys(flow.artifacts).length, 0);
  record.conversationId = 'c';
  recoverConversationFlow(flow, { readTaskRecord: () => record });
  assert.equal(Object.values(flow.artifacts)[0].host, 'server');
  assert.equal(Object.values(flow.artifacts)[0].path, '/home/u/movie.mp4');
});

test('064：不同根目标复用短调用ID，恢复交付仍归原任务与原运行', () => {
  const flow=createFlowSnapshot({conversationId:'c'});
  const records={};
  for(const [index,runId] of ['r1','r2'].entries()){
    const taskId=`t${index}`;
    flow.runs[runId]={runId,closedAt:10,generation:1};
    flow.timeline.push({kind:'assistant',runId,parts:[{kind:'delegation',toolCallId:'call-0',taskId}]});
    flow.tasks[taskId]={taskId,rootRunId:runId,toolCallId:'call-0',phase:'running'};
    records[taskId]={taskId,rootRunId:runId,conversationId:'c',toolCallId:'call-0',outcome:'complete',endedAt:10,
      workspace:{host:'isolated',dir:'/work'},deliverables:[{kind:'file',path:`/work/${taskId}.md`}]};
  }
  recoverConversationFlow(flow,{readTaskRecord:id=>records[id]});
  assert.deepEqual(Object.values(flow.artifacts).map(a=>[a.producerRunId,a.taskId]),[['r1','t0'],['r2','t1']]);
  assert.equal(flow.timeline[0].parts.at(-1).name,'t0.md');
  assert.equal(flow.timeline[1].parts.at(-1).name,'t1.md');
});

test('recovered child tasks and retained executions cannot retain live activity, permissions or spinning tools', () => {
  const flow=createFlowSnapshot({conversationId:'restart'});
  flow.runs.root={runId:'root',closedAt:20,outcome:'interrupted'};
  const conversation={revision:1,messages:[{parts:[{type:'thinking',endedAt:null},{type:'tools',calls:[{id:'push',state:'running'},{id:'done',state:'done'}]}]}]};
  flow.tasks.child={taskId:'child',rootRunId:'root',phase:'running',activity:{phase:'waiting-background'},permission:{id:'p'},conversation,
    executions:{earlier:{phase:'terminal',outcome:'interrupted',activity:{phase:'running'},conversation:structuredClone(conversation)}}};
  assert.equal(recoverConversationFlow(flow).changed,true);
  const child=flow.tasks.child;assert.equal(child.phase,'terminal');assert.equal(child.outcome,'interrupted');assert.equal(child.activity,null);assert.equal(child.permission,null);
  for(const value of [child,child.executions.earlier]){
    assert.equal(value.activity,null);assert.equal(value.conversation.messages[0].parts[1].calls[0].state,'stopped');
    assert.equal(value.conversation.messages[0].parts[1].calls[1].state,'done');assert.equal(value.conversation.messages[0].parts[0].endedAt,20);
  }
  assert.equal(recoverConversationFlow(flow).changed,false);
});
