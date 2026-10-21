// flow-timeline-view：恢复后单一时间线投影，turns 只按身份补载荷；
// 覆盖完整历史、编辑回卷、实时续聊、任务／工具与交付。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlowTimelineProjector, projectFlowTimeline } from './flow-timeline-view.ts';
import { normalizeFlowHistory } from '../../../../../main/services/flow-bootstrap.mjs';
import { applyFlowFact } from '../../../../../shared/conversation-flow.mjs';

const snapshot = (timeline, tasks = {}) => ({
  schemaVersion: 1, conversationId: 'c', revision: 5, generation: 1, phase: 'idle',
  activeRunId: null, queuePaused: false, pending: [], timeline, runs: {}, tasks,
  artifacts: {}, permissions: {}, pendingReports: [],
});
// 旧损坏材料须先经过生产恢复归一化；renderer 不再承担整表历史兜底。
const recoveredView = (flow, turns) => projectFlowTimeline(normalizeFlowHistory(flow, turns).snapshot, turns);

test('后台/资源等待收起回应光标但仍保留活目标，恢复生成时重新显示', () => {
  const project = createFlowTimelineProjector();
  const timeline = [{ itemId: 'a', kind: 'assistant', runId: 'r', parts: [{ partId: 'p', kind: 'text', content: '等待结果。' }] }];
  for (const phase of ['waiting-background', 'waiting-resource']) {
    const flow = { ...snapshot(timeline), activeRunId: 'r', runs: { r: { activity: { phase } } } };
    const waiting = project(flow).transcripts[0];
    assert.equal(waiting.live, true);
    assert.equal(waiting.streaming, false);
    assert.equal(project({ ...flow, runs: { r: { activity: { phase: 'running' } } } }).transcripts[0].streaming, true);
  }
});

test('流式展示只跟随当前助手尾段，派单切段与并入输入后的旧行立即收走光标资格', () => {
  const project = createFlowTimelineProjector();
  const first = { itemId: 'first', kind: 'assistant', runId: 'r', parts: [
    { partId: 'p1', kind: 'text', content: '先核对。' },
  ] };
  const running = { ...snapshot([first]), activeRunId: 'r', runs: { r: { startedAt: 1 } } };
  assert.equal(project(running).transcripts[0].streaming, true);

  const delegated = { ...first, parts: [...first.parts,
    { partId: 'd', kind: 'delegation', toolCallId: 'call', status: 'running' },
  ] };
  const dispatch = project({ ...running, timeline: [delegated] }).transcripts;
  assert.equal(dispatch[0].live, true, '运行未结束，整轮复制与停止状态仍保留');
  assert.equal(dispatch[0].streaming, false, '正在派单时前面的正文不再流式展示');

  const resumed = { ...delegated, parts: [...delegated.parts,
    { partId: 'p2', kind: 'text', content: '收到结果，继续。' },
  ] };
  const rows = project({ ...running, timeline: [resumed] }).transcripts;
  assert.deepEqual(rows.filter(row => row.live && row.streaming).map(row => row.text), ['收到结果，继续。']);

  const next = { itemId: 'next', kind: 'assistant', runId: 'r', afterInputId: 'merged', parts: [
    { partId: 'p3', kind: 'text', content: '处理补充要求。' },
  ] };
  const extended = { ...running, timeline: [resumed, next] };
  const appended = project(extended).transcripts;
  assert.equal(appended[2].streaming, false, '即便旧 item 引用不变，缓存也要刷新旧尾行');
  assert.deepEqual(appended.filter(row => row.live && row.streaming).map(row => row.text), ['处理补充要求。']);
  for (const outcome of ['completed', 'stopped', 'failed']) {
    const closed = project({ ...extended, activeRunId: null, runs: { r: { startedAt: 1, closedAt: 9, outcome } } }).transcripts;
    assert.equal(closed.filter(row => row.live && row.streaming).length, 0, `${outcome} 收口后没有流式段`);
  }
});

