import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createBotHost } from './host.mjs';
import { replyToGoalCheck } from '../../../scripts/lib/goal-model-fixture.mjs';

test('real SDK child stream, actual file tools and restart preserve a separate task conversation', { timeout: 30000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-child-flow-')));
  const dataDir = path.join(root, 'data'), workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'proof.txt'), 'CHILD_TOOL_PROOF');
  const thinking = Promise.withResolvers(), proceed = Promise.withResolvers();
  let host, instanceId, childCalls = 0;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (replyToGoalCheck(body, res)) return;
    const main = body.tools?.some(tool => tool.function.name === 'task');
    const afterTask = body.messages.some(message => message.role === 'tool');
    let tool;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
    if (main && !afterTask) tool = { id: 'dispatch-child', type: 'function', function: { name: 'task', arguments: JSON.stringify({ agent: 'fixer', description: '核对文件', prompt: '读取 proof.txt 并报告 CHILD_DONE。' }) } };
    else if (!main && childCalls++ === 0) {
      send({ role: 'assistant', reasoning_content: 'CHILD_THINKING_ONLY' });
      thinking.resolve();
      await proceed.promise;
      send({ content: 'CHILD_COMMENTARY_ONLY' });
      tool = { id: 'read-proof', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'proof.txt' }) } };
    } else send({ role: 'assistant', content: main ? 'ROOT_DONE' : 'CHILD_DONE' });
    if (tool) send({ role: 'assistant', tool_calls: [{ index: 0, ...tool }] });
    send({}, tool ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    proceed.resolve(); await host?.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  const start = async () => {
    host = await createBotHost({ dataDir, defaultDir: workspace, allowLoopbackModels: true, validateModel: async () => {} });
    ({ instanceId } = await host.request('handshake'));
  };
  const call = (method, params = {}) => host.request(method, { instanceId, requestId: randomUUID(), ...params });
  const wait = async predicate => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error('Child conversation did not reach expected state');
  };
  await start();
  await call('model.sync', { models: [{ modelKey: 'test/fixture', providerId: 'test', model: 'fixture', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'SYNTHETIC_ONLY' }] });
  const { id } = await call('session.create');
  await call('session.update', { id, modelKey: 'test/fixture' });
  await call('flow.command', { id, command: { type: 'send', input: { inputId: randomUUID(), text: '派一个 fixer 核对 proof.txt。' } } });
  await thinking.promise;
  const live = await wait(async () => {
    const flow = await call('flow.snapshot', { id });
    return JSON.stringify(Object.values(flow.tasks)).includes('CHILD_THINKING_ONLY') && flow;
  });
  assert.doesNotMatch(JSON.stringify(live.timeline), /CHILD_THINKING_ONLY/);
  const liveTask = Object.values(live.tasks)[0];
  assert.equal(liveTask.progressText, '正在思考');
  assert.equal(liveTask.phase, 'running');
  proceed.resolve();
  const finished = await wait(async () => { const flow = await call('flow.snapshot', { id }); return flow.phase === 'idle' && flow; });
  const task = Object.values(finished.tasks)[0];
  assert.equal(task.outcome, 'complete');
  const messages = task.conversation.messages;
  assert.deepEqual(messages.map(message => message.author), ['user', 'hemi', 'hemi']);
  assert.deepEqual(messages[1].parts.map(part => part.type), ['thinking', 'text', 'tools']);
  assert.equal(messages[1].parts[2].calls[0].output, 'CHILD_TOOL_PROOF');
  assert.equal(messages[1].parts[2].calls[0].state, 'done');
  assert.equal(messages[2].text, 'CHILD_DONE');
  assert.doesNotMatch(JSON.stringify(finished.timeline), /CHILD_(THINKING|COMMENTARY)_ONLY/);
  await host.close(); host = null; await start();
  const restored = await call('flow.snapshot', { id });
  assert.deepEqual(Object.values(restored.tasks)[0].conversation, task.conversation);
});
