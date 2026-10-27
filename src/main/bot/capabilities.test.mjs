import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createBotHost} from './host.mjs';
import {createBotCapabilities} from './capabilities.mjs';

test('Bot owns encrypted search/decision keys and restores its switches without exposing secrets', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-bot-caps-'));
  t.after(() => fs.rm(dataDir, {recursive: true, force: true}));
  const service = createBotCapabilities({dataDir, platform: 'linux'});
  assert.equal((await service.resolve()).features.desktop, false);
  const view = service.configure({computerUseEnabled: true, searchApiKey: 'fixture-search-key', browserActApiKey: 'fixture-decision-key', browserEnabled: false});
  assert.equal(view.computerUseEnabled, false);assert.equal(view.hasSearchKey, true);
  assert.equal(JSON.stringify(view).includes('fixture-'), false);
  const disk = await fs.readFile(path.join(dataDir, 'capabilities.json'), 'utf8');assert.equal(disk.includes('fixture-'), false);
  const restored = createBotCapabilities({dataDir, platform: 'linux'});
  const caps = await restored.resolve();assert.equal(caps.extensionConfig.web.apiKey, 'fixture-search-key');assert.equal(caps.features.browser, false);
  restored.configure({searchApiKey: ''});assert.equal((await restored.resolve()).features.web, false);
  await service.close();await restored.close();
});

test('Host skill library imports, validates, discovers and persists enabled versions beside project skills', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-bot-library-'));
  const options = {dataDir: path.join(root, 'data'), defaultDir: path.join(root, 'project'), validateModel: async () => {}};
  let host = await createBotHost(options);const hello = await host.request('handshake');let sequence = 0;
  const call = (method, params = {}) => host.request(method, {instanceId: hello.instanceId, requestId: `request-${++sequence}`, ...params});
  t.after(async () => {await host.close();await fs.rm(root, {recursive: true, force: true});});
  const imported = await call('skills.import', {files: [{path: 'SKILL.md', contentBase64: Buffer.from('---\nname: bot-library\ndescription: Test owned library\n---\nBOT_LIBRARY_CONTENT').toString('base64')}]});
  assert.equal(imported.ok, true);
  await call('model.sync', {models: [{modelKey: 'fixture/model', providerId: 'fixture', name: 'Fixture', model: 'fixture', api: 'openai-completions', baseUrl: 'https://models.example.invalid/v1', apiKey: 'fixture-key'}]});
  const session = await call('session.create');const available = await call('skills', {id: session.id});assert.equal(available.skills.at(0).source, 'library');
  const skillId = imported.skill.id;assert.match((await call('skills.read', {skillId})).text, /BOT_LIBRARY_CONTENT/);
  await assert.rejects(call('skills.import', {files: [{path: '../SKILL.md', contentBase64: 'aGVsbG8='}]}), /路径/);
  await call('skills.set-enabled', {skillId, enabled: false});assert.equal((await call('skills', {id: session.id})).skills.length, 0);
  await call('skills.set-enabled', {skillId, enabled: true});
  await host.close();host = await createBotHost(options);assert.equal((await call('skills', {id: session.id})).skills.at(0).skillId, skillId);
  await call('skills.remove', {skillId});assert.equal((await call('skills.state')).installed.length, 0);
});