test('编辑已载入会话第一条：新代 flow 立即替换旧代档案，回卷空窗也不复活旧分支', () => {
  const turns = [
    { id: 'old-user', author: 'user', text: '编辑前', createdAt: 1 },
    { id: 'old-answer', author: 'hemi', text: '旧回答', createdAt: 2 },
  ];
  const fresh = { ...snapshot([
    { id: 'new-user', kind: 'user', runId: 'new-run', text: '编辑后', deliveredAt: 3 },
    { itemId: 'new-answer', kind: 'assistant', runId: 'new-run', parts: [{ partId: 'new-text', kind: 'text', content: '新回答' }] },
  ]), generation: 2, runs: { 'new-run': { startedAt: 3 } } };
  const out = projectFlowTimeline(fresh, turns);
  assert.equal(out.source, 'flow');
  assert.deepEqual(out.transcripts.map(t => t.text), ['编辑后', '新回答']);
  const empty = projectFlowTimeline({ ...fresh, timeline: [], activeRunId: null }, turns);
  assert.deepEqual(empty.transcripts, [], '宿主裁剪已生效、替换输入尚未派发时不退回旧全文');
});

test('编辑后只按身份补仍在场的载荷，旧全文在任何代次都不能接管实时流', () => {
  const attachment = { attachmentId: 'kept-attachment', name: '保留资料.txt', kind: 'text' };
  const turns = [
    { id: 'keep', author: 'user', text: '保留前缀', createdAt: 1, attachments: [attachment] },
    { id: 'old', author: 'user', text: '被替换', createdAt: 2 },
  ];
  const fresh = { ...snapshot([
    { id: 'keep', kind: 'user', runId: 'keep-run', text: '保留前缀', deliveredAt: 1 },
    { id: 'new', kind: 'user', runId: 'new-run', text: '替换后的输入', deliveredAt: 3 },
  ]), generation: 3, runs: { 'keep-run': { startedAt: 1, closedAt: 2 }, 'new-run': { startedAt: 3 } } };
  const out = projectFlowTimeline(fresh, turns);
  assert.equal(out.source, 'flow');
  assert.deepEqual(out.transcripts.map(t => t.id), ['keep', 'new']);
  assert.deepEqual(out.transcripts[0].attachments, [attachment]);
  const incomplete = projectFlowTimeline({ ...fresh, generation: 1 }, turns);
  assert.equal(incomplete.source, 'flow');
  assert.deepEqual(incomplete.transcripts, out.transcripts, '完整性处理在恢复边界，静态 turns 不再盖过当前时间线');
});

const TURNS = [
  { id: 'tu1', createdAt: 10, author: 'user', text: '带附件的问题', inputSource: 'text', attachments: [{ attachmentId: 'a1', name: '报告.md', kind: 'text' }] },
  { id: 'th1', createdAt: 11, author: 'hemi', text: '先派侦察', thinking: { text: '想一想', durationMs: 800 }, usage: { modelKey: 'p/m' }, parts: [{ type: 'text', text: '先派侦察' }] },
  { id: 'tt1', createdAt: 12, author: 'hemi', kind: 'task', text: '核对文件', taskSeq: 1, taskId: 'task-1', taskSnap: { taskId: 'task-1', agent: 'explorer', phase: 'terminal', outcome: 'complete', log: ['第1步', '第2步'] } },
  { id: 'th2', createdAt: 13, author: 'hemi', text: '核对完成，结论如下' },
  { id: 'te1', createdAt: 14, author: 'hemi', kind: 'error', text: '模型超时' },
];

const TIMELINE = [
  { id: 'in-1', kind: 'user', runId: 'r1', text: '带附件的问题', inputSource: 'text', attachmentIds: ['a1'], acceptedAt: 10, deliveredAt: 10 },
  { itemId: 'i1', kind: 'assistant', runId: 'r1', afterInputId: 'in-1', parts: [{ partId: 'p1', kind: 'text', content: '先派侦察' }] },
  { itemId: 'i2', kind: 'assistant', runId: 'r1', afterInputId: null, parts: [{ partId: 'd1', kind: 'delegation', toolCallId: 'tc1', taskId: 'task-1', status: 'done' }] },
  { itemId: 'i3', kind: 'assistant', runId: 'r1', afterInputId: null, parts: [{ partId: 'p2', kind: 'text', content: '核对完成，结论如下' }] },
  { itemId: 'i4', kind: 'assistant', runId: 'r2', afterInputId: null, parts: [{ partId: 'n1', kind: 'notice', level: 'error', text: '模型超时' }] },
];

