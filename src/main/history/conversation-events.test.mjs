import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConversationStore } from './conversation-store.mjs';
import { conversationTaskSeq, conversationTurnsForTask } from './conversation-events.mjs';
import { createTaskHistory, snapshotFromRecord } from './task-history.mjs';

const snap = {
  taskId: 'task-1-durable', conversationId: 'conv-durable', seq: 1,
  taskText: '查询当前型号', phase: 'terminal', outcome: 'complete',
  startedAt: 100, endedAt: 250, log: [{ at: 100, text: '开始' }, { at: 200, text: '提交收尾' }],
  resultText: '本轮请求为 model-a', outcomeReason: null,
};

test('恢复卡片序号不受档案倒序影响；保留活卡序号，缺卡才从稳定任务身份恢复', () => {
  assert.equal(conversationTaskSeq({ taskId: 'task-7-durable' }, []), 7);
  assert.equal(conversationTaskSeq(snap, [
    { kind: 'task', taskId: snap.taskId, taskSeq: 2, taskFrozen: true },
    { kind: 'task', taskId: snap.taskId, taskSeq: 7 },
  ]), 7);
});

test('回复/任务先由宿主保存：旧全表不能抹掉，重载补写幂等，编辑仍有效', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-durable-'));
  try {
    const store = createConversationStore({ dir });
    const user = { id: 'user-1', author: 'user', text: '型号是什么', createdAt: 90 };
    store.saveSession({ id: 'conv-durable', turns: [user] });
    const reply = { id: 'reply-durable', author: 'hemi', text: '我来核查', createdAt: 110 };
    store.appendHostTurns('conv-durable', [user, reply, ...conversationTurnsForTask(snap)]);
    store.saveSession({ id: 'conv-durable', turns: [user] });
    const fresh = createConversationStore({ dir });
    fresh.appendHostTurns('conv-durable', conversationTurnsForTask(snap));
    const turns = fresh.getSession('conv-durable').turns;
    assert.equal(turns.length, 4);
    assert.equal(turns.filter((turn) => turn.kind === 'task').length, 1);
    assert.equal(turns.filter((turn) => turn.text === snap.resultText).length, 1);
    assert.equal(turns.at(-1).createdAt, 250);
    // 024 回卷（2026-10-10 仿 zcode 语义改版）：编辑重发撤下编辑点之后的全部
    // 内容——宿主已确认的回复/任务卡也被剪除键拦住，不得经任何回写路径复活。
    const rewound = fresh.getSession('conv-durable').turns.filter((turn) => turn.id === user.id);
    fresh.saveSession({
      id: 'conv-durable',
      turns: rewound.map((turn) => turn.id === user.id ? { ...turn, text: '型号是什么（改）', editedAt: 300 } : turn),
      removedTurnKeys: ['reply-durable', snap.taskId, ...turns.filter((turn) => turn.id !== user.id).map((turn) => turn.id)],
    });
    const cut = fresh.getSession('conv-durable');
    assert.deepEqual(cut.turns.map((turn) => turn.id), ['user-1']);
    assert.equal(cut.turns[0].editedAt, 300);
    assert.ok(cut.cutKeys.includes(snap.taskId));
    // 三条复活路径全部按剪除键过滤：宿主追加、restoreTaskResults 式补终态、
    // 旧视图全表回写（来件里混回被剪条目也一并丢弃）。
    assert.equal(fresh.appendHostTurns('conv-durable', [reply]).ok, true);
    fresh.appendHostTurns('conv-durable', conversationTurnsForTask({ ...snap, endedAt: 999 }));
    fresh.saveSession({ id: 'conv-durable', turns: [user, reply, ...conversationTurnsForTask(snap)] });
    assert.deepEqual(fresh.getSession('conv-durable').turns.map((turn) => turn.id), ['user-1']);
    // 撤下后再无新内容：同表保存幂等（unchanged 不写盘），标题依据仍可派生。
    const before = fresh.getSession('conv-durable');
    fresh.saveSession({ id: 'conv-durable', turns: fresh.getSession('conv-durable').turns });
    assert.equal(fresh.getSession('conv-durable').updatedAt, before.updatedAt);
    fresh.deleteSession('conv-durable');
    assert.equal(fresh.appendHostTurns('conv-durable', [reply]).ok, false);
    assert.equal(fresh.getSession('conv-durable'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('转向并入的旧卡保持冻结，终态只更新末尾活卡的位置与快照', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-frozen-'));
  try {
    const store = createConversationStore({ dir });
    const card = conversationTurnsForTask(snap)[0];
    const frozen = { ...card, taskFrozen: true, taskSnap: { ...snap, phase: 'running', outcome: null } };
    const active = { ...card, id: 'moved-active', createdAt: 280 };
    store.saveSession({ id: 'conv-durable', turns: [frozen, active] });
    store.appendHostTurns('conv-durable', conversationTurnsForTask({ ...snap, endedAt: 350 }));
    const turns = store.getSession('conv-durable').turns;
    assert.equal(turns.filter((turn) => turn.kind === 'task').length, 2);
    assert.equal(turns.find((turn) => turn.taskFrozen).taskSnap.phase, 'running');
    assert.equal(turns.find((turn) => turn.id === 'moved-active').createdAt, 280);
    assert.equal(turns.find((turn) => turn.id === 'moved-active').taskSnap.phase, 'terminal');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('旧随机 ID 的任务卡/同文结果不重复插入，缺项才恢复；未绑定任务不补写', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-recover-'));
  try {
    const store = createConversationStore({ dir });
    store.saveSession({ id: 'conv-durable', turns: [
      { ...conversationTurnsForTask(snap)[0], id: 'legacy-card' },
      { ...conversationTurnsForTask(snap)[1], id: 'legacy-result' },
    ] });
    store.appendHostTurns('conv-durable', conversationTurnsForTask(snap));
    const turns = store.getSession('conv-durable').turns;
    assert.deepEqual(turns.map((turn) => turn.id), ['legacy-card', 'legacy-result']);
    assert.deepEqual(conversationTurnsForTask({ ...snap, conversationId: null }), []);
    assert.equal(conversationTurnsForTask({ ...snap, verifying: true }).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('退出中断后重新打开：修正旧按钮提示，保留中断原因，重复恢复幂等且不自动续跑', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-interrupted-announcement-'));
  try {
    const historyDir = path.join(dir, 'tasks');
    const conversationDir = path.join(dir, 'conversations');
    const conversationId = 'conv-interrupted';
    const history = createTaskHistory({ dir: historyDir });
    const record = history.createRecord({ taskText: '字幕与成片后期', conversationId, inputSource: 'text' });
    history.startExecution(record.taskId);
    history.appendEvent(record.taskId, '开始处理字幕。');
    const conversations = createConversationStore({ dir: conversationDir });
    conversations.saveSession({ id: conversationId, turns: [
      { id: 'user-1', author: 'user', text: '开始做后期', createdAt: record.createdAt },
    ] });
    const previousResultId = `task-result:${record.taskId}:0`;
    // 复现旧版已落盘的宿主提示；修复应更新同一身份，而非追加第二条。
    conversations.appendHostTurns(conversationId, [{
      id: previousResultId, author: 'hemi', taskId: record.taskId,
      text: '任务已结束，但我没能核实结果是否成立；点任务卡上的「检查结果」。',
      createdAt: record.createdAt + 100,
    }]);
    const updatedAt = conversations.getSession(conversationId).updatedAt;

    const rebootedHistory = createTaskHistory({ dir: historyDir });
    assert.equal(rebootedHistory.recoverOnBoot().marked, 1);
    const interrupted = rebootedHistory.getRecord(record.taskId);
    assert.equal(interrupted.interrupted, true);
    assert.equal(interrupted.outcome, null, '恢复只标中断，不声称执行完成');
    assert.ok(interrupted.events.some((event) => event.text === '开始处理字幕。'));
    const recoveredSnap = snapshotFromRecord(interrupted, 1);
    assert.match(recoveredSnap.outcomeReason, /应用退出.*执行中断/);
    assert.match(recoveredSnap.progressText, /执行中断/);
    const recoveredTurns = conversationTurnsForTask(recoveredSnap);
    const recoveredConversations = createConversationStore({ dir: conversationDir });
    recoveredConversations.appendHostTurns(conversationId, recoveredTurns, { keepUpdatedAt: true });
    const first = recoveredConversations.getSession(conversationId);
    const result = first.turns.find((turn) => turn.id === previousResultId);
    assert.match(result.text, /执行中断.*尚未拿到最终结果/);
    assert.match(result.text, /直接告诉我/);
    assert.doesNotMatch(result.text, /任务卡|检查结果|任务完成/);
    assert.equal(first.turns.filter((turn) => turn.taskId === record.taskId && turn.kind !== 'task').length, 1);
    assert.equal(first.updatedAt, updatedAt);
    recoveredConversations.appendHostTurns(conversationId, recoveredTurns, { keepUpdatedAt: true });
    assert.deepEqual(recoveredConversations.getSession(conversationId), first);
    assert.equal(rebootedHistory.recoverOnBoot().marked, 0);
    assert.deepEqual(rebootedHistory.getRecord(record.taskId), interrupted, '恢复对话不产生新尝试或新执行事件');

    // 旧核实失败日志可留档，但不再合成新的失败气泡或按钮指引。
    const legacyLogTurns = conversationTurnsForTask({
      ...snap, log: [...snap.log, { at: 260, text: '核实未能完成：Connection error.' }],
    });
    assert.equal(legacyLogTurns.length, 2);
    assert.equal(legacyLogTurns[1].text, snap.resultText);
    assert.ok(legacyLogTurns.every((turn) => !turn.id.startsWith('task-verify-fail:')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bug#15：续用（runs 递增）冻结旧卡轮＋以 :r{n} 追加新轮——旧运行记录不被新状态覆盖（A-05）', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-ac39-bug15-'));
  try {
    const store = createConversationStore({ dir });
    store.saveSession({ id: 'conv-reuse', turns: [] });
    const base = { ...snap, taskId: 'task-9-reuse', conversationId: 'conv-reuse', seq: 9, resultText: null };
    // 首轮：running → terminal（同轮更新，1 条卡轮）
    store.appendHostTurns('conv-reuse', conversationTurnsForTask({ ...base, runs: 1, taskText: '列出文件名', phase: 'running' }));
    store.appendHostTurns('conv-reuse', conversationTurnsForTask({ ...base, runs: 1, taskText: '列出文件名', phase: 'terminal', outcome: 'complete', endedAt: 250 }));
    let cards = store.getSession('conv-reuse').turns.filter((t) => t.kind === 'task');
    assert.equal(cards.length, 1, '首轮同轮更新收敛为 1 条');
    assert.equal(cards[0].taskFrozen, undefined, '未续用前首轮仍是活卡');
    // 续用：runs=2 running → terminal（旧卡冻结＋新轮追加）
    store.appendHostTurns('conv-reuse', conversationTurnsForTask({ ...base, runs: 2, taskText: '补看首行', phase: 'running' }));
    cards = store.getSession('conv-reuse').turns.filter((t) => t.kind === 'task');
    assert.equal(cards.length, 2, '续用后两轮各一条卡轮');
    assert.equal(cards[0].taskFrozen, true, '旧卡轮被冻结');
    assert.equal(cards[0].taskSnap.runs, 1);
    assert.equal(cards[0].taskSnap.taskText, '列出文件名', '旧轮文本不被新轮覆盖');
    assert.equal(cards[1].taskSnap.runs, 2);
    assert.equal(cards[1].taskFrozen, undefined, '新轮是唯一活卡');
    // 同轮重复落档幂等（runs=2 terminal 再来一次）
    store.appendHostTurns('conv-reuse', conversationTurnsForTask({ ...base, runs: 2, taskText: '补看首行', phase: 'terminal', outcome: 'complete', endedAt: 400 }));
    cards = store.getSession('conv-reuse').turns.filter((t) => t.kind === 'task');
    assert.equal(cards.length, 2, '同轮重复落档不产生第三条');
    // 三次续用：第二次续用冻结 runs=2 轮，追加 runs=3
    store.appendHostTurns('conv-reuse', conversationTurnsForTask({ ...base, runs: 3, taskText: '第三轮', phase: 'running' }));
    cards = store.getSession('conv-reuse').turns.filter((t) => t.kind === 'task');
    assert.equal(cards.length, 3);
    assert.deepEqual(cards.map((t) => [t.taskSnap.runs, Boolean(t.taskFrozen)]), [[1, true], [2, true], [3, false]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
