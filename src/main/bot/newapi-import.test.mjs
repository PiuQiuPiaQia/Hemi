import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createBotHost } from './host.mjs';
import { createBotDesktopService } from './desktop-service.mjs';
import { oauthTestReply, waitForOAuth } from '../../../scripts/oauth-test-fixture.mjs';

test('New API import saves only to its Bot: real protocol validation/inference, encrypted versions, atomic receipts, edit and restart', { timeout: 60000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-bot-newapi-'));
  const secret = 'NEWAPI-BOT-PRIVATE-KEY', calls = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ body, authorization: req.headers.authorization, key: req.headers['x-api-key'] });
    const reply = oauthTestReply('https://fixture.invalid' + req.url, { body });
    res.writeHead(reply.status, Object.fromEntries(reply.headers)); res.end(Buffer.from(await reply.arrayBuffer()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dataDir = path.join(root, 'server');
  let host = await createBotHost({ dataDir, defaultDir: path.join(root, 'workspace') });
  const hello = await host.request('handshake');
  const call = (method, params = {}) => host.request(method, { instanceId: hello.instanceId, requestId: randomUUID(), ...params });
  const desktop = createBotDesktopService({ userDataDir: path.join(root, 'desktop'), runner: {}, profiles: { list: async () => ({ providers: [] }) }, autoComponentUpdates: false,
    transport: { rpc: (_target, method, params) => host.request(method, params), probe: async () => ({ bot: await host.request('handshake'), home: root }), disconnect: async () => {} } });
  t.after(async () => { await desktop.close(); await host.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const candidate = await desktop.connect({ host: 'fixture' });
  await desktop.initialize({ candidateId: candidate.candidate.id, accountSetup: true });
  const store = desktop.importProfiles(hello.instanceId);
  await store.list();
  const base = `http://127.0.0.1:${server.address().port}`;
  const input = { operationId: 'pi-bot-import-test', planHash: createHash('sha256').update('test-plan').digest('hex'), providers: [
    { deterministicId: 'mpi-openai', name: 'Site · OpenAI', api: 'openai-completions', baseUrl: base + '/v1', apiKey: secret, models: [{ model: 'site-gpt' }] },
    { deterministicId: 'mpi-anthropic', name: 'Site · Anthropic', api: 'anthropic-messages', baseUrl: base, apiKey: secret, models: [{ model: 'site-claude' }] },
  ] };
  const imported = await store.importProvidersAtomic(input);
  assert.equal(imported.providers.length, 2);
  assert.deepEqual(await store.findImportReceipt(input.operationId), imported.receipt);
  assert.deepEqual(await store.importProvidersAtomic(input), imported);
  await assert.rejects(store.importProvidersAtomic({ ...input, planHash: 'f'.repeat(64) }), /身份|计划/);
  let snapshot = await call('snapshot');
  assert.ok(snapshot.models.every(model => model.configuration === 'newapi' && model.source === 'cloud'));
  assert.doesNotMatch(JSON.stringify(snapshot), /encryptedApiKey|NEWAPI-BOT-PRIVATE/);
  assert.doesNotMatch(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'), /NEWAPI-BOT-PRIVATE/);
  assert.equal(await fs.access(path.join(root, 'desktop/runtime-v2/text-model-profiles.json')).then(() => true, () => false), false);
  const run = async key => {
    const session = await call('session.create'); await call('session.update', { id: session.id, modelKey: key });
    await call('flow.command', { id: session.id, command: { type: 'send', input: { inputId: randomUUID(), text: 'test imported model' } } });
    const detail = await waitForOAuth(() => call('session.open', { id: session.id }), detail => !detail.flow.activeRunId && JSON.stringify(detail.flow.timeline).includes('OAuth OK'));
    assert.doesNotMatch(JSON.stringify(detail), /encryptedApiKey|NEWAPI-BOT-PRIVATE/);
  };
  for (const model of snapshot.models) await run(model.key);
  const first = snapshot.models[0];
  const edited = await call('model.configure', { preserveCredentials: true, expectedModelRevision: snapshot.modelConfigRevision,
    models: [{ ...first, modelKey: first.key, apiKey: '', name: 'Edited site' }] });
  assert.ok(edited.results.every(item => item.ok));
  assert.doesNotMatch(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'), /NEWAPI-BOT-PRIVATE/);
  const before = (await call('snapshot')).models;
  await assert.rejects(store.importProvidersAtomic({ operationId: 'pi-invalid-import', planHash: 'a'.repeat(64), providers: [input.providers[0], { ...input.providers[1], apiKey: '' }] }), /API Key/);
  assert.deepEqual((await call('snapshot')).models, before);
  await host.close(); host = await createBotHost({ dataDir, defaultDir: path.join(root, 'workspace') });
  await run(first.key);
  assert.deepEqual(await store.findImportReceipt(input.operationId), imported.receipt);
  assert.ok(calls.some(request => request.authorization === `Bearer ${secret}`));
  assert.ok(calls.some(request => request.key === secret));
  await assert.rejects(desktop.importProfiles('another-bot').list(), /连接已更换/);
});