test('恢复旧档：turns 统一迁为时间线，附件／思考／用量／任务载荷仍按身份保留', () => {
  const { transcripts, leftoverTurns } = recoveredView(snapshot(TIMELINE), TURNS);
  assert.equal(leftoverTurns, 0);
  assert.deepEqual(transcripts.map((item) => item.author + (item.kind ? ':' + item.kind : '')), ['user', 'hemi', 'hemi:task', 'hemi', 'hemi:error']);
  // 用户：ID/附件取 turns（可编辑与 chips 兼容）。
  assert.equal(transcripts[0].id, 'tu1');
  assert.equal(transcripts[0].attachments[0].name, '报告.md');
  // 助手：思考/用量/parts 取 turns，ID 用 responseId。
  assert.equal(transcripts[1].id, 'th1');
  assert.equal(transcripts[1].thinking.text, '想一想');
  assert.equal(transcripts[1].usage.modelKey, 'p/m');
  // 任务卡：档案整条带走（全量快照含 log、taskSeq）。
  assert.equal(transcripts[2].id, 'tt1');
  assert.equal(transcripts[2].taskSnap.log.length, 2);
  assert.equal(transcripts[2].taskSeq, 1);
  // 错误：ID/文本取 turns。
  assert.equal(transcripts[4].id, 'te1');
});

test('纯 flow 渲染（无 turns）：字段兜底（含任务卡投影、notice→error）', () => {
  const { transcripts } = projectFlowTimeline(snapshot(TIMELINE, {
    'task-1': { taskId: 'task-1', agent: 'explorer', phase: 'terminal', outcome: 'complete', taskText: '核对文件', endedAt: 12 },
  }), []);
  assert.equal(transcripts.length, 5);
  assert.equal(transcripts[0].id, 'in-1', 'flow inputId 身份');
  assert.equal(transcripts[0].attachments, undefined);
  assert.equal(transcripts[2].kind, 'task');
  assert.equal(transcripts[2].taskSnap.agent, 'explorer');
  assert.equal(transcripts[4].kind, 'error');
  assert.equal(transcripts[4].text, '模型超时');
});

test('060 语义：局部旧档在宿主整体迁移后按原存储顺序展示，零丢失', () => {
  const short = TIMELINE.slice(0, 2); // 即便 flow 骨架只剩两项
  const { transcripts, leftoverTurns } = recoveredView(snapshot(short), TURNS);
  assert.equal(leftoverTurns, 0, '旧档直译无「未映射」概念（全量即保序）');
  assert.equal(transcripts.length, 5, '档案五条全出');
  assert.equal(transcripts.at(-1).kind, 'error');
});

test('withdrawn 的旧排队项两侧都不出现', () => {
  const turns = [...TURNS, { id: 'tu2', createdAt: 15, author: 'user', text: '撤回项', withdrawn: true }];
  const { transcripts, leftoverTurns } = projectFlowTimeline(snapshot(TIMELINE), turns);
  assert.equal(leftoverTurns, 0);
  assert.ok(!transcripts.some((item) => item.text === '撤回项'));
});

test('局部旧档整体迁移：受理语→任务卡→总结 与源档案顺序一致', () => {
  const mixed = [
    { id: 'in-1', kind: 'user', runId: 'r1', text: '去核对', inputSource: 'text', attachmentIds: [], acceptedAt: 1, deliveredAt: 1 },
    { itemId: 'i1', kind: 'assistant', runId: 'r1', afterInputId: 'in-1', parts: [
      { partId: 'p1', kind: 'text', content: '先派侦察' },
      { partId: 'd1', kind: 'delegation', toolCallId: 'tc1', taskId: 'task-m', status: 'done' },
      { partId: 'p2', kind: 'text', content: '核对完成' },
    ] },
  ];
  const turns = [
    { id: 'tu1', createdAt: 1, author: 'user', text: '去核对' },
    { id: 'th1', createdAt: 2, author: 'hemi', text: '先派侦察' },
    { id: 'tt1', createdAt: 3, author: 'hemi', kind: 'task', text: '核对文件', taskSeq: 1, taskId: 'task-m', taskSnap: { taskId: 'task-m', agent: 'explorer', log: ['x'] } },
    { id: 'th2', createdAt: 4, author: 'hemi', text: '核对完成' },
  ];
  const { transcripts, leftoverTurns } = recoveredView(snapshot(mixed), turns);
  assert.equal(leftoverTurns, 0);
  assert.deepEqual(transcripts.map((item) => item.author + (item.kind ? ':' + item.kind : '') + ':' + (item.id ?? '')), ['user:tu1', 'hemi:th1', 'hemi:task:tt1', 'hemi:th2'], '各段消费对应 turn、顺序与档案一致');
  assert.equal(transcripts[2].taskSnap.log.length, 1, '任务卡全量快照');
});


