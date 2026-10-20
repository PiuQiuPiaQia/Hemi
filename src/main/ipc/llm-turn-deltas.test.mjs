// 048 S2：对话轮增量事件转发策略与回合级思考/用量合并（AC-05/AC-08）。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTurnDeltaSink,
  mergeRoundThinking,
  mergeRoundUsage,
} from './llm-turn-deltas.mjs';

test('转发策略：正文仅在禁用工具的轮转发（016 缓冲语义），思考类恒转发（AC-05）', () => {
  const sent = [];
  const sink = createTurnDeltaSink({ send: (event) => sent.push(event) });

  // 工具轮：text 被缓冲（不转发），思考照发——工具轮思考常超 10s，是实时
  // 反馈最有价值的窗口。
  sink.beginRound({ toolsAllowed: true });
  sink.onEvent({ kind: 'text', text: '我去建文件' });
  sink.onEvent({ kind: 'thinking_start' });
  sink.onEvent({ kind: 'thinking', text: '用户要建文件' });
  sink.onEvent({ kind: 'thinking_end' });

  // 收尾轮：正文正常流式。
  sink.beginRound({ toolsAllowed: false });
  sink.onEvent({ kind: 'text', text: '好' });

  assert.deepEqual(sent, [
    { kind: 'thinking_start' },
    { kind: 'thinking', text: '用户要建文件' },
    { kind: 'thinking_end' },
    { kind: 'text', text: '好' },
  ]);
});

test('转发策略：未知 kind 原样透传、主进程不解释（AC-08 扩展性——测试桩 kind）', () => {
  const sent = [];
  const sink = createTurnDeltaSink({ send: (event) => sent.push(event) });
  sink.beginRound({ toolsAllowed: true });

  // 未来新增的内容类型（引用、多模态等）：管道只搬运，消费端在渲染层。
  sink.onEvent({ kind: 'citation', url: 'https://example.com', title: '例证' });
  sink.onEvent({ kind: 'image_chunk', data: 'AAAA' });
  // 非法输入（无 kind）静默丢弃。
  sink.onEvent(null);
  sink.onEvent({ text: '无 kind' });

  assert.deepEqual(sent, [
    { kind: 'citation', url: 'https://example.com', title: '例证' },
    { kind: 'image_chunk', data: 'AAAA' },
  ]);
});

test('转发策略：restart 恒透传（自动路由切备用清渲染层缓冲）', () => {
  const sent = [];
  const sink = createTurnDeltaSink({ send: (event) => sent.push(event) });
  sink.beginRound({ toolsAllowed: true });
  sink.onEvent({ kind: 'restart' });
  assert.deepEqual(sent, [{ kind: 'restart' }]);
});

test('转发策略：首条正文回调只触发一次（首字计时用）', () => {
  let fires = 0;
  const sink = createTurnDeltaSink({ send: () => {}, onFirstText: () => { fires += 1; } });
  sink.beginRound({ toolsAllowed: false });
  sink.onEvent({ kind: 'text', text: '你' });
  sink.onEvent({ kind: 'text', text: '好' });
  assert.equal(fires, 1);
});

test('回合思考合并：多轮续接同一思考块（轮间空行）、时长累加、空轮跳过', () => {
  const merged = mergeRoundThinking([
    { text: '先想第一步', durationMs: 1200 },
    null,
    { text: '收到工具结果再想', durationMs: 800 },
  ]);
  assert.equal(merged.text, '先想第一步\n\n收到工具结果再想');
  assert.equal(merged.durationMs, 2000);

  assert.equal(mergeRoundThinking([null, undefined]), undefined);
  // 只有时长没有文本（摘要式思考未回文本）也保留时长。
  assert.deepEqual(mergeRoundThinking([{ text: '', durationMs: 300 }]), { text: '', durationMs: 300 });
});

test('回合用量合并：跨轮累加、身份取实际作答模型、全缺省不产出', () => {
  const merged = mergeRoundUsage(
    [
      { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, genMs: 900 },
      null, // abort 轮不回 usage，不计入
      { input: 150, output: 40, cacheRead: 0, cacheWrite: 10, genMs: 1100 },
    ],
    { modelKey: 'p1/fallback-model', modelName: '备用供应商' },
  );
  assert.deepEqual(merged, {
    modelKey: 'p1/fallback-model',
    modelName: '备用供应商',
    input: 250,
    output: 60,
    cacheRead: 30,
    cacheWrite: 10,
    genMs: 2000,
  });

  assert.equal(mergeRoundUsage([null, null], { modelKey: 'x', modelName: 'y' }), undefined);
});
