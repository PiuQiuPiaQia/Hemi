import assert from 'node:assert/strict';
import test from 'node:test';

import { terminalAnnouncementText } from './task-announcement.ts';

test('050 播报口径：念 speechText，绝不念正文（R-14）', () => {
  assert.equal(
    terminalAnnouncementText({ resultText: '| 平台 | 价格 |\n| --- | --- |', speechText: '查到了，明天晴。', outcome: 'complete', outcomeReason: null }),
    '查到了，明天晴。',
  );
  // 正文在手但语音缺失（回炉失败）→ 固定短句，不念长表。
  assert.equal(
    terminalAnnouncementText({ resultText: '很长的正文…', speechText: null, outcome: 'complete', outcomeReason: null }),
    '任务完成了，详情在屏幕上。',
  );
  assert.equal(
    terminalAnnouncementText({ resultText: '很长的正文…', speechText: '', outcome: 'partial', outcomeReason: null }),
    '任务部分完成，详情在屏幕上。',
  );
});

test('blocked/denied/unknown 空正文＝固定人话文案', () => {
  assert.match(
    terminalAnnouncementText({ resultText: null, speechText: null, outcome: 'blocked', outcomeReason: '命令命中禁止规则：scutil --get' }),
    /安全底线/,
  );
  assert.match(
    terminalAnnouncementText({ resultText: null, speechText: null, outcome: 'denied', outcomeReason: '用户拒绝了这一步' }),
    /没等到你的允许/,
  );
  // 遗留档案可能把按钮提示留在 reason，不能再次引导到退役入口。
  const unknown = terminalAnnouncementText({ resultText: null, speechText: null, outcome: 'unknown', outcomeReason: '可点「检查结果」核实' });
  assert.match(unknown, /没有返回明确结果/);
  assert.match(unknown, /直接告诉我/);
  assert.doesNotMatch(unknown, /任务卡|检查结果/);
});

test('授权超时不声称整条任务没开始或多次超时', () => {
  const text = terminalAnnouncementText({
    resultText: null,
    speechText: null,
    outcome: 'unknown',
    outcomeReason: '等授权超时或被拒，任务没有真正开始',
  });
  assert.match(text, /没拿到可核实的结果/);
  assert.match(text, /授权/);
  // 别再让人去「核实」一个不存在的结果。
  assert.doesNotMatch(text, /任务跑完了/);
  assert.doesNotMatch(text, /没能开始做|几次/);
  assert.doesNotMatch(text, /任务卡|检查结果/);
  const partiallyExecuted = terminalAnnouncementText({
    resultText: null, speechText: null, outcome: 'unknown', outcomeReason: '授权超时或被拒，未拿到可核实的结果',
    recentToolCalls: [{ tool: 'read', actionState: null }],
  });
  assert.match(partiallyExecuted, /已执行部分查询/);
  assert.doesNotMatch(partiallyExecuted, /任务卡|检查结果/);
});

test('其余终态无正文＝照念 outcomeReason，null＝不交代', () => {
  assert.equal(
    terminalAnnouncementText({ resultText: null, outcome: 'startfailed', outcomeReason: '执行器没起来' }),
    '执行器没起来',
  );
  assert.equal(terminalAnnouncementText({ resultText: null, speechText: null, outcome: 'startfailed', outcomeReason: null }), null);
});