test('057 回归：delegation part 无 taskId 且档案任务轮被文本段耗掉——按 toolCallId 反查 flow.tasks 兜底出卡', () => {
  // 停止场景实录：受理语与 delegation 同项、档案把任务轮排在回复前；part 无 taskId。
  const mixed = [
    { id: 'in-1', kind: 'user', runId: 'r1', text: '逐个交付后停下', inputSource: 'text', attachmentIds: [], acceptedAt: 1, deliveredAt: 1 },
    { itemId: 'i1', kind: 'assistant', runId: 'r1', afterInputId: 'in-1', parts: [
      { partId: 'p1', kind: 'text', content: '这就派执行者' },
      { partId: 'd1', kind: 'delegation', toolCallId: 'tc9', status: 'running' },
    ] },
  ];
  const turns = [
    { id: 'tu1', createdAt: 1, author: 'user', text: '逐个交付后停下' },
    { id: 'tt1', createdAt: 2, author: 'hemi', kind: 'task', text: '逐个声明', taskSeq: 1, taskId: 'task-x', taskSnap: { taskId: 'task-x', agent: 'fixer', outcome: 'stopped' } },
    { id: 'th1', createdAt: 3, author: 'hemi', text: 'f1 已交付后停止' },
  ];
  const snap = snapshot(mixed);
  snap.tasks = { 'task-x': { taskId: 'task-x', agent: 'fixer', outcome: 'stopped', toolCallId: 'tc9', taskText: '逐个声明' } };
  const { transcripts } = projectFlowTimeline(snap, turns);
  const card = transcripts.find((item) => item.kind === 'task');
  assert.ok(card, '任务卡必须在场（兜底出卡）');
  assert.equal(card.taskId, 'task-x');
  assert.equal(card.taskSnap.agent, 'fixer');
  assert.equal(card.taskSnap.outcome, 'stopped');
});

test('057 回归：同一助手段内连续两张派单卡逐 part 各出一张（重载不丢卡）——2026-10-16 AC-35 四时点矩阵钓出', () => {
  const tasks = {
    'task-a': { taskId: 'task-a', taskText: '反序子任务一', phase: 'terminal', outcome: 'complete' },
    'task-b': { taskId: 'task-b', taskText: '反序子任务二', phase: 'terminal', outcome: 'complete' },
  };
  const timeline = [
    { id: 'in-9', kind: 'user', runId: 'r9', text: '同时派两个', inputSource: 'text', attachmentIds: [], acceptedAt: 1, deliveredAt: 1 },
    { itemId: 'i9', kind: 'assistant', runId: 'r9', afterInputId: 'in-9', parts: [
      { partId: 'da', kind: 'delegation', toolCallId: 'tca', taskId: 'task-a', status: 'done' },
      { partId: 'db', kind: 'delegation', toolCallId: 'tcb', taskId: 'task-b', status: 'done' },
    ] },
  ];
  // 纯 flow 渲染（无 turns）：两张卡都在、顺序＝派单顺序。
  const pure = projectFlowTimeline(snapshot(timeline, tasks), []);
  const pureCards = pure.transcripts.filter((t) => t.kind === 'task');
  assert.equal(pureCards.length, 2, '连续 delegation 不折叠成一张');
  assert.deepEqual(pureCards.map((t) => t.taskId), ['task-a', 'task-b']);
  assert.equal(pure.leftoverTurns, 0);
  // turns 供载荷：两张任务轮各归其位（不串卡、不剩 leftover）。
  const turns = [
    { id: 'tu9', createdAt: 1, author: 'user', text: '同时派两个' },
    { id: 'tta', createdAt: 2, author: 'hemi', kind: 'task', text: '反序子任务一', taskId: 'task-a', taskSnap: tasks['task-a'] },
    { id: 'ttb', createdAt: 3, author: 'hemi', kind: 'task', text: '反序子任务二', taskId: 'task-b', taskSnap: tasks['task-b'] },
  ];
  const zipped = recoveredView(snapshot(timeline, tasks), turns);
  const zippedCards = zipped.transcripts.filter((t) => t.kind === 'task');
  assert.equal(zippedCards.length, 2);
  assert.deepEqual(zippedCards.map((t) => t.id), ['tta', 'ttb']);
  assert.equal(zipped.leftoverTurns, 0);
});

