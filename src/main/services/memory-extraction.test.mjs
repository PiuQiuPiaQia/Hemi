// 037 Phase D 单测：终态经验提炼（纯函数、store 单事务提交、服务队列端到端）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildEvidenceWhitelist,
  buildExtractionPrompt,
  parseExtractionJson,
  validateExtractionOutput,
  EXTRACTION_LIMITS,
} from './memory-extraction.mjs';
import { createMemoryService } from './memory.mjs';

// ---------------------------------------------------------------- 纯函数

test('parseExtractionJson：裸 JSON/围栏/夹带文本都能取到；垃圾返回 null', () => {
  const bare = parseExtractionJson('{"notes":[],"candidates":[]}');
  assert.deepEqual(bare, { notes: [], candidates: [] });
  const fenced = parseExtractionJson('```json\n{"notes":[{"text":"a"}],"candidates":[]}\n```');
  assert.equal(fenced.notes[0].text, 'a');
  const noisy = parseExtractionJson('好的，以下是结果：{"notes":[],"candidates":[{"action":"add"}]} 请查收');
  assert.equal(noisy.candidates.length, 1);
  assert.equal(parseExtractionJson('我不是 JSON'), null);
  assert.equal(parseExtractionJson(''), null);
});

test('validateExtractionOutput：证据白名单/条目引用/预算上限整批拒绝', () => {
  const whitelist = buildEvidenceWhitelist({ checks: [{ status: 'satisfied' }] });
  assert.deepEqual(whitelist, ['report', 'check-0']);
  const ok = validateExtractionOutput({
    notes: [{ text: '构建需要先装依赖', derivedFromEntryIds: ['mem-1'] }],
    candidates: [{ action: 'add', title: '构建顺序', body: '先装依赖再构建', kind: 'experience', evidenceRefs: ['report'] }],
  }, { evidenceWhitelist: whitelist, domainEntryIds: ['mem-1'] });
  assert.equal(ok.ok, true);
  assert.equal(ok.candidates[0].action, 'add');

  assert.equal(validateExtractionOutput({ notes: [], candidates: [{ action: 'add', title: 't', body: '', kind: 'fact', evidenceRefs: ['瞎写的'] }] }, { evidenceWhitelist: whitelist, domainEntryIds: [] }).ok, false);
  assert.equal(validateExtractionOutput({ notes: [{ text: 'x', derivedFromEntryIds: ['mem-9'] }], candidates: [] }, { evidenceWhitelist: whitelist, domainEntryIds: ['mem-1'] }).ok, false, 'note 引用不存在条目');
  assert.equal(validateExtractionOutput({ notes: [], candidates: [{ action: 'add', title: 't', body: '', kind: 'diary', evidenceRefs: ['report'] }] }, { evidenceWhitelist: whitelist, domainEntryIds: [] }).ok, false, 'kind 非法');
  assert.equal(validateExtractionOutput({ notes: [], candidates: [{ action: 'add', title: 't', body: '', kind: 'fact', evidenceRefs: [] }] }, { evidenceWhitelist: whitelist, domainEntryIds: [] }).ok, false, '无证据引用');
  const tooMany = { notes: [], candidates: Array.from({ length: EXTRACTION_LIMITS.maxCandidates + 1 }, () => ({ action: 'add', title: 't', body: '', kind: 'fact', evidenceRefs: ['report'] })) };
  assert.equal(validateExtractionOutput(tooMany, { evidenceWhitelist: whitelist, domainEntryIds: [] }).ok, false, '候选超上限整批拒绝');
  const replace = validateExtractionOutput({
    notes: [], candidates: [{ action: 'replace', existingEntryId: 'mem-1', title: '改', body: '', kind: 'fact', evidenceRefs: ['check-0'] }],
  }, { evidenceWhitelist: whitelist, domainEntryIds: ['mem-1'] });
  assert.equal(replace.ok, true);
  assert.equal(replace.candidates[0].existingEntryId, 'mem-1');
});

test('buildExtractionPrompt：任务文本/核验/条目清单进提示词，JSON 契约在场', () => {
  const messages = buildExtractionPrompt({
    taskText: '在 /tmp 建 hello.txt',
    verdict: 'complete',
    report: '已创建文件',
    checks: [{ status: 'satisfied', target: '文件存在', evidence: '列目录确认' }],
    domainEntries: [{ id: 'mem-1', version: 2, title: '构建顺序' }],
    workspaceLabel: 'Hemi 项目',
  });
  const text = messages.map((m) => m.content).join('\n');
  assert.match(text, /在 \/tmp 建 hello\.txt/);
  assert.match(text, /check-0/);
  assert.match(text, /mem-1 v2 构建顺序/);
  assert.match(text, /"candidates"/);
  assert.equal(messages[0].role, 'system');
});

