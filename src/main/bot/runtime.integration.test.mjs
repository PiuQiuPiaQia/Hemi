import {replyToGoalCheck} from '../../../scripts/lib/goal-model-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createBotHost } from './host.mjs';
import {validateCloudModel} from './runtime.mjs';
async function until(fn) {
  for (let i = 0; i < 400; i++) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('Timed out');
}

test(
  'actual Hemi SDK executes and registers a cloud file, returns its bytes, and resumes conversation after reload',
  { timeout: 30000 },
  async (t) => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-bot-sdk-')),
    );
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    const skillDir = path.join(workspace, '.agents/skills/cloud-review');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: cloud-review\ndescription: Cloud fixture review\n---\nRead the project before editing.',
    );
    const requests = [];
    const server = http.createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);if(replyToGoalCheck(body,res))return;
      requests.push(body);
      const text = JSON.stringify(body.messages);
      const tools = body.messages.filter((m) => m.role === 'tool');
      let tool = null,
        content = 'OK';
      if (text.includes('WRITE_CLOUD_PROOF')) {
        if (!tools.some((m) => m.tool_call_id === 'proof-bash'))
          tool = {
            id: 'proof-bash',
            type: 'function',
            function: {
              name: 'bash',
              arguments: JSON.stringify({
                command: process.platform === 'win32' ? 'node -e "require(\'fs\').writeFileSync(\'proof.md\',\'cloud runtime bytes\')"' : 'printf "cloud runtime bytes" > proof.md',
              }),
            },
          };
        else if (!tools.some((m) => m.tool_call_id === 'proof-delivery'))
          tool = {
            id: 'proof-delivery',
            type: 'function',
            function: {
              name: 'register_delivery',
              arguments: JSON.stringify({
                files: [{ path: 'proof.md', description: 'Linux Host proof' }],
              }),
            },
          };
        else content = '已完成：[proof.md](proof.md)';
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = {
        id: 'fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture-model',
      };
      res.write(
        'data: ' +
          JSON.stringify({
            ...base,
            choices: [
              {
                index: 0,
                delta: tool
                  ? { role: 'assistant', tool_calls: [{ ...tool, index: 0 }] }
                  : { role: 'assistant', content },
                finish_reason: null,
              },
            ],
          }) +
          '\n\n',
      );
      res.write(
        'data: ' +
          JSON.stringify({
            ...base,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: tool ? 'tool_calls' : 'stop',
              },
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 10,
              total_tokens: 30,
            },
          }) +
          '\n\n',
      );
      res.end('data: [DONE]\n\n');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const validationErrors=[];
    const options = {
      dataDir: path.join(root, 'data'),
      defaultDir: workspace,
      allowLoopbackModels: true,
      validateModel:async config=>{try{await validateCloudModel(config);}catch(error){validationErrors.push(String(error.stack)+' '+JSON.stringify(error.cause));throw error;}},
    };
    let host = await createBotHost(options);
    const hello = await host.request('handshake');
    const call = (method, p = {}) =>
      host.request(method, {
        instanceId: hello.instanceId,
        requestId: 'op-' + randomUUID(),
        ...p,
      });
    t.after(async () => {
      await host.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await fs.rm(root, { recursive: true, force: true });
    });
    const sync = await call('model.sync', {
      models: [
        {
          modelKey: 'test/fixture',
          providerId: 'test',
          name: 'Fixture',
          model: 'fixture-model',
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          api: 'openai-completions',
          apiKey: 'fixture-only-key',
          thinkingLevel: 'off',
        },
      ],
    });
    assert.equal(sync.results[0].ok, true, validationErrors.join('\n'));
    const session = await call('session.create');
    const result = await call('flow.command', {
      id: session.id,
      command: {
        type: 'send',
        input: {
          inputId: 'real-sdk-input',
          text: 'WRITE_CLOUD_PROOF',
          skills: [
            {
              skillId: 'project:cloud-review',
              source: 'project',
              name: 'cloud-review',
              token: 'cloud-review',
            },
          ],
        },
      },
    });
    assert.equal(result.ok, true);
    const detail = await until(async () => {
      const d = await call('session.open', { id: session.id });
      return d.flow.phase === 'idle' &&
        d.flow.timeline.some((i) => i.kind === 'assistant')
        ? d
        : null;
    });
    assert.equal(Object.values(detail.flow.runs).at(-1).outcome, 'completed');
    assert.equal(
      await fs.readFile(path.join(workspace, 'proof.md'), 'utf8'),
      'cloud runtime bytes',
    );
    const artifact = Object.values(detail.flow.artifacts)[0];
    assert.ok(artifact, 'a real verified deliverable must exist');
    const file = await call('file.download', {
      id: session.id,
      artifactId: artifact.artifactId,
    });
    assert.equal(
      Buffer.from(file.base64, 'base64').toString(),
      'cloud runtime bytes',
    );
    assert.ok(
      requests[1].tools.every(
        (t) =>
          !/^ui_|screen_view|app_open|vision/.test(t.function.name) || process.platform === 'win32',
      ),
    );
    assert.ok(requests[1].tools.some(tool => tool.function.name === 'browser_navigate'));
    assert.ok(requests[1].tools.some(tool => tool.function.name === 'conversation_read'));
    assert.ok(detail.usage.length >= 3);
    assert.ok(detail.usage.every(call => call.modelName === 'fixture-model' && call.providerName === 'Fixture'), '真实 SDK 调用分别保存供应商名与型号');
    assert.equal(JSON.stringify(detail).includes('fixture-only-key'), false);
    await host.close();
    host = await createBotHost(options);
    assert.deepEqual((await call('session.open', { id: session.id })).usage, detail.usage, '重启后保留用量的供应商名与型号');
    assert.equal(
      (await call('session.open', { id: session.id })).flow.timeline.length,
      detail.flow.timeline.length,
    );
    assert.ok(JSON.stringify(requests).includes('用户显式选择的技能'));
    assert.ok(JSON.stringify(requests).includes('cloud-review'));
  },
);
