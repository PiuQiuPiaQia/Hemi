import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetSummaryFacts } from './budget-summary.mjs';

test('069 总结 brief 有界且各段独立裁剪，不让超长子报告挤掉交付和工具事实', () => {
  const large = '\n'.repeat(100000);
  const { brief, fallbackText } = budgetSummaryFacts({
    limit: 60, userText: `本轮唯一目标${large}`, texts: Array(100).fill(large),
    tasks: Array.from({ length: 50 }, () => ({ role: { name: 'fixer' }, outcome: 'failed', resultText: large })),
    observations: Array.from({ length: 100 }, () => ({ tool: 'write', outcome: 'ok', resource: { scope: `file:/tmp/UNIQUE${large}` } })),
    artifacts: [{ name: '阶段成果', path: '/tmp/UNIQUE_ARTIFACT.txt' }],
  });
  assert.ok(brief.length < 24000);
  for (const text of ['本轮唯一目标', 'registeredDeliveries', 'UNIQUE_ARTIFACT.txt', 'toolFacts', 'childReports', 'mainAgentText', '省略', '不代表整个目标验收通过']) assert.ok(brief.includes(text), text);
  assert.match(fallbackText, /60 次执行请求上限/);
  assert.match(fallbackText, /登记不等于全部质量检查通过/);
  assert.doesNotMatch(brief, /base64|apiKey/);
});
