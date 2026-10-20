import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentTools } from './agent-tools.mjs';
import { MAIN_CONTROL_TOOLS } from './agent-roles.mjs';
import { judgeAccess } from './gate/access-policy.mjs';

test('工作流准备工具传递卡片身份、版本与停止信号，不暴露启动操作', async () => {
  const controller = new AbortController();
  const tool = createAgentTools({ workflowPreparation: async (args, signal) => {
    assert.deepEqual(args, { action: 'update', invocationId: 'inv-a', expectedDraftRevision: 3, set: { topic: '月报' } });
    assert.equal(signal, controller.signal);
    return { ready: true };
  } }).find(tool => tool.name === 'workflow_preparation');
  assert.ok(tool);
  assert.deepEqual(tool.parameters.properties.action.enum, ['list', 'get', 'update', 'abandon']);
  assert.match((await tool.execute('call-a', { action: 'update', invocationId: 'inv-a', expectedDraftRevision: 3, set: { topic: '月报' } }, controller.signal)).content[0].text, /"ready": true/);
  assert.ok(MAIN_CONTROL_TOOLS.includes('workflow_preparation'));
});

test('只读阶段允许查询准备卡，拒绝更新或取消', () => {
  for (const action of ['list', 'get', 'update', 'abandon']) {
    for (const scope of [{ phase: 'verify' }, { boundary: 'readonly' }]) {
      const verdict = judgeAccess({ tool: 'workflow_preparation', input: { action }, q: {}, ...scope });
      assert.equal(verdict.verdict, ['list', 'get'].includes(action) ? 'allow' : 'deny');
    }
  }
});
