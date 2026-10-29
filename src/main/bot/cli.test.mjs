import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rpc } from './cli.mjs';
import {botControlEndpoint, controlToken} from './control-endpoint.mjs';

test('control subscription delivers a large initial snapshot before ready without treating it as a slow reader', {timeout: 15000}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-cli-large-watch-')), dataDir = path.join(root, 'data');
  const entry = new URL('./cli.mjs', import.meta.url).href;
  const source = `import {serve} from ${JSON.stringify(entry)};const service=await serve({defaultDir:${JSON.stringify(root)},validateModel:async()=>{}});process.once('SIGTERM',()=>void service.close().then(()=>process.exit(0)));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {env: {...process.env, HEMI_BOT_DATA_DIR: dataDir}, stdio: ['ignore', 'ignore', 'pipe']});
  let errors = ''; child.stderr.on('data', bytes => {errors += bytes;});
  t.after(async () => {if (child.exitCode === null) {const done = once(child, 'exit'); child.kill(); await done;} await fs.rm(root, {recursive: true, force: true});});
  let hello, socket, token;
  for (let i = 0; i < 200; i++) {
    try {token = controlToken(dataDir); socket = botControlEndpoint(dataDir, process.platform, token); hello = await rpc({method: 'handshake'}, {socket, token, timeoutMs: 200}); break;}
    catch {if (child.exitCode !== null) throw new Error(errors); await new Promise(resolve => setTimeout(resolve, 20));}
  }
  assert.ok(hello, errors);
  const call = (method, params = {}) => rpc({method, params: {instanceId: hello.instanceId, requestId: crypto.randomUUID(), ...params}}, {socket, token});
  await call('model.sync', {models: [{modelKey: 'f/m', providerId: 'f', name: 'Fixture', model: 'fake', api: 'openai-completions', baseUrl: 'https://fixture.invalid', apiKey: 'TEST_ONLY'}]});
  const {id} = await call('session.create'), content = 'x'.repeat(3 * 1024 * 1024);
  await call('session.draft', {id, revision: 1, references: [{key: 'large-history', title: content}]});
  const client = net.createConnection(socket); t.after(() => client.destroy());
  const frames = []; let buffer = '';
  const ready = new Promise((resolve, reject) => {
    client.on('error', reject);
    client.on('data', bytes => {buffer += bytes; let end; while ((end = buffer.indexOf('\n')) >= 0) {const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); frames.push(frame); if (frame.type === 'ready') resolve();}});
    client.once('close', () => reject(new Error('Large initial control snapshot disconnected before ready')));
  });
  await once(client, 'connect'); client.pause();
  client.write(JSON.stringify({method: 'events.watch', params: {instanceId: hello.instanceId, id}, ...(token ? {controlToken: token} : {})}) + '\n');
  const resume = setTimeout(() => client.resume(), 200); t.after(() => clearTimeout(resume));
  await ready;
  assert.equal(frames[0].snapshot.detail.draft.references[0].title, content);
  await call('session.rename', {id, title: 'still-subscribed'});
  const end = Date.now() + 3000;
  while (!frames.some(frame => frame.type === 'catalog')) {assert.ok(Date.now() < end, 'control subscription stopped after ready'); await new Promise(resolve => setTimeout(resolve, 10));}
});

test(
  'deployed symlink entry starts a real resident Host, socket is private and a second Host cannot replace it',
  { timeout: 15000, skip: process.platform === 'win32' && 'Linux Host Unix socket, symlink and POSIX permissions' },
  async (t) => {
    const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-bot-cli-')),
      ),
      entry = path.join(root, 'current.mjs');
    await fs.symlink(path.join(import.meta.dirname, 'cli.mjs'), entry);
    const env = {
      ...process.env,
      HEMI_BOT_DATA_DIR: path.join(root, 'data'),
      HEMI_BOT_ISOLATED_TEST: '1',
    };
    const child = spawn(process.execPath, [entry, 'serve'], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let error = '';
    child.stderr.on('data', (chunk) => (error += chunk));
    t.after(async () => {
      if (child.exitCode === null) {
        const done = once(child, 'exit');
        child.kill('SIGTERM');
        await done;
      }
      await fs.rm(root, { recursive: true, force: true });
    });
    const socket = path.join(root, 'data/control.sock');
    let hello;
    for (let i = 0; i < 200; i++) {
      try {
        hello = await rpc({ method: 'handshake' }, { socket, timeoutMs: 1000 });
        break;
      } catch {
        if (child.exitCode !== null) throw new Error(error);
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    assert.ok(hello);
    assert.equal(hello.protocol, 1);
    assert.equal((await fs.stat(socket)).mode & 0o777, 0o600);
    const second = spawn(process.execPath, [entry, 'serve'], {
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const [code] = await once(second, 'exit');
    assert.notEqual(code, 0);
    const restored = await rpc({ method: 'handshake' }, { socket });
    assert.equal(restored.bootId, hello.bootId);
    assert.equal(restored.instanceId, hello.instanceId);
  },
);
