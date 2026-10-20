import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildNodePrompt,
  extractOutputJson,
  parseNodeOutputs,
  createWorkflowNodeAgent,
  createNodeAgentExecutor,
} from './workflow-node-agent.mjs';

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { draft: { type: 'string', description: '正文' }, count: { type: 'number' } },
};

const NODE_SPEC = {
  nodeId: 'agent-1',
  nodeType: 'hemi-agent',
  nodeData: {
    title: '起草',
    goal: '按主题起草周报',
    outputSchema: OUTPUT_SCHEMA,
  },
};

function mockSession({ response = '', capture = [] } = {}) {
  return {
    capture,
    async prompt(text) {
      capture.push(text);
      // hemi-session 真实收口形状：texts 数组＋lastText＋usages
      return { texts: [response], lastText: response, usages: [{ input: 1, output: 2 }], requests: 1, toolNames: [] };
    },
    abort() {
      this.aborted = true;
    },
    dispose() {},
    isBusy: () => false,
  };
}

test('buildNodePrompt：目标＋绑定输入＋输出契约齐全，JSON 契约在末尾', () => {
  const prompt = buildNodePrompt({
    nodeType: 'hemi-agent',
    nodeData: NODE_SPEC.nodeData,
    inputs: { topic: 'Q4 复盘', rows: ['a', 'b'] },
  });
  assert.match(prompt, /工作流节点执行/);
  assert.match(prompt, /按主题起草周报/);
  assert.match(prompt, /- topic = Q4 复盘/);
  assert.match(prompt, /- rows = \["a","b"\]/);
  assert.match(prompt, /- draft（string：正文）/);
  assert.match(prompt, /```json/);
});

test('buildNodePrompt：无输出 schema 时只要文字总结', () => {
  const prompt = buildNodePrompt({ nodeType: 'hemi-agent', nodeData: { goal: 'x' }, inputs: {} });
  assert.doesNotMatch(prompt, /```json/);
  assert.match(prompt, /用文字总结/);
});

test('parseNodeOutputs：json 围栏解析＋字段齐全', () => {
  const { outputs } = parseNodeOutputs({
    text: '前言\n```json\n{"draft": "正文稿", "count": 3}\n```',
    outputSchema: OUTPUT_SCHEMA,
  });
  assert.deepEqual(outputs, { draft: '正文稿', count: 3 });
});

test('parseNodeOutputs：缺块／坏 JSON／缺字段／类型错各自报错带 code', () => {
  assert.throws(() => parseNodeOutputs({ text: '没有块', outputSchema: OUTPUT_SCHEMA }), (e) => e.code === 'node-output-missing');
  assert.throws(() => parseNodeOutputs({ text: '```json\n{broken\n```', outputSchema: OUTPUT_SCHEMA }), (e) => e.code === 'node-output-invalid');
  assert.throws(
    () => parseNodeOutputs({ text: '```json\n{"draft": "x"}\n```', outputSchema: OUTPUT_SCHEMA }),
    (e) => e.code === 'node-output-missing-field' && e.field === 'count'
  );
  assert.throws(
    () => parseNodeOutputs({ text: '```json\n{"draft": true, "count": 1}\n```', outputSchema: OUTPUT_SCHEMA }),
    (e) => e.code === 'node-output-type-mismatch'
  );
});

test('parseNodeOutputs：number 字段收到数字串按 warning 宽收；无 schema 直接过', () => {
  const { outputs, warnings } = parseNodeOutputs({
    text: '```json\n{"draft": 42, "count": 3}\n```',
    outputSchema: OUTPUT_SCHEMA,
  });
  assert.equal(outputs.draft, '42');
  assert.equal(warnings.length, 1);
  assert.deepEqual(parseNodeOutputs({ text: '随便说说', outputSchema: null }).outputs, {});
});

test('extractOutputJson：json 围栏优先、普通围栏兜底、裸对象识别', () => {
  assert.equal(extractOutputJson('a\n```json\n{"x":1}\n```'), '{"x":1}');
  assert.equal(extractOutputJson('a\n```\n{"x":1}\n```'), '{"x":1}');
  assert.equal(extractOutputJson('{"x":1}'), '{"x":1}');
  assert.equal(extractOutputJson('纯文字'), null);
});

test('createWorkflowNodeAgent.run：提示词进 session、输出解析、usage 透传', async () => {
  const session = mockSession({ response: '结论\n```json\n{"draft": "稿", "count": 7}\n```' });
  const agent = createWorkflowNodeAgent({ session, nodeSpec: NODE_SPEC, executionOwner: { workflowRunId: 'w1', nodeId: 'agent-1', attemptId: 't1' } });
  const result = await agent.run({ inputs: { topic: '周报' } });
  assert.match(session.capture[0], /按主题起草周报/);
  assert.deepEqual(result.outputs, { draft: '稿', count: 7 });
  assert.deepEqual(result.usage, { input: 1, output: 2 });
  assert.equal(agent.ownerLabel, 'w1/agent-1/t1');
});

test('abort 贯通：runner 栅栏调用 agent.abort 到 session.abort', async () => {
  const session = mockSession({});
  const agent = createWorkflowNodeAgent({ session, nodeSpec: NODE_SPEC });
  agent.abort();
  assert.equal(session.aborted, true);
});

test('createNodeAgentExecutor：openAgent 注入、inputs 透传、outputs 返回、release 必达', async () => {
  const released = [];
  const seen = {};
  const executor = createNodeAgentExecutor({
    openAgent: async ({ nodeSpec, executionOwner }) => {
      seen.spec = nodeSpec;
      seen.owner = executionOwner;
      return {
        agent: {
          ownerLabel: `${executionOwner.workflowRunId}/${nodeSpec.nodeId}`,
          run: async ({ inputs }) => ({ outputs: { draft: inputs.topic }, text: '', usage: null }),
        },
        release: () => released.push(nodeSpec.nodeId),
      };
    },
  });
  const result = await executor.execute({
    node: { id: 'agent-1', type: 'hemi-agent', data: NODE_SPEC.nodeData },
    inputs: { topic: '周报' },
    workflowRunId: 'wrun-9',
  });
  assert.deepEqual(result.outputs, { draft: '周报' });
  assert.equal(seen.owner.workflowRunId, 'wrun-9');
  assert.deepEqual(released, ['agent-1'], '失败与否 release 都执行');
});

test('createNodeAgentExecutor：agent 抛错上抛且 release 仍执行', async () => {
  const released = [];
  const executor = createNodeAgentExecutor({
    openAgent: async () => ({
      agent: { ownerLabel: 'x', run: async () => { throw new Error('模型 503'); } },
      release: () => released.push('r'),
    }),
  });
  await assert.rejects(
    () =>
      executor.execute({
        node: { id: 'n', type: 'hemi-agent', data: {} },
        inputs: {},
        workflowRunId: 'w',
      }),
    /模型 503/
  );
  assert.deepEqual(released, ['r']);
});
