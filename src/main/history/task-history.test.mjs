// 009 任务历史单测：原子写、受理闸、损坏容忍、中断补标、容量裁剪、删除。
// 全部走注入目录（mkdtemp），不触 userData。
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_RECORDS,
  buildRecordView,
  emptyRecord,
  excerptContext,
  isTerminalOutcome,
  newTaskId,
  snapshotFromRecord,
  createTaskHistory,
} from './task-history.mjs';

function makeStore(dir, extra = {}) {
  return createTaskHistory({ dir, ...extra });
}

test('newTaskId/isTerminalOutcome/excerptContext 基本语义', () => {
  const id = newTaskId(3, 1758100000000);
  assert.match(id, /^task-3-[a-z0-9]+$/);
  assert.notEqual(newTaskId(3, 1758100000001), id);
  assert.equal(isTerminalOutcome('complete'), true);
  assert.equal(isTerminalOutcome(null), false);
  assert.equal(excerptContext(''), '');
  const long = excerptContext('字'.repeat(3000), 2000);
  assert.ok(long.includes('原文 3000 字'));
});

test('createRecord：受理闸——建档失败（目录不可写）直接抛', () => {
  const blocked = path.join(os.tmpdir(), `hemi-hist-blocked-${process.pid}`);
  writeFileSync(blocked, '占用文件挡住目录位置');
  try {
    const store = createTaskHistory({ dir: blocked });
    assert.throws(() => store.createRecord({ taskText: '做任务' }), /ENOTDIR|EEXIST|not a directory/i);
  } finally {
    rmSync(blocked, { force: true });
  }
});

