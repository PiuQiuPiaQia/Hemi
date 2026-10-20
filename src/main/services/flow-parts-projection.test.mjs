// 057 flow-parts-projection 单测：流事件→part 事实映射（累计内容/分段/派单/失败）、
// 任务快照投影（必需字段＋预览截断）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFlowFactsBlock, createRunPartProjector, projectTaskFact } from './flow-parts-projection.mjs';

test('本轮锚点遵守排队派发与停止事实，不把后到输入默认并入当前目标', () => {
  const block = buildFlowFactsBlock({
    timeline: [{ kind: 'user', runId: 'old', text: '旧目标' }],
    runs: { old: { runId: 'old', outcome: 'stopped', stopReason: 'promote' } },
    tasks: {}, pending: [{ text: '待派发的独立请求' }],
  }, { userText: '继续', runId: 'current' });
  assert.match(block, /本轮任务以当前用户消息原文为准/);
  assert.match(block, /不主动复述本块、内部编号或标签/);
  assert.match(block, /用户明确询问诊断信息时可据实解释/);
  assert.match(block, /已停止目标 old（插队取代）：旧目标/);
  assert.match(block, /由宿主按顺序派发，不自行合并或提前处理/);
  assert.match(block, /旧目标已经停止/);
  assert.doesNotMatch(block, /默认是对这一轮的补充|显式并入|待派发的独立请求/);
});

test('事实锚点不再截断重述长用户输入，避免伪造相互矛盾的任务参数', () => {
  const userText = `在 /tmp/${'long-path-'.repeat(15)}file.txt 写入「UNIQUE_CONTENT」`;
  const block = buildFlowFactsBlock({ timeline: [], runs: {}, tasks: {} }, { userText });
  assert.match(block, /本块只记录状态，不补充或改写用户指令/);
  assert.doesNotMatch(block, /long-path|UNIQUE_CONTENT|「」/);
});

test('后续对话取得同会话实际完成的工作流文件，不把排队或失败的伪输出当交付',()=>{
  const block=buildFlowFactsBlock({timeline:[{kind:'assistant',parts:[
    {kind:'workflow-card',status:'completed',invocationId:'inv-real',outputs:{file:'/tmp/actual-report.md',__summary:'internal-summary'}},
    {kind:'workflow-card',status:'failed',outputs:{file:'/tmp/failed-file'}},
    {kind:'workflow-card',status:'queued',outputs:{file:'/tmp/queued-file'}},
  ]}],runs:{},tasks:{},pending:[]});
  assert.match(block,/inv-real/);assert.match(block,/actual-report.md/);
  assert.doesNotMatch(block,/failed-file|queued-file|internal-summary/);
});

function applyAll(startSnapshot, facts) {
  // 直接复用归约层验证投影事实可被应用（不另写影子实现）。
  // eslint-disable-next-line import/no-relative-packages
  return facts.reduce((snapshot, fact) => {
    const { applyFlowFact } = globalThis.__flow ?? {};
    return snapshot;
  }, null);
}

test('文本与思考：首段 appended、后续 updated 携带累计内容', () => {
  const projector = createRunPartProjector({ runId: 'r1' });
  const f1 = projector.handle({ kind: 'text', text: '你' });
  assert.equal(f1.length, 1);
  assert.equal(f1[0].type, 'part-appended');
  assert.equal(f1[0].part.kind, 'text');
  assert.equal(f1[0].part.content, '你');
  const f2 = projector.handle({ kind: 'text', text: '好' });
  assert.equal(f2[0].type, 'part-updated');
  assert.equal(f2[0].patch.content, '你好');
  const f3 = projector.handle({ kind: 'thinking', text: '想一想' });
  assert.equal(f3[0].part.kind, 'thinking');
  const f4 = projector.handle({ kind: 'thinking', text: '……' });
  assert.equal(f4[0].patch.content, '想一想……');
});

test('工具往返分段：工具后正文另起新 part；task 派单 → delegation part', () => {
  const projector = createRunPartProjector({ runId: 'r2' });
  projector.handle({ kind: 'text', text: '第一段' });
  const toolStart = projector.handle({ kind: 'tool_start', tool: 'bash', toolCallId: 'tc1', args: { command: 'ls' } });
  assert.equal(toolStart[0].part.kind, 'tool');
  assert.equal(toolStart[0].part.status, 'running');
  const delegation = projector.handle({ kind: 'tool_start', tool: 'task', toolCallId: 'tc2', args: { agent: 'explorer' } });
  assert.equal(delegation[0].part.kind, 'delegation');
  const toolEnd = projector.handle({ kind: 'tool_end', toolCallId: 'tc1', isError: false });
  assert.deepEqual(toolEnd[0].patch, { status: 'done' });
  const toolEndErr = projector.handle({ kind: 'tool_end', toolCallId: 'tc2', isError: true });
  assert.deepEqual(toolEndErr[0].patch, { status: 'error' });
  const after = projector.handle({ kind: 'text', text: '第二段' });
  assert.equal(after[0].type, 'part-appended', '工具后正文另起新段');
  assert.equal(after[0].part.content, '第二段');
  const endThinking = projector.handle({ kind: 'thinking_end' });
  assert.equal(endThinking.length, 0);
});

