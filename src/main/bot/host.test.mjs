import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createBotHost } from './host.mjs';
const tick = () => new Promise((r) => setTimeout(r, 30));
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-bot-test-')),
  );
  const calls = [],
    waiting = new Map();
  const executorFactory = () => ({
    run: async (spec, apply) => {
      calls.push(spec);
      return new Promise((resolve) =>
        waiting.set(spec.conversationId, { resolve, apply, spec }),
      );
    },
    stop: async (id) => waiting.get(id)?.resolve({ stopped: true }),
    decide: () => true,
    close: async () => {
      for (const w of waiting.values()) w.resolve({ stopped: true });
    },
  });
  const options = {
    dataDir: path.join(root, 'data'),
    defaultDir: path.join(root, 'workspace'),
    executorFactory,
    validateModel: async () => {},
    allowLoopbackModels: true,
  };
  let host = await createBotHost(options);
  let info = await host.request('handshake');
  const req = (method, p = {}) =>
    host.request(method, {
      instanceId: info.instanceId,
      requestId: 'op-' + randomUUID(),
      ...p,
    });
  t.after(async () => {
    await host.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const config = {
    modelKey: 'provider/model',
    providerId: 'provider',
    name: 'Fixture',
    model: 'fake',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:12345/v1',
    apiKey: 'TEST-SECRET',
  };
  await req('model.sync', { models: [config] });
  return {
    root,
    req,
    calls,
    waiting,
    config,
    get host() {
      return host;
    },
    async restart(afterClose) {
      await host.close();
      await afterClose?.(path.join(root, 'data/state.json'));
      host = await createBotHost(options);
      info = await host.request('handshake');
    },
  };
}
test('cloud sessions, models and credentials are isolated; duplicate request returns same creation', async (t) => {
  const f = await fixture(t),
    requestId = 'op-' + randomUUID();
  const first = await f.req('session.create', { requestId }),
    second = await f.req('session.create', { requestId });
  assert.deepEqual(first, second);
  const snapshot = await f.req('snapshot', { id: first.id });
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(JSON.stringify(snapshot).includes('TEST-SECRET'), false);
  await assert.rejects(
    () => f.host.request('snapshot', { instanceId: 'other' }),
    /身份不同/,
  );
  if (process.platform !== 'win32') assert.equal(
    (await fs.stat(path.join(f.root, 'data/state.json'))).mode & 0o777,
    0o600,
  );
});

test('正文路径可预览但不登记交付，链接身份隔离会话且不可作为交付下载', async t => {
  const f = await fixture(t);
  const a = await f.req('session.create'), b = await f.req('session.create');
  const target = path.join(f.root, 'workspace', '正文 100% 报告.md');
  await fs.writeFile(target, '# LINK_CONTENT');
  const stateFile = path.join(f.root, 'data/state.json');
  const before = await fs.readFile(stateFile, 'utf8');
  for (const link of [target, './正文 100% 报告.md', pathToFileURL(target).href]) {
    const resolved = await f.req('file.resolve', { id: a.id, path: link });
    assert.match(resolved.artifactId, /^link-/);
    const preview = await f.req('file.read', { id: a.id, artifactId: resolved.artifactId, path: resolved.path });
    assert.equal(preview.text, '# LINK_CONTENT');
    await assert.rejects(() => f.req('file.read', { id: b.id, artifactId: resolved.artifactId, path: resolved.path }), /不属于当前会话/);
    await assert.rejects(() => f.req('file.download', { id: a.id, artifactId: resolved.artifactId }), /未登记/);
  }
  assert.deepEqual((await f.req('flow.snapshot', { id: a.id })).artifacts, {});
  assert.equal(await fs.readFile(stateFile, 'utf8'), before);
});

test('正文路径预览重查范围、符号链接、文件类型与大小，拒绝控制数据和错误 URL', {skip: process.platform === 'win32' && 'Linux Host POSIX filesystem and symlinks'}, async t => {
  const f = await fixture(t), a = await f.req('session.create');
  const dir = path.join(f.root, 'workspace');
  const target = path.join(dir, 'report.md'), outside = path.join(f.root, 'outside.md');
  await fs.writeFile(target, 'allowed');
  await fs.writeFile(outside, 'outside');
  await fs.symlink(outside, path.join(dir, 'outside-link.md'));
  await fs.symlink(path.join(f.root, 'data/state.json'), path.join(dir, 'control-link.json'));
  const large = await fs.open(path.join(dir, 'large.md'), 'w');
  await large.truncate(20 * 1024 * 1024 + 1); await large.close();
  for (const link of ['../outside.md', './outside-link.md', './control-link.json', dir,
    './large.md', 'file://other-host/report.md', 'file:///bad%ZZ', 'https://example.test/report.md', './absent.md']) {
    await assert.rejects(() => f.req('file.resolve', { id: a.id, path: link }));
  }
  const resolved = await f.req('file.resolve', { id: a.id, path: target });
  await fs.unlink(target);
  await fs.symlink(outside, target);
  await assert.rejects(() => f.req('file.read', { id: a.id, artifactId: resolved.artifactId, path: resolved.path }), /允许范围/);
});

test('正文 ~/ 路径按 Host 家目录展开，读取后仍不生成交付记录', {skip: process.platform === 'win32' && 'Linux Host home and file URL semantics'}, async t => {
  const f = await fixture(t), a = await f.req('session.create');
  const dir = await fs.mkdtemp(path.join(os.homedir(), 'hemi-bot-link-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'notes.md');
  await fs.writeFile(target, 'HOME_LINK');
  const resolved = await f.req('file.resolve', { id: a.id, path: '~/' + path.relative(os.homedir(), target) });
  assert.equal((await f.req('file.read', { id: a.id, artifactId: resolved.artifactId, path: resolved.path })).text, 'HOME_LINK');
  assert.deepEqual((await f.req('flow.snapshot', { id: a.id })).artifacts, {});
});

test('draft model probes run on the Host without saving credentials or operations; list failures are safe', async t => {
  const f = await fixture(t);
  const before = await fs.readFile(path.join(f.root, 'data/state.json'), 'utf8');
  const headers = [];
  const server = http.createServer((request, response) => {
    headers.push(request.headers.authorization);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'remote-only' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const config = { ...f.config, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'DRAFT-ONLY-SECRET' };
  assert.deepEqual(await f.req('model.list', { config }), { ok: true, models: ['remote-only'] });
  assert.deepEqual(headers, ['Bearer DRAFT-ONLY-SECRET']);
  assert.equal((await f.req('model.test', { config })).ok, true);
  assert.equal(await fs.readFile(path.join(f.root, 'data/state.json'), 'utf8'), before);
  await assert.rejects(f.req('model.test', { config: { ...config, baseUrl: 'file:///tmp/example' } }), /地址无效/);
});

test('manual server-local models are accepted while imported desktop loopback URLs are rejected', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-bot-loopback-'));
  const host = await createBotHost({ dataDir: path.join(root, 'data'), defaultDir: path.join(root, 'workspace'), validateModel: async () => {} });
  t.after(async () => { await host.close(); await fs.rm(root, { recursive: true, force: true }); });
  const info = await host.request('handshake');
  const models = [{ modelKey: 'ollama/model', providerId: 'ollama', name: 'Server Ollama', model: 'qwen', api: 'openai-completions', baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama' }];
  const imported = await host.request('model.sync', { instanceId: info.instanceId, requestId: 'loopback-import', models });
  assert.equal(imported.results[0].ok, false);
  const manual = await host.request('model.sync', { instanceId: info.instanceId, requestId: 'loopback-manual', models, source: 'manual' });
  assert.equal(manual.results[0].ok, true);
});

test('manual providers save atomically when one model fails, so corrected retries create no duplicates', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-bot-manual-batch-'));
  const host = await createBotHost({ dataDir: path.join(root, 'data'), defaultDir: path.join(root, 'workspace'), validateModel: async config => { if (config.model === 'bad') throw new Error('fixture failure'); } });
  t.after(async () => { await host.close(); await fs.rm(root, { recursive: true, force: true }); });
  const info = await host.request('handshake');
  const config = { providerId: 'manual', name: 'Manual', api: 'openai-completions', baseUrl: 'https://model.example.test/v1', apiKey: 'BATCH-SECRET' };
  const models = ['good', 'bad'].map(model => ({ ...config, model, modelKey: 'manual/' + model }));
  const result = await host.request('model.sync', { instanceId: info.instanceId, requestId: 'manual-batch-fails', source: 'manual', models });
  assert.ok(result.results.every(result => result.ok === false));
  assert.equal((await host.request('snapshot', { instanceId: info.instanceId })).models.length, 0);
  await host.request('model.sync', { instanceId: info.instanceId, requestId: 'manual-batch-fixed', source: 'manual', models: [models[0]] });
  assert.equal((await host.request('snapshot', { instanceId: info.instanceId })).models.length, 1);
});
test('host runs different conversations independently and preserves each accepted model and directory', async (t) => {
  const f = await fixture(t),
    a = await f.req('session.create'),
    b = await f.req('session.create');
  const dir = path.join(f.root, 'other');
  await fs.mkdir(dir);
  await f.req('flow.command', {
    id: a.id,
    command: { type: 'send', input: { inputId: 'input-a', text: 'first' } },
  });
  await f.req('flow.command', {
    id: b.id,
    command: { type: 'send', input: { inputId: 'input-b', text: 'second' } },
  });
  await tick();
  assert.equal(f.calls.length, 2);
  assert.equal((await f.req('session.open', {id: a.id})).status, 'running');
  assert.equal((await f.req('session.open', {id: b.id})).status, 'running');
  await f.req('session.update', { id: b.id, dir });
  f.waiting.get(a.id).resolve({});
  await tick();
  assert.equal(f.calls.length, 2);
  assert.equal(
    f.calls[1].envelope.workspaceSnapshot.dir,
    path.join(f.root, 'workspace'),
  );
});
test('server directory lists real folders, rejects missing/control paths and only updates chosen session', async (t) => {
  const f = await fixture(t),
    a = await f.req('session.create'),
    b = await f.req('session.create'),
    dir = path.join(f.root, 'project');
  await fs.mkdir(dir);
  await fs.mkdir(path.join(dir, 'source'));
  await fs.writeFile(path.join(dir, 'readme.md'), 'test');
  const list = await f.req('directory.list', { path: dir });
  assert.deepEqual(
    list.folders.map((v) => v.name),
    ['source'],
  );
  await f.req('session.update', { id: a.id, dir });
  assert.equal(
    (await f.req('session.open', { id: b.id })).dir,
    path.join(f.root, 'workspace'),
  );
  await assert.rejects(
    () => f.req('directory.list', { path: path.join(f.root, 'absent') }),
    /找不到/,
  );
  await assert.rejects(
    () => f.req('session.update', { id: a.id, dir: path.join(f.root, 'data') }),
    /运行数据目录/,
  );
});
test('cloud model sync preserves earlier revision and failed update, returning no credentials', async (t) => {
  const f = await fixture(t),
    a = await f.req('session.create');
  await f.req('flow.command', {
    id: a.id,
    command: { type: 'send', input: { inputId: 'frozen', text: 'run' } },
  });
  await tick();
  const frozen = f.calls[0].envelope.modelPolicySnapshot.revision;
  await f.req('model.sync', {
    models: [{ ...f.config, apiKey: 'NEW-SECRET' }],
  });
  assert.notEqual((await f.req('snapshot')).models[0].revision, frozen);
  assert.equal(f.calls[0].envelope.modelPolicySnapshot.revision, frozen);
  const r = await f.req('model.sync', {
    models: [{ ...f.config, apiKey: '', oauthProvider: 'anthropic' }],
  });
  assert.equal(r.results[0].ok, false);
  assert.equal(JSON.stringify(r).includes('NEW-SECRET'), false);
});
test('server drafts and attachments restore after Host restart, cross-session read rejected', async (t) => {
  const f = await fixture(t),
    a = await f.req('session.create'),
    b = await f.req('session.create');
  await f.req('session.draft', { id: a.id, text: 'saved draft', revision: 1 });
  const upload = await f.req('attachment.add', {
    id: a.id,
    name: 'brief.md',
    base64: Buffer.from('# remote bytes').toString('base64'),
  });
  await f.restart();
  assert.equal(
    (await f.req('session.open', { id: a.id })).draft.text,
    'saved draft',
  );
  assert.match(
    (
      await f.req('attachment.read', {
        id: a.id,
        attachmentId: upload.attachment.attachmentId,
      })
    ).text,
    /remote bytes/,
  );
  await assert.rejects(
    () =>
      f.req('attachment.read', {
        id: b.id,
        attachmentId: upload.attachment.attachmentId,
      }),
    /不属于/,
  );
});
test('stopping Host cancels work, blocks new tasks and preserves records for explicit restart', async (t) => {
  const f = await fixture(t),
    a = await f.req('session.create');
  await f.req('flow.command', {
    id: a.id,
    command: { type: 'send', input: { inputId: 'stop-input', text: 'work' } },
  });
  await tick();
  await f.req('service.stop');
  await tick();
  assert.equal((await f.req('snapshot')).enabled, false);
  await assert.rejects(
    () =>
      f.req('flow.command', {
        id: a.id,
        command: { type: 'send', input: { inputId: 'blocked', text: 'no' } },
      }),
    /已停止/,
  );
  await f.req('service.start');
  assert.equal(
    (await f.req('session.open', { id: a.id })).flow.timeline[0].text,
    'work',
  );
});

test('maintenance waits for idle, blocks new work until completion, receipts survive restart without private model data', async (t) => {
  const f = await fixture(t),
    a = await f.req('session.create');
  await f.req('maintenance.begin');
  await assert.rejects(
    () =>
      f.req('flow.command', {
        id: a.id,
        command: {
          type: 'send',
          input: { inputId: 'maintenance-blocked', text: 'wait' },
        },
      }),
    /正在维护/,
  );
  await f.req('maintenance.end');
  await f.req('model.sync', {
    requestId: 'known-model-sync',
    models: [
      { ...f.config, baseUrl: f.config.baseUrl + '?api_key=QUERY-SECRET' },
    ],
  });
  await f.restart();
  const receipt = await f.req('operation.get', {
    operationId: 'known-model-sync',
  });
  assert.equal(receipt.status, 'done');
  assert.equal(JSON.stringify(receipt).includes('QUERY-SECRET'), false);
  assert.equal(
    JSON.stringify(await f.req('snapshot')).includes('QUERY-SECRET'),
    false,
  );
  assert.equal(
    JSON.stringify(await f.req('diagnostics')).includes('TEST-SECRET'),
    false,
  );
  assert.equal(
    (await f.req('operation.get', { operationId: 'never-received' })).status,
    'missing',
  );
  await f.req('flow.command', {
    id: a.id,
    command: {
      type: 'send',
      input: { inputId: 'maintenance-running', text: 'work' },
    },
  });
  await tick();
  await assert.rejects(() => f.req('maintenance.begin'), /仍有工作/);
});

test('rewind freezes current cloud model/directory while retaining original uploaded attachments', async (t) => {
  const f = await fixture(t),
    a = await f.req('session.create');
  const attachment = (
    await f.req('attachment.add', {
      id: a.id,
      name: 'brief.md',
      base64: Buffer.from('cloud brief').toString('base64'),
    })
  ).attachment;
  await f.req('flow.command', {
    id: a.id,
    command: {
      type: 'send',
      input: {
        inputId: 'rewind-original',
        text: 'first',
        attachmentIds: [attachment.attachmentId],
      },
    },
  });
  await tick();
  f.waiting.get(a.id).resolve({});
  await tick();
  const directory = path.join(f.root, 'replacement');
  await fs.mkdir(directory);
  await f.req('session.update', { id: a.id, dir: directory });
  const result = await f.req('flow.command', {
    id: a.id,
    command: {
      type: 'rewind',
      targetInputId: 'rewind-original',
      input: { inputId: 'rewind-replacement', text: 'changed' },
    },
  });
  assert.equal(result.ok, true);
  await tick();
  assert.equal(f.calls.at(-1).envelope.workspaceSnapshot.dir, directory);
  assert.deepEqual(f.calls.at(-1).envelope.attachmentIds, [
    attachment.attachmentId,
  ]);
  assert.ok(f.calls.at(-1).envelope.modelPolicySnapshot.revision);
  f.waiting.get(a.id).resolve({});
  await tick();
  assert.equal(f.calls.filter(call => call.envelope.inputId === 'rewind-replacement').length, 1);
  const completed = await f.req('flow.snapshot', { id: a.id });
  assert.equal(completed.phase, 'idle');
  assert.equal(completed.generation, 2);
});

test('a delayed stop keeps its original run target after a rewind changes generation', async t => {
  const f = await fixture(t), {id} = await f.req('session.create');
  await f.req('flow.command', {id, command: {type: 'send', input: {inputId: 'original-stop-target', text: 'original'}}});
  await tick();
  const original = await f.req('flow.snapshot', {id});
  await f.req('flow.command', {id, generation: original.generation, command: {type: 'rewind', targetInputId: 'original-stop-target', input: {inputId: 'new-stop-target', text: 'new'}}});
  await tick();
  const current = await f.req('flow.snapshot', {id});
  assert.equal(current.generation, original.generation + 1);
  assert.notEqual(current.activeRunId, original.activeRunId);
  const delayed = await f.req('flow.command', {id, generation: original.generation, command: {type: 'stop', targetRunId: original.activeRunId}});
  assert.deepEqual(delayed, {ok: false, code: 'run-changed'});
  assert.equal((await f.req('flow.snapshot', {id})).activeRunId, current.activeRunId);
  f.waiting.get(id).resolve({}); await tick();
  assert.equal((await f.req('flow.snapshot', {id})).runs[current.activeRunId].outcome, 'completed');
});

test('deleting a running session waits for cancellation and leaves other sessions and Host usable', async (t) => {
  const f = await fixture(t),
    a = await f.req('session.create'),
    b = await f.req('session.create');
  assert.equal(
    (await f.req('snapshot')).sessions.find((s) => s.id === a.id).status,
    null,
  );
  await f.req('flow.command', {
    id: a.id,
    command: {
      type: 'send',
      input: { inputId: 'delete-running', text: 'work' },
    },
  });
  await tick();
  await f.req('session.remove', { id: a.id });
  const snapshot = await f.req('snapshot', { id: a.id });
  assert.equal(snapshot.detail, undefined);
  assert.deepEqual(
    snapshot.sessions.map((s) => s.id),
    [b.id],
  );
  await f.req('flow.command', {
    id: b.id,
    command: { type: 'send', input: { inputId: 'after-delete', text: 'next' } },
  });
  await tick();
  assert.equal(f.calls.at(-1).conversationId, b.id);
});
test('a Host restart marks unfinished operation receipts interrupted and never replays them', async (t) => {
  const f = await fixture(t);
  await f.restart(async (file) => {
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    state.operations['lost-sync'] = { status: 'pending', hash: 'fixture' };
    await fs.writeFile(file, JSON.stringify(state));
  });
  assert.equal(
    (await f.req('operation.get', { operationId: 'lost-sync' })).status,
    'interrupted',
  );
  assert.equal(f.calls.length, 0);
});

test('queued inputs keep the original model secret until their final run settles, then rotation removes it', async (t) => {
  const f = await fixture(t),
    a = await f.req('session.create'),
    b = await f.req('session.create');
  await f.req('flow.command', {
    id: a.id,
    command: {
      type: 'send',
      input: { inputId: 'rotating-active', text: 'active' },
    },
  });
  await tick();
  const revision = f.calls[0].envelope.modelPolicySnapshot.revision;
  await f.req('flow.command', {
    id: a.id,
    command: {
      type: 'send',
      input: { inputId: 'rotating-pending', text: 'pending' },
    },
  });
  await f.req('flow.command', {
    id: b.id,
    command: {
      type: 'send',
      input: { inputId: 'rotating-other', text: 'other' },
    },
  });
  await f.req('model.sync', {
    models: [{ ...f.config, apiKey: 'ROTATED-KEY' }],
  });
  // Avoid an open async Windows read handle while the same process commits.
  const state = () => JSON.parse(readFileSync(path.join(f.root, 'data/state.json'), 'utf8'));
  assert.ok((await state()).versions[revision]);
  f.waiting.get(a.id).resolve({});
  await tick();
  assert.equal(f.calls[1].envelope.modelPolicySnapshot.revision, revision);
  assert.ok((await state()).versions[revision]);
  f.waiting.get(b.id).resolve({});
  await tick();
  assert.equal(f.calls[2].envelope.inputId, 'rotating-pending');
  assert.equal(f.calls[2].envelope.modelPolicySnapshot.revision, revision);
  assert.ok((await state()).versions[revision]);
  f.waiting.get(a.id).resolve({});
  await tick();
  assert.equal((await state()).versions[revision], undefined);
});

test('new chats remember the last opened/selected model and always start in the built-in workspace', async t => {
  const f = await fixture(t);
  const other = { ...f.config, modelKey: 'provider/other', model: 'other' };
  await f.req('model.sync', { models: [other] });
  const a = await f.req('session.create'), b = await f.req('session.create');
  const custom = path.join(f.root, 'custom-project'); await fs.mkdir(custom);
  await f.req('session.update', { id: b.id, modelKey: other.modelKey, dir: custom });
  const c = await f.req('session.create');
  assert.equal((await f.req('session.open', { id: c.id, activate: false })).modelKey, other.modelKey);
  assert.equal((await f.req('session.open', { id: c.id, activate: false })).dir, path.join(f.root, 'workspace'));
  assert.equal((await f.req('session.open', { id: a.id, activate: false })).modelKey, f.config.modelKey);
  const d = await f.req('session.create');
  assert.equal((await f.req('session.open', { id: d.id, activate: false })).modelKey, other.modelKey, 'background reads do not change model preference');
  await f.req('session.open', { id: a.id });
  await f.restart();
  const e = await f.req('session.create');
  assert.equal((await f.req('session.open', { id: e.id, activate: false })).modelKey, f.config.modelKey, 'opening a chat is remembered across Host restart');
  await f.req('session.update', { id: e.id, modelKey: other.modelKey });
  await assert.rejects(f.req('session.update', { id: e.id, modelKey: 'missing/model' }));
  await f.restart();
  const g = await f.req('session.create');
  assert.equal((await f.req('session.open', { id: g.id, activate: false })).modelKey, other.modelKey, 'model choice survives restart and invalid selections');
  assert.equal((await f.req('session.open', { id: b.id, activate: false })).dir, custom, 'other chats keep their own directory');
});

test('crashed background run restores one authoritative idle state for detail, catalog and disk, preserving the paused queue', async t => {
  const f=await fixture(t),session=await f.req('session.create');
  await f.restart(async file=>{
    const state=JSON.parse(await fs.readFile(file,'utf8')),flow=state.sessions[session.id].flow;
    flow.phase='running';flow.activeRunId='crashed';
    flow.runs.crashed={runId:'crashed',startedAt:1,closedAt:null,outcome:null,activity:{phase:'waiting-background',jobs:[{id:'push'}]}};
    flow.timeline=[{kind:'assistant',runId:'crashed',parts:[{kind:'tool',partId:'push',status:'running'}]}];
    flow.pending=[{inputId:'queued',state:'pending',text:'keep queued input'}];
    await fs.writeFile(file,JSON.stringify(state));
  });
  const detail=await f.req('session.open',{id:session.id}),catalog=await f.req('snapshot');
  assert.equal(detail.status,null);assert.equal(catalog.sessions.find(x=>x.id===session.id).status,null);
  assert.equal(detail.flow.activeRunId,null);assert.equal(detail.flow.runs.crashed.activity,null);
  assert.equal(detail.flow.timeline[0].parts[0].status,'stopped');assert.equal(detail.flow.queuePaused,true);
  assert.equal(detail.flow.pending[0].text,'keep queued input');assert.equal(f.calls.length,0);
  const disk=JSON.parse(await fs.readFile(path.join(f.root,'data/state.json'),'utf8'));
  assert.deepEqual(disk.sessions[session.id].flow,detail.flow);
});
