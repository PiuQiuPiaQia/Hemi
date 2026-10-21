import assert from 'node:assert/strict';
import test from 'node:test';

import { formatCallElapsed, resolveCallDockStatus } from './call-dock-state.ts';

const base = {
  callActive: true,
  sessionState: 'listening',
  turnPhase: 'listening',
  streamingReply: '',
  interimText: '',
  muted: false,
};

test('后台和资源等待不会伪装成思考/回应，静音和接通优先级保持', () => {
  for (const waiting of ['background', 'resource']) {
    const state = { ...base, turnPhase: 'thinking', streamingReply: '已有文字', waiting };
    assert.equal(resolveCallDockStatus(state).phase, 'waiting');
    assert.match(resolveCallDockStatus(state).label, /等待/);
    assert.equal(resolveCallDockStatus({ ...state, muted: true }).phase, 'muted');
    assert.equal(resolveCallDockStatus({ ...state, sessionState: 'requesting' }).phase, 'connecting');
  }
});

// ---- resolveCallDockStatus：五态映射与优先级 ----

test('静音是硬覆盖：任何相位都显示已静音', () => {
  for (const turnPhase of ['listening', 'thinking', 'speaking', 'replying']) {
    const status = resolveCallDockStatus({ ...base, turnPhase, muted: true });
    assert.equal(status.phase, 'muted');
    assert.match(status.label, /已静音/);
  }
});

test('接通中优先于回合相位', () => {
  const status = resolveCallDockStatus({ ...base, sessionState: 'requesting', turnPhase: 'thinking' });
  assert.equal(status.phase, 'connecting');
  assert.match(status.label, /正在接通/);
});

test('思考相位：无首字＝正在想，有流式增量＝回应中', () => {
  assert.equal(resolveCallDockStatus({ ...base, turnPhase: 'thinking' }).label, '正在想');
  const streaming = resolveCallDockStatus({
    ...base,
    turnPhase: 'thinking',
    streamingReply: '好的，',
  });
  assert.equal(streaming.phase, 'speaking');
  assert.equal(streaming.label, '回应中');
});

test('聆听相位：有临时稿显示识别中，无临时稿是我在听', () => {
  const interim = resolveCallDockStatus({ ...base, interimText: '帮我查天气' });
  assert.equal(interim.label, '正在识别');
  assert.equal(interim.detail, '帮我查天气');
  assert.equal(resolveCallDockStatus(base).label, '我在听');
});

test('播报与收尾相位各归其位', () => {
  assert.equal(resolveCallDockStatus({ ...base, turnPhase: 'speaking' }).label, '正在说');
  assert.equal(resolveCallDockStatus({ ...base, turnPhase: 'replying' }).label, '说完了');
});

test('未激活通话不假装在听', () => {
  const idle = resolveCallDockStatus({ ...base, callActive: false, sessionState: 'idle', turnPhase: 'idle' });
  assert.equal(idle.phase, 'idle');
  assert.equal(idle.label, '待机');
});

// ---- formatCallElapsed ----

test('计时格式：秒到 mm:ss，负数按 0 处理', () => {
  assert.equal(formatCallElapsed(0), '00:00');
  assert.equal(formatCallElapsed(65), '01:05');
  assert.equal(formatCallElapsed(600), '10:00');
  assert.equal(formatCallElapsed(-3), '00:00');
});
