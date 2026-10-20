import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { buildRuntimeDiagnostic, buildRuntimeDiagnosticBlock, isGreetingOnly } from './runtime-diagnostics.mjs';

test('诊断冻结当前实例/会话/两类型号，密钥与 URL 凭据不投影', () => {
  const diagnostic = buildRuntimeDiagnostic({
    conversationId: 'conv-current', requestId: 'request-1', startedAt: 1,
    config: { model: 'claude-opus', apiKey: 'secret-key', baseUrl: 'https://user:password@relay.example/v1?token=secret-query' },
    executionConfig: { model: 'deepseek-flash' },
    version: '0.5.2', platform: 'darwin', versions: { node: '24.18.1', electron: '44.0.0' },
    userDataDir: '/tmp/current-dev', isPackaged: false,
  });
  assert.equal(diagnostic.conversationId, 'conv-current');
  // logPath 是 path.join 口径：Windows 下是反斜杠（实现无关平台语义，测试跟随）。
  assert.equal(diagnostic.logPath, path.join('/tmp/current-dev', 'hemi.log'));
  assert.equal(diagnostic.dialogue.requestedModel, 'claude-opus');
  assert.equal(diagnostic.execution.requestedModel, 'deepseek-flash');
  assert.equal(diagnostic.runtime.node, '24.18.1');
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret|password|user:/);
  assert.match(buildRuntimeDiagnosticBlock(diagnostic), /不能断言供应商没有推理/);
  const block = buildRuntimeDiagnosticBlock(diagnostic);
  assert.match(block, /不代表所有角色子 agent 的实际调用/);
  assert.match(block, /实际型号与备用切换以对应回合、子 agent 的调用记录为准/);
  assert.doesNotMatch(block, /主脑模型与执行模型分开说明/);
});

test('问候无执行意图；含任务指令或「你好」文件名的消息仍可执行', () => {
  assert.equal(isGreetingOnly('你好啊！'), true);
  assert.equal(isGreetingOnly('Hi!'), true);
  assert.equal(isGreetingOnly('你好，继续查当前模型'), false);
  assert.equal(isGreetingOnly('创建你好.txt'), false);
});

test('入史诊断只携带本轮冻结信息；最近回合详情通过诊断工具按需查询', () => {
  const current = { conversationId: 'current-conv', requestId: 'current-request' };
  const block = buildRuntimeDiagnosticBlock(current, [{ requestId: 'OLD_REQUEST_MUST_NOT_REPEAT', thinkingDurationMs: 123 }]);
  assert.match(block, /current-request/);
  assert.doesNotMatch(block, /OLD_REQUEST_MUST_NOT_REPEAT|"recent"/);
  assert.match(block, /get_runtime_diagnostics/);
  assert.match(block, /询问本轮配置型号.+直接依据本块回答，不重复调用工具/);
  assert.match(block, /需要查询近期历史回合、耗时/);
});