// ---------------------------------------------------------------- 060 S2：身份投影回归（REG-060 形状）
// 旧实现 `nextUserTurn(text)` 按文本向后扫描：跳过不匹配用户项（丢消息）、同文取先遇到的
// （身份错配）、`nextHemiTurn(wantTask)` 按类型消费（子报告错接为某轮答复）。

const RUN = (id, inputIds) => ({ runId: id, generation: 1, source: 'user', inputIds, startedAt: 1, endedAt: 2, closedAt: 3, outcome: 'completed' });
const SEQ = (id, text) => ({ id, createdAt: 1, author: 'user', text, inputSource: 'text' });

test('060-T2 旧档缺口（REG-060 形状）：flow 缺项不丢消息、同文「1」身份不串、子报告不冒充澄清答复', () => {
  // turns：13 条档案轮（含更早的一条同文「1」与完整天气链）。
  const turns = [
    SEQ('in-1-old', '1'),
    { id: 'a-old', createdAt: 1, author: 'hemi', text: '（更早那条 1 的答复）', parts: [{ type: 'text', text: '（更早那条 1 的答复）' }] },
    SEQ('in-weather', '明天天气如何'),
    { id: 'a-weather-1', createdAt: 1, author: 'hemi', text: '我去查天气。', parts: [{ type: 'text', text: '我去查天气。' }] },
    { createdAt: 1, author: 'hemi', kind: 'task', text: '查询明天天气', taskId: 'task-w', taskSnap: { taskId: 'task-w', toolCallId: 'tc-w', phase: 'terminal', outcome: 'complete', taskText: '查询明天天气' } },
    { id: 'task-result:task-w:1', createdAt: 1, author: 'hemi', taskId: 'task-w', text: '## 天气报告（子任务）' },
    SEQ('in-tj', '看看天津的'),
    SEQ('in-gt', '还有高铁票'),
    SEQ('in-1a', '1'),
    { id: 'a-1a', createdAt: 1, author: 'hemi', text: '「1」是指第一条候选，我来澄清天气为天津口径。', parts: [{ type: 'text', text: '「1」是指第一条候选，我来澄清天气为天津口径。' }] },
    SEQ('in-hh', '和火车'),
    { createdAt: 1, author: 'hemi', text: '（和火车的答复段）', parts: [{ type: 'text', text: '（和火车的答复段）' }] },
  ];
  // flow：仅有天气链与「1」的澄清段（天津/高铁/火车/任务卡在 flow 中缺失——060 复现形状）。
  const timeline = [
    { id: 'in-1-old', kind: 'user', runId: 'r0', text: '1', inputSource: 'text', attachmentIds: [], acceptedAt: 1, deliveredAt: 1 },
    { itemId: 'r0-a', kind: 'assistant', runId: 'r0', afterInputId: 'in-1-old', parts: [{ partId: 'p-old', kind: 'text', content: '（更早那条 1 的答复）' }] },
    { id: 'in-weather', kind: 'user', runId: 'r1', text: '明天天气如何', inputSource: 'text', attachmentIds: [], acceptedAt: 1, deliveredAt: 1 },
    { itemId: 'r1-a', kind: 'assistant', runId: 'r1', afterInputId: 'in-weather', parts: [{ partId: 'p-w', kind: 'text', content: '我去查天气。' }] },
    { id: 'in-1a', kind: 'user', runId: 'r9', text: '1', inputSource: 'text', attachmentIds: [], acceptedAt: 1, deliveredAt: 1 },
    { itemId: 'r9-a', kind: 'assistant', runId: 'r9', afterInputId: 'in-1a', parts: [{ partId: 'p-1a', kind: 'text', content: '「1」是指第一条候选，我来澄清天气为天津口径。' }] },
    { id: 'in-hh', kind: 'user', runId: 'r10', text: '和火车', inputSource: 'text', attachmentIds: [], acceptedAt: 1, deliveredAt: 1 },
    { itemId: 'r10-a', kind: 'assistant', runId: 'r10', afterInputId: 'in-hh', parts: [{ partId: 'p-hh', kind: 'text', content: '（和火车的答复段）' }] },
  ];
  const runs = { r0: RUN('r0'), r1: RUN('r1'), r9: RUN('r9'), r10: RUN('r10') };
  const out = recoveredView({ ...snapshot(timeline, {}), runs }, turns);
  const texts = out.transcripts.map((t) => t.text);
  // ① 不丢消息：13 条档案项全部在场（含 flow 缺的天津/高铁/任务卡/报告/火车）。
  assert.ok(texts.includes('看看天津的'), '天津输入不丢');
  assert.ok(texts.includes('还有高铁票'), '高铁输入不丢');
  assert.ok(texts.includes('和火车'), '火车输入不丢');
  assert.ok(out.transcripts.some((t) => t.kind === 'task' && t.taskId === 'task-w'), '任务卡不丢');
  assert.ok(texts.includes('## 天气报告（子任务）'), '子报告保留（不静默丢）');
  // ② 同文「1」身份不串：「1」的用户项 id 必须是 flow 的 in-1a（不是更早的 in-1-old）。
  const lastOne = [...out.transcripts].reverse().find((t) => t.author === 'user' && t.text === '1');
  assert.equal(lastOne?.id, 'in-1a', '同文按身份配对，不取先遇到的');
  const oldOne = out.transcripts.find((t) => t.author === 'user' && t.text === '1');
  assert.equal(oldOne?.id, 'in-1-old', '更早的同文保留自身身份');
  // ③ 子报告不冒充澄清答复：in-1a 之后紧随的助手文本是该轮澄清，不是天气报告。
  const idxOne = out.transcripts.findIndex((t) => t.author === 'user' && t.id === 'in-1a');
  const nextHemi = out.transcripts.slice(idxOne + 1).find((t) => t.author !== 'user');
  assert.match(String(nextHemi?.text ?? ''), /澄清天气为天津口径/, '「1」的答复是澄清段（不是子报告）');
  // ④ 全部源项已经进入同一时间线，不再靠未映射兜底展示第二份列表。
  assert.equal(out.source, 'flow');
  assert.equal(out.transcripts.length, turns.length);
  assert.equal(out.leftoverTurns, 0);
});