test('思考收口后正文另起 part；finish 失败补 notice、成功不加', () => {
  const projector = createRunPartProjector({ runId: 'r3' });
  projector.handle({ kind: 'thinking', text: '思考' });
  projector.handle({ kind: 'thinking_end' });
  const text = projector.handle({ kind: 'text', text: '回答' });
  assert.equal(text[0].part.kind, 'text', '思考后的正文不混进思考段');
  assert.deepEqual(projector.finish(), []);
  const notice = projector.finish({ error: new Error('模型超时') });
  assert.equal(notice.length, 1);
  assert.equal(notice[0].part.kind, 'notice');
  assert.equal(notice[0].part.level, 'error');
  assert.match(notice[0].part.text, /模型超时/);
});

test('projection 事实可被归约层应用：时间线成段、内容替换幂等', async () => {
  const { applyFlowFact, createFlowSnapshot } = await import('../../shared/conversation-flow.mjs');
  let snapshot = createFlowSnapshot({ conversationId: 'c' });
  snapshot = applyFlowFact(snapshot, { type: 'run-preparing', runId: 'r4', source: 'user', at: 1 }).snapshot;
  snapshot = applyFlowFact(snapshot, { type: 'run-started', runId: 'r4', at: 2 }).snapshot;
  const projector = createRunPartProjector({ runId: 'r4', generation: 1 });
  const events = [
    { kind: 'thinking', text: '先想' },
    { kind: 'thinking_end' },
    { kind: 'text', text: '正文开' },
    { kind: 'text', text: '头' },
    { kind: 'tool_start', tool: 'task', toolCallId: 'tc9', args: { agent: 'explorer' } },
    { kind: 'tool_end', toolCallId: 'tc9' },
    { kind: 'text', text: '汇总' },
  ];
  for (const event of events) {
    for (const fact of projector.handle(event)) snapshot = applyFlowFact(snapshot, fact).snapshot;
  }
  const assistant = snapshot.timeline.filter((e) => e.kind === 'assistant');
  assert.equal(assistant.length, 1);
  assert.deepEqual(assistant[0].parts.map((p) => p.kind), ['thinking', 'text', 'delegation', 'text']);
  assert.equal(assistant[0].parts[1].content, '正文开头');
  assert.equal(assistant[0].parts[3].content, '汇总');
  assert.equal(assistant[0].parts[2].status, 'done');
});

test('task 投影：必需字段保留、正文只留预览、无 id 返回 null', () => {
  const fact = projectTaskFact({
    taskId: 't-1', key: 'task-1', conversationId: 'c1', agent: 'explorer', agentTitle: '侦察',
    phase: 'terminal', outcome: 'complete', taskText: '核对文件', progressText: '已完成',
    runs: 2, toolCallId: 'tc7', sources: [{ title: 'a', url: 'https://a' }],
    artifacts: [{ artifactId: 'af1', path: '/tmp/x.md' }], resultText: '长'.repeat(500), resultVersion: 3,
  }, { generation: 1 });
  assert.equal(fact.type, 'task-updated');
  assert.equal(fact.generation, 1);
  assert.equal(fact.task.taskId, 't-1');
  assert.equal(fact.task.agent, 'explorer');
  assert.equal(fact.task.runs, 2);
  assert.equal(fact.task.artifacts.length, 1);
  assert.equal(fact.task.resultPreview.length, 200, '正文只留 200 字预览');
  assert.equal(fact.task.resultPreview, '长'.repeat(200));
  assert.equal(projectTaskFact({ key: null, taskId: null }), null);
});

test('060：真实并入边界切开开放段，补充之后的文本不能更新到补充之前', async () => {
  const { applyFlowFact, createFlowSnapshot } = await import('../../shared/conversation-flow.mjs');
  let state = createFlowSnapshot({ conversationId: 'c' });
  const apply = (fact) => { state = applyFlowFact(state, fact).snapshot; };
  apply({ type: 'run-preparing', runId: 'r', inputIds: ['A'], at: 1 });
  apply({ type: 'input-delivered', runId: 'r', input: { inputId: 'A', text: 'A' } });
  const projector = createRunPartProjector({ runId: 'r', inputId: 'A' });
  for (const fact of projector.handle({ kind: 'text', text: '补充前' })) apply(fact);
  projector.delivered('B');
  apply({ type: 'input-delivered', runId: 'r', input: { inputId: 'B', text: 'B' } });
  for (const fact of projector.handle({ kind: 'text', text: '补充后' })) apply(fact);
  assert.deepEqual(state.timeline.map((row) => row.kind === 'user' ? row.text : row.parts[0].content), ['A', '补充前', 'B', '补充后']);
  assert.notEqual(state.timeline[1].itemId, state.timeline[3].itemId);
});

test('060：缺失 tool_end 的取消运行收口为 stopped，不残留 running／成功勾', () => {
  const projector = createRunPartProjector({ runId: 'r' });
  projector.handle({ kind: 'tool_start', tool: 'bash', toolCallId: 'tc1' });
  const facts = projector.finish({ stopped: true });
  assert.equal(facts[0].patch.status, 'stopped');
  assert.deepEqual(projector.finish({ stopped: true }), []);
});
