import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createBotHost } from './host.mjs';
import { replyToGoalCheck } from '../../../scripts/lib/goal-model-fixture.mjs';

test('real Bot restart gives new child tasks durable identities and preserves older terminal records', { timeout: 30000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-task-identity-')));
  const dataDir = path.join(root, 'data'), workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  let host, instanceId, phase = 0;
  const dispatched = new Set();
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (replyToGoalCheck(body, res)) return;
    const main = body.tools?.some(tool => tool.function.name === 'task');
    let tool;
    if (main && !dispatched.has(phase)) {
      dispatched.add(phase);
      tool = { index: 0, id: `spawn-${phase}`, type: 'function', function: { name: 'task', arguments: JSON.stringify({ agent: 'fixer', description: `child ${phase}`, prompt: `Report CHILD_DONE_${phase} without tools.` }) } };
    }
    const delta = tool ? { role: 'assistant', tool_calls: [tool] } : { role: 'assistant', content: main ? 'ROOT_DONE' : `CHILD_DONE_${phase}` };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [part, finish] of [[delta, null], [{}, tool ? 'tool_calls' : 'stop']]) res.write('data: ' + JSON.stringify({ id: randomUUID(), model: 'fixture', choices: [{ index: 0, delta: part, finish_reason: finish }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await host?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  const start = async () => {
    host = await createBotHost({ dataDir, defaultDir: workspace, allowLoopbackModels: true, validateModel: async () => {} });
    ({ instanceId } = await host.request('handshake'));
  };
  const call = (method, params = {}) => host.request(method, { instanceId, requestId: randomUUID(), ...params });
  await start();
  await call('model.sync', { models: [{ modelKey: 'test/main', providerId: 'test', model: 'fixture', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'SYNTHETIC_ONLY' }] });
  const { id } = await call('session.create');
  await call('session.update', { id, modelKey: 'test/main' });
  const send = async () => {
    await call('flow.command', { id, command: { type: 'send', input: { inputId: randomUUID(), text: `Delegate one child task, phase ${phase}.` } } });
    const deadline = Date.now() + 10000;
    while (true) {
      const flow = await call('flow.snapshot', { id });
      if (flow.phase === 'idle' && Object.keys(flow.runs).length === phase + 1) {
        assert.ok(Object.values(flow.runs).every(run => run.outcome === 'completed'), JSON.stringify(flow.timeline.flatMap(item => item.parts ?? []).filter(part => part.kind === 'notice')));
        return;
      }
      assert.ok(Date.now() < deadline, 'Bot did not settle');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const journal = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'runtime-v2/run-journal.json'), 'utf8'));
  await send();
  const before = await journal();
  assert.equal(Object.keys(before.tasks).length, 1);
  await host.close(); host = null;
  phase++;
  await start();
  await send();
  const after = await journal();
  assert.equal(Object.keys(after.tasks).length, 2);
  for (const [key, value] of Object.entries(before.tasks)) assert.deepEqual(after.tasks[key], value);
  assert.equal(new Set(Object.values(after.tasks).map(task => task.owner.taskId)).size, 2);
  assert.ok(Object.values(after.dispatches).every(dispatch => dispatch.state === 'terminal'));
});