test('恢复后续聊沿同一时间线更新，静态历史载荷不冻结用户项／流式正文', () => {
  const turns = [{ id: 'old', author: 'user', text: '旧输入' }, { id: 'old-answer', author: 'hemi', text: '旧回答' }];
  let current = normalizeFlowHistory(snapshot([]), turns).snapshot;
  current = applyFlowFact(current, { type: 'run-preparing', runId: 'live', inputIds: ['fresh'], source: 'user', at: 1 }).snapshot;
  current = applyFlowFact(current, { type: 'input-delivered', runId: 'live', input: { inputId: 'fresh', text: '新消息' }, at: 2 }).snapshot;
  current = applyFlowFact(current, { type: 'part-appended', runId: 'live', afterInputId: 'fresh', part: { partId: 'text', kind: 'text', content: '流式回答' } }).snapshot;
  const rows = projectFlowTimeline(current, turns).transcripts;
  assert.deepEqual(rows.map(row => row.text), ['旧输入', '旧回答', '新消息', '流式回答']);
  assert.equal(rows.at(-1).live, true);
});

test('060-T3 同文双输入（两条「1」各自身份）：不按文本去重、不互相消费', () => {
  const turns = [SEQ('in-1a', '1'), SEQ('in-1b', '1')];
  const timeline = [
    { id: 'in-1a', kind: 'user', runId: 'r1', text: '1', inputSource: 'text', attachmentIds: [], acceptedAt: 1, deliveredAt: 1 },
    { itemId: 'r1-a', kind: 'assistant', runId: 'r1', afterInputId: 'in-1a', parts: [{ partId: 'p1', kind: 'text', content: '答复A' }] },
    { id: 'in-1b', kind: 'user', runId: 'r2', text: '1', inputSource: 'text', attachmentIds: [], acceptedAt: 2, deliveredAt: 2 },
    { itemId: 'r2-a', kind: 'assistant', runId: 'r2', afterInputId: 'in-1b', parts: [{ partId: 'p2', kind: 'text', content: '答复B' }] },
  ];
  const runs = { r1: RUN('r1'), r2: RUN('r2') };
  const out = projectFlowTimeline({ ...snapshot(timeline, {}), runs }, turns);
  const users = out.transcripts.filter((t) => t.author === 'user');
  assert.deepEqual(users.map((t) => t.id), ['in-1a', 'in-1b'], '两条同文各自身份、各一次');
  assert.equal(out.transcripts.filter((t) => t.author !== 'user').length, 2, '两个答复段都在');
  assert.equal(out.leftoverTurns, 0, '新档无未映射');
});