// ---------------------------------------------------------------- 服务队列端到端

const GOOD_JSON = JSON.stringify({
  notes: [{ text: '自驱动验收任务跑通记忆链路', derivedFromEntryIds: [] }],
  candidates: [{ action: 'add', title: '真机验收口径', body: '以 self-run-task harness 为准。', kind: 'experience', evidenceRefs: ['report'] }],
});

function makeService() {
  const root = mkdtempSync(path.join(tmpdir(), 'hemi-extract-'));
  const service = createMemoryService({ memoryDir: path.join(root, 'memory') });
  const events = [];
  service.subscribeChanges((info) => events.push(info));
  return { root, service, events };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等待队列跑空（running=false 且 pending=0，轮询直到稳定）。 */
async function drainQueue(service) {
  for (let i = 0; i < 100; i += 1) {
    const stats = service.extractionStats;
    if (!stats.running && stats.pending === 0) {
      await sleep(30);
      if (!service.extractionStats.running && service.extractionStats.pending === 0) return;
    }
    await sleep(30);
  }
}

function snapshotOf(overrides = {}) {
  return {
    taskId: 'task-1',
    conversationId: 'conv-1',
    taskText: '在 /tmp 建 hello.txt',
    verdict: 'complete',
    report: '已创建 hello.txt，内容自测',
    checks: [{ status: 'satisfied', target: '文件存在', evidence: '列目录确认' }],
    workspaceId: 'ws-a',
    ...overrides,
  };
}

test('提炼端到端：成功落本域（notes 进 daily、候选进 MEMORY）并广播 origin=task', async () => {
  const { root, service, events } = makeService();
  try {
    const modelCalls = [];
    const queued = service.scheduleTaskExtraction(snapshotOf(), {
      runModel: async ({ messages }) => {
        modelCalls.push(messages);
        return GOOD_JSON;
      },
      isExitSummaryEnabled: async () => true,
    });
    assert.equal(queued.queued, true);
    await drainQueue(service);
    const stats = service.extractionStats;
    assert.equal(stats.lastResult?.code, 'committed', JSON.stringify(stats.lastResult));

    const view = await service.buildView({ workspaceId: 'ws-a' });
    assert.match(view.data.text, /真机验收口径/);
    const client = service.bindTaskClient({ workspaceId: 'ws-a', mode: 'verify' });
    const records = await client.readWorkingRecords();
    const todayNotes = (records.data.daily ?? []).flatMap((d) => d.records.map((r) => r.text));
    assert.ok(todayNotes.some((t) => t.includes('自驱动验收任务跑通记忆链路')));
    const taskEvents = events.filter((e) => e.origin === 'task');
    assert.equal(taskEvents.length, 1);
    assert.equal(taskEvents[0].title, '真机验收口径');
    assert.equal(modelCalls.length, 1, '一次有界请求');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('开关关闭：作业开始与提交前都拦截，不落盘（AC-12）', async () => {
  const { root, service } = makeService();
  try {
    let enabled = false;
    service.scheduleTaskExtraction(snapshotOf(), {
      runModel: async () => {
        assert.fail('开关关闭时不应调用模型');
      },
      isExitSummaryEnabled: async () => enabled,
    });
    await drainQueue(service);
    assert.equal(service.extractionStats.lastResult?.code, 'switch_off');

    // 作业开始时开着、提交前关闭：模型被调用但不落盘。
    enabled = true;
    let switchFlipped = false;
    service.scheduleTaskExtraction({ ...snapshotOf(), taskId: 'task-2' }, {
      runModel: async () => {
        switchFlipped = true;
        enabled = false; // 模型返回后、提交前被关掉
        return GOOD_JSON;
      },
      isExitSummaryEnabled: async () => enabled,
    });
    await drainQueue(service);
    assert.equal(switchFlipped, true);
    assert.equal(service.extractionStats.lastResult?.code, 'switch_off_before_commit');
    const view = await service.buildView({ workspaceId: 'ws-a' });
    assert.doesNotMatch(view.data.text, /真机验收口径/, '关闭后不落盘');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('作业期间遗忘：提交 source_revoked，迟到候选不写回（AC-10）', async () => {
  const { root, service } = makeService();
  try {
    // 预置一个可 replace 的条目。
    const client = service.bindTaskClient({ workspaceId: 'ws-a', mode: 'run' });
    const added = await client.addEntry({ title: '旧约定', body: 'x', kind: 'fact' });
    let forgetNow = null;
    service.scheduleTaskExtraction(snapshotOf({
      taskId: 'task-3',
      report: '报告',
    }), {
      runModel: async () => {
        // 模型在途时执行遗忘（推进 epoch 与 forgetBeforeSeq）。
        forgetNow = await service.forgetEntry({ scope: { kind: 'workspace', workspaceId: 'ws-a' }, entryId: added.data.entry.id, expectedVersion: 1 });
        return GOOD_JSON;
      },
      isExitSummaryEnabled: async () => true,
    });
    await drainQueue(service);
    assert.equal(forgetNow?.ok, true);
    assert.equal(service.extractionStats.lastResult?.code, 'source_revoked', JSON.stringify(service.extractionStats.lastResult));
    const view = await service.buildView({ workspaceId: 'ws-a' });
    assert.doesNotMatch(view.data.text, /真机验收口径/, '遗忘后迟到候选不落盘');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('无效输出与模型失败：如实记录、不落盘、不抛出；同 taskId 去重', async () => {
  const { root, service } = makeService();
  try {
    service.scheduleTaskExtraction(snapshotOf({ taskId: 'task-4' }), {
      runModel: async () => '我觉得一切都好（不是 JSON）',
      isExitSummaryEnabled: async () => true,
    });
    service.scheduleTaskExtraction(snapshotOf({ taskId: 'task-4' }), { // 同 taskId：覆盖排队
      runModel: async () => GOOD_JSON,
      isExitSummaryEnabled: async () => true,
    });
    await drainQueue(service);
    const stats = service.extractionStats;
    assert.equal(stats.lastResult?.code, 'committed');
    assert.equal(stats.pending, 0);

    service.scheduleTaskExtraction(snapshotOf({ taskId: 'task-5' }), {
      runModel: async () => { throw new Error('网关炸了'); },
      isExitSummaryEnabled: async () => true,
    });
    await drainQueue(service);
    assert.equal(service.extractionStats.lastResult?.code, 'error');

    service.scheduleTaskExtraction(snapshotOf({ taskId: 'task-6' }), {
      runModel: async () => '{"notes":[],"candidates":[]}',
      isExitSummaryEnabled: async () => true,
    });
    await drainQueue(service);
    assert.equal(service.extractionStats.lastResult?.code, 'empty', '无可提炼内容如实记录');
    // task-4 已合法提交 1 条；随后的 error/empty 作业不新增（失败路径不落盘）。
    const listed = await service.listEntries({ scope: { kind: 'workspace', workspaceId: 'ws-a' } });
    assert.equal(listed.data.entries.length, 1, JSON.stringify(listed.data.entries.map((e) => e.title)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('超时分类回归（2026-10-05 审计）：宿主包装的「回合已取消。」按超时落账，不误记失败', async () => {
  // 真机实录：10-05 五个终态作业三个贴着 10s 墙钟被砍，chatTurn 把作业 abort
  // 包装成 new Error('回合已取消。')（name 不是 AbortError）——旧判定只认 name，
  // 超时全被记成「失败」。回归钉死：作业自己的 signal 已中止即算超时。
  const root = mkdtempSync(path.join(tmpdir(), 'hemi-extract-'));
  const service = createMemoryService({
    memoryDir: path.join(root, 'memory'),
    // 200ms：30ms 时高负载 runner 上定时器可能在 runModel 注册监听器前就
    // 触发（mac CI v0.6.8 实撞），桩需容忍；生产默认 60s 无此窗口问题。
    extractionLimits: { jobTimeoutMs: 200 },
  });
  try {
    service.scheduleTaskExtraction(snapshotOf({ taskId: 'task-t' }), {
      runModel: ({ signal }) =>
        new Promise((_resolve, reject) => {
          // signal 已中止时 addEventListener 不回放——先查一次，保证
          // 「注册晚于墙钟」的形态也能落到 catch 被分类，不悬挂。
          if (signal.aborted) {
            reject(new Error('回合已取消。'));
            return;
          }
          signal.addEventListener('abort', () => reject(new Error('回合已取消。')));
        }),
      isExitSummaryEnabled: async () => true,
    });
    await drainQueue(service);
    const last = service.extractionStats.lastResult;
    assert.equal(last?.code, 'timeout', JSON.stringify(last));
    assert.equal(last?.reason, '回合已取消。');
    const listed = await service.listEntries({ scope: { kind: 'workspace', workspaceId: 'ws-a' } });
    assert.equal(listed.data.entries.length, 0, '超时作业不落盘');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
