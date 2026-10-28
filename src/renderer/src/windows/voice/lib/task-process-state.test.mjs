import assert from 'node:assert/strict';
import test from 'node:test';
import { processStepsOf, taskElapsedMs, formatDuration } from './task-process-state.ts';

test('Bot 子任务只有独立对话、没有旧 log 时仍可打开运行中与已完成详情', () => {
  const snap = { phase: 'running', startedAt: 1000, progressText: '正在执行命令', conversation: {messages: []} };
  assert.equal(processStepsOf(snap).at(-1).title, '正在执行命令');
  assert.equal(taskElapsedMs(snap, 4000), 3000);
  assert.deepEqual(processStepsOf({...snap, phase: 'terminal'}), []);
  assert.equal(taskElapsedMs({...snap, phase: 'terminal', endedAt: 5000}, 6000), 4000);
  assert.equal(taskElapsedMs({phase: 'terminal'}, 6000), null);
  assert.equal(taskElapsedMs({...snap, phase: 'terminal'}, 6000), null);
});

test('超时、拒绝与未执行画异常；之后真实成功仍为成功', () => {
  const steps = processStepsOf({ phase: 'terminal', log: [
    { at: 1, text: '已允许（持续）：Terminal' },
    { at: 2, text: '确认超时，本次操作未获授权。（等待 30 秒）' },
    { at: 3, text: '已拒绝本次操作。' },
    { at: 4, text: '操作未执行：截图' },
    { at: 5, text: '核实未能完成：timeout' },
    { at: 6, text: '已读取：当前配置' },
  ] });
  assert.deepEqual(steps.map((step) => step.attention), [false, true, true, true, true, false]);
});

test('「已完成：动作（耗时）」剥前缀做标题、耗时进时间位（056：看得到执行了什么）', () => {
  const steps = processStepsOf({ phase: 'terminal', log: [
    { at: 1000, text: '已完成：读取 ~/src/main/agent/subagents.mjs（120ms）' },
    { at: 2000, text: '已完成：搜索「describeTool」（1.4s）' },
    { at: 3000, text: '已完成：写入 ~/README.md' },
  ] });
  assert.deepEqual(steps.map((step) => step.title), [
    '读取 ~/src/main/agent/subagents.mjs',
    '搜索「describeTool」',
    '写入 ~/README.md',
  ]);
  assert.deepEqual(steps.map((step) => step.duration), ['120ms', '1.4s', '']);
  assert.deepEqual(steps.map((step) => step.attention), [false, false, false]);
});

test('运行中的一步用 progressText 单列，不再拿最后一条已完成日志充数', () => {
  const steps = processStepsOf({
    phase: 'running',
    startedAt: 1000,
    progressText: '正在搜索内容（已 3 秒）',
    log: [{ at: 2000, text: '已完成：读取 ~/a.ts' }],
  });
  const running = steps[steps.length - 1];
  assert.equal(steps.length, 2);
  assert.equal(running.running, true);
  assert.equal(running.title, '正在搜索内容');
  assert.equal(steps[0].running, false);
  // 终态没有运行步。
  const done = processStepsOf({ phase: 'terminal', progressText: '正在搜索内容', log: [{ at: 1, text: '已完成：读取 ~/a.ts' }] });
  assert.equal(done.every((step) => !step.running), true);
});

test('终态用时包含最后总结，运行态用当前时间，旧档才回退末日志', () => {
  const snap = { phase: 'terminal', startedAt: 1000, endedAt: 252500, log: [{ at: 202000, text: '提交收尾' }] };
  assert.equal(taskElapsedMs(snap, 300000), 251500);
  assert.equal(formatDuration(taskElapsedMs(snap, 300000)), '4 分 12 秒');
  assert.equal(taskElapsedMs({ ...snap, phase: 'running' }, 300000), 299000);
  assert.equal(taskElapsedMs({ ...snap, endedAt: null }, 300000), 201000);
});
