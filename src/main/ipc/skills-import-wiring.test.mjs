import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { IPC } from '../../shared/ipc-channels.mjs';
import { createSkillStore, readSkillDirectory } from '../skills/skill-store.mjs';
import { createLocalSkillScanner } from '../skills/local-agent-skills.mjs';
import { errorView } from '../bot/storage.mjs';

// 仅替换 Electron/远传边界；实际 handler/preload 原码、scanner、store 在真实临时 FS 上执行。
async function loadIpc(file, globals, exports) {
  const source = (await fs.readFile(new URL(file, import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  return new vm.Script(`${source}\n;({${exports.join(',')}})`, { filename: file })
    .runInNewContext({ process, console, Buffer, ...globals });
}
async function setup(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-skill-ipc-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'home'); const source = path.join(home, '.agents/skills/ipc-demo');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: ipc-demo\ndescription: IPC 演示\n---\n');
  const handlers = new Map();
  const mainWindow = { webContents: {} };
  const state = { mainWindow };
  const event = { sender: mainWindow.webContents };
  const app = { getPath: () => path.join(temp, 'user'), getAppPath: () => temp, getVersion: () => 'test' };
  const ipcMain = { handle: (name, callback) => handlers.set(name, callback) };
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [source] }) };
  return { temp, home, source, handlers, state, event, app, ipcMain, dialog };
}

test('真实 preload→主机 IPC：默认链接、显式复制、批选 mode 透传与错误回执', async t => {
  const env = await setup(t);
  const api = await loadIpc('./skills.ipc.mjs', {
    ...env, os: { homedir: () => env.home }, path, IPC,
    createLogger: () => ({ warn() {} }), createLocalSkillScanner, createSkillStore,
    createSkillsmpService: () => ({ searchState: () => null }), getWorkspaceService: () => null,
  }, ['registerSkillsIpc', 'getSkillService']);
  api.registerSkillsIpc();
  let bridge;
  const preload = await fs.readFile(new URL('../../preload/index.cjs', import.meta.url), 'utf8');
  new vm.Script(preload).runInNewContext({ process, console, require: name => {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, webUtils: {},
      ipcRenderer: { on() {}, sendSync() {}, invoke: (channel, payload) => env.handlers.get(channel)(env.event, payload) } };
  } });
  const linked = await bridge.importLocalSkill();
  assert.equal(linked.ok, true); assert.equal(linked.skill.importMode, 'symlink');
  assert.equal(lstatSync(api.getSkillService().managedPath(linked.skill.id)).isSymbolicLink(), true);
  const copied = await bridge.importLocalSkill({ mode: 'copy' });
  assert.equal(copied.skill.importMode, 'copy'); assert.equal(copied.skill.id, linked.skill.id);
  const scan = await bridge.scanLocalSkills();
  const paths = scan.candidates.map(x => x.path);
  const batchLink = await bridge.importLocalSkills(paths);
  assert.equal(batchLink.state.installed[0].importMode, 'symlink');
  const batchCopy = await bridge.importLocalSkills(paths, { mode: 'copy' });
  assert.equal(batchCopy.state.installed[0].importMode, 'copy');
  await fs.writeFile(path.join(env.source, 'large.bin'), Buffer.alloc(3 * 1024 * 1024));
  const failure = await bridge.importLocalSkills(paths, { mode: 'copy' });
  assert.equal(failure.ok, false); assert.match(failure.failed[0].reason, /复制.*2 MiB/);
  assert.equal((await bridge.importLocalSkills(paths)).ok, true);
  assert.equal((await bridge.importLocalSkill({ mode: 'invalid' })).ok, false);
  await api.getSkillService().prune();
});

test('Bot 桥单项/批选默认 copy、拒绝链接，不向跨机器命令泄漏目录；保留复制限制', async t => {
  const env = await setup(t);
  const host = createSkillStore({ root: path.join(env.temp, 'host-store') });
  const sent = [];
  const desktop = {
    getState: () => ({ binding: { instanceId: 'instance' } }),
    command: async (method, params) => {
      sent.push({ method, params });
      if (method === 'skills.state') return host.state();
      if (method === 'skills.import') return host.importFiles(params);
      throw new Error(`不应远传的方法：${method}`);
    },
  };
  const api = await loadIpc('./bot.ipc.mjs', {
    ...env, fs, path, os: { homedir: () => env.home }, randomUUID,
    createBotDesktopService: () => desktop, createSshRunner: () => ({}), getRemoteService: () => ({}),
    getProfiles: () => ({}), getWorkspaceService: () => null, readSkillDirectory, createLocalSkillScanner, errorView,
  }, ['registerBotIpc']);
  api.registerBotIpc();
  const command = (method, params = {}) => env.handlers.get('bot:command')(env.event,
    { method, params: { expectedInstanceId: 'instance', ...params } });
  const first = await command('skills.import-local');
  assert.equal(first.ok, true); assert.equal(first.result.skill.importMode, 'copy');
  assert.equal(first.result.skill.sourcePath, null);
  assert.equal(lstatSync(host.managedPath(first.result.skill.id)).isSymbolicLink(), false);
  const payload = sent.find(x => x.method === 'skills.import').params;
  assert.deepEqual(Object.keys(payload), ['files']);
  assert.equal(JSON.stringify(payload).includes(env.source), false);
  await host.remove(first.result.skill.id);
  const scan = await command('skills.scan-local');
  const paths = scan.result.candidates.map(x => x.path);
  const batch = await command('skills.import-local-batch', { paths });
  assert.equal(batch.result.ok, true);
  assert.equal(host.state().installed[0].importMode, 'copy');
  for (const method of ['skills.import-local', 'skills.import-local-batch']) {
    const denied = await command(method, { paths, mode: 'symlink' });
    assert.equal(denied.ok, false); assert.equal(denied.code, 'unsupported'); assert.match(denied.message, /仅支持复制/);
  }
  await fs.writeFile(path.join(env.source, 'large.bin'), Buffer.alloc(3 * 1024 * 1024));
  const tooBig = await command('skills.import-local');
  assert.equal(tooBig.ok, false); assert.match(tooBig.message, /Bot 复制.*2 MiB/);
  const tooBigBatch = await command('skills.import-local-batch', { paths, mode: 'copy' });
  assert.equal(tooBigBatch.result.ok, false); assert.match(tooBigBatch.result.failed[0].reason, /2 MiB/);
  assert.equal(sent.every(x => !x.method.includes('local')), true);
  await host.prune();
});
