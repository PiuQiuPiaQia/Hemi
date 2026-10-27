import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {startWindowsDesktopWorker, createWindowsDesktopClient, desktopEndpoint} from './windows-desktop.mjs';
import {controlToken} from './control-endpoint.mjs';
import {windowsAppIdentity} from './windows-desktop-apps.mjs';

test('desktop pipe authenticates, binds Windows identities and cancels disconnected calls without replay', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-desktop-pipe-'));
  const token = controlToken(root, {create: true, platform: 'win32'}), endpoint = desktopEndpoint(root, token);
  let unlocked = true, typed = '', cancelled = false;
  const driver = {
    listAppWindows: async () => [{pid: 123, name: '测试', bundleId: '', windows: [{windowId: '456'}]}],
    async typeText({text, signal}) {
      if (text !== 'wait') {typed = text;return {text};}
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => {cancelled = true;reject(new DOMException('Stopped', 'AbortError'));}, {once: true}));
    },
    dispose: async () => {},
  };
  const apps = {status: async () => ({available: unlocked, reason: '锁屏'}),
    running: async () => new Map([[123, {bundleId: 'win32:exe:c:\\fixture.exe'}]]),
    list: async () => [{name: '测试', bundleId: 'win32:exe:c:\\fixture.exe'}], open: async () => ({ok: true})};
  const worker = await startWindowsDesktopWorker({dataDir: root, endpoint, driver, apps});
  const client = createWindowsDesktopClient({dataDir: root, endpoint});
  t.after(async () => {await client.dispose();await worker.close();await fs.rm(root, {recursive: true, force: true});});
  assert.equal((await client.listAppWindows()).at(0).bundleId, 'win32:exe:c:\\fixture.exe');
  await client.typeText({text: '中文🙂'});assert.equal(typed, '中文🙂');
  unlocked = false;await assert.rejects(client.typeText({text: 'must not execute'}), /锁屏/);assert.equal(typed, '中文🙂');unlocked = true;
  const raw = net.createConnection(endpoint);let reply = '';
  raw.on('data', chunk => {reply += chunk;});raw.on('connect', () => raw.write(JSON.stringify({controlToken: '0'.repeat(64), method: 'typeText', params: {text: 'unauthorized'}}) + '\n'));
  await new Promise(resolve => raw.on('close', resolve));assert.match(reply, /认证失败/);assert.equal(typed, '中文🙂');
  const controller = new AbortController(), pending = client.typeText({text: 'wait', signal: controller.signal});
  await new Promise(resolve => setTimeout(resolve, 30));controller.abort();await assert.rejects(pending, /停止/);
  for (let i = 0; !cancelled && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 10));assert.ok(cancelled);
  assert.deepEqual(await client.openApplication({app: '测试'}), {ok: true});
});

test('Windows application identities use executable paths or AUMIDs, never display names or PIDs', () => {
  assert.equal(windowsAppIdentity({executable: 'C:\\Program Files\\Tool\\APP.exe'}), 'win32:exe:c:\\program files\\tool\\app.exe');
  assert.equal(windowsAppIdentity({appId: 'Vendor.Fixture!App'}), 'win32:aumid:vendor.fixture!app');
  assert.equal(windowsAppIdentity({}), null);
});