test('生命周期：建档 → 事件 → 转向 → 终态（报告原文与回炉句分开存）', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-hist-'));
  try {
    const store = makeStore(dir);
    const record = store.createRecord({ taskText: '整理下载目录', context: '工作对象封装' });
    assert.ok(record.taskId.startsWith('task-'));
    assert.equal(record.pendingOnly, false);

    store.appendEvent(record.taskId, '正在移动图片');
    store.recordSteer(record.taskId, { text: '顺便删掉空文件夹', accepted: 'steered' });
    store.finishRecord(record.taskId, {
      outcome: 'complete',
      resultText: '整理好了，共 20 张。',
      report: '完整报告原文超过六百字。'.repeat(60),
    });

    const loaded = store.getRecord(record.taskId);
    assert.equal(loaded.events.some((event) => event.text === '正在移动图片'), true);
    assert.equal(loaded.steers.length, 1);
    assert.equal(loaded.steeredCount, 1);
    assert.equal(loaded.outcome, 'complete');
    assert.ok(loaded.report.length > 600); // AC-07：完整报告，不是 600 字回炉句
    assert.equal(loaded.resultText, '整理好了，共 20 张。');
    assert.equal(loaded.contextExcerpt, '工作对象封装');
    assert.ok(loaded.endedAt >= loaded.createdAt);

    // 原子写无残留临时文件。
    assert.ok(!readdirSync(dir).some((name) => name.includes('.tmp-')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('排队未执行：pendingOnly 记录保留，起跑复用同一 taskId', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-hist-'));
  try {
    const store = makeStore(dir);
    const queued = store.createRecord({ taskText: '排队中的指令', pendingOnly: true });
    assert.equal(queued.pendingOnly, true);
    assert.equal(store.getRecord(queued.taskId).outcome, null);

    store.startExecution(queued.taskId);
    const started = store.getRecord(queued.taskId);
    assert.equal(started.pendingOnly, false);
    assert.ok(started.startedAt);
    assert.equal(started.taskId, queued.taskId); // D-5：寻址不漂
    assert.ok(started.events.some((event) => event.text === '任务开始执行。'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recoverOnBoot：无终态补标 interrupted；stopped 保持；pendingOnly 保留不启动', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-hist-'));
  try {
    const store = makeStore(dir);
    const running = store.createRecord({ taskText: '跑到一半退出' });
    const stopped = store.createRecord({ taskText: '主动停止' });
    store.finishRecord(stopped.taskId, { outcome: 'stopped', resultText: '任务已停止。' });
    const pending = store.createRecord({ taskText: '排队时退出', pendingOnly: true });
    // 换新实例模拟重启（缓存清空）。
    const rebooted = makeStore(dir);
    rebooted.recoverOnBoot();
    const viewed = rebooted.listTasks().tasks;
    const runningView = viewed.find((view) => view.taskId === running.taskId);
    assert.equal(runningView.interrupted, true);
    assert.equal(runningView.outcome, null);
    assert.equal(viewed.find((view) => view.taskId === stopped.taskId).interrupted, false);
    const pendingView = viewed.find((view) => view.taskId === pending.taskId);
    assert.equal(pendingView.pendingOnly, true, '排队记录保留未执行，不静默启动');
    assert.equal(pendingView.interrupted, false);
    // 档案里的事件可读（AC-02 的「最后已知事实」）。
    const detail = rebooted.getRecord(running.taskId);
    assert.ok(detail.events.some((event) => event.text.includes('执行中断')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recoverOnBoot 幂等：已补标记录不再重复追加中断事件（2026-09-30 审计）', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-hist-'));
  try {
    const store = makeStore(dir);
    const running = store.createRecord({ taskText: '跑到一半退出' });
    // 模拟连续多天重启：第一次补标，其后每次启动都应跳过。
    const outcomes = [];
    const eventCounts = [];
    for (let boot = 0; boot < 3; boot += 1) {
      const rebooted = makeStore(dir);
      outcomes.push(rebooted.recoverOnBoot().marked);
      eventCounts.push(
        rebooted.getRecord(running.taskId).events.filter((event) => event.text.includes('执行中断')).length,
      );
    }
    assert.deepEqual(outcomes, [1, 0, 0], '只有首次启动补标，其后不重复');
    assert.deepEqual(eventCounts, [1, 1, 1], '中断事件只追加一条，不随重启累积');
    // startAttempt 清掉 interrupted 后再次被打断，补标恢复生效。
    const resumed = makeStore(dir);
    resumed.startAttempt(running.taskId);
    assert.equal(resumed.getRecord(running.taskId).interrupted, false);
    const reInterrupted = makeStore(dir);
    assert.equal(reInterrupted.recoverOnBoot().marked, 1);
    assert.equal(reInterrupted.getRecord(running.taskId).interrupted, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('损坏容忍：坏文件呈现为 corrupt 条目，其余历史仍可读、可删', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-hist-'));
  try {
    const store = makeStore(dir);
    const good = store.createRecord({ taskText: '好记录' });
    store.finishRecord(good.taskId, { outcome: 'complete', resultText: '完成' });
    writeFileSync(path.join(dir, 'task-999-broken.json'), '{ not json');
    const list = store.listTasks();
    assert.equal(list.tasks.length, 2);
    const broken = list.tasks.find((view) => view.corrupt);
    assert.ok(broken, '损坏条目可见');
    assert.equal(broken.taskId, 'task-999-broken');
    assert.equal(list.tasks.find((view) => view.taskId === good.taskId).outcome, 'complete');
    // 损坏记录可删；删前删后状态都要对。
    assert.equal(store.getRecord('task-999-broken')?.corrupt, true);
    assert.equal(store.deleteTask('task-999-broken'), true);
    assert.equal(store.listTasks().tasks.length, 1);
    assert.equal(store.getRecord('task-999-broken'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('容量裁剪：超过 maxRecords 时移除最旧', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-hist-'));
  try {
    const store = makeStore(dir, { maxRecords: 3 });
    const ids = [];
    for (let i = 0; i < 5; i += 1) {
      const record = store.createRecord({ taskText: `任务${i}` });
      // createdAt 可能同毫秒：手工拉开时间保证排序稳定。
      record.createdAt -= (5 - i) * 1000;
      store.finishRecord(record.taskId, { outcome: 'complete', resultText: 'done' });
      ids.push(record.taskId);
    }
    // 裁剪发生在启动恢复扫描（D-6）；这里的记录全是终态，只会裁剪不会补标。
    store.recoverOnBoot();
    const remaining = store.listTasks().tasks.map((view) => view.taskId);
    assert.equal(remaining.length, 3);
    assert.equal(remaining.includes(ids[0]), false);
    assert.equal(remaining.includes(ids[4]), true);
    assert.ok(!existsSync(path.join(dir, `${ids[0]}.json`)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listTasks/storageError：非法 ID 与视图纯函数', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-hist-'));
  try {
    const store = makeStore(dir);
    assert.throws(() => store.getRecord('../escape'), /非法任务 ID/);
    const record = emptyRecord({ taskId: newTaskId(1), taskText: 'x' });
    const view = buildRecordView(record);
    assert.deepEqual(
      Object.keys(view).sort(),
      ['conversationId', 'createdAt', 'endedAt', 'hasBody', 'hasDelivery', 'hasReport', 'inputSource', 'interrupted', 'outcome', 'outcomeReason', 'pendingOnly', 'runs', 'startedAt', 'steeredCount', 'taskId', 'taskText', 'updatedAt', 'workspace'].sort(),
    );
    assert.equal(store.listTasks().storageError, null);
    assert.equal(MAX_RECORDS, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('读写往返：落盘内容可直接 JSON 解析（人可查档）', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-hist-'));
  try {
    const store = makeStore(dir);
    const record = store.createRecord({ taskText: '查档任务' });
    const raw = JSON.parse(readFileSync(path.join(dir, `${record.taskId}.json`), 'utf8'));
    assert.equal(raw.taskText, '查档任务');
    assert.equal(raw.version, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('011 startAttempt：attempts 记录 + 清 interrupted + 事件留痕', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-hist-'));
  try {
    const store = makeStore(dir);
    const record = store.createRecord({ taskText: '中断任务' });
    store.recoverOnBoot();
    assert.equal(store.getRecord(record.taskId).interrupted, true);
    store.startAttempt(record.taskId);
    const after = store.getRecord(record.taskId);
    assert.equal(after.interrupted, false);
    assert.equal(after.attempts.length, 1);
    assert.equal(after.attempts[0].kind, 'resume');
    assert.ok(after.events.some((event) => event.text.includes('第 1 次尝试')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('012 appendDeliverable：登记/去重/入档', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-hist-'));
  try {
    const store = makeStore(dir);
    const record = store.createRecord({ taskText: '做产物' });
    const artifact = { id: 'art-1', kind: 'file', path: '/tmp/a.md', name: 'a.md' };
    assert.equal(store.appendDeliverable(record.taskId, artifact), true);
    assert.equal(store.appendDeliverable(record.taskId, { ...artifact, id: 'art-2' }), true); // 同 path 去重
    assert.equal(store.appendDeliverable(record.taskId, { id: 'art-3', kind: 'link', url: 'https://x' }), true);
    const stored = store.getRecord(record.taskId);
    assert.equal(stored.deliverables.length, 2);
    assert.equal(stored.deliverables[0].registeredAt > 0, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 017：snapshotFromRecord（会话存档修复的快照重建） ----

test('snapshotFromRecord：全量事件（截 200）、核验、产物、阶段行', () => {
  const events = Array.from({ length: 260 }, (_, i) => ({ at: 1000 + i, text: `步骤 ${i + 1}` }));
  events.unshift({ at: 999, text: '任务开始。' });
  events.push({ at: 5000, text: '阶段成果：已查到数据' });
  const record = {
    taskId: 'task-2-abc',
    taskText: '查数据',
    outcome: 'complete',
    resultText: '查到了。',
    outcomeReason: null,
    steeredCount: 1,
    updatedAt: 6000,
    events,
    verifications: [{ verdict: 'complete', evidence: ['证据 1'], unchecked: ['未确认 1'], at: 5500 }],
    deliverables: [
      { id: 'art-1', kind: 'file', path: '/tmp/a.txt', name: 'a.txt', registeredAt: 4000 },
      { id: 'art-2', kind: 'link', url: 'https://example.com', name: 'example.com', registeredAt: 4100 },
    ],
  };

  const snap = snapshotFromRecord(record, 7);
  assert.equal(snap.seq, 7);
  assert.equal(snap.taskId, 'task-2-abc');
  assert.equal(snap.phase, 'terminal');
  assert.equal(snap.outcome, 'complete');
  assert.equal(snap.progressText, '查到了。');
  assert.equal(snap.verified, true);
  assert.equal(snap.stageText, '已查到数据');
  assert.equal(snap.steeredCount, 1);
  assert.equal(snap.log.length, 200); // 全量截尾
  assert.equal(snap.log[0].text, '步骤 62'); // 保留的是最后 200 条
  assert.equal(snap.log.at(-1).text, '阶段成果：已查到数据');
  assert.deepEqual(snap.verification, { verdict: 'complete', evidence: ['证据 1'], unchecked: ['未确认 1'], at: 5500 });
  assert.deepEqual(snap.artifacts.map((a) => a.kind), ['file', 'link']);
  assert.equal(snap.artifacts[0].path, '/tmp/a.txt');
  assert.equal(snap.artifacts[1].url, 'https://example.com');
  assert.equal(snap.permission, null);
});

test('050 snapshotFromRecord：新契约字段透传；旧档案按 delivery/resultText 投影正文', () => {
  // 新档案：正文契约字段原样透传。
  const fresh = snapshotFromRecord({
    taskId: 'task-3-x',
    taskText: '查数据',
    outcome: 'complete',
    resultText: '查到了，共 3 家。',
    resultVersion: 2,
    bodySource: 'executor',
    speechText: '查到了，详情在屏幕上。',
    notices: ['其中一个页面异常'],
    sources: [{ title: 'A', url: 'https://a.example.com', visited: true }],
    events: [],
  }, 3);
  assert.equal(fresh.resultText, '查到了，共 3 家。');
  assert.equal(fresh.resultVersion, 2);
  assert.equal(fresh.bodySource, 'executor');
  assert.equal(fresh.speechText, '查到了，详情在屏幕上。');
  assert.deepEqual(fresh.notices, ['其中一个页面异常']);
  assert.deepEqual(fresh.sources, [{ title: 'A', url: 'https://a.example.com', visited: true }]);

  // 旧档案（v1 delivery）：投影成正文，回炉句转 speechText。
  const legacy = snapshotFromRecord({
    taskId: 'task-4-x',
    taskText: '调研天气',
    outcome: 'complete',
    resultText: '北京多云，建议带伞。', // 旧回炉句
    delivery: {
      form: 'card', kind: 'comparison', title: '天气对比', summary: '北京多云。',
      blocks: [{ type: 'p', text: '降水概率 30%。' }],
      sources: [{ title: '气象台', url: 'https://weather.example.com' }],
      files: [],
    },
    events: [],
  }, 4);
  assert.equal(legacy.bodySource, 'legacy-delivery');
  assert.match(legacy.resultText, /北京多云。/);
  assert.match(legacy.resultText, /降水概率 30%/);
  assert.equal(legacy.speechText, '北京多云，建议带伞。', '旧回炉句转为语音交代');
  assert.equal(legacy.resultVersion, 1);

  // 旧档案（只有 resultText，无 delivery）：resultText 直接当正文。
  const legacyPlain = snapshotFromRecord({
    taskId: 'task-5-x',
    taskText: '旧任务',
    outcome: 'complete',
    resultText: '一句话结论。',
    events: [],
  }, 5);
  assert.equal(legacyPlain.bodySource, 'legacy-result');
  assert.equal(legacyPlain.resultText, '一句话结论。');
  assert.equal(legacyPlain.speechText, null);
});

test('snapshotFromRecord：极简记录不炸（无核验/无产物/无终态字段）', () => {
  const snap = snapshotFromRecord({ taskId: 'task-1-x', taskText: '空', events: [] }, 1);
  assert.equal(snap.outcome, 'unknown');
  assert.equal(snap.verification, null);
  assert.deepEqual(snap.artifacts, []);
  assert.equal(snap.stageText, null);
  assert.deepEqual(snap.log, []);
});

test('018 过程记录：finishRecord 落盘耗时与审批等待，snapshotFromRecord 透传', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-toolcalls-'));
  try {
    const store = makeStore(dir);
    const record = store.createRecord({ taskText: '查资料' });
    const toolCalls = [
      { tool: 'web_search', startedAt: 1000, durationMs: 800, isError: false, actionState: null },
      { tool: 'ui_click', startedAt: 2000, durationMs: 1500, isError: false, actionState: 'executed' },
    ];
    store.finishRecord(record.taskId, {
      outcome: 'complete',
      resultText: '完成。',
      toolCalls,
      approvals: { count: 2, totalWaitMs: 83000 },
    });

    const stored = store.getRecord(record.taskId);
    assert.deepEqual(stored.toolCalls, toolCalls);
    assert.deepEqual(stored.approvals, { count: 2, totalWaitMs: 83000 });

  const snap = snapshotFromRecord(stored, 3);
  assert.equal(snap.recentToolCalls.length, 2);
  assert.equal(snap.recentToolCalls[1].durationMs, 1500);
  assert.equal(snap.readOnly, false, '已执行 GUI 动作的历史卡不能继续显示只读');
  assert.deepEqual(snap.approvals, { count: 2, totalWaitMs: 83000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('026 结构化收尾提交随终态落盘，旧档案缺省兼容', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-task-result-'));
  try {
    const store = makeStore(dir);
    const record = store.createRecord({ taskText: '结构化收尾' });
    const taskResult = {
      schemaVersion: 1,
      proposedVerdict: 'complete',
      checks: [{ target: '文件存在', status: 'satisfied', evidence: 'ls 已列出' }],
      missing: [],
      sideEffects: [],
      submittedAt: 1234,
    };
    store.finishRecord(record.taskId, {
      outcome: 'complete',
      resultText: '完成。',
      taskResult,
      verification: { verdict: 'complete', evidence: ['文件存在：ls 已列出'], unchecked: [] },
    });
    assert.deepEqual(store.getRecord(record.taskId).taskResult, taskResult);
    assert.deepEqual(snapshotFromRecord(store.getRecord(record.taskId), 1).taskResult, taskResult);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 024 文字输入：建档来源的落盘与视图/快照恢复 ----

test('024 inputSource：建档归一化落盘，视图与快照重建带回来源', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-hist-'));
  try {
    const store = makeStore(dir);
    const textRecord = store.createRecord({ taskText: '文字任务', inputSource: 'text', conversationId: 'conv-t' });
    assert.equal(textRecord.inputSource, 'text');
    const voiceRecord = store.createRecord({ taskText: '语音任务', inputSource: 'voice' });
    assert.equal(voiceRecord.inputSource, 'voice');
    // 非法/缺省值归一化为 voice（旧调用方与旧档案兼容）。
    const legacyRecord = store.createRecord({ taskText: '旧式任务' });
    assert.equal(legacyRecord.inputSource, 'voice');

    const views = store.listTasks().tasks;
    assert.equal(views.find((v) => v.taskId === textRecord.taskId).inputSource, 'text');
    assert.equal(views.find((v) => v.taskId === legacyRecord.taskId).inputSource, 'voice');

    // 快照重建（会话存档修复路径）：来源不丢。
    const snap = snapshotFromRecord(textRecord, 3);
    assert.equal(snap.inputSource, 'text');
    // 旧档案（无字段）重建按 voice。
    const legacySnap = snapshotFromRecord({ ...legacyRecord, inputSource: undefined }, 4);
    assert.equal(legacySnap.inputSource, 'voice');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 025 交付落档 ----

function sampleDelivery() {
  return {
    schemaVersion: 1,
    form: 'card',
    kind: 'summary',
    title: '明天北京天气',
    summary: '多云转晴。',
    blocks: [{ type: 'p', text: '降水概率 30%。' }],
    sources: [{ id: 'src-1', title: '气象台', url: 'https://weather.example.com' }],
    mainArtifacts: [],
    attachmentArtifacts: ['art-1'],
    reason: '简单结论卡',
    partial: null,
    degraded: [],
    presentationError: null,
    registeredAt: Date.now(),
  };
}

test('025 setDelivery：交付落档可读，列表视图 hasDelivery 为真', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-hist-'));
  try {
    const store = makeStore(dir);
    const record = store.createRecord({ taskText: '查天气' });
    store.appendDeliverable(record.taskId, { id: 'art-1', kind: 'file', path: '/tmp/a.csv', name: 'a.csv' });
    assert.equal(store.setDelivery(record.taskId, sampleDelivery()), true);

    const detail = store.getRecord(record.taskId);
    assert.equal(detail.delivery.title, '明天北京天气');
    assert.equal(detail.delivery.attachmentArtifacts[0], 'art-1');

    const view = store.listTasks().tasks.find((v) => v.taskId === record.taskId);
    assert.equal(view.hasDelivery, true);

    // 覆盖语义：重登以最后一次为准。
    store.setDelivery(record.taskId, { ...sampleDelivery(), title: '修正版' });
    assert.equal(store.getRecord(record.taskId).delivery.title, '修正版');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('025 mergeDeliverableMeta：重复登记复用 ID、合并 role/mediaType', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-hist-'));
  try {
    const store = makeStore(dir);
    const record = store.createRecord({ taskText: '生成文件' });
    store.appendDeliverable(record.taskId, { id: 'art-1', kind: 'file', path: '/tmp/a.csv', name: 'a.csv' });
    // appendDeliverable 去重：同 path 不新增。
    assert.equal(store.appendDeliverable(record.taskId, { id: 'art-2', kind: 'file', path: '/tmp/a.csv', name: 'a.csv' }), true);
    assert.equal(store.getRecord(record.taskId).deliverables.length, 1);

    assert.equal(store.mergeDeliverableMeta(record.taskId, 'art-1', { role: 'main', mediaType: 'text/csv' }), true);
    const artifact = store.getRecord(record.taskId).deliverables[0];
    assert.equal(artifact.id, 'art-1');
    assert.equal(artifact.role, 'main');
    assert.equal(artifact.mediaType, 'text/csv');

    // 旧档案没有交付字段：视图/快照兼容。
    const bare = store.createRecord({ taskText: '老任务' });
    assert.equal(store.listTasks().tasks.find((v) => v.taskId === bare.taskId).hasDelivery, false);
    const snap = snapshotFromRecord(store.getRecord(bare.taskId), 2);
    assert.equal(snap.delivery, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('025 snapshotFromRecord：交付与产物 role 随快照透传（会话载入回看）', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-hist-'));
  try {
    const store = makeStore(dir);
    const record = store.createRecord({ taskText: '调研' });
    store.appendDeliverable(record.taskId, { id: 'art-1', kind: 'file', path: '/tmp/a.md', name: 'a.md', role: 'attachment', mediaType: 'text/markdown' });
    store.setDelivery(record.taskId, sampleDelivery());
    store.finishRecord(record.taskId, { outcome: 'complete', resultText: '完成', report: '报告' });

    const snap = snapshotFromRecord(store.getRecord(record.taskId), 1);
    assert.equal(snap.delivery.form, 'card');
    assert.equal(snap.delivery.title, '明天北京天气');
    assert.equal(snap.artifacts[0].role, 'attachment');
    assert.equal(snap.artifacts[0].mediaType, 'text/markdown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
