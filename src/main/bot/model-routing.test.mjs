import {replyToGoalCheck} from '../../../scripts/lib/goal-model-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createBotHost } from './host.mjs';
import { manualProviderModels } from './models.mjs';

async function until(read) {
  const end = Date.now() + 15000;
  for (;;) { const value = await read(); if (value) return value; if (Date.now() > end) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 15)); }
}
async function fixture(t, extra = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-bot-routing-')));
  const host = await createBotHost({ dataDir: path.join(root, 'data'), defaultDir: path.join(root, 'workspace'), validateModel: async () => {}, ...extra });
  const hello = await host.request('handshake');
  const call = (method, params = {}) => host.request(method, { instanceId: hello.instanceId, requestId: randomUUID(), ...params });
  t.after(async () => { await host.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, host, call };
}
const configs = (baseUrl = 'https://fixture.invalid/v1', apiKey = 'PRIVATE-OLD') => ['main', 'explorer', 'oracle', 'fixer', 'designer', 'fallback'].map(role => ({ modelKey: `local/${role}`, providerId: 'local', name: 'Local', model: `${role}-model`, api: 'openai-completions', baseUrl, apiKey, supportsVision: role === 'designer' }));
const roleModels = Object.fromEntries(['main', 'explorer', 'oracle', 'fixer', 'designer', 'fallback'].map(role => [role, `local/${role}`]));

test('local origin is read-only in cloud, cloud edit preserves keys and stable IDs, and source is persisted without exposing credentials', async t => {
  const f = await fixture(t);
  await f.call('model.sync', { models: configs() });
  let result = await f.call('model.sync', { source: 'manual', models: [{ ...configs()[0], apiKey: 'OVERWRITE' }] });
  assert.equal(result.results[0].ok, false);
  const models = manualProviderModels({ name: 'Cloud', baseUrl: 'http://localhost:1234/v1', apiKey: 'PRIVATE-CLOUD', models: [{ model: 'cloud-original' }] }, 'cloud-operation');
  result = await f.call('model.sync', { source: 'manual', models });
  assert.equal(result.results[0].ok, true);
  const edited = manualProviderModels({ id: models[0].providerId, name: 'Cloud edited', baseUrl: models[0].baseUrl, models: [{ id: 'm-0', model: 'cloud-edited' }, { id: 'another', model: 'cloud-new' }] }, 'cloud-edit');
  result = await f.call('model.sync', { source: 'manual', models: edited });
  assert.ok(result.results.every(model => model.ok));
  assert.equal(result.models.find(model => model.key === models[0].modelKey).source, 'cloud');
  assert.equal(result.models.find(model => model.key === models[0].modelKey).model, 'cloud-edited');
  assert.ok(result.models.filter(model => model.providerId === 'local').every(model => model.source === 'local'));
  const state = JSON.parse(await fs.readFile(path.join(f.root, 'data/state.json'), 'utf8'));
  assert.ok(edited.every(model => state.versions[state.models[model.modelKey]].apiKey === 'PRIVATE-CLOUD'));
  assert.ok(!JSON.stringify(await f.call('snapshot')).includes('PRIVATE-'));
  result = await f.call('model.sync', { models: [{ ...models[0], model: 'LOCAL-OVERWRITE' }] });
  assert.equal(result.results[0].ok, false);
});

test('automatic policy freezes all role and fallback revisions, keeps queued secrets private, and prunes only after settlement', async t => {
  const runs = [];
  const f = await fixture(t, { executorFactory: ({ getModel }) => ({
    run(spec) { return new Promise(resolve => runs.push({ spec, resolve, getModel })); },
    stop() { for (const run of runs) run.resolve({ stopped: true }); }, decide() { return false; }, close() { for (const run of runs) run.resolve({ stopped: true }); },
  }) });
  await f.call('model.sync', { models: configs() });
  await f.call('model.local-config', { keys: configs().map(model => model.modelKey), roleModels });
  const { id } = await f.call('session.create');
  assert.equal((await f.call('session.open', { id })).modelKey, 'auto');
  await f.call('flow.command', { id, command: { type: 'send', input: { inputId: 'auto-first', text: 'run' } } });
  await until(() => runs.length === 1);
  await f.call('flow.command', { id, command: { type: 'send', input: { inputId: 'auto-queued', text: 'queued' } } });
  const old = runs[0].spec.envelope.modelPolicySnapshot;
  assert.equal(old.mode, 'routed'); assert.equal(Object.keys(old.revisions).length, 6);
  assert.ok(!JSON.stringify(old).includes('PRIVATE-'));
  await f.call('model.sync', { models: configs(undefined, 'PRIVATE-NEW') });
  await f.call('model.local-config', { keys: configs().map(model => model.modelKey), roleModels: { main: 'local/fallback' } });
  for (const [key, revision] of Object.entries(old.revisions)) assert.equal(runs[0].getModel(key, revision).apiKey, 'PRIVATE-OLD');
  runs[0].resolve({}); await until(() => runs.length === 2);
  for (const [key, revision] of Object.entries(runs[1].spec.envelope.modelPolicySnapshot.revisions)) assert.equal(runs[1].getModel(key, revision).apiKey, 'PRIVATE-OLD');
  runs[1].resolve({}); await until(async () => !(await f.call('session.open', { id })).flow.activeRunId);
  const state = JSON.parse(await fs.readFile(path.join(f.root, 'data/state.json'), 'utf8'));
  assert.ok(!JSON.stringify(state.versions).includes('PRIVATE-OLD'));
  await assert.rejects(() => f.call('model.local-config', { keys: ['local/main'], roleModels }), /原路由保留/);
  assert.deepEqual((await f.call('snapshot')).roleModels, { main: 'local/fallback' });
});

function sse(res, model, { content = 'OK', tools = [] } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = delta => 'data: ' + JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n';
  res.write(chunk(tools.length ? { role: 'assistant', tool_calls: tools.map((tool, index) => ({ index, id: `task-${index}`, type: 'function', function: { name: tool._toolName ?? 'task', arguments: JSON.stringify(Object.fromEntries(Object.entries(tool).filter(([key]) => key !== '_toolName'))) } })) } : { role: 'assistant', content }));
  res.write('data: ' + JSON.stringify({ id: 'end', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: tools.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
test('real Hemi SDK selects each role model, falls back for main and roles, and keeps fixed mode on its exact model', { timeout: 60000, skip: process.platform === 'win32' && 'Linux Host role commands and POSIX paths' }, async t => {
  const requests = [];
  let blockedReview = false;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);if(replyToGoalCheck(body,res))return;const  text = JSON.stringify(body.messages); requests.push(body);
    const isChild = text.includes('ROLE_WORK');
    if (body.model === 'shared-model' && req.url.includes('/primary/')) { res.writeHead(503); res.end('temporary failure'); return; }
    if (body.model === 'main-model' && text.includes('BG_STOP') && body.messages.filter(message => message.role === 'user').length > 1) { blockedReview = true; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); return; }
    if (body.model === 'main-model' && text.includes('FAIL_MAIN') || body.model === 'oracle-model' && text.includes('FAIL_ROLE')) {
      res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'temporary failure', type: 'server_error' } })); return;
    }
    if (body.model === 'main-model' && !isChild && text.includes('BACKGROUND_ROLE') && !body.messages.some(message => message.role === 'tool')) {
      sse(res, body.model, { tools: [{ agent: 'fixer', description: 'background', prompt: 'ROLE_WORK BACKGROUND_ROLE', background: true }] }); return;
    }
    if (body.model === 'main-model' && !isChild && text.includes('CHILD_PERMISSION') && !body.messages.some(message => message.role === 'tool')) {
      const prompt = 'CHILD_PERMISSION TARGET=' + text.match(/TARGET=([^\s"\\]+)/)?.[1];
      sse(res, body.model, { tools: [{ agent: 'fixer', description: 'write', prompt: 'ROLE_WORK ' + prompt }] }); return;
    }
    if (body.model === 'fixer-model' && isChild && text.includes('CHILD_PERMISSION') && !body.messages.some(message => message.role === 'tool')) {
      const file = text.match(/TARGET=([^\s"\\]+)/)?.[1];
      sse(res, body.model, { tools: [{ _toolName: 'bash', command: `rm -rf -- '${file}'` }] }); return;
    }
    if (isChild && text.includes('BACKGROUND_ROLE')) await new Promise(resolve => setTimeout(resolve, 120));
    if (body.model === 'main-model' && !isChild && text.includes('ROUTE_ROLES') && !body.messages.some(message => message.role === 'tool')) {
      sse(res, body.model, { tools: ['explorer', 'oracle', 'fixer', 'designer'].map(agent => ({ agent, description: agent, prompt: 'ROLE_WORK ' + agent + (agent === 'oracle' ? ' FAIL_ROLE' : '') })) }); return;
    }
    sse(res, body.model, { content: isChild ? 'ROLE_DONE ' + body.model : 'ROOT_DONE ' + body.model });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const f = await fixture(t, { allowLoopbackModels: true });
  await f.call('model.sync', { models: configs(`http://127.0.0.1:${server.address().port}/v1`) });
  await f.call('model.local-config', { keys: configs().map(model => model.modelKey), roleModels });
  const { id } = await f.call('session.create');
  async function send(inputId, text) {
    const before = requests.length;
    await f.call('flow.command', { id, command: { type: 'send', input: { inputId, text } } });
    await until(async () => { const detail = await f.call('session.open', { id }); return requests.length > before && !detail.flow.activeRunId && !detail.flow.pending.length && detail; });
    return requests.slice(before);
  }
  let calls = await send('role-routing', 'ROUTE_ROLES');
  for (const name of ['explorer', 'oracle', 'fixer', 'designer', 'fallback']) assert.ok(calls.some(call => call.model === `${name}-model`), `${name} routed`);
  assert.ok(calls.filter(call => call.model === 'explorer-model').every(call => !call.tools?.some(tool => ['task', 'write', 'bash'].includes(tool.function.name))), 'read-only roles keep their tool boundary');
  const detail = await f.call('session.open', { id });
  assert.ok(detail.usage.some(call => call.role === 'oracle' && call.modelKey === 'local/fallback'));
  const bg = await f.call('session.create'), bgBefore = requests.length;
  await f.call('flow.command', { id: bg.id, command: { type: 'send', input: { inputId: 'bg-role', text: 'BACKGROUND_ROLE' } } });
  await until(async () => { const d = await f.call('session.open', { id: bg.id }); return d.usage.length >= 4 && !d.flow.activeRunId; });
  assert.ok(requests.slice(bgBefore).filter(call => call.model === 'main-model').length >= 3, 'main reviews the background handoff before completing');
  const permissionSession = await f.call('session.create'), target = path.join(f.root, 'outside-workspace.txt');
  await fs.writeFile(target, 'isolated permission fixture');
  await f.call('flow.command', { id: permissionSession.id, command: { type: 'send', input: { inputId: 'child-permission', text: 'CHILD_PERMISSION TARGET=' + target } } });
  const permission = await until(async () => Object.values((await f.call('session.open', { id: permissionSession.id })).permissions).find(permission => permission.status === 'pending'));
  assert.equal(await fs.readFile(target, 'utf8'), 'isolated permission fixture');
  await f.call('permission.decide', { id: permissionSession.id, permissionId: permission.id, value: permission.options[0] });
  await until(async () => { const d = await f.call('session.open', { id: permissionSession.id }); return d.usage.length >= 3 && !d.flow.activeRunId; });
  assert.equal(await fs.access(target).then(() => true, () => false), false);
  const stopped = await f.call('session.create');
  await f.call('flow.command', { id: stopped.id, command: { type: 'send', input: { inputId: 'stop-background-review', text: 'BACKGROUND_ROLE BG_STOP' } } });
  await until(() => blockedReview);
  const active = (await f.call('session.open', { id: stopped.id })).flow.activeRunId;
  await Promise.race([
    f.call('flow.command', { id: stopped.id, command: { type: 'stop', targetRunId: active } }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('background review did not stop')), 3000); timer.unref(); }),
  ]);
  await until(async () => !(await f.call('session.open', { id: stopped.id })).flow.activeRunId);
  const fixedRoles = await f.call('session.create'), fixedRoleBefore = requests.length;
  await f.call('session.update', { id: fixedRoles.id, modelKey: 'local/main' });
  await f.call('flow.command', { id: fixedRoles.id, command: { type: 'send', input: { inputId: 'fixed-roles', text: 'ROUTE_ROLES' } } });
  await until(async () => { const d = await f.call('session.open', { id: fixedRoles.id }); return d.usage.length >= 6 && !d.flow.activeRunId; });
  assert.ok(requests.slice(fixedRoleBefore).every(call => call.model === 'main-model'), 'fixed roles use the exact main selection');
  const another = await f.call('session.create');
  await f.call('session.update', { id: another.id, modelKey: 'auto' });
  await f.call('flow.command', { id: another.id, command: { type: 'send', input: { inputId: 'fallback-main', text: 'FAIL_MAIN' } } });
  await until(async () => { const d = await f.call('session.open', { id: another.id }); return d.usage.some(call => call.modelKey === 'local/fallback') && !d.flow.activeRunId; });
  const fixed = await f.call('session.create');
  await f.call('session.update', { id: fixed.id, modelKey: 'local/main' });
  const before = requests.length;
  await f.call('flow.command', { id: fixed.id, command: { type: 'send', input: { inputId: 'fixed-main', text: 'FAIL_MAIN' } } });
  // The shared runtime recovers transient failures on a fixed model. Stop that
  // actual recovery instead of waiting for its production thirty-minute deadline.
  const recovering = await until(async () => { const d = await f.call('session.open', { id: fixed.id }); return d.flow.runs[d.flow.activeRunId]?.recovery?.phase === 'waiting' && d; });
  await f.call('flow.command', {id: fixed.id, command: {type: 'stop', targetRunId: recovering.flow.activeRunId}});
  await until(async () => !(await f.call('session.open', {id: fixed.id})).flow.activeRunId);
  assert.ok(requests.slice(before).every(call => call.model === 'main-model'), 'fixed mode must not borrow the fallback');
  const shared = ['main', 'backup'].map(name => ({ modelKey: 'same/' + name, providerId: 'same', name: 'Same model ID', model: 'shared-model', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/${name === 'main' ? 'primary' : 'backup'}/v1`, apiKey: 'FIXTURE_KEY' }));
  await f.call('model.sync', { models: shared });
  await f.call('model.local-config', { keys: [...configs().map(model => model.modelKey), ...shared.map(model => model.modelKey)], roleModels: { main: 'same/main', fallback: 'same/backup' } });
  const same = await f.call('session.create');
  await f.call('session.update', { id: same.id, modelKey: 'auto' });
  await f.call('flow.command', { id: same.id, command: { type: 'send', input: { inputId: 'same-model-fallback', text: 'Reply' } } });
  const routed = await until(async () => { const d = await f.call('session.open', { id: same.id }); return d.usage.some(call => call.modelKey === 'same/backup') && !d.flow.activeRunId && d; });
  assert.ok(routed.usage.some(call => call.modelKey === 'same/main'));
  assert.ok(routed.usage.every(call => call.modelName === 'shared-model'));

});
