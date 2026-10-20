// 057 bug#12 防御层：busy 派生（本地 thinking 或 flow preparing/running 任一为真）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveModelBusy } from './turn-busy.ts';

test('busy 派生：thinking 或 flow 运行事实任一为真', () => {
  assert.equal(deriveModelBusy({ turnPhase: 'thinking', flowPhase: null }), true);
  assert.equal(deriveModelBusy({ turnPhase: 'idle', flowPhase: 'preparing' }), true);
  assert.equal(deriveModelBusy({ turnPhase: 'idle', flowPhase: 'running' }), true);
  // 060：停止中仍占用，资源退出前不能把会话当空闲。
  assert.equal(deriveModelBusy({ turnPhase: 'idle', flowPhase: 'stopping' }), true);
  assert.equal(deriveModelBusy({ turnPhase: 'replying', flowPhase: null }), false);
  assert.equal(deriveModelBusy({ turnPhase: 'idle', flowPhase: 'idle' }), false);
  assert.equal(deriveModelBusy({ turnPhase: null, flowPhase: undefined }), false);
});

test('busy 派生：早停后下一回合（stopped 关闭 → 新 run preparing）立即回忙', () => {
  assert.equal(deriveModelBusy({ turnPhase: 'idle', flowPhase: 'idle' }), false);
  assert.equal(deriveModelBusy({ turnPhase: 'idle', flowPhase: 'preparing' }), true, '队列派发/事件回合不经 runTurn 也要亮');
});

test('提交入口在途判定＝busy 派生（2026-10-16 审计 A1：主进程回合期间提交必须入队）', () => {
  // 文字发送（handleSubmitText）与语音定稿（submitTurn）的「在途→入队」守卫
  // 直接调用本函数：主进程发起的回合（队列派发/事件回合/前台子 agent 等待中）
  // 不置本地 turnPhase，只查 thinking 会漏判成直发——llm:chat preempt:'active'
  // 会作废在途回合（10-15 实录：两条追问乐观上屏、宿主从未受理、无回复）。
  assert.equal(deriveModelBusy({ turnPhase: 'idle', flowPhase: 'running' }), true, '在途回合期间提交→入队');
  assert.equal(deriveModelBusy({ turnPhase: 'idle', flowPhase: 'preparing' }), true, '事件回合起跑（未占槽）期间提交→入队');
  // 连续模式抢话不受影响：replying（本地播报中、flow 已收口）仍走直发抢话。
  assert.equal(deriveModelBusy({ turnPhase: 'replying', flowPhase: 'idle' }), false);
});
