import test from 'node:test';
import assert from 'node:assert/strict';
import {moduleUnderTest} from './compile.mjs';
import {createFlowSnapshot, applyFlowFact} from '../../../src/shared/conversation-flow.mjs';
import {createRunPartProjector} from '../../../src/main/services/flow-parts-projection.mjs';

const {projectFlowTimeline} = await moduleUnderTest('../src/core/flow-timeline-view.ts');

test('正文在消息结束时停止光标，目标校验和续跑保持同一运行，重放不恢复旧光标', () => {
  let state = createFlowSnapshot({conversationId:'lifecycle'});
  const apply = fact => {
    const result = applyFlowFact(state, fact);
    assert.equal(result.applied, true);
    state = result.snapshot;
  };
  const projector = createRunPartProjector({runId:'run', now:() => 100});
  const stream = event => projector.handle(event).forEach(apply);
  const tail = () => projectFlowTimeline(state).transcripts.at(-1);
  const activity = phase => stream({kind:'activity', activity:{phase, since:100, jobs:[], resources:[]}});
  apply({type:'run-preparing', runId:'run', at:1});
  apply({type:'run-started', runId:'run', at:2});
  stream({kind:'text', text:'第一段回答'});
  assert.equal(tail().streaming, true);
  stream({kind:'message-end'});
  assert.equal(tail().streaming, false);
  assert.equal(tail().live, true);
  assert.equal(state.phase, 'running');
  assert.deepEqual(projector.handle({kind:'message-end'}), [], '重复结束事件幂等');
  for (const phase of ['compacting','verifying','continuing','waiting-subagents','waiting-background','waiting-resource','finishing']) {
    activity(phase);
    assert.equal(tail().streaming, false, phase);
    assert.equal(state.phase, 'running', phase);
  }
  activity('running');
  assert.equal(tail().streaming, false, '阶段恢复不能重新点亮已结束的正文');
  assert.equal(projectFlowTimeline(JSON.parse(JSON.stringify(state))).transcripts.at(-1).streaming, false);
  stream({kind:'request-start'});
  stream({kind:'text', text:'续跑后的结果'});
  assert.equal(tail().streaming, true);
  assert.equal(tail().parts.at(-1).text, '续跑后的结果');
  stream({kind:'message-end'});
  apply({type:'run-closed', runId:'run', outcome:'completed', at:200});
  assert.equal(state.phase, 'idle');
  assert.equal(tail().streaming, false);
  assert.equal(tail().live, undefined);
  const late = applyFlowFact(state, {type:'run-activity', runId:'run', activity:{phase:'verifying'}});
  assert.equal(late.applied, false, '迟到的阶段事件不能复活运行');
});

test('旧快照缺少正文结束标记时，收尾阶段仍关闭光标', () => {
  const snapshot = {conversationId:'old', generation:0, timeline:[{kind:'assistant',itemId:'answer',runId:'run',parts:[{kind:'text',partId:'text',content:'已有回答'}]}], runs:{run:{activity:{phase:'verifying'}}}, tasks:{}};
  assert.equal(projectFlowTimeline(snapshot).transcripts.at(-1).streaming, false);
});
