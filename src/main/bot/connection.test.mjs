import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createBotDesktopService} from './desktop-service.mjs';

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-connect-'));
  let running = false;
  const calls = [], phases = [];
  const info = {platform: 'win32', home: 'C:\\Users\\Owner', existing: true, runtimeNeeded: false};
  const bot = {instanceId: 'original-instance', configured: true, protocol: 1};
  const transport = {
    async probe() { calls.push('probe'); return {...info, ...(running ? {bot} : {serviceError: '服务未就绪'})}; },
    async control(_host, action) { calls.push(action); running = true; },
    async install() { assert.fail('A stopped or failed existing Bot must never be overwritten'); },
    ...overrides,
  };
  const service = createBotDesktopService({userDataDir: root, runner: {}, transport, autoComponentUpdates: false,
    onChanged(state) { if (phases.at(-1) !== state.busy) phases.push(state.busy); }});
  t.after(async () => { await service.close(); await fs.rm(root, {recursive: true, force: true}); });
  return {service, calls, phases, info, bot, transport};
}

test('connect automatically starts a stopped existing Bot and rechecks its original identity', async t => {
  const f = await fixture(t);
  await f.service.connect({host: 'windows-test'});
  const state = f.service.getState();
  assert.deepEqual(f.calls, ['probe', 'start', 'probe']);
  assert.equal(state.candidate.info.bot.instanceId, 'original-instance');
  assert.equal(state.candidate.info.serviceError, undefined);
  assert.deepEqual(f.phases, ['probe', 'start-service', '']);
  assert.equal(state.binding, null); // Binding and model selection still require initialization.
});

test('healthy and fresh hosts skip service recovery; fresh hosts retain automatic runtime installation metadata', async t => {
  const f = await fixture(t, {async control() { assert.fail('unnecessary service start'); }});
  for (const info of [{existing: true, bot: {instanceId: 'healthy'}}, {existing: false, runtimeNeeded: true}]) {
    f.transport.probe = async () => info;
    await f.service.connect({host: 'windows-test'});
    assert.deepEqual(f.service.getState().candidate.info, info);
    assert.equal(f.service.getState().busy, '');
  }
  assert.ok(!f.phases.includes('start-service'));
});

test('failed automatic startup preserves the installation and a guarded retry can recover it', async t => {
  const f = await fixture(t);
  const start = f.transport.control;
  f.transport.control = async () => { throw Object.assign(new Error('任务计划程序拒绝启动'), {code: 'permission'}); };
  await f.service.connect({host: 'windows-test'});
  assert.match(f.service.getState().candidate.info.serviceError, /自动启动 Bot 未成功.*任务计划程序拒绝启动/);
  assert.equal(f.service.getState().candidate.info.existing, true);
  const id = f.service.getState().candidate.id;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.transport.control = async (...args) => { await gate; await start(...args); };
  const retry = f.service.command('candidate.start');
  try {
    assert.equal(f.service.getState().busy, 'candidate.start');
    await assert.rejects(f.service.command('candidate.start'), {code: 'busy'});
    await assert.rejects(f.service.connect({host: 'different-test'}), {code: 'busy'});
  } finally { release(); }
  await retry;
  assert.equal(f.service.getState().busy, '');
  assert.equal(f.service.getState().candidate.id, id);
  assert.equal(f.service.getState().candidate.info.bot.instanceId, 'original-instance');
  assert.equal(f.service.getState().candidate.info.serviceError, undefined);
  assert.deepEqual(f.service.diagnostics().events.filter(event => event.stage === 'candidate.start').map(event => event.outcome), ['failed', 'confirmed']);
});

test('a successful service command alone does not count as a healthy Bot', async t => {
  const f = await fixture(t, {async control() {}});
  await f.service.connect({host: 'windows-test'});
  assert.match(f.service.getState().candidate.info.serviceError, /启动后仍未收到 Bot 响应/);
  assert.equal(f.service.getState().candidate.info.bot, undefined);
});