test('060 REG-060-02：真实保存的用户和 reply turns 同时存在，实时与重载始终六项', () => {
  const timeline = [], turns = [], runs = {};
  for (let n = 1; n <= 3; n++) {
    timeline.push({ kind: 'user', id: `in-${n}`, runId: `r${n}`, text: `问题${n}`, inputSource: 'text', deliveredAt: 1 });
    timeline.push({ kind: 'assistant', itemId: `a${n}`, runId: `r${n}`, parts: [{ partId: `p${n}`, kind: 'text', content: `回答${n}` }] });
    turns.push(SEQ(`in-${n}`, `问题${n}`), { id: `reply-${n}`, runId: `r${n}`, author: 'hemi', text: `回答${n}` });
    runs[`r${n}`] = RUN(`r${n}`, [`in-${n}`]);
  }
  const live = projectFlowTimeline({ ...snapshot(timeline), runs }, []);
  const restored = projectFlowTimeline({ ...snapshot(timeline), runs }, turns);
  assert.equal(restored.transcripts.length, 6);
  assert.deepEqual(restored.transcripts, live.transcripts);
  assert.equal(new Set(restored.transcripts.map((row) => row.id)).size, 6);
});

test('060：纯工具／思考段也实时显示，收口保持同一行身份；历史卡不被续用覆盖', () => {
  const run = { ...RUN('r1', ['in-1']), closedAt: null };
  const user = { kind: 'user', id: 'in-1', runId: 'r1', text: '慢工具', inputSource: 'text' };
  const waiting = projectFlowTimeline({ ...snapshot([user]), runs: { r1: run }, activeRunId: 'r1' });
  const timeline = [user, { kind: 'assistant', itemId: 'r1:a:in-1', runId: 'r1', parts: [{ partId: 't1', kind: 'tool', tool: 'bash', toolCallId: 'tc1', status: 'running' }] }];
  const live = projectFlowTimeline({ ...snapshot(timeline), runs: { r1: run }, activeRunId: 'r1' });
  assert.equal(live.transcripts.length, 2);
  assert.equal(live.transcripts[1].id, waiting.transcripts[1].id);
  assert.equal(live.transcripts[1].parts[0].calls[0].state, 'running');
  const done = projectFlowTimeline({ ...snapshot(timeline), runs: { r1: { ...run, closedAt: 9 } } });
  assert.equal(done.transcripts[1].id, live.transcripts[1].id);
  const tasks = { t: { taskId: 't', toolCallId: 'new', runs: 2, phase: 'running', executions: { old: { taskId: 't', toolCallId: 'old', runs: 1, phase: 'terminal', outcome: 'complete' } } } };
  const cards = [{ kind: 'assistant', itemId: 'cards', runId: 'r1', parts: [{ partId: 'd1', kind: 'delegation', toolCallId: 'old' }, { partId: 'd2', kind: 'delegation', toolCallId: 'new' }] }];
  const rows = projectFlowTimeline({ ...snapshot(cards, tasks), runs: { r1: RUN('r1') } }).transcripts;
  assert.equal(rows[0].taskSnap.runs, 1);
  assert.equal(rows[0].taskSnap.outcome, 'complete');
  assert.equal(rows[1].taskSnap.runs, 2);
});

test('062：交付文件 part 投影为紧凑入口，同文件跨运行只留第一个', () => {
  const user1 = { kind: 'user', id: 'in-1', runId: 'r1', text: '画一张图', inputSource: 'text' };
  const user2 = { kind: 'user', id: 'in-2', runId: 'r2', text: '再改改', inputSource: 'text' };
  const timeline = [
    user1,
    { kind: 'assistant', itemId: 'r1:a:in-1', runId: 'r1', parts: [
      { partId: 't1', kind: 'text', content: '做好了' },
      { partId: 'dl-1', kind: 'deliverable', artifactId: 'd-x', name: '图.svg' },
    ] },
    user2,
    { kind: 'assistant', itemId: 'r2:a:in-2', runId: 'r2', parts: [
      // 第二轮更新同一文件：登记内容版本，不再复制第二个入口。
      { partId: 'dl-2', kind: 'deliverable', artifactId: 'd-x', name: '图.svg' },
      { partId: 'dl-3', kind: 'deliverable', artifactId: 'd-y', name: '表.md' },
    ] },
  ];
  const rows = projectFlowTimeline(snapshot(timeline)).transcripts;
  const chips = rows.flatMap((row) => (row.parts ?? []).filter((part) => part.type === 'file-delivery'));
  assert.equal(chips.length, 2);
  assert.deepEqual(chips.map((chip) => chip.artifactId), ['d-x', 'd-y']);
  assert.equal(chips[0].name, '图.svg');
  // 入口出现在所属运行的助手条目里（第一轮），不是全堆到末尾。
  assert.ok(rows[1].parts.some((part) => part.type === 'file-delivery' && part.artifactId === 'd-x'));
});


test('064：相同短 toolCallId 的任务按 part.taskId 关联，失败派单及已关闭缺档不再转圈', () => {
  const timeline=['r1','r2','r3','r4'].map((runId,index)=>({kind:'assistant',itemId:runId,runId,parts:[{
    partId:`${runId}-d`,kind:'delegation',toolCallId:'call-0',status:index===2?'error':'done',
    ...(index<2?{taskId:`t-${runId}`}:{})
  }]}));
  const tasks={
    't-r1':{taskId:'t-r1',rootRunId:'r1',toolCallId:'call-0',phase:'terminal',outcome:'complete',taskText:'第一个'},
    't-r2':{taskId:'t-r2',rootRunId:'r2',toolCallId:'call-0',phase:'terminal',outcome:'failed',taskText:'第二个'},
  };
  const runs=Object.fromEntries(['r1','r2','r3','r4'].map(runId=>[runId,{...RUN(runId),closedAt:9}]));
  const rows=projectFlowTimeline({...snapshot(timeline,tasks),runs}).transcripts;
  assert.equal(rows[0].taskSnap.outcome,'complete');
  assert.equal(rows[1].taskSnap.outcome,'failed');
  assert.equal(rows[2].taskSnap.outcome,'startfailed');
  assert.equal(rows[3].taskSnap.outcome,'unknown');
  assert.ok(rows.every(row=>row.taskSnap.phase==='terminal'));
});

test('067 投影只重算变化项，后台任务／正文分片不使未变历史换引用', async () => {
  const { createFlowTimelineProjector } = await import('./flow-timeline-view.ts');
  const project = createFlowTimelineProjector();
  const u = { id: 'u', kind: 'user', runId: 'r', text: '输入', inputSource: 'text' };
  const a = { itemId: 'a', kind: 'assistant', runId: 'r', parts: [{ partId: 'p', kind: 'text', content: '原文' }] };
  const f = { ...snapshot([u, a]), runs: { r: { startedAt: 1, closedAt: 2 } } };
  const first = project(f).transcripts;
  const unrelated = project({ ...f, tasks: { other: { taskId: 'other', phase: 'running' } }, revision: 6 }).transcripts;
  assert.equal(unrelated[0], first[0]); assert.equal(unrelated[1], first[1]);
  const changed = project({ ...f, timeline: [u, { ...a, parts: [{ ...a.parts[0], content: '新正文' }] }] }).transcripts;
  assert.equal(changed[0], first[0]); assert.notEqual(changed[1], first[1]); assert.equal(changed[1].text, '新正文');
  const rewound = project({ ...f, generation: 2, timeline: [u] }).transcripts;
  assert.deepEqual(rewound.map(t => t.id), ['u']); assert.notEqual(rewound[0], first[0]);
  const restored = project({ ...f, conversationId: 'other' }).transcripts;
  assert.notEqual(restored[0], first[0]);
});

test('067 缓存命中也参与交付去重，删除前一个入口后后一个必须恢复', async () => {
  const { createFlowTimelineProjector } = await import('./flow-timeline-view.ts');
  const project = createFlowTimelineProjector();
  const one = { itemId: 'one', kind: 'assistant', runId: 'r', parts: [{ partId: 'd1', kind: 'deliverable', artifactId: 'file', name: 'a.txt' }] };
  const two = { itemId: 'two', kind: 'assistant', runId: 'r', parts: [{ partId: 'd2', kind: 'deliverable', artifactId: 'file', name: 'a.txt' }] };
  const f = { ...snapshot([one, two]), runs: { r: { closedAt: 2 } } };
  assert.deepEqual(project(f).transcripts.map(t => t.id), ['one']);
  assert.deepEqual(project({ ...f, revision: 6 }).transcripts.map(t => t.id), ['one']);
  assert.deepEqual(project({ ...f, timeline: [two] }).transcripts.map(t => t.id), ['two']);
});
